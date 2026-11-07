import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rows, tx, parse, pool } from "./db.js";
import { ApiError, requireRole } from "./security.js";
import {
  extractRequirements,
  type RequirementCandidate,
} from "../shared/intake.js";
import { validQuote } from "../shared/evidence.js";
export const confirmedRequirementSchema = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
  quote: z.string().min(4).max(1200),
  start: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(2000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function requirementSource(
  id: string,
  proposalId: string,
  db: any = pool,
  lock = false,
) {
  const [v] = await rows(
    "SELECT v.id,v.sha256,v.text_content,v.status,v.expires_on,d.proposal_id,d.kind,d.title,v.version FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?" +
      (lock ? " FOR UPDATE" : ""),
    [id],
    db,
  );
  const date =
    v?.expires_on instanceof Date
      ? v.expires_on.toISOString().slice(0, 10)
      : String(v?.expires_on || "");
  if (
    !v ||
    v.proposal_id !== proposalId ||
    v.kind !== "customer" ||
    v.status !== "published" ||
    (date &&
      date.slice(0, 10) <
        new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
          new Date(),
        ))
  )
    throw new ApiError(422, "客户需求来源未发布、已撤回、过期或不属于本方案");
  return v;
}
export function intakeRouter(access: any, audit: any) {
  const r = Router();
  r.post("/proposals/:id/requirement-batches", async (req, res) => {
    const b = z
      .object({
        expectedRevision: z.number().int(),
        versionIds: z.array(z.string().uuid()).min(1).max(8),
      })
      .parse(req.body);
    let id = "";
    await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      requireRole(req, "engineer");
      if (
        p.owner_id !== req.user.id ||
        !["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status) ||
        p.revision !== b.expectedRevision
      )
        throw new ApiError(409, "请先保存并核对最新草稿");
      const candidates: RequirementCandidate[] = [];
      for (const versionId of [...new Set(b.versionIds)].sort()) {
        const v = await requirementSource(versionId, p.id, db, true);
        for (const c of extractRequirements(v.text_content))
          candidates.push({
            id: randomUUID(),
            versionId,
            quote: c.quote,
            start: c.start,
            text: c.quote,
            sha256: v.sha256,
          });
      }
      if (candidates.length > 100)
        throw new ApiError(422, "需求候选超过100条，请减少文档分批处理");
      id = randomUUID();
      await db.execute(
        "INSERT INTO sp_requirement_batches(id,proposal_id,edition,revision,created_by,candidates) VALUES (?,?,?,?,?,?)",
        [
          id,
          p.id,
          p.edition,
          p.revision,
          req.user.id,
          JSON.stringify(candidates),
        ],
      );
      await audit(db, req, "requirements.extracted", p.id, {
        batchId: id,
        count: candidates.length,
        mode: "local_rules",
      });
    });
    res.json({ id });
  });
  r.get("/proposals/:id/requirement-batches", async (req, res) => {
    await access(req, req.params.id);
    res.json(
      (
        await rows(
          "SELECT * FROM sp_requirement_batches WHERE proposal_id=? ORDER BY created_at DESC LIMIT 20",
          [req.params.id],
        )
      ).map((b) => ({ ...b, candidates: parse(b.candidates) })),
    );
  });
  r.post(
    "/proposals/:id/requirement-batches/:batchId/apply",
    async (req, res) => {
      const b = z
        .object({
          expectedRevision: z.number().int(),
          items: z
            .array(
              z.object({
                id: z.string().uuid(),
                text: z.string().trim().min(1).max(2000),
              }),
            )
            .min(1)
            .max(100),
        })
        .parse(req.body);
      if (new Set(b.items.map((i) => i.id)).size !== b.items.length)
        throw new ApiError(422, "不能重复确认同一条需求");
      await tx(async (db) => {
        const p = await access(req, req.params.id, db, true);
        requireRole(req, "engineer");
        if (
          p.owner_id !== req.user.id ||
          !["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status) ||
          p.revision !== b.expectedRevision
        )
          throw new ApiError(409, "方案已有修改，请重新提取或刷新比较");
        const [batch] = await rows(
          "SELECT * FROM sp_requirement_batches WHERE id=? AND proposal_id=? FOR UPDATE",
          [req.params.batchId, p.id],
          db,
        );
        if (
          !batch ||
          batch.created_by !== req.user.id ||
          batch.applied_at ||
          batch.edition !== p.edition ||
          batch.revision !== p.revision
        )
          throw new ApiError(409, "需求批次已采用或基于旧修订");
        const candidates: RequirementCandidate[] = parse(batch.candidates),
          adopted = [];
        for (const item of b.items) {
          const c = candidates.find((c) => c.id === item.id);
          if (!c) throw new ApiError(422, "候选不存在");
          const v = await requirementSource(c.versionId, p.id, db, true);
          if (v.sha256 !== c.sha256 || !validQuote(v.text_content, c))
            throw new ApiError(422, "需求来源或原文已失效");
          adopted.push({ ...c, text: item.text });
        }
        const history = JSON.stringify(p);
        const previous = p.body.confirmedRequirements || [];
        const existing = new Set(
          previous.map((c: any) => c.versionId + ":" + c.start + ":" + c.quote),
        );
        const unique = adopted.filter(
          (c) => !existing.has(c.versionId + ":" + c.start + ":" + c.quote),
        );
        if (!unique.length)
          throw new ApiError(409, "所选原文已确认，不重复追加");
        p.body.confirmedRequirements = [...previous, ...unique];
        if (p.body.confirmedRequirements.length > 100)
          throw new ApiError(422, "已确认需求最多100条");
        const content = unique.map((c) => c.text).join("\n");
        p.body.requirements = [p.body.requirements, content]
          .filter(Boolean)
          .join("\n");
        if (p.body.requirements.length > 20000)
          throw new ApiError(422, "需求正文超过2万字符，请精简后重试");
        await db.execute(
          "INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
          [p.id, p.edition, p.revision, history, req.user.id],
        );
        await db.execute(
          "UPDATE sp_proposals SET body=?,revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
          [JSON.stringify(p.body), p.id],
        );
        await db.execute(
          "UPDATE sp_requirement_batches SET applied_at=UTC_TIMESTAMP(3) WHERE id=?",
          [batch.id],
        );
        await audit(db, req, "requirements.confirmed", p.id, {
          batchId: batch.id,
          items: unique,
          revision: p.revision + 1,
        });
      });
      res.json({ ok: true });
    },
  );
  r.post("/proposals/:id/confirmed-requirements/remove", async (req, res) => {
    const b = z
      .object({
        expectedRevision: z.number().int(),
        id: z.string().uuid(),
        note: z.string().trim().min(4).max(2000),
      })
      .parse(req.body);
    await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      requireRole(req, "engineer");
      if (
        p.owner_id !== req.user.id ||
        !["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status) ||
        p.revision !== b.expectedRevision
      )
        throw new ApiError(409, "请在最新草稿修订中办理");
      const old = p.body.confirmedRequirements || [];
      if (!old.some((c: any) => c.id === b.id))
        throw new ApiError(409, "确认记录不存在或已撤销");
      const snapshot = JSON.stringify(p);
      p.body.confirmedRequirements = old.filter((c: any) => c.id !== b.id);
      await db.execute(
        "INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
        [p.id, p.edition, p.revision, snapshot, req.user.id],
      );
      await db.execute(
        "UPDATE sp_proposals SET body=?,revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [JSON.stringify(p.body), p.id],
      );
      await audit(db, req, "requirements.confirmation_removed", p.id, {
        id: b.id,
        note: b.note,
        revision: p.revision + 1,
      });
    });
    res.json({ ok: true });
  });
  return r;
}
