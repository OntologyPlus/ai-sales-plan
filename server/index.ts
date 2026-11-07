import express from "express";
import helmet from "helmet";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { z } from "zod";
import { pool, rows, tx, parse } from "./db.js";
import {
  ApiError,
  authenticate,
  requireRole,
  hash,
  passwordHash,
  passwordMatches,
} from "./security.js";
import {
  roles,
  sections,
  validateReviewers,
  mayDecide,
} from "../shared/workflow.js";
import { evidenceRouter, citationSchema, requireEvidence } from "./evidence.js";
import { jobsRouter, JobWorker } from "./jobs.js";
import { CompatibleModelRuntime } from "./model.js";
import {
  matchingRouter,
  requireMatching,
  requirementSchema,
} from "./matching.js";
import { deliveryRouter } from "./delivery.js";
import { intakeRouter, confirmedRequirementSchema } from "./intake.js";
import { operationsRouter } from "./operations.js";
import { pcbaApplicationRouter } from "./pcba-application.js";
import { workspaceRouter, WorkspaceWorker } from "./workspace.js";
import { projectRouter,projectApproval,projectReviewer,checkApprovedProject } from "./project.js";
const worker = new JobWorker(new CompatibleModelRuntime());
const workspaceWorker = new WorkspaceWorker();
const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "8mb" }));
const api = express.Router();
app.use("/api", api);
api.use((req, _res, next) => {
  _res.setHeader("Cache-Control", "no-store");
  if (
    !["GET", "HEAD"].includes(req.method) &&
    ![
      process.env.APP_ORIGIN || "http://127.0.0.1:3200",
      ...(process.env.NODE_ENV === "production"
        ? []
        : ["http://127.0.0.1:5173"]),
    ].includes(req.headers.origin || "")
  )
    return next(new ApiError(403, "请求来源不受信任"));
  next();
});
const attempts = new Map<string, { n: number; until: number }>();
api.post("/login", async (req, res) => {
  const b = z
    .object({ email: z.email(), password: z.string().min(1).max(200) })
    .parse(req.body);
  const ip = req.ip || "local";
  let a = attempts.get(ip);
  if (a && a.until < Date.now()) {
    attempts.delete(ip);
    a = undefined;
  }
  if (a && a.n >= 10) throw new ApiError(429, "登录尝试过多，请15分钟后重试");
  attempts.set(ip, {
    n: (a?.n || 0) + 1,
    until: a?.until || Date.now() + 900000,
  });
  const [u] = await rows("SELECT * FROM sp_users WHERE email=? AND active=1", [
    b.email,
  ]);
  if (!u || !passwordMatches(b.password, u.password_hash))
    throw new ApiError(401, "账号或密码错误");
  attempts.delete(ip);
  const token = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  await pool.execute(
    "INSERT INTO sp_sessions(token_hash,user_id,csrf,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR))",
    [hash(token), u.id, csrf],
  );
  res.setHeader(
    "Set-Cookie",
    `sp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    roles: parse(u.roles),
    csrf,
  });
});
api.use(authenticate);
api.get("/me", (req, res) => res.json({ ...req.user, csrf: req.csrf }));
api.post("/logout", async (req, res) => {
  await pool.execute("DELETE FROM sp_sessions WHERE token_hash=?", [
    req.sessionHash,
  ]);
  res.setHeader(
    "Set-Cookie",
    "sp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  res.json({ ok: true });
});
const audit = async (
  db: any,
  req: any,
  action: string,
  id: string | null,
  details: any = {},
) => {
  await db.execute(
    "INSERT INTO sp_audit_logs(actor_id,proposal_id,action,details) VALUES (?,?,?,?)",
    [req.user.id, id, action, JSON.stringify(details)],
  );
};
const serialize = (p: any) => ({ ...p, body: parse(p.body) });
async function access(
  req: express.Request,
  id: string,
  db: any = pool,
  lock = false,
) {
  const [p] = await rows(
    "SELECT * FROM sp_proposals WHERE id=?" + (lock ? " FOR UPDATE" : ""),
    [id],
    db,
  );
  if (!p) throw new ApiError(404, "方案不存在");
  if (p.owner_id !== req.user.id && !req.user.roles.includes("admin")) {
    const s = await rows(
      "SELECT s.id FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id WHERE r.proposal_id=? AND s.assignee_id=?",
      [id, req.user.id],
      db,
    );
    if (!s.length) {
      const assignments = await rows(
        "SELECT * FROM sp_review_assignments WHERE owner_id=?",
        [p.owner_id],
        db,
      );
      if (!await projectReviewer(req,p,db) &&
        !assignments.some((a) =>
          ["chemist", "compliance", "leader"].some(
            (role) =>
              a[role + "_id"] === req.user.id && req.user.roles.includes(role),
          ),
        )
      )
        throw new ApiError(404, "方案不存在或无访问权限");
    }
  }
  return serialize(p);
}
function editable(req: express.Request, p: any) {
  requireRole(req, "engineer");
  if (p.owner_id !== req.user.id) throw new ApiError(403, "仅负责人可修改");
  if (!["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(p.status))
    throw new ApiError(409, "当前版本不可修改，请撤回审核或开启新版本");
}
const bodySchema = z.object({
  requirements: z.string().max(20000),
  confirmedRequirements: z
    .array(confirmedRequirementSchema)
    .max(100)
    .default([]),
  productIds: z.array(z.string().uuid()).max(20),
  matchingRequirements: z.array(requirementSchema).max(30).default([]),
  productSpecs: z.record(z.string().uuid(), z.string().uuid()).default({}),
  sections: z
    .array(
      z.object({
        title: z.string().max(200),
        content: z.string().max(50000),
        evidence: z.string().max(20000),
        citations: z.array(citationSchema).max(30).default([]),
      }),
    )
    .length(6),
});
api.use(operationsRouter(access, audit));
api.use(intakeRouter(access, audit));
api.use(pcbaApplicationRouter(access, audit));
api.use(evidenceRouter(access, audit));
api.use(matchingRouter(access, audit));
api.use(deliveryRouter(access, audit));
api.use(jobsRouter(access, audit, worker));
api.use(workspaceRouter(access, audit, workspaceWorker));
api.use(projectRouter(access,audit));
api.get("/review-assignments", async (req, res) => {
  const all = await rows("SELECT * FROM sp_review_assignments");
  res.json(
    all.filter(
      (a) => req.user.roles.includes("admin") || a.owner_id === req.user.id,
    ),
  );
});
api.put("/review-assignments/:ownerId", async (req, res) => {
  requireRole(req, "admin");
  const b = z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      chemist: z.string().uuid(),
      compliance: z.string().uuid(),
      leader: z.string().uuid(),
    })
    .parse(req.body);
  await tx(async (db) => {
    const all = (
      await rows("SELECT id,roles,active FROM sp_users FOR UPDATE", [], db)
    ).map((u) => ({ ...u, roles: parse(u.roles) }));
    const owner = all.find((u) => u.id === req.params.ownerId);
    if (!owner?.active || !owner.roles.includes("engineer"))
      throw new ApiError(422, "请选择启用的工程师");
    try {
      validateReviewers(
        owner.id,
        owner.id,
        { chemist: b.chemist, compliance: b.compliance, leader: b.leader },
        all,
      );
    } catch (e: any) {
      throw new ApiError(422, e.message);
    }
    const [old] = await rows(
      "SELECT revision FROM sp_review_assignments WHERE owner_id=? FOR UPDATE",
      [owner.id],
      db,
    );
    if ((old?.revision || 0) !== b.expectedRevision)
      throw new ApiError(409, "审核配置已改变，请刷新");
    await db.execute(
      "INSERT INTO sp_review_assignments(owner_id,chemist_id,compliance_id,leader_id,revision) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE chemist_id=VALUES(chemist_id),compliance_id=VALUES(compliance_id),leader_id=VALUES(leader_id),revision=VALUES(revision)",
      [owner.id, b.chemist, b.compliance, b.leader, b.expectedRevision + 1],
    );
    await audit(db, req, "review_assignment.saved", null, {
      ownerId: owner.id,
    });
  });
  res.json({ ok: true });
});

api.get("/users", async (req, res) => {
  const u = await rows(
    "SELECT id,name,email,roles,active FROM sp_users ORDER BY created_at",
  );
  res.json(u.map((x) => ({ ...x, roles: parse(x.roles) })));
});
api.post("/users", async (req, res) => {
  requireRole(req, "admin");
  const b = z
    .object({
      email: z.email(),
      name: z.string().trim().min(1).max(80),
      password: z.string().min(12).max(200),
      roles: z.array(z.enum(roles)).min(1),
    })
    .parse(req.body);
  await tx(async (db) => {
    await db.execute(
      "INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",
      [
        randomUUID(),
        b.email,
        b.name,
        passwordHash(b.password),
        JSON.stringify([...new Set(b.roles)]),
      ],
    );
    await audit(db, req, "user.created", null, {
      email: b.email,
      roles: b.roles,
    });
  });
  res.json({ ok: true });
});
api.put("/users/:id", async (req, res) => {
  requireRole(req, "admin");
  const b = z
    .object({ roles: z.array(z.enum(roles)).min(1), active: z.boolean() })
    .parse(req.body);
  await tx(async (db) => {
    const all = await rows(
      "SELECT id,roles,active FROM sp_users FOR UPDATE",
      [],
      db,
    );
    const target = all.find((u) => u.id === req.params.id);
    if (!target) throw new ApiError(404, "账号不存在");
    if (
      (!b.active || !b.roles.includes("admin")) &&
      parse(target.roles).includes("admin") &&
      !all.some(
        (u) =>
          u.id !== target.id && u.active && parse(u.roles).includes("admin"),
      )
    )
      throw new ApiError(409, "必须保留至少一个启用的管理员");
    await db.execute("UPDATE sp_users SET roles=?,active=? WHERE id=?", [
      JSON.stringify([...new Set(b.roles)]),
      b.active,
      target.id,
    ]);
    if (!b.active)
      await db.execute("DELETE FROM sp_sessions WHERE user_id=?", [target.id]);
    await audit(db, req, "user.updated", null, {
      userId: target.id,
      roles: b.roles,
      active: b.active,
    });
  });
  res.json({ ok: true });
});
api.get("/customers", async (req, res) =>
  res.json(
    await rows(
      "SELECT * FROM sp_customers" +
        (req.user.roles.includes("admin") ? "" : " WHERE owner_id=?"),
      req.user.roles.includes("admin") ? [] : [req.user.id],
    ),
  ),
);
api.post("/customers", async (req, res) => {
  requireRole(req, "engineer");
  const b = z
    .object({
      name: z.string().trim().min(1).max(160),
      industry: z.string().max(100),
      contact: z.string().max(160),
    })
    .parse(req.body);
  const id = randomUUID();
  await tx(async (db) => {
    await db.execute(
      "INSERT INTO sp_customers(id,name,industry,contact,owner_id) VALUES (?,?,?,?,?)",
      [id, b.name, b.industry, b.contact, req.user.id],
    );
    await audit(db, req, "customer.created", null, { id });
  });
  res.json({ id });
});
api.get("/products", async (_req, res) =>
  res.json(await rows("SELECT * FROM sp_products ORDER BY code")),
);
api.post("/products", async (req, res) => {
  requireRole(req, "admin");
  const b = z
    .object({
      code: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(160),
      cas: z.string().max(80),
      description: z.string().max(20000),
    })
    .parse(req.body);
  await tx(async (db) => {
    const id = randomUUID();
    await db.execute(
      "INSERT INTO sp_products(id,code,name,cas,description) VALUES (?,?,?,?,?)",
      [id, b.code, b.name, b.cas, b.description],
    );
    await audit(db, req, "product.created", null, { id });
  });
  res.json({ ok: true });
});
api.get("/proposals", async (req, res) => {
  const admin = req.user.roles.includes("admin");
  const r = await rows(
    `SELECT p.id,p.code,p.title,p.scene,p.status,p.edition,p.revision,p.owner_id,p.updated_at,c.name AS customer_name,u.name AS owner_name FROM sp_proposals p JOIN sp_customers c ON c.id=p.customer_id JOIN sp_users u ON u.id=p.owner_id ${admin ? "" : "WHERE p.owner_id=? OR EXISTS(SELECT 1 FROM sp_approval_requests r JOIN sp_approval_steps s ON s.request_id=r.id WHERE r.proposal_id=p.id AND s.assignee_id=?) OR EXISTS(SELECT 1 FROM sp_review_assignments a WHERE a.owner_id=p.owner_id AND ((a.chemist_id=? AND ?=1) OR (a.compliance_id=? AND ?=1) OR (a.leader_id=? AND ?=1)))"} ORDER BY p.updated_at DESC`,
    admin
      ? []
      : [
          req.user.id,
          req.user.id,
          req.user.id,
          Number(req.user.roles.includes("chemist")),
          req.user.id,
          Number(req.user.roles.includes("compliance")),
          req.user.id,
          Number(req.user.roles.includes("leader")),
        ],
  );
  const extra=admin?[]:await rows("SELECT p.id,p.code,p.title,p.scene,p.status,p.edition,p.revision,p.owner_id,p.updated_at,c.name AS customer_name,u.name AS owner_name FROM sp_proposals p JOIN sp_customers c ON c.id=p.customer_id JOIN sp_users u ON u.id=p.owner_id JOIN sp_project_controls x ON x.proposal_id=p.id AND x.edition=p.edition WHERE (x.finance_id=? AND ?=1) OR (x.quality_id=? AND ?=1) OR (x.legal_id=? AND ?=1)",[req.user.id,Number(req.user.roles.includes("finance")),req.user.id,Number(req.user.roles.includes("quality")),req.user.id,Number(req.user.roles.includes("legal"))]);
  res.json([...new Map([...r,...extra].map(p=>[p.id,p])).values()]);
});
api.post("/proposals", async (req, res) => {
  requireRole(req, "engineer");
  const b = z
    .object({
      title: z.string().trim().min(1).max(160),
      customerId: z.string().uuid(),
      scene: z.string().trim().min(1).max(200),
    })
    .parse(req.body);
  const [c] = await rows(
    "SELECT id FROM sp_customers WHERE id=? AND owner_id=?",
    [b.customerId, req.user.id],
  );
  if (!c) throw new ApiError(403, "请选择本人负责的客户");
  const id = randomUUID();
  await tx(async (db) => {
    await db.execute(
      "INSERT INTO sp_proposals(id,code,title,customer_id,owner_id,created_by,scene,body) VALUES (?,?,?,?,?,?,?,?)",
      [
        id,
        "SP-" +
          new Date().toISOString().slice(0, 10).replaceAll("-", "") +
          "-" +
          randomBytes(3).toString("hex").toUpperCase(),
        b.title,
        b.customerId,
        req.user.id,
        req.user.id,
        b.scene,
        JSON.stringify({
          requirements: "",
          productIds: [],
          sections: sections.map((title) => ({
            title,
            content: "",
            evidence: "",
          })),
        }),
      ],
    );
    await audit(db, req, "proposal.created", id);
  });
  res.json({ id });
});
api.get("/proposals/:id", async (req, res) => {
  const p = await access(req, req.params.id);
  const requests = await rows(
    "SELECT * FROM sp_approval_requests WHERE proposal_id=? ORDER BY created_at DESC",
    [p.id],
  );
  const steps = await rows(
    "SELECT s.*,u.name AS assignee_name FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id JOIN sp_users u ON u.id=s.assignee_id WHERE r.proposal_id=?",
    [p.id],
  );
  const versions = await rows(
    "SELECT id,edition,revision,created_at FROM sp_proposal_versions WHERE proposal_id=? ORDER BY id DESC",
    [p.id],
  );
  res.json({
    ...p,
    requests: requests.map((x) => ({
      ...x,
      snapshot: undefined,
      steps: steps.filter((s) => s.request_id === x.id),
    })),
    versions,
  });
});
api.put("/proposals/:id", async (req, res) => {
  const b = z
    .object({ expectedRevision: z.number().int(), body: bodySchema })
    .parse(req.body);
  await tx(async (db) => {
    const p = await access(req, req.params.id, db, true);
    editable(req, p);
    if (p.revision !== b.expectedRevision)
      throw new ApiError(
        409,
        "内容已更新，请先重新载入并比较，本地输入未自动覆盖",
      );
    // Template definitions and confirmed provenance are server-owned snapshot fields.
    if (p.body.template) {
      b.body.sections.forEach((s: any, i: number) => {
        if (s.title !== p.body.sections[i].title)
          throw new ApiError(422, "模板标题须通过模板版本管理修改");
      });
    }
    const savedBody = {
      ...b.body,
      template: p.body.template,
      confirmedRequirements: p.body.confirmedRequirements || [],
      applicationProfileRevision: p.body.applicationProfileRevision,
      projectDependencies:p.body.projectDependencies||[],
      sections: b.body.sections.map((s: any, i: number) => ({
        ...s,
        required: p.body.sections[i].required ?? true,
        enabled: p.body.sections[i].enabled ?? true,
      })),
    };
    await db.execute(
      "INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
      [p.id, p.edition, p.revision, JSON.stringify(p), req.user.id],
    );
    await db.execute(
      "UPDATE sp_proposals SET body=?,revision=revision+1,status='DRAFT',updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [JSON.stringify(savedBody), p.id],
    );
    await audit(db, req, "proposal.saved", p.id, { revision: p.revision + 1 });
  });
  res.json({ ok: true });
});
api.get("/proposals/:id/history/:version", async (req, res) => {
  await access(req, req.params.id);
  const [v] = await rows(
    "SELECT * FROM sp_proposal_versions WHERE id=? AND proposal_id=?",
    [req.params.version, req.params.id],
  );
  if (!v) throw new ApiError(404, "版本不存在");
  res.json({ ...v, snapshot: parse(v.snapshot) });
});
api.post("/proposals/:id/submit", async (req, res) => {
  const b = z
    .object({
      expectedRevision: z.number().int(),
      note: z.string().trim().min(10).max(2000),
      assignments: z.object({
        chemist: z.string().uuid(),
        compliance: z.string().uuid(),
        leader: z.string().uuid(),
      }),
    })
    .parse(req.body);
  await tx(async (db) => {
    const p = await access(req, req.params.id, db, true);
    editable(req, p);
    if (p.revision !== b.expectedRevision)
      throw new ApiError(409, "版本已改变，请重新载入");
    if (
      !p.body.requirements.trim() ||
      p.body.sections.some(
        (s: any) =>
          s.enabled !== false &&
          (s.required !== false || s.content.trim()) &&
          (!s.content.trim() || (!s.evidence.trim() && !s.citations?.length)),
      )
    )
      throw new ApiError(422, "请填写需求及每章正文和依据，再提交审核");
    const [configured] = await rows(
      "SELECT * FROM sp_review_assignments WHERE owner_id=? FOR UPDATE",
      [p.owner_id],
      db,
    );
    if (
      configured &&
      ["chemist", "compliance", "leader"].some(
        (role) =>
          configured[role + "_id"] !==
          b.assignments[role as keyof typeof b.assignments],
      )
    )
      throw new ApiError(409, "请使用管理员配置的审核分工，刷新后重试");
    const users = (
      await rows("SELECT id,roles,active FROM sp_users", [], db)
    ).map((u) => ({ ...u, roles: parse(u.roles) }));
    try {
      validateReviewers(p.owner_id, p.created_by, b.assignments, users);
    } catch (e: any) {
      throw new ApiError(422, e.message);
    }
    const evidenceVersions = await requireEvidence(p, db, true);
    const riskSnapshot = await rows(
      "SELECT r.*,u.name AS owner_name FROM sp_risks r JOIN sp_users u ON u.id=r.owner_id WHERE r.proposal_id=?",
      [p.id],
      db,
    );
    const matchingSnapshot = await requireMatching(p, db, true);
    const project=await projectApproval(p,db);
    const allAssignments={...b.assignments,...project.assignments};
    if(new Set(Object.values(allAssignments)).size!==Object.keys(allAssignments).length)throw new ApiError(422,"技术、合规、财务、终审及必要专业节点须由不同人员办理");
    const [customer] = await rows(
      "SELECT name,industry FROM sp_customers WHERE id=?",
      [p.customer_id],
      db,
    );
    const id = randomUUID(),
      snapshot = JSON.stringify({
        ...p,
        evidenceVersions,
        riskSnapshot,
        matchingSnapshot,
        customer,
        projectSnapshot:project.snapshot,
        approvalPolicy:{version:2,requiredRoles:Object.keys(allAssignments)},
      });
    await db.execute(
      "INSERT INTO sp_approval_requests(id,proposal_id,edition,revision,snapshot,snapshot_hash,note) VALUES (?,?,?,?,?,?,?)",
      [id, p.id, p.edition, p.revision, snapshot, hash(snapshot), b.note],
    );
    for (const [role, assignee] of Object.entries(allAssignments))
      await db.execute(
        "INSERT INTO sp_approval_steps(id,request_id,role,assignee_id,status) VALUES (?,?,?,?,?)",
        [
          randomUUID(),
          id,
          role,
          assignee,
          ["leader","finance"].includes(role) ? "waiting" : "pending",
        ],
      );
    await db.execute("UPDATE sp_proposals SET status='IN_REVIEW' WHERE id=?", [
      p.id,
    ]);
    await audit(db, req, "approval.submitted", p.id, {
      requestId: id,
      hash: hash(snapshot),
    });
  });
  res.json({ ok: true });
});
api.post("/proposals/:id/withdraw", async (req, res) => {
  await tx(async (db) => {
    const p = await access(req, req.params.id, db, true);
    if (p.owner_id !== req.user.id || !req.user.roles.includes("engineer"))
      throw new ApiError(403, "仅负责人可撤回");
    if (p.status !== "IN_REVIEW") throw new ApiError(409, "当前无待审申请");
    const r = await rows(
      "SELECT id FROM sp_approval_requests WHERE proposal_id=? AND status='pending'",
      [p.id],
      db,
    );
    for (const a of r) {
      await db.execute(
        "UPDATE sp_approval_steps SET status='closed' WHERE request_id=? AND status IN ('waiting','pending')",
        [a.id],
      );
      await db.execute(
        "UPDATE sp_approval_requests SET status='withdrawn' WHERE id=?",
        [a.id],
      );
    }
    await db.execute("UPDATE sp_proposals SET status='DRAFT' WHERE id=?", [
      p.id,
    ]);
    await audit(db, req, "approval.withdrawn", p.id);
  });
  res.json({ ok: true });
});
api.post("/proposals/:id/decide", async (req, res) => {
  const b = z
    .object({
      stepId: z.string().uuid(),
      decision: z.enum(["approved", "changes_requested", "rejected"]),
      comment: z.string().trim().max(4000),
    })
    .parse(req.body);
  if (b.decision !== "approved" && !b.comment)
    throw new ApiError(422, "退回或驳回必须填写原因");
  await tx(async (db) => {
    const p = await access(req, req.params.id, db, true);
    const [s] = await rows(
      "SELECT s.*,r.status AS request_status,r.revision,r.edition FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id WHERE s.id=? AND r.proposal_id=? FOR UPDATE",
      [b.stepId, p.id],
      db,
    );
    if (!s || s.assignee_id !== req.user.id)
      throw new ApiError(403, "未分配此审核");
    requireRole(req, s.role);
    if ([p.owner_id, p.created_by].includes(req.user.id))
      throw new ApiError(403, "禁止自我审批");
    if (
      p.status !== "IN_REVIEW" ||
      s.status !== "pending" ||
      s.request_status !== "pending" ||
      s.revision !== p.revision ||
      s.edition !== p.edition
    )
      throw new ApiError(409, "审批已处理或版本已改变");
    if (b.decision === "approved") {
      await requireEvidence(p, db, true);
      const [approval]=await rows("SELECT snapshot FROM sp_approval_requests WHERE id=?",[s.request_id],db);
      await checkApprovedProject(parse(approval.snapshot),db);
    }
    const steps = await rows(
      "SELECT role,status FROM sp_approval_steps WHERE request_id=?",
      [s.request_id],
      db,
    );
    if (!mayDecide(steps, s.role))
      throw new ApiError(409, "技术及合规须先通过");
    await db.execute(
      "UPDATE sp_approval_steps SET status=?,comment=?,decided_at=UTC_TIMESTAMP(3) WHERE id=?",
      [b.decision, b.comment, s.id],
    );
    if (b.decision !== "approved") {
      await db.execute(
        "UPDATE sp_approval_steps SET status='closed' WHERE request_id=? AND status IN ('pending','waiting')",
        [s.request_id],
      );
      await db.execute("UPDATE sp_approval_requests SET status=? WHERE id=?", [
        b.decision,
        s.request_id,
      ]);
      await db.execute("UPDATE sp_proposals SET status=? WHERE id=?", [
        b.decision.toUpperCase(),
        p.id,
      ]);
    } else if (s.role === "leader") {
      await db.execute(
        "UPDATE sp_approval_requests SET status='approved' WHERE id=?",
        [s.request_id],
      );
      await db.execute("UPDATE sp_proposals SET status='APPROVED' WHERE id=?", [
        p.id,
      ]);
    } else {
      const next = await rows(
        "SELECT role,status FROM sp_approval_steps WHERE request_id=?",
        [s.request_id],
        db,
      );
      for(const role of ["finance","leader"])if(mayDecide(next,role))await db.execute("UPDATE sp_approval_steps SET status='pending' WHERE request_id=? AND role=? AND status='waiting'",[s.request_id,role]);
    }
    await audit(db, req, "approval." + b.decision, p.id, {
      stepId: s.id,
      role: s.role,
      comment: b.comment,
    });
  });
  res.json({ ok: true });
});
api.post("/proposals/:id/new-version", async (req, res) => {
  await tx(async (db) => {
    const p = await access(req, req.params.id, db, true);
    requireRole(req, "engineer");
    if (p.owner_id !== req.user.id || p.status !== "APPROVED")
      throw new ApiError(409, "仅负责人可基于批准版本开启新版");
    await db.execute(
      "INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
      [p.id, p.edition, p.revision, JSON.stringify(p), req.user.id],
    );
    await db.execute(
      "UPDATE sp_proposals SET edition=edition+1,revision=1,status='DRAFT',body=JSON_REMOVE(body,'$.applicationProfileRevision','$.projectDependencies') WHERE id=?",
      [p.id],
    );
    await audit(db, req, "proposal.new_version", p.id);
  });
  res.json({ ok: true });
});
api.get("/audit", async (req, res) => {
  requireRole(req, "admin");
  res.json(
    await rows(
      "SELECT a.*,u.name AS actor_name FROM sp_audit_logs a JOIN sp_users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200",
    ),
  );
});
api.use((_req, res) => {
  res.status(404).json({ error: "接口不存在" });
});
app.use(express.static(resolve("dist")));
if (existsSync("dist/index.html"))
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
app.use(
  (
    e: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (e instanceof ApiError)
      return void res.status(e.status).json({ error: e.message });
    if (e instanceof z.ZodError)
      return void res
        .status(400)
        .json({ error: "输入不符合要求", fields: e.issues });
    if (e.code === "ER_DUP_ENTRY")
      return void res.status(409).json({ error: "记录已存在，请勿重复操作" });
    console.error("API失败：", e.code || e.name);
    res.status(500).json({ error: "服务或数据库暂不可用" });
  },
);
const server = app.listen(
  Number(process.env.PORT || 3200),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log("售前方案平台 http://127.0.0.1:" + (process.env.PORT || 3200)),
);
if (process.env.WORKER_ENABLED !== "false") {
  void worker.start();
  void workspaceWorker.start();
}
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([worker.stop(), workspaceWorker.stop()]);
  server.close(() => {
    void pool.end();
  });
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
