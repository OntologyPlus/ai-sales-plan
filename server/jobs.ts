import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, rows, tx, parse } from "./db.js";
import { ApiError, requireRole, hash } from "./security.js";
import { editableStatus, parseCandidate, type AiInput } from "../shared/ai.js";
import { kindSatisfies } from "../shared/evidence.js";
import {
  modelReady,
  modelConfig,
  providerFingerprint,
  type ModelRuntime,
} from "./model.js";
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
export async function event(
  db: any,
  id: string,
  type: string,
  payload: any = {},
) {
  await db.execute(
    "INSERT INTO sp_job_events(job_id,type,payload) VALUES (?,?,?)",
    [id, type, JSON.stringify(payload)],
  );
}
function assertOwner(req: Request, p: any) {
  requireRole(req, "engineer");
  if (p.owner_id !== req.user.id)
    throw new ApiError(403, "仅方案负责人可执行AI编制");
  if (!editableStatus(p.status))
    throw new ApiError(409, "方案正在审核或已批准，不能生成或采用候选");
}
export async function loadAiSource(
  id: string,
  proposalId: string,
  db: any = pool,
  lock = false,
) {
  const [v] = await rows(
    "SELECT v.id,v.version,v.sha256,v.text_content,v.status,v.allow_model,v.expires_on,d.proposal_id,d.title,d.kind FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?" +
      (lock ? " FOR UPDATE" : ""),
    [id],
    db,
  );
  if (!v || (v.proposal_id && v.proposal_id !== proposalId))
    throw new ApiError(422, "所选资料不属于当前授权范围");
  if (v.status !== "published" || !v.allow_model)
    throw new ApiError(422, "所选资料尚未发布、已撤回或未许可模型使用");
  const date =
    v.expires_on instanceof Date
      ? v.expires_on.toISOString().slice(0, 10)
      : v.expires_on;
  if (
    date &&
    String(date).slice(0, 10) <
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
        new Date(),
      )
  )
    throw new ApiError(422, "所选资料已过期");
  return v;
}
export async function authorizeJob(job: any, db: any = pool, lock = false) {
  const input: AiInput = parse(job.input_snapshot);
  const [p] = await rows(
    "SELECT * FROM sp_proposals WHERE id=?" + (lock ? " FOR UPDATE" : ""),
    [job.proposal_id],
    db,
  );
  const [u] = await rows(
    "SELECT active,roles FROM sp_users WHERE id=?",
    [job.requested_by],
    db,
  );
  if (
    !p ||
    !u?.active ||
    !parse(u.roles).includes("engineer") ||
    p.owner_id !== job.requested_by ||
    !editableStatus(p.status)
  )
    throw new ApiError(409, "负责人权限或方案状态已改变");
  if (p.edition !== input.edition || p.revision !== input.revision)
    throw new ApiError(409, "方案已修订，旧任务或候选失效，请重新生成");
  for (const s of input.sources) {
    const v = await loadAiSource(s.id, p.id, db, lock);
    if (v.sha256 !== s.sha256) throw new ApiError(409, "证据版本指纹已改变");
  }
  return { ...p, body: parse(p.body) };
}
export function jobsRouter(access: Access, audit: Audit, worker: JobWorker) {
  const r = Router();
  r.get("/ai/config", (_req, res) =>
    res.json({
      configured: modelReady(),
      workerReady: worker.ready,
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      sourceCharLimit: 12000,
      totalCharLimit: 60000,
      maxSources: 8,
      timeoutSeconds: modelConfig.timeoutSeconds,
    }),
  );
  r.get("/proposals/:id/jobs", async (req, res) => {
    await access(req, req.params.id);
    const jobs = await rows(
      "SELECT id,status,error_message,created_at,started_at,finished_at,applied_at,usage_json,input_snapshot,requested_by FROM sp_jobs WHERE proposal_id=? ORDER BY created_at DESC LIMIT 30",
      [req.params.id],
    );
    res.json(
      jobs.map((j) => {
        const input = parse(j.input_snapshot);
        return {
          id: j.id,
          status: j.applied_at ? "applied" : j.status,
          error: j.error_message,
          createdAt: j.created_at,
          sectionIndex: input.sectionIndex,
          sectionTitle: input.sectionTitle,
          revision: input.revision,
          edition: input.edition,
          usage: parse(j.usage_json),
          requestedBy: j.requested_by,
        };
      }),
    );
  });
  r.post("/proposals/:id/jobs", async (req, res) => {
    const b = z
      .object({
        requestKey: z.string().uuid(),
        expectedRevision: z.number().int(),
        sectionIndex: z.number().int().min(0).max(5),
        versionIds: z.array(z.string().uuid()).min(1).max(8),
        instruction: z.string().max(2000).default(""),
        consent: z.literal(true),
      })
      .parse(req.body);
    const requestHash = hash(JSON.stringify(b));
    const id = await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      assertOwner(req, p);
      const [existing] = await rows(
        "SELECT id,request_hash,requested_by FROM sp_jobs WHERE proposal_id=? AND request_key=?",
        [p.id, b.requestKey],
        db,
      );
      if (existing) {
        if (
          existing.request_hash !== requestHash ||
          existing.requested_by !== req.user.id
        )
          throw new ApiError(409, "幂等键已用于不同请求");
        return existing.id;
      }
      if (!modelReady()) throw new ApiError(503, "模型密钥尚未配置，AI未启用");
      if (!worker.ready)
        throw new ApiError(503, "后台任务服务未就绪，请稍后重试");
      if (p.revision !== b.expectedRevision)
        throw new ApiError(409, "请刷新最新修订后生成");
      if (p.body.sections[b.sectionIndex].enabled === false)
        throw new ApiError(422, "该章节已由模板停用");
      if (!p.body.requirements.trim())
        throw new ApiError(422, "请先保存已确认的需求");
      const sources = [];
      for (const versionId of [...new Set(b.versionIds)].sort()) {
        const v = await loadAiSource(versionId, p.id, db, true);
        sources.push({
          id: v.id,
          title: v.title,
          kind: v.kind,
          sha256: v.sha256,
          text: v.text_content.slice(0, 12000),
          totalChars: v.text_content.length,
        });
      }
      if (sources.reduce((n, s) => n + s.text.length, 0) > 60000)
        throw new ApiError(422, "选中资料片段超过6万字符，请减少文档");
      if (
        !kindSatisfies(
          b.sectionIndex,
          sources.map((s) => s.kind),
        )
      )
        throw new ApiError(422, "请选择该章节必需的技术或合规资料");
      const [count] = await rows(
        "SELECT COUNT(*) AS n FROM sp_jobs WHERE requested_by=? AND status IN ('queued','running')",
        [req.user.id],
        db,
      );
      if (count.n >= 3)
        throw new ApiError(429, "最多保留3个待执行任务，请完成或取消后重试");
      const input: AiInput = {
        proposalId: p.id,
        edition: p.edition,
        revision: p.revision,
        sectionIndex: b.sectionIndex,
        sectionTitle: p.body.sections[b.sectionIndex].title,
        scene: p.scene,
        requirements: p.body.requirements,
        instruction: b.instruction,
        templateInstruction: p.body.template?.definition?.instruction || "",
        sources,
        provider: providerFingerprint(),
        model: modelConfig.model,
      };
      const id = randomUUID();
      await db.execute(
        "INSERT INTO sp_jobs(id,proposal_id,requested_by,request_key,request_hash,input_snapshot) VALUES (?,?,?,?,?,?)",
        [
          id,
          p.id,
          req.user.id,
          b.requestKey,
          requestHash,
          JSON.stringify(input),
        ],
      );
      await event(db, id, "queued", {
        sectionIndex: b.sectionIndex,
        sourceCount: sources.length,
      });
      await audit(db, req, "ai.queued", p.id, {
        jobId: id,
        revision: p.revision,
        sourceIds: sources.map((s) => s.id),
        model: modelConfig.model,
      });
      return id;
    });
    res.json({ id });
  });
  r.get("/proposals/:id/jobs/:jobId", async (req, res) => {
    await access(req, req.params.id);
    const [j] = await rows(
      "SELECT * FROM sp_jobs WHERE id=? AND proposal_id=?",
      [req.params.jobId, req.params.id],
    );
    if (!j) throw new ApiError(404, "任务不存在");
    let stale = "";
    try {
      await authorizeJob(j);
    } catch (e: any) {
      stale = e instanceof ApiError ? e.message : "无法核验当前依据";
    }
    const input = parse(j.input_snapshot);
    res.json({
      id: j.id,
      status: j.applied_at ? "applied" : j.status,
      sectionTitle: input.sectionTitle,
      edition: input.edition,
      revision: input.revision,
      stale,
      result: !stale ? parse(j.result_json) : null,
      error: j.error_message,
      usage: parse(j.usage_json),
      sources: input.sources.map((s: any) => ({
        id: s.id,
        title: s.title,
        readChars: s.text.length,
        totalChars: s.totalChars,
      })),
      events: (
        await rows(
          "SELECT id,type,payload,created_at FROM sp_job_events WHERE job_id=? ORDER BY id",
          [j.id],
        )
      ).map((e) => ({ ...e, payload: parse(e.payload) })),
    });
  });
  r.post("/proposals/:id/jobs/:jobId/cancel", async (req, res) => {
    await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      requireRole(req, "engineer");
      if (p.owner_id !== req.user.id)
        throw new ApiError(403, "仅负责人可取消任务");
      const [j] = await rows(
        "SELECT * FROM sp_jobs WHERE id=? AND proposal_id=? FOR UPDATE",
        [req.params.jobId, p.id],
        db,
      );
      if (!j) throw new ApiError(404, "任务不存在");
      if (!["queued", "running"].includes(j.status))
        throw new ApiError(409, "任务已结束");
      await db.execute(
        "UPDATE sp_jobs SET cancel_requested=1,status='cancelled',finished_at=UTC_TIMESTAMP(3) WHERE id=?",
        [j.id],
      );
      await event(db, j.id, "cancelled");
      await audit(db, req, "ai.cancelled", p.id, { jobId: j.id });
    });
    worker.cancel(req.params.jobId);
    res.json({ ok: true });
  });
  r.post("/proposals/:id/jobs/:jobId/apply", async (req, res) => {
    const b = z.object({ expectedRevision: z.number().int() }).parse(req.body);
    await tx(async (db) => {
      const p = await access(req, req.params.id, db, true);
      assertOwner(req, p);
      const [j] = await rows(
        "SELECT * FROM sp_jobs WHERE id=? AND proposal_id=? FOR UPDATE",
        [req.params.jobId, p.id],
        db,
      );
      if (!j) throw new ApiError(404, "任务不存在");
      if (j.requested_by !== req.user.id)
        throw new ApiError(403, "只能采用本人发起的候选");
      if (j.applied_at) throw new ApiError(409, "此候选已经采用");
      if (j.status !== "completed" || j.cancel_requested || !j.result_json)
        throw new ApiError(409, "任务没有可采用结果");
      if (p.revision !== b.expectedRevision)
        throw new ApiError(409, "正文已更新，请保留本地输入并刷新比较");
      await authorizeJob(j, db, true);
      const input: AiInput = parse(j.input_snapshot);
      const candidate = parseCandidate(
        JSON.stringify(parse(j.result_json)),
        input,
      );
      await db.execute(
        "INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",
        [p.id, p.edition, p.revision, JSON.stringify(p), req.user.id],
      );
      p.body.sections[input.sectionIndex] = {
        ...p.body.sections[input.sectionIndex],
        content: candidate.content,
        citations: candidate.citations,
        evidence: candidate.gaps.length
          ? "待补证：" + candidate.gaps.join("；")
          : "",
      };
      await db.execute(
        "UPDATE sp_proposals SET body=?,revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [JSON.stringify(p.body), p.id],
      );
      await db.execute(
        "UPDATE sp_jobs SET applied_at=UTC_TIMESTAMP(3) WHERE id=?",
        [j.id],
      );
      await event(db, j.id, "applied", { revision: p.revision + 1 });
      await audit(db, req, "ai.applied", p.id, {
        jobId: j.id,
        sectionIndex: input.sectionIndex,
        revision: p.revision + 1,
      });
    });
    res.json({ ok: true });
  });
  return r;
}
export class JobWorker {
  ready = false;
  private owner: any;
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  private busy = false;
  private stopping = false;
  private lockName = "sales_plan_ai_worker_v1";
  private tasks = new Set<Promise<void>>();
  private stopPromise?: Promise<void>;
  constructor(private runtime: ModelRuntime) {}
  async start() {
    try {
      this.owner = await pool.getConnection();
      const [r]: any = await this.owner.execute(
        "SELECT GET_LOCK(?,0) AS acquired",
        [this.lockName],
      );
      if (Number(r[0].acquired) !== 1) {
        this.owner.release();
        this.owner = undefined;
        return;
      }
      await this.owner.execute(
        "UPDATE sp_jobs SET status='failed',error_message='服务重启中断了生成；为避免重复计费，请核对后手动重新生成',finished_at=UTC_TIMESTAMP(3) WHERE status='running'",
      );
      this.ready = true;
      this.timer = setInterval(() => {
        void this.tick();
      }, 1000);
      void this.tick();
    } catch {
      this.ready = false;
      await this.release();
      console.error("AI后台服务未就绪，请核对迁移与数据库连接");
    }
  }
  private async release() {
    const connection = this.owner;
    this.owner = undefined;
    if (!connection) return;
    try {
      await connection.execute("SELECT RELEASE_LOCK(?)", [this.lockName]);
    } catch {
    } finally {
      connection.release();
    }
  }
  cancel(id: string) {
    this.active.get(id)?.abort();
  }
  private async tick() {
    if (this.busy || this.stopping || !this.ready) return;
    this.busy = true;
    try {
      const [r]: any = await this.owner.execute(
        "SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS owned",
        [this.lockName],
      );
      if (!r[0].owned) throw new Error("lock lost");
      for (const [id, c] of this.active) {
        const [j] = await rows("SELECT * FROM sp_jobs WHERE id=?", [id]);
        if (!j || j.cancel_requested) {
          c.abort();
          continue;
        }
        try {
          await authorizeJob(j);
        } catch {
          c.abort();
        }
      }
      if (this.active.size || this.stopping || !this.ready) return;
      const [j] = await rows(
        "SELECT * FROM sp_jobs WHERE status='queued' ORDER BY created_at LIMIT 1",
      );
      if (!j || this.stopping || !this.ready) return;
      const [u]: any = await pool.execute(
        "UPDATE sp_jobs SET status='running',started_at=UTC_TIMESTAMP(3) WHERE id=? AND status='queued'",
        [j.id],
      );
      if (!u.affectedRows) return;
      const c = new AbortController();
      this.active.set(j.id, c);
      const task = this.execute(j, c).finally(() => {
        this.active.delete(j.id);
        this.tasks.delete(task);
      });
      this.tasks.add(task);
    } catch {
      this.ready = false;
      for (const c of this.active.values()) c.abort();
      console.error("AI调度暂停：数据库连接或任务所有权异常");
    } finally {
      this.busy = false;
    }
  }
  private async execute(job: any, c: AbortController) {
    const timeout =
      Math.min(3600, Math.max(10, modelConfig.timeoutSeconds || 600)) * 1000;
    const timer = setTimeout(() => c.abort(), timeout);
    try {
      await authorizeJob(job);
      const input: AiInput = parse(job.input_snapshot);
      if (
        input.provider !== providerFingerprint() ||
        input.model !== modelConfig.model
      )
        throw new ApiError(409, "模型配置已改变，请重新发起任务");
      if (this.stopping || !this.ready || c.signal.aborted)
        throw new ApiError(409, "后台执行已停止");
      await event(pool, job.id, "started", { model: input.model });
      if (this.stopping || !this.ready || c.signal.aborted)
        throw new ApiError(409, "后台执行已停止");
      const result = await this.runtime.generate(input, c.signal);
      if (c.signal.aborted)
        throw new ApiError(409, "任务已取消、授权变化或执行超时");
      const candidate = parseCandidate(JSON.stringify(result.candidate), input);
      await tx(async (db) => {
        await authorizeJob(job, db, true);
        const [j] = await rows(
          "SELECT status,cancel_requested FROM sp_jobs WHERE id=? FOR UPDATE",
          [job.id],
          db,
        );
        if (
          j.status !== "running" ||
          j.cancel_requested ||
          this.stopping ||
          !this.ready
        )
          throw new ApiError(409, "任务已停止");
        await db.execute(
          "UPDATE sp_jobs SET status='completed',result_json=?,usage_json=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",
          [JSON.stringify(candidate), JSON.stringify(result.usage), job.id],
        );
        await event(db, job.id, "completed", { gaps: candidate.gaps.length });
      });
    } catch (e: any) {
      if (!this.stopping) {
        try {
          await tx(async (db) => {
            const [j] = await rows(
              "SELECT status FROM sp_jobs WHERE id=? FOR UPDATE",
              [job.id],
              db,
            );
            if (j?.status !== "running") return;
            const message =
              e instanceof ApiError
                ? e.message
                : c.signal.aborted
                  ? "生成已停止：取消、超时或授权发生变化"
                  : "模型调用或结构化引用校验失败，请检查服务与资料后重试";
            await db.execute(
              "UPDATE sp_jobs SET status='failed',error_message=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",
              [message, job.id],
            );
            await event(db, job.id, "failed", { message });
          });
        } catch {
          console.error("AI任务状态保存失败，等待重启核对");
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  stop() {
    if (!this.stopPromise) this.stopPromise = this.doStop();
    return this.stopPromise;
  }
  private async doStop() {
    this.stopping = true;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
    for (const c of this.active.values()) c.abort();
    await Promise.allSettled(this.tasks);
    await this.release();
  }
}
