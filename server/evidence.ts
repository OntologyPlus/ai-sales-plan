import { requirementSource } from "./intake.js";
import { checkRiskEvidence } from "./risk-validation.js";
import { storage, storedFile } from "./storage.js";
import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, rows, tx, parse } from "./db.js";
import { ApiError, requireRole, hash } from "./security.js";
import { extract } from "./extract.js";
import {
  documentKinds,
  validQuote,
  reviewRole,
  kindSatisfies,
  type Citation,
} from "../shared/evidence.js";
export { citationSchema } from "./contracts.js";
import { matchingReport } from "./matching.js";
import { projectApproval,projectSourceChanged } from "./project.js";
type Access = (
  req: Request,
  id: string,
  db?: any,
  lock?: boolean,
) => Promise<any>;
type Audit = (
  db: any,
  req: any,
  action: string,
  id: string | null,
  details?: any,
) => Promise<void>;
async function permitted(req: Request, d: any, access: Access, db: any) {
  if (d.proposal_id) await access(req, d.proposal_id, db);
  else if (
    d.status !== "published" &&
    !req.user.roles.some((r: string) =>
      ["admin", reviewRole(d.kind)].includes(r),
    )
  )
    throw new ApiError(404, "资料不存在或无权访问");
}
export async function inspectEvidence(p: any, db: any = pool, lock = false) {
  const issues: string[] = [];
  const versions: any[] = [];
  const risks = await rows(
    "SELECT * FROM sp_risks WHERE proposal_id=?" + (lock ? " FOR UPDATE" : ""),
    [p.id],
    db,
  );
  for (const risk of risks) {
    if (!risk.blocking) continue;
    if (risk.status !== "closed")
      issues.push("存在未关闭的阻断风险：" + risk.title);
    else {
      try {
        versions.push(
          ...(await checkRiskEvidence(parse(risk.evidence) || [], p.id, db)),
        );
      } catch {
        issues.push("已关闭风险的补证依据失效：" + risk.title);
      }
    }
  }
  for (const c of p.body.confirmedRequirements || []) {
    try {
      const v = await requirementSource(c.versionId, p.id, db, lock);
      if (v.sha256 !== c.sha256 || !validQuote(v.text_content, c))
        throw Error();
      versions.push({
        id: v.id,
        title: v.title,
        version: v.version,
        sha256: v.sha256,
        kind: v.kind,
      });
    } catch {
      issues.push("已确认需求来源失效，请核对并重新确认");
    }
  }
  if (!p.body.requirements?.trim()) issues.push("请填写已确认的客户需求");
  for (const [i, s] of p.body.sections.entries()) {
    if (s.enabled === false) continue;
    if (s.required === false && !s.content?.trim()) continue;
    if (!s.content?.trim()) issues.push(`第${i + 1}章缺少正文`);
    const refs: Citation[] = s.citations || [];
    if (!refs.length) {
      issues.push(`第${i + 1}章需要可核验的文档原文引用，手填说明不能代替引用`);
      continue;
    }
    const kinds: string[] = [];
    for (const c of refs) {
      const [v] = await rows(
        "SELECT v.id,v.version,v.sha256,v.status,v.expires_on,v.text_content,v.allow_model,d.kind,d.title,d.proposal_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?" +
          (lock ? " FOR UPDATE" : ""),
        [c.versionId],
        db,
      );
      if (!v || (v.proposal_id && v.proposal_id !== p.id)) {
        issues.push(`第${i + 1}章引用资料不存在或不属于本方案`);
        continue;
      }
      if (v.status !== "published")
        issues.push(`第${i + 1}章引用《${v.title}》未发布或已撤回`);
      if (
        v.expires_on &&
        String(
          v.expires_on instanceof Date
            ? v.expires_on.toISOString().slice(0, 10)
            : v.expires_on,
        ).slice(0, 10) <
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Shanghai",
          }).format(new Date())
      )
        issues.push(`第${i + 1}章引用《${v.title}》已过期`);
      if (!validQuote(v.text_content, c))
        issues.push(`第${i + 1}章引文与原文位置不一致`);
      kinds.push(v.kind);
      versions.push({
        id: v.id,
        title: v.title,
        version: v.version,
        sha256: v.sha256,
        kind: v.kind,
        allowModel: !!v.allow_model,
      });
    }
    if (!kindSatisfies(i, kinds))
      issues.push(
        `第${i + 1}章缺少${i === 5 ? "SDS或正式合规资料" : "TDS或应用说明"}引用`,
      );
  }
  const matching = await matchingReport(p, db, lock);
  issues.push(...matching.issues);
  versions.push(...matching.evidenceVersions);
  return {
    issues: [...new Set(issues)],
    versions: [...new Map(versions.map((v) => [v.id, v])).values()],
  };
}
export async function requireEvidence(p: any, db: any = pool, lock = false) {
  const r = await inspectEvidence(p, db, lock);
  if (r.issues.length) throw new ApiError(422, r.issues.join("；"));
  return r.versions;
}
export function evidenceRouter(access: Access, audit: Audit) {
  const r = Router();
  r.get("/documents", async (req, res) => {
    const proposalId = req.query.proposalId
      ? z.string().uuid().parse(req.query.proposalId)
      : null;
    if (proposalId) await access(req, proposalId);
    const docs = await rows(
      `SELECT d.*,v.id AS version_id,v.version,v.filename,v.sha256,v.status,v.allow_model,v.expires_on,v.parse_notes,v.created_by AS version_author FROM sp_documents d JOIN sp_document_versions v ON v.document_id=d.id WHERE ${proposalId ? "(d.proposal_id=? OR d.proposal_id IS NULL)" : "d.proposal_id IS NULL"} ORDER BY d.created_at DESC,v.version DESC`,
      proposalId ? [proposalId] : [],
    );
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    res.json(
      docs
        .filter(
          (d) =>
            (d.proposal_id ||
              d.status === "published" ||
              req.user.roles.some((role: string) =>
                ["admin", reviewRole(d.kind)].includes(role),
              )) &&
            (!q || `${d.title} ${d.filename}`.toLowerCase().includes(q)),
        )
        .map((d) => ({ ...d, parse_notes: parse(d.parse_notes) })),
    );
  });
  const upload = z.object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(documentKinds),
    proposalId: z.string().uuid().nullable().default(null),
    filename: z
      .string()
      .min(1)
      .max(240)
      .regex(/^[^/\\]+$/),
    base64: z.string().max(7000000),
    allowModel: z.boolean().default(false),
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    documentId: z.string().uuid().optional(),
    expectedVersion: z.number().int().positive().optional(),
  });
  r.post("/documents", async (req, res) => {
    const b = upload.parse(req.body);
    if (b.proposalId) {
      const p = await access(req, b.proposalId);
      requireRole(req, "engineer");
      if (p.owner_id !== req.user.id)
        throw new ApiError(403, "仅方案负责人可上传客户私有资料");
      if (!["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status))
        throw new ApiError(409, "请先撤回审核或开启新版本");
    } else requireRole(req, "admin");
    if (
      !b.base64 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        b.base64,
      )
    )
      throw new ApiError(422, "文件编码无效");
    const bytes = Buffer.from(b.base64, "base64");
    const result = await extract(b.filename, bytes);
    const id = b.documentId || randomUUID(),
      versionId = randomUUID();
    const file = await storage.put("documents", bytes);
    await tx(async (db) => {
      let version = 1;
      if (b.documentId) {
        const [d] = await rows(
          "SELECT * FROM sp_documents WHERE id=? FOR UPDATE",
          [id],
          db,
        );
        if (!d || d.proposal_id !== b.proposalId || d.kind !== b.kind)
          throw new ApiError(409, "文档类别或范围不匹配");
        const [v] = await rows(
          "SELECT MAX(version) AS n FROM sp_document_versions WHERE document_id=?",
          [id],
          db,
        );
        if (v.n !== b.expectedVersion)
          throw new ApiError(409, "文档已有新版本，请刷新");
        version = v.n + 1;
      } else
        await db.execute(
          "INSERT INTO sp_documents(id,title,kind,proposal_id,created_by) VALUES (?,?,?,?,?)",
          [id, b.title, b.kind, b.proposalId, req.user.id],
        );
      await db.execute(
        "INSERT INTO sp_document_versions(id,document_id,version,filename,sha256,storage_provider,storage_key,byte_size,text_content,parse_notes,allow_model,expires_on,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          versionId,
          id,
          version,
          b.filename,
          file.sha256,
          file.provider,
          file.key,
          file.size,
          result.text,
          JSON.stringify(result.notes),
          b.allowModel,
          b.expiresOn,
          req.user.id,
        ],
      );
      await audit(db, req, "document.uploaded", b.proposalId, {
        documentId: id,
        versionId,
        version,
      });
    });
    res.json({ id, versionId, notes: result.notes });
  });
  r.get("/documents/:id", async (req, res) => {
    const [d] = await rows(
      "SELECT d.*,v.*,d.id AS document_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?",
      [req.params.id],
    );
    if (!d) throw new ApiError(404, "资料不存在");
    await permitted(req, d, access, pool);
    const { storage_key, storage_provider, byte_size, ...safe } = d;
    res.json({ ...safe, parse_notes: parse(d.parse_notes) });
  });
  r.get("/documents/:id/download", async (req, res) => {
    const [d] = await rows(
      "SELECT d.*,v.*,d.id AS document_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?",
      [req.params.id],
    );
    if (!d) throw new ApiError(404, "资料不存在");
    await permitted(req, d, access, pool);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res
      .type("application/octet-stream")
      .attachment(d.filename)
      .send(await storedFile(d));
  });
  r.post("/documents/:id/review", async (req, res) => {
    const b = z
      .object({
        decision: z.enum(["publish", "withdraw"]),
        note: z.string().trim().min(4).max(2000),
      })
      .parse(req.body);
    await tx(async (db) => {
      const [d] = await rows(
        "SELECT d.*,v.*,d.id AS document_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=? FOR UPDATE",
        [req.params.id],
        db,
      );
      if (!d) throw new ApiError(404, "资料不存在");
      await permitted(req, d, access, db);
      if (b.decision === "publish") {
        requireRole(req, reviewRole(d.kind));
        if (d.kind !== "customer" && d.created_by === req.user.id)
          throw new ApiError(403, "专业资料须由另一位专业人员复核");
        if (d.status !== "draft") throw new ApiError(409, "仅草稿版本可以发布");
      } else {
        if (!req.user.roles.includes("admin"))
          requireRole(req, reviewRole(d.kind));
        if (d.status === "withdrawn") throw new ApiError(409, "此版本已撤回");
      }
      await db.execute(
        "UPDATE sp_document_versions SET status=?,reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP(3) WHERE id=?",
        [
          b.decision === "publish" ? "published" : "withdrawn",
          req.user.id,
          b.note,
          d.id,
        ],
      );
      await audit(db, req, "document." + b.decision, d.proposal_id, {
        versionId: d.id,
        note: b.note,
      });
      await projectSourceChanged(d.id,db);
    });
    res.json({ ok: true });
  });
  r.get("/proposals/:id/precheck", async (req, res) => {
    const p = await access(req, req.params.id);
    const result = await inspectEvidence(p);
    if(["DRAFT","CHANGES_REQUESTED","REJECTED"].includes(p.status))try{await projectApproval(p);}catch(e){if(!(e instanceof ApiError))throw e;result.issues.push(e.message);}
    const [assignment] = await rows(
      "SELECT * FROM sp_review_assignments WHERE owner_id=?",
      [p.owner_id],
    );
    res.json({ ...result, assignment: assignment || null });
  });
  return r;
}
