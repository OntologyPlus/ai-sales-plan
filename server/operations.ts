import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rows, tx, parse } from "./db.js";
import {
  ApiError,
  passwordHash,
  passwordMatches,
  requireRole,
} from "./security.js";
import { templateDefinitionSchema } from "../shared/templates.js";
import { citationSchema } from "./contracts.js";
import { checkRiskEvidence } from "./risk-validation.js";
import { inspectEvidence } from "./evidence.js";
export function operationsRouter(access: any, audit: any) {
  const r = Router();
  r.post("/account/password", async (req, res) => {
    const b = z
      .object({
        currentPassword: z.string().max(200),
        newPassword: z.string().min(12).max(200),
      })
      .parse(req.body);
    await tx(async (db) => {
      const [u] = await rows(
        "SELECT password_hash FROM sp_users WHERE id=? FOR UPDATE",
        [req.user.id],
        db,
      );
      if (!passwordMatches(b.currentPassword, u.password_hash))
        throw new ApiError(403, "当前密码不正确");
      await db.execute("UPDATE sp_users SET password_hash=? WHERE id=?", [
        passwordHash(b.newPassword),
        req.user.id,
      ]);
      await db.execute("DELETE FROM sp_sessions WHERE user_id=?", [
        req.user.id,
      ]);
      await audit(db, req, "password.changed", null);
    });
    res.json({ ok: true });
  });
  r.post("/users/:id/reset-password", async (req, res) => {
    requireRole(req, "admin");
    const b = z
      .object({ newPassword: z.string().min(12).max(200) })
      .parse(req.body);
    await tx(async (db) => {
      const [u] = await rows(
        "SELECT id FROM sp_users WHERE id=? FOR UPDATE",
        [req.params.id],
        db,
      );
      if (!u) throw new ApiError(404, "账号不存在");
      await db.execute("UPDATE sp_users SET password_hash=? WHERE id=?", [
        passwordHash(b.newPassword),
        u.id,
      ]);
      await db.execute("DELETE FROM sp_sessions WHERE user_id=?", [u.id]);
      await audit(db, req, "password.reset", null, { userId: u.id });
    });
    res.json({ ok: true });
  });
  r.get("/inbox", async (req, res) => {
    const steps = await rows(
      "SELECT p.id,p.title,s.role,s.id AS step_id FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id JOIN sp_proposals p ON p.id=r.proposal_id WHERE s.assignee_id=? AND s.status='pending' AND r.status='pending'",
      [req.user.id],
    );
    const returned = await rows(
      "SELECT id,title,status FROM sp_proposals WHERE owner_id=? AND status IN ('CHANGES_REQUESTED','REJECTED')",
      [req.user.id],
    );
    const risks = await rows(
      "SELECT r.*,p.title AS proposal_title FROM sp_risks r JOIN sp_proposals p ON p.id=r.proposal_id WHERE r.status<>'closed' AND (r.owner_id=? OR p.owner_id=?)",
      [req.user.id, req.user.id],
    );
    const jobs = await rows(
      "SELECT j.id,j.proposal_id,j.status,j.error_message,p.title FROM sp_jobs j JOIN sp_proposals p ON p.id=j.proposal_id WHERE j.requested_by=? AND j.status IN ('completed','failed') AND j.applied_at IS NULL ORDER BY j.created_at DESC LIMIT 30",
      [req.user.id],
    );
    const candidates = await rows(
      `SELECT p.* FROM sp_proposals p WHERE p.status<>'ARCHIVED' AND (p.owner_id=? OR EXISTS(SELECT 1 FROM sp_approval_requests a JOIN sp_approval_steps s ON s.request_id=a.id WHERE a.proposal_id=p.id AND s.assignee_id=?) OR EXISTS(SELECT 1 FROM sp_review_assignments a WHERE a.owner_id=p.owner_id AND (a.chemist_id=? OR a.compliance_id=? OR a.leader_id=?))) ORDER BY p.updated_at DESC LIMIT 200`,
      Array(5).fill(req.user.id),
    );
    const alerts = [];
    for (const p of candidates) {
      try {
        await access(req, p.id);
        const check = await inspectEvidence({ ...p, body: parse(p.body) });
        if (check.issues.length)
          alerts.push({ id: p.id, title: p.title, issues: check.issues });
      } catch {}
    }
    const visibleRisks = [];
    for (const risk of risks) {
      try {
        await access(req, risk.proposal_id);
        visibleRisks.push({ ...risk, evidence: parse(risk.evidence) });
      } catch {}
    }
    const riskReviews = [];
    if (
      req.user.roles.some((x: string) => ["chemist", "compliance"].includes(x))
    )
      for (const p of candidates) {
        try {
          await access(req, p.id);
          const list = await rows(
            "SELECT * FROM sp_risks WHERE proposal_id=? AND status='submitted' AND owner_id<>?",
            [p.id, req.user.id],
          );
          if (p.owner_id !== req.user.id)
            riskReviews.push(
              ...list.map((r) => ({ ...r, proposal_title: p.title })),
            );
        } catch {}
      }
    const projectTasks=[];
    for(const r of await rows("SELECT r.id,r.proposal_id,r.data,p.title AS proposal_title FROM sp_project_records r JOIN sp_proposals p ON p.id=r.proposal_id AND p.edition=r.edition WHERE r.kind='task' AND JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.assigneeId'))=? AND JSON_EXTRACT(r.data,'$.done')=FALSE ORDER BY r.updated_at DESC LIMIT 100",[req.user.id])){try{await access(req,r.proposal_id);const data=parse(r.data);projectTasks.push({id:r.id,proposal_id:r.proposal_id,title:r.proposal_title+" · "+data.label,issues:[data.description,...(data.dueOn?["期限："+data.dueOn]:[])]});}catch(e){if(!(e instanceof ApiError))throw e;}}
    res.json({
      reviews: steps.filter((s) => req.user.roles.includes(s.role)),
      returned,
      risks: visibleRisks,
      riskReviews,
      alerts,
      jobs,
      projectTasks,
      checkedLimit: 200,
    });
  });
  r.get("/templates", async (_req, res) =>
    res.json(
      (await rows("SELECT * FROM sp_templates ORDER BY created_at DESC"))
        .filter((t) => t.active || _req.user.roles.includes("admin"))
        .map((t) => ({ ...t, definition: parse(t.definition) })),
    ),
  );
  r.post("/templates", async (req, res) => {
    requireRole(req, "admin");
    const b = templateDefinitionSchema.parse(req.body),
      id = randomUUID();
    await tx(async (db) => {
      let family = b.familyId || id,
        version = 1;
      if (b.familyId) {
        const all = await rows(
          "SELECT * FROM sp_templates WHERE family_id=? ORDER BY version DESC FOR UPDATE",
          [family],
          db,
        );
        if (!all.length || all[0].version !== b.expectedVersion)
          throw new ApiError(409, "模板已有新版或不存在，请刷新");
        version = all[0].version + 1;
      } else if (b.expectedVersion !== 0)
        throw new ApiError(422, "新模板应从首版开始");
      await db.execute(
        "INSERT INTO sp_templates(id,family_id,version,name,industry,definition,created_by) VALUES (?,?,?,?,?,?,?)",
        [
          id,
          family,
          version,
          b.name,
          b.industry,
          JSON.stringify(b),
          req.user.id,
        ],
      );
      await audit(db, req, "template.created", null, {
        templateId: id,
        familyId: family,
        version,
      });
    });
    res.json({ id });
  });
  r.post("/templates/:id/status", async (req, res) => {
    requireRole(req, "admin");
    const b = z.object({ active: z.boolean() }).parse(req.body);
    await tx(async (db) => {
      const [t] = await rows(
        "SELECT id FROM sp_templates WHERE id=? FOR UPDATE",
        [req.params.id],
        db,
      );
      if (!t) throw new ApiError(404, "模板不存在");
      await db.execute("UPDATE sp_templates SET active=? WHERE id=?", [
        b.active,
        req.params.id,
      ]);
      await audit(db, req, "template.status", null, {
        templateId: req.params.id,
        active: b.active,
      });
    });
    res.json({ ok: true });
  });
  r.post("/proposals/:id/template", async (req, res) => {
    const b = z
      .object({
        templateId: z.string().uuid(),
        expectedRevision: z.number().int(),
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
        throw new ApiError(409, "方案状态或修订已改变");
      const [t] = await rows(
        "SELECT * FROM sp_templates WHERE id=? AND active=1",
        [b.templateId],
        db,
      );
      if (!t) throw new ApiError(422, "模板已停用");
      const history = JSON.stringify(p);
      const body = p.body,
        d = parse(t.definition);
      if (body.sections.some((s: any) => s.content.trim()))
        throw new ApiError(409, "已有正文，不能直接替换模板");
      body.sections = d.sections.map((s: any) => ({
        ...s,
        content: "",
        evidence: "",
        citations: [],
      }));
      body.template = {
        id: t.id,
        familyId: t.family_id,
        version: t.version,
        name: t.name,
        definition: d,
      };
      await db.execute(
        "INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
        [p.id, p.edition, p.revision, history, req.user.id],
      );
      await db.execute(
        "UPDATE sp_proposals SET body=?,revision=revision+1 WHERE id=?",
        [JSON.stringify(body), p.id],
      );
      await audit(db, req, "template.applied", p.id, { templateId: t.id });
    });
    res.json({ ok: true });
  });
  r.get("/proposals/:id/risks", async (req, res) => {
    await access(req, req.params.id);
    res.json(
      await rows(
        "SELECT * FROM sp_risks WHERE proposal_id=? ORDER BY created_at DESC",
        [req.params.id],
      ),
    );
  });
  r.post("/proposals/:id/risks", async (req, res) => {
    const b = z
      .object({
        title: z.string().trim().min(1).max(200),
        ownerId: z.string().uuid(),
        blocking: z.boolean(),
      })
      .parse(req.body);
    await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      requireRole(req, "engineer");
      if (
        p.owner_id !== req.user.id ||
        !["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status)
      )
        throw new ApiError(409, "仅草稿负责人可登记风险");
      const [u] = await rows(
        "SELECT id FROM sp_users WHERE id=? AND active=1",
        [b.ownerId],
        db,
      );
      if (!u) throw new ApiError(422, "责任人未启用");
      try {
        await access(
          {
            ...req,
            user: {
              id: u.id,
              roles: parse(
                (
                  await rows(
                    "SELECT roles FROM sp_users WHERE id=?",
                    [u.id],
                    db,
                  )
                )[0].roles,
              ),
            },
          },
          p.id,
          db,
        );
      } catch {
        throw new ApiError(422, "责任人须具有本方案访问范围，请先配置审核分工");
      }
      await db.execute(
        "INSERT INTO sp_risks(id,proposal_id,title,owner_id,blocking) VALUES (?,?,?,?,?)",
        [randomUUID(), p.id, b.title, b.ownerId, b.blocking],
      );
      await audit(db, req, "risk.created", p.id, { title: b.title });
    });
    res.json({ ok: true });
  });
  r.post("/proposals/:id/risks/:riskId", async (req, res) => {
    const b = z
      .object({
        action: z.enum(["submit", "close", "reopen"]),
        expectedRevision: z.number().int().positive(),
        citations: z.array(citationSchema).max(20).default([]),
        note: z.string().trim().min(4).max(4000),
      })
      .parse(req.body);
    await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      const [risk] = await rows(
        "SELECT * FROM sp_risks WHERE id=? AND proposal_id=? FOR UPDATE",
        [req.params.riskId, p.id],
        db,
      );
      if (!risk) throw new ApiError(404, "风险不存在");
      if (!["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status))
        throw new ApiError(409, "请先撤回审批或开启新版本");
      if (risk.revision !== b.expectedRevision)
        throw new ApiError(409, "风险已更新，请刷新比较");
      if (b.action === "submit") {
        if (!["open", "submitted"].includes(risk.status))
          throw new ApiError(409, "关闭风险请先由专业人员重新打开");
        if (!b.citations.length)
          throw new ApiError(422, "补证须绑定有效资料原文");
        await checkRiskEvidence(b.citations, p.id, db);
        if (req.user.id !== risk.owner_id && req.user.id !== p.owner_id)
          throw new ApiError(403, "仅责任人或方案负责人可补证");
      } else {
        if (
          !req.user.roles.some((x: string) =>
            ["chemist", "compliance"].includes(x),
          ) ||
          req.user.id === risk.owner_id ||
          req.user.id === p.owner_id
        )
          throw new ApiError(403, "需独立专业人员复核");
        if (b.action === "close")
          await checkRiskEvidence(parse(risk.evidence) || [], p.id, db);
        if (b.action === "reopen" && risk.status === "open")
          throw new ApiError(409, "风险已经打开");
        if (b.action === "close" && risk.status !== "submitted")
          throw new ApiError(409, "请先提交补证");
      }
      await db.execute(
        "UPDATE sp_risks SET status=?,note=?,evidence=?,revision=revision+1 WHERE id=?",
        [
          b.action === "submit"
            ? "submitted"
            : b.action === "close"
              ? "closed"
              : "open",
          b.note,
          JSON.stringify(
            b.action === "submit" ? b.citations : parse(risk.evidence) || [],
          ),
          risk.id,
        ],
      );
      await audit(db, req, "risk." + b.action, p.id, {
        riskId: risk.id,
        note: b.note,
        evidence:
          b.action === "submit" ? b.citations : parse(risk.evidence) || [],
        revision: risk.revision + 1,
      });
    });
    res.json({ ok: true });
  });
  return r;
}
