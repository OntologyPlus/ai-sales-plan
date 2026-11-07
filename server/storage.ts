import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, realpath, lstat, open, link, unlink } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { ApiError } from "./security.js";
export type StoredObject = {
  provider: "local";
  key: string;
  size: number;
  sha256: string;
};
export interface FileStorage {
  put(kind: "documents" | "artifacts", bytes: Buffer): Promise<StoredObject>;
  get(
    key: string,
    expectedHash: string,
    expectedSize?: number,
  ): Promise<Buffer>;
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export class LocalFileStorage implements FileStorage {
  constructor(readonly directory: string) {}
  private async location(key: string) {
    if (
      !/^(documents|artifacts)\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key) ||
      key.split("/")[1] !== key.slice(-64, -62)
    )
      throw new ApiError(409, "文件存储标识无效");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await realpath(this.directory);
    const parts = key.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if ((await lstat(dir)).isSymbolicLink())
        throw new ApiError(409, "文件存储目录不允许符号链接");
      const actual = await realpath(dir);
      if (!actual.startsWith(root + sep))
        throw new ApiError(409, "文件存储路径越界");
    }
    return join(dir, parts.at(-1)!);
  }
  async put(
    kind: "documents" | "artifacts",
    bytes: Buffer,
  ): Promise<StoredObject> {
    const sha256 = digest(bytes),
      key = `${kind}/${sha256.slice(0, 2)}/${sha256}`,
      path = await this.location(key),
      temp = path + "." + randomUUID() + ".tmp";
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      try {
        await link(temp, path);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
      await this.get(key, sha256, bytes.length);
    } finally {
      await unlink(temp).catch(() => {});
    }
    return { provider: "local", key, size: bytes.length, sha256 };
  }
  async get(key: string, expectedHash: string, expectedSize?: number) {
    try {
      if (key.slice(-64) !== expectedHash) throw new Error("hash key mismatch");
      const path = await this.location(key);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const st = await file.stat();
        if (!st.isFile() || st.size > 25 * 1024 * 1024)
          throw new Error("invalid file");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      if (
        digest(bytes) !== expectedHash ||
        (expectedSize !== undefined && bytes.length !== expectedSize)
      )
        throw new Error("integrity mismatch");
      return bytes;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(409, "原文件缺失或指纹异常，请恢复文件备份");
    }
  }
}
export const storage: FileStorage = new LocalFileStorage(
  resolve(process.env.FILE_STORAGE_DIR || "./data/files"),
);
export function storedFile(row: any) {
  if (row.storage_provider !== "local" || !row.storage_key)
    throw new ApiError(409, "文件存储信息未迁移或存储后端不可用");
  return storage.get(row.storage_key, row.sha256, Number(row.byte_size));
}
