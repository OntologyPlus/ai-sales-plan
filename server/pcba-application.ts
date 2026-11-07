import { Router, type Request } from "express";
import { z } from "zod";
import { rows, tx, parse, pool } from "./db.js";
import { ApiError, hash, requireRole } from "./security.js";
import { requirementSource } from "./intake.js";
import { validQuote } from "../shared/evidence.js";
import { pcbaSaveSchema, suggestPcbaFacts, type PcbaFact } from "../shared/pcba-application.js";
import { assessPcbaProfile, pcbaProfileSchema, type PcbaProfile } from "../shared/pcba.js";

type Access = (req: Request, id: string, db?: any, lock?: boolean) => Promise<any>;
type Audit = (db: any, req: Request, action: string, id: string, details: any) => Promise<void>;

async function profileRows(sql: string, args: any[], db: any = pool) {
  try { return await rows(sql, args, db); }
  catch (e: any) {
    if (e.code === "ER_NO_SUCH_TABLE") throw new ApiError(503, "PCBA档案尚未完成迁移8，请运行数据库迁移");
    throw e;
  }
}

async function checkFact(f: PcbaFact, proposalId: string, db: any, lock: boolean) {
  for (const c of f.citations) {
    const v = await requirementSource(c.versionId, proposalId, db, lock);
    if (v.sha256 !== c.sha256 || !validQuote(v.text_content, c))
      throw new ApiError(422, "档案引用已失效，请重新选择客户原文");
  }
}

function assertEditable(req: Request, p: any) {
  requireRole(req, "engineer");
  if (p.owner_id !== req.user.id) throw new ApiError(403, "仅方案负责人可维护应用档案");
  if (!["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status))
    throw new ApiError(409, "当前方案不可修改，请撤回审核或开启新版本");
}

export function pcbaApplicationRouter(access: Access, audit: Audit) {
  const r = Router();
  r.get("/proposals/:id/application", async (req, res) => {
    await tx(async db => {
      const p = await access(req, req.params.id, db, true);
      const [record] = await profileRows("SELECT * FROM sp_pcba_profiles WHERE proposal_id=? AND edition=?", [p.id, p.edition], db);
      const profile: PcbaProfile = record ? pcbaProfileSchema.parse(parse(record.profile))
        : { schemaVersion: 1, id: p.id, projectId: p.id, revision: 0, application: "pcba-cleaning", facts: [] };
      const unavailable: string[] = [];
      // Current source availability applies to derived values too. Keep originals only in protected storage.
      for (const f of profile.facts) {
        try { await checkFact(f, p.id, db, false); }
        catch (e) {
          if (!(e instanceof ApiError) || e.status !== 422) throw e;
          unavailable.push(f.field); f.value = null; f.status = "candidate"; f.citations = [];
        }
      }
      res.json({ profile, unavailable, assessment: assessPcbaProfile(profile), edition: p.edition,
        editable: p.owner_id === req.user.id && req.user.roles.includes("engineer") && ["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status),
        proposalRevision: p.revision, updatedAt: record?.updated_at || null });
    });
  });
  r.post("/proposals/:id/application/suggestions", async (req, res) => {
    const b = z.object({ versionId: z.string().uuid(), expectedEdition: z.number().int(),
      expectedProposalRevision: z.number().int() }).strict().parse(req.body);
    await tx(async db => {
      const p = await access(req, req.params.id, db, true); assertEditable(req, p);
      if (p.edition !== b.expectedEdition || p.revision !== b.expectedProposalRevision)
        throw new ApiError(409, "方案已有更新，请先刷新应用档案");
      const v = await requirementSource(b.versionId, p.id, db, true);
      res.json({ mode: "local_rules", candidates: suggestPcbaFacts(v.text_content, { versionId: v.id, sha256: v.sha256 }) });
    });
  });
  r.patch("/proposals/:id/application", async (req, res) => {
    const b = pcbaSaveSchema.parse(req.body);
    const requestHash = hash(JSON.stringify(b));
    let receipt: any;
    await tx(async db => {
      const p = await access(req, req.params.id, db, true); assertEditable(req, p);
      if (p.edition !== b.expectedEdition) throw new ApiError(409, "方案版次已改变，请刷新后办理");
      const [prior] = await profileRows("SELECT * FROM sp_pcba_profile_versions WHERE proposal_id=? AND edition=? AND request_id=?", [p.id, b.expectedEdition, b.requestId], db);
      if (prior) {
        if (prior.actor_id !== req.user.id || prior.request_hash !== requestHash)
          throw new ApiError(409, "请求编号已用于其他内容");
        receipt = { ok: true, revision: prior.revision, proposalRevision: prior.proposal_revision }; return;
      }
      const [record] = await profileRows("SELECT * FROM sp_pcba_profiles WHERE proposal_id=? AND edition=? FOR UPDATE", [p.id, p.edition], db);
      if (p.edition !== b.expectedEdition || p.revision !== b.expectedProposalRevision || (record?.revision || 0) !== b.expectedProfileRevision)
        throw new ApiError(409, "方案或档案已更新，本地输入仍保留；请比较最新版本后重试");
      const old: PcbaProfile = record ? pcbaProfileSchema.parse(parse(record.profile))
        : { schemaVersion: 1, id: p.id, projectId: p.id, revision: 0, application: "pcba-cleaning", facts: [] };
      for (const f of b.changes) await checkFact(f, p.id, db, true);
      const facts = new Map(old.facts.map(f => [f.field, f]));
      for (const f of b.changes) facts.set(f.field, f);
      const profile = pcbaProfileSchema.parse({ ...old, revision: old.revision + 1, facts: [...facts.values()] });
      await db.execute("INSERT INTO sp_pcba_profiles(proposal_id,edition,revision,profile,updated_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),profile=VALUES(profile),updated_by=VALUES(updated_by),updated_at=UTC_TIMESTAMP(3)",
        [p.id, p.edition, profile.revision, JSON.stringify(profile), req.user.id]);
      await db.execute("INSERT INTO sp_pcba_profile_versions(proposal_id,edition,revision,profile,request_id,request_hash,actor_id,proposal_revision) VALUES (?,?,?,?,?,?,?,?)",
        [p.id, p.edition, profile.revision, JSON.stringify(profile), b.requestId, requestHash, req.user.id, p.revision + 1]);
      await db.execute("INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
        [p.id, p.edition, p.revision, JSON.stringify(p), req.user.id]);
      await db.execute("UPDATE sp_proposals SET body=?,revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [JSON.stringify({ ...p.body, applicationProfileRevision: profile.revision }), p.id]);
      await audit(db, req, "application.saved", p.id, { revision: profile.revision,
        fields: b.changes.map(f => ({ field: f.field, status: f.status })), requestId: b.requestId });
      receipt = { ok: true, revision: profile.revision, proposalRevision: p.revision + 1 };
    });
    res.json(receipt);
  });
  return r;
}
