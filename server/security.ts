import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { rows, parse } from "./db.js";
export const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export function passwordHash(v: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(v, salt, 64).toString("hex");
}
export function passwordMatches(v: string, h: string) {
  const [s, k] = h.split(":");
  const b = Buffer.from(k || "", "hex");
  return b.length === 64 && timingSafeEqual(b, scryptSync(v, s, 64));
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
declare global {
  namespace Express {
    interface Request {
      user: any;
      csrf: string;
      sessionHash: string;
    }
  }
}
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("sp_session="))
      ?.slice(11);
    if (!token) throw new ApiError(401, "请先登录");
    const [u] = await rows(
      "SELECT u.id,u.name,u.email,u.roles,s.csrf FROM sp_sessions s JOIN sp_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(3) AND u.active=1",
      [hash(token)],
    );
    if (!u) throw new ApiError(401, "会话已过期");
    req.user = { ...u, roles: parse(u.roles) };
    req.csrf = u.csrf;
    req.sessionHash = hash(token);
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-csrf-token"] !== u.csrf
    )
      throw new ApiError(403, "请求校验失败，请重新登录");
    next();
  } catch (e) {
    next(e);
  }
}
export function requireRole(req: Request, role: string) {
  if (!req.user.roles.includes(role))
    throw new ApiError(403, "当前角色无权操作");
}
