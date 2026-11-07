import { storage } from "../server/storage.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { pool, rows } from "../server/db.js";
import { passwordHash, hash } from "../server/security.js";
import { sections } from "../shared/workflow.js";
const marker = randomUUID(),
  userId = randomUUID(),
  outsider = randomUUID(),
  proposalId = randomUUID(),
  customerId = randomUUID(),
  documentId = randomUUID(),
  sourceId = randomUUID();
const text = "合成测试TDS，25℃条件下仅供软件流程测试，不构成实际产品建议。";
let app: ChildProcess | undefined,
  base = "",
  origin = "",
  cookie = "",
  csrf = "",
  otherCookie = "",
  otherCsrf = "",
  calls = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mock = createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const payload = JSON.parse(raw);
  const input = JSON.parse(payload.messages[1].content);
  assert.equal(req.headers.authorization, "Bearer synthetic-test-only");
  assert.equal(input.sources[0].versionId, sourceId);
  assert.equal(input.sources[0].text, text);
  assert.equal(input.templateInstruction, "合成模板约束");
  calls++;
  const send = () => {
    const candidate = {
      content: "合成章节候选，仅供软件验证；实际工况仍待确认。",
      citations: [
        {
          versionId: sourceId,
          quote:
            input.instruction === "bad_quote" ? "不存在于原文的内容" : text,
          start: 0,
        },
      ],
      gaps: ["缺少真实客户验证"],
    };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(candidate) },
          },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 34, total_tokens: 55 },
      }),
    );
  };
  if (input.instruction === "delay") {
    const t = setTimeout(() => {
      timers.delete(t);
      send();
    }, 15000);
    timers.add(t);
    res.on("close", () => {
      clearTimeout(t);
      timers.delete(t);
    });
  } else send();
});
async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as any).port;
}
async function api(path: string, method = "GET", body?: any, other = false) {
  return fetch(base + "/api" + path, {
    method,
    headers: {
      origin,
      cookie: other ? otherCookie : cookie,
      "x-csrf-token": other ? otherCsrf : csrf,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function ok(path: string, method = "GET", body?: any) {
  const r = await api(path, method, body);
  const d = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(d)}`);
  return d;
}
async function waitJob(id: string, statuses: string[]) {
  for (let n = 0; n < 120; n++) {
    try {
      const j = await ok(`/proposals/${proposalId}/jobs/${id}`);
      if (statuses.includes(j.status)) return j;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
    await sleep(100);
  }
  throw Error("等待任务超时");
}
async function create(instruction = "", requestKey = randomUUID()) {
  return ok(`/proposals/${proposalId}/jobs`, "POST", {
    requestKey,
    expectedRevision: revision,
    sectionIndex: 2,
    versionIds: [sourceId],
    instruction,
    consent: true,
  });
}
async function stopApp() {
  if (!app) return;
  const child = app;
  app = undefined;
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("验证服务未正常关闭"));
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
let revision = 1;
try {
  const [pending] = await rows(
    "SELECT COUNT(*) AS n FROM sp_jobs WHERE status IN ('queued','running')",
  );
  if (pending.n)
    throw new Error("存在业务AI任务，请先完成或取消后再运行隔离验证");
  const port = await listen(mock);
  const reservation = createServer();
  const appPort = await listen(reservation);
  await new Promise<void>((r) => reservation.close(() => r()));
  base = `http://127.0.0.1:${appPort}`;
  origin = base;
  app = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_ORIGIN: origin,
      MODEL_API_KEY: "synthetic-test-only",
      MODEL_BASE_URL: `http://127.0.0.1:${port}`,
      MODEL_ID: "synthetic-model",
      JOB_TIMEOUT_SECONDS: "30",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  app.stdout?.on("data", (b) => {
    logs += String(b);
  });
  app.stderr?.on("data", (b) => {
    logs += String(b);
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) break;
    } catch {}
    if (app.exitCode !== null) throw Error("验证服务无法启动：" + logs);
    await sleep(100);
  }
  const password = randomBytes(20).toString("hex");
  for (const id of [userId, outsider])
    await pool.execute(
      "INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",
      [
        id,
        `ai-${id}@example.test`,
        "AI合成验证账号",
        passwordHash(password),
        JSON.stringify(["engineer"]),
      ],
    );
  for (const id of [userId, outsider]) {
    const r = await api("/login", "POST", {
      email: `ai-${id}@example.test`,
      password,
    });
    assert.equal(r.status, 200);
    const data = await r.json(),
      c = r.headers.get("set-cookie")!.split(";")[0];
    if (id === userId) {
      cookie = c;
      csrf = data.csrf;
    } else {
      otherCookie = c;
      otherCsrf = data.csrf;
    }
  }
  for (let n = 0; n < 50; n++) {
    if ((await ok("/ai/config")).workerReady) break;
    await sleep(100);
  }
  assert.equal(
    (await ok("/ai/config")).workerReady,
    true,
    "须先停止其他AI Worker再运行隔离验证",
  );
  await pool.execute(
    "INSERT INTO sp_customers(id,name,industry,contact,owner_id) VALUES (?,?,?,?,?)",
    [customerId, "合成验证客户", "测试", "", userId],
  );
  const body = {
    template: { definition: { instruction: "合成模板约束" } },
    requirements: "合成客户需求，不含真实客户信息",
    productIds: [],
    sections: sections.map((title) => ({
      title,
      content: "保留的人工正文",
      evidence: "",
      citations: [],
    })),
  };
  await pool.execute(
    "INSERT INTO sp_proposals(id,code,title,customer_id,owner_id,created_by,scene,body) VALUES (?,?,?,?,?,?,?,?)",
    [
      proposalId,
      "AI-VERIFY-" + marker,
      "合成AI验证",
      customerId,
      userId,
      userId,
      "合成场景",
      JSON.stringify(body),
    ],
  );
  await pool.execute(
    "INSERT INTO sp_documents(id,title,kind,proposal_id,created_by) VALUES (?,?,?,?,?)",
    [documentId, "合成TDS", "tds", proposalId, userId],
  );
  const storedSource = await storage.put("documents", Buffer.from(text));
  await pool.execute(
    "INSERT INTO sp_document_versions(id,document_id,version,filename,sha256,storage_provider,storage_key,byte_size,text_content,parse_notes,status,allow_model,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      sourceId,
      documentId,
      1,
      "合成.txt",
      storedSource.sha256,
      storedSource.provider,
      storedSource.key,
      storedSource.size,
      text,
      "[]",
      "published",
      true,
      userId,
    ],
  );
  await pool.execute(
    "UPDATE sp_document_versions SET allow_model=0 WHERE id=?",
    [sourceId],
  );
  assert.equal(
    (
      await api(`/proposals/${proposalId}/jobs`, "POST", {
        requestKey: randomUUID(),
        expectedRevision: 1,
        sectionIndex: 2,
        versionIds: [sourceId],
        consent: true,
      })
    ).status,
    422,
  );
  assert.equal(calls, 0);
  await pool.execute(
    "UPDATE sp_document_versions SET allow_model=1 WHERE id=?",
    [sourceId],
  );
  const requestKey = randomUUID(),
    j = await create("", requestKey);
  assert.equal((await create("", requestKey)).id, j.id);
  assert.equal(
    (await api(`/proposals/${proposalId}/jobs/${j.id}`, "GET", undefined, true))
      .status,
    404,
  );
  const completed = await waitJob(j.id, ["completed", "failed"]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.usage.totalTokens, 55);
  assert.equal(
    (await ok("/proposals/" + proposalId)).body.sections[2].content,
    "保留的人工正文",
  );
  await ok(`/proposals/${proposalId}/jobs/${j.id}/apply`, "POST", {
    expectedRevision: 1,
  });
  revision = 2;
  let p = await ok("/proposals/" + proposalId);
  assert.equal(p.revision, 2);
  assert.match(p.body.sections[2].content, /合成章节/);
  assert.equal(p.body.sections[1].content, "保留的人工正文");
  assert.equal(
    (
      await api(`/proposals/${proposalId}/jobs/${j.id}/apply`, "POST", {
        expectedRevision: 2,
      })
    ).status,
    409,
  );
  const bad = await create("bad_quote");
  assert.equal(
    (await waitJob(bad.id, ["completed", "failed"])).status,
    "failed",
  );
  const stale = await create();
  await waitJob(stale.id, ["completed"]);
  await ok("/proposals/" + proposalId, "PUT", {
    expectedRevision: revision,
    body: p.body,
  });
  revision++;
  assert.equal(
    (
      await api(`/proposals/${proposalId}/jobs/${stale.id}/apply`, "POST", {
        expectedRevision: revision,
      })
    ).status,
    409,
  );
  const cancelled = await create("delay");
  await waitJob(cancelled.id, ["running"]);
  await ok(`/proposals/${proposalId}/jobs/${cancelled.id}/cancel`, "POST");
  assert.equal(
    (await waitJob(cancelled.id, ["cancelled"])).status,
    "cancelled",
  );
  const revoked = await create("delay");
  await waitJob(revoked.id, ["running"]);
  await pool.execute(
    "UPDATE sp_document_versions SET status='withdrawn' WHERE id=?",
    [sourceId],
  );
  assert.equal((await waitJob(revoked.id, ["failed"])).status, "failed");
  const old = await ok(`/proposals/${proposalId}/jobs/${stale.id}`);
  assert.equal(old.result, null);
  await pool.execute(
    "UPDATE sp_document_versions SET status='published' WHERE id=?",
    [sourceId],
  );
  const interrupted = await create("delay");
  await waitJob(interrupted.id, ["running"]);
  await stopApp();
  // 重启不会自动再次发送运行中的请求，避免模型重复计费。
  app = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_ORIGIN: origin,
      MODEL_API_KEY: "synthetic-test-only",
      MODEL_BASE_URL: `http://127.0.0.1:${port}`,
      MODEL_ID: "synthetic-model",
    },
    stdio: "ignore",
  });
  const before = calls;
  const recovered = await waitJob(interrupted.id, ["failed"]);
  assert.match(recovered.error, /重启/);
  await sleep(500);
  assert.equal(calls, before);
  console.log(
    "真实MySQL/HTTP及本地合成模型验证通过：外发许可、幂等、权限隔离、后台生成、引文校验、人工采用、旧候选保护、取消、撤回、重启不重复请求。",
  );
} finally {
  await stopApp();
  for (const t of timers) clearTimeout(t);
  mock.closeAllConnections();
  await new Promise<void>((r) => mock.close(() => r()));
  await pool.execute(
    "DELETE e FROM sp_job_events e JOIN sp_jobs j ON j.id=e.job_id WHERE j.proposal_id=?",
    [proposalId],
  );
  await pool.execute("DELETE FROM sp_jobs WHERE proposal_id=?", [proposalId]);
  await pool.execute("DELETE FROM sp_proposal_versions WHERE proposal_id=?", [
    proposalId,
  ]);
  await pool.execute("DELETE FROM sp_document_versions WHERE document_id=?", [
    documentId,
  ]);
  await pool.execute("DELETE FROM sp_documents WHERE id=?", [documentId]);
  await pool.execute("DELETE FROM sp_proposals WHERE id=?", [proposalId]);
  await pool.execute("DELETE FROM sp_customers WHERE id=?", [customerId]);
  for (const id of [userId, outsider]) {
    await pool.execute("DELETE FROM sp_audit_logs WHERE actor_id=?", [id]);
    await pool.execute("DELETE FROM sp_sessions WHERE user_id=?", [id]);
    await pool.execute("DELETE FROM sp_users WHERE id=?", [id]);
  }
  await pool.end();
  console.log("AI验证服务、临时账号及合成资料已清理");
}
