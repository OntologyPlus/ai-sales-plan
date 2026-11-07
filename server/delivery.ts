import { storage, storedFile } from "./storage.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rows, tx, parse, pool } from "./db.js";
import { ApiError } from "./security.js";
import { requireEvidence } from "./evidence.js";
import { renderApproval } from "./rendering/render.js";
import { checkApprovedProject } from "./project.js";
export { renderApproval } from "./rendering/render.js";
const renderer = "0.6.0-project-node-docx";
const pending = new Map<string, Promise<void>>();
export function deliveryRouter(
  access: (req: Request, id: string, db?: any, lock?: boolean) => Promise<any>,
  audit: any,
) {
  const router = Router();
  async function check(
    req: Request,
    requestId?: string,
    db: any = pool,
    lock = false,
  ) {
    const p = await access(req, String(req.params.id), db, lock);
    const [u] = await rows(
      "SELECT roles,active FROM sp_users WHERE id=?",
      [req.user.id],
      db,
    );
    const roles = u ? parse(u.roles) : [];
    if (
      !u?.active ||
      (!(p.owner_id === req.user.id && roles.includes("engineer")) &&
        !roles.includes("leader"))
    )
      throw new ApiError(403, "无正式导出权限");
    const [approval] = await rows(
      "SELECT * FROM sp_approval_requests WHERE proposal_id=? AND status='approved'" +
        (requestId ? " AND id=?" : " ORDER BY created_at DESC") +
        " LIMIT 1" +
        (lock ? " FOR UPDATE" : ""),
      requestId ? [p.id, requestId] : [p.id],
      db,
    );
    if (!approval) throw new ApiError(409, "未找到已批准版本");
    const snapshot = parse(approval.snapshot);
    await requireEvidence(snapshot, db, lock);
    await checkApprovedProject(snapshot,db);
    return { p, approval, snapshot };
  }
  async function ensure(req: Request, requestId?: string) {
    const { approval, snapshot } = await check(req, requestId);
    const existing = await rows(
      "SELECT format FROM sp_artifacts WHERE request_id=? AND format='docx'",
      [approval.id],
    );
    if (existing.length) return approval.id;
    if (!pending.has(approval.id)) {
      if (pending.size >= 1)
        throw new ApiError(429, "成果渲染繁忙，请稍后重试");
      const task = (async () => {
        const steps = await rows(
          "SELECT s.role,s.comment,s.decided_at,u.name FROM sp_approval_steps s JOIN sp_users u ON u.id=s.assignee_id WHERE request_id=? AND s.status='approved' ORDER BY FIELD(s.role,'chemist','compliance','quality','legal','finance','leader')",
          [approval.id],
        );
        const required=snapshot.approvalPolicy?.requiredRoles||["chemist","compliance","leader"];
        if (steps.length!==required.length || !required.every((role:string)=>steps.some(s=>s.role===role))) throw new ApiError(409, "批准记录不完整");
        const stamp = (d: any) =>
          new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        const payload = {
          snapshot,
          requestId: approval.id,
          snapshotHash: approval.snapshot_hash,
          approvedOn: stamp(steps.find(s=>s.role==="leader")!.decided_at),
          steps: steps.map((s) => ({ ...s, decidedAt: stamp(s.decided_at) })),
        };
        let files: { docx: Buffer };
        try {
          files = await renderApproval(payload);
        } catch {
          throw new ApiError(503, "Word生成失败，请检查批准内容并重试");
        }
        if (files.docx.length > 20 * 1024 * 1024)
          throw new ApiError(422, "单个成果超过20MB上限");
        const stored = await storage.put("artifacts", files.docx);
        await tx(async (db) => {
          await check(req, approval.id, db, true);
          const [old] = await rows(
            "SELECT id FROM sp_artifacts WHERE request_id=? AND format='docx' FOR UPDATE",
            [approval.id],
            db,
          );
          if (!old)
            await db.execute(
              "INSERT INTO sp_artifacts(id,request_id,format,renderer_version,sha256,storage_provider,storage_key,byte_size) VALUES (?,?,?,?,?,?,?,?)",
              [
                randomUUID(),
                approval.id,
                "docx",
                renderer,
                stored.sha256,
                stored.provider,
                stored.key,
                stored.size,
              ],
            );
          await audit(db, req, "artifacts.created", req.params.id, {
            requestId: approval.id,
            renderer,
          });
        });
      })().finally(() => pending.delete(approval.id));
      pending.set(approval.id, task);
    }
    await pending.get(approval.id);
    return approval.id;
  }
  router.get("/proposals/:id/artifacts", async (req, res) => {
    await access(req, req.params.id);
    const approvals = await rows(
      "SELECT id,edition,revision,created_at FROM sp_approval_requests WHERE proposal_id=? AND status='approved' ORDER BY created_at DESC",
      [req.params.id],
    );
    const files = await rows(
      "SELECT a.id,a.request_id,a.format,a.renderer_version,a.sha256,a.created_at FROM sp_artifacts a JOIN sp_approval_requests r ON r.id=a.request_id WHERE r.proposal_id=? AND a.format='docx'",
      [req.params.id],
    );
    res.json({ approvals, files });
  });
  router.post("/proposals/:id/artifacts", async (req, res) => {
    const b = z
      .object({ requestId: z.string().uuid().optional() })
      .parse(req.body);
    const requestId = await ensure(req, b.requestId);
    res.json({
      requestId,
      files: await rows(
        "SELECT id,format,sha256,renderer_version FROM sp_artifacts WHERE request_id=? AND format='docx'",
        [requestId],
      ),
    });
  });
  async function download(
    req: Request,
    res: any,
    format: string,
    requestId?: string,
  ) {
    if (format !== "docx")
      throw new ApiError(404, "当前仅支持Word（DOCX）导出");
    const id = await ensure(req, requestId);
    const [f] = await rows(
      "SELECT * FROM sp_artifacts WHERE request_id=? AND format=?",
      [id, format],
    );
    if (!f) throw new ApiError(409, "原成果记录缺失");
    const bytes = await storedFile(f);
    const { p, approval } = await tx(async (db) => {
      const checked = await check(req, id, db, true);
      await db.execute(
        "INSERT INTO sp_exports(id,proposal_id,request_id,actor_id,format,sha256) VALUES (?,?,?,?,?,?)",
        [randomUUID(), checked.p.id, id, req.user.id, format, f.sha256],
      );
      await audit(db, req, "export." + format, checked.p.id, {
        requestId: id,
        artifactId: f.id,
        sha256: f.sha256,
      });
      return checked;
    });
    res.setHeader("X-Content-SHA256", f.sha256);
    res
      .type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .attachment(`${p.code}-V${approval.edition}.${format}`)
      .send(bytes);
  }
  router.get("/proposals/:id/export.:format", async (req, res) => {
    const requestId = req.query.requestId
      ? z.string().uuid().parse(req.query.requestId)
      : undefined;
    await download(req, res, req.params.format, requestId);
  });
  return router;
}
