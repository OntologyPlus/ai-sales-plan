import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { pool, rows, parse } from "../server/db.js";
import { hash, passwordHash } from "../server/security.js";
import { sections } from "../shared/workflow.js";
const ids: string[] = [],
  templateIds: string[] = [],
  clients: any = {},
  marker = randomUUID();
let proposal = "",
  customer = "",
  batchId = "",
  riskId = "",
  revision = 1;
const base = "http://127.0.0.1:3200";
const ui = process.argv.includes("--ui");
async function request(c: any, path: string, method = "GET", body?: any) {
  return fetch(base + "/api" + path, {
    method,
    headers: {
      origin: base,
      cookie: c.cookie || "",
      "x-csrf-token": c.csrf || "",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function call(c: any, path: string, method = "GET", body?: any) {
  const r = await request(c, path, method, body);
  const d = await r.json();
  assert.ok(r.ok, `${path} ${r.status} ${JSON.stringify(d)}`);
  return d;
}
async function login(email: string, password: string) {
  const r = await request({}, "/login", "POST", { email, password });
  assert.equal(r.status, 200);
  const u = await r.json();
  return { ...u, cookie: r.headers.get("set-cookie")!.split(";")[0] };
}
async function get() {
  const p = await call(clients.engineer, "/proposals/" + proposal);
  revision = p.revision;
  return p;
}
async function save(body: any) {
  await call(clients.engineer, "/proposals/" + proposal, "PUT", {
    expectedRevision: revision,
    body,
  });
  return get();
}
try {
  clients.admin = await login(
    process.env.BOOTSTRAP_EMAIL || "admin@example.test",
    process.env.BOOTSTRAP_PASSWORD!,
  );
  for (const role of [
    "engineer",
    "chemist",
    "compliance",
    "leader",
    "outsider",
  ]) {
    const id = randomUUID(),
      email =
        ui && role === "engineer"
          ? "ui-verify@example.test"
          : `ops-${id}@example.test`,
      password =
        ui && role === "engineer"
          ? "Ui-temporary-check-2026!"
          : randomBytes(20).toString("hex");
    ids.push(id);
    await pool.execute(
      "INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",
      [
        id,
        email,
        "合成验证" + role,
        passwordHash(password),
        JSON.stringify([role === "outsider" ? "engineer" : role]),
      ],
    );
    clients[role] = { ...(await login(email, password)), id, password };
  }
  const e = clients.engineer,
    admin = clients.admin,
    assignments = {
      chemist: clients.chemist.id,
      compliance: clients.compliance.id,
      leader: clients.leader.id,
    };
  await call(admin, "/review-assignments/" + e.id, "PUT", {
    expectedRevision: 0,
    ...assignments,
  });
  customer = (
    await call(e, "/customers", "POST", {
      name: "合成待办验证客户",
      industry: "软件验证",
      contact: "",
    })
  ).id;
  proposal = (
    await call(e, "/proposals", "POST", {
      title: "合成五项功能验收方案",
      customerId: customer,
      scene: "合成场景",
    })
  ).id;
  const definition = {
    name: "合成行业模板" + marker.slice(0, 8),
    industry: "软件验证",
    instruction: "保留工况和验证限制，不编造参数。",
    sections: sections.map((title, i) => ({
      title,
      required: i !== 3,
      enabled: i !== 3,
    })),
  };
  assert.equal(
    (await request(e, "/templates", "POST", definition)).status,
    403,
  );
  const t1 = (await call(admin, "/templates", "POST", definition)).id;
  templateIds.push(t1);
  let templates = await call(admin, "/templates");
  const template = templates.find((t: any) => t.id === t1);
  const t2 = (
    await call(admin, "/templates", "POST", {
      ...definition,
      name: definition.name + "修订",
      familyId: template.family_id,
      expectedVersion: 1,
    })
  ).id;
  templateIds.push(t2);
  assert.equal(
    (
      await request(admin, "/templates", "POST", {
        ...definition,
        familyId: template.family_id,
        expectedVersion: 1,
      })
    ).status,
    409,
  );
  await call(e, `/proposals/${proposal}/template`, "POST", {
    templateId: t1,
    expectedRevision: 1,
  });
  let p = await get();
  assert.equal(p.revision, 2);
  assert.equal(p.body.sections[3].enabled, false);
  const history = await call(
    e,
    `/proposals/${proposal}/history/${p.versions[0].id}`,
  );
  assert.equal(history.snapshot.body.template, undefined);
  await call(admin, "/templates/" + t1 + "/status", "POST", { active: false });
  assert.equal((await get()).body.template.id, t1);
  assert.equal(
    (
      await request(e, `/proposals/${proposal}/template`, "POST", {
        templateId: t1,
        expectedRevision: revision,
      })
    ).status,
    422,
  );
  await call(e, `/proposals/${proposal}/template`, "POST", {
    templateId: t2,
    expectedRevision: revision,
  });
  await get();
  const docs: any = {};
  for (const kind of ["customer", "tds", "sds"]) {
    const text =
      kind === "customer"
        ? "客户要求强度不低于18 MPa。必须核对25℃铝基材条件。备注仅用于软件验证。"
        : "合成技术依据仅供软件测试，不构成实际产品建议。";
    const d = await call(e, "/documents", "POST", {
      title: "合成" + kind,
      kind,
      proposalId: proposal,
      filename: kind + ".txt",
      base64: Buffer.from(text).toString("base64"),
      allowModel: false,
    });
    docs[kind] = { ...d, text };
    await call(
      kind === "customer"
        ? e
        : clients[kind === "sds" ? "compliance" : "chemist"],
      "/documents/" + d.versionId + "/review",
      "POST",
      { decision: "publish", note: "复核合成资料，仅供软件验收" },
    );
  }
  batchId = (
    await call(e, `/proposals/${proposal}/requirement-batches`, "POST", {
      expectedRevision: revision,
      versionIds: [docs.customer.versionId],
    })
  ).id;
  assert.equal(
    (
      await request(
        clients.outsider,
        `/proposals/${proposal}/requirement-batches`,
      )
    ).status,
    404,
  );
  p = await get();
  p.body.requirements = "手工基线要求";
  await save(p.body);
  let batches = await call(e, `/proposals/${proposal}/requirement-batches`),
    batch = batches.find((b: any) => b.id === batchId);
  assert.equal(batch.candidates.length, 2);
  assert.equal(
    (
      await request(
        e,
        `/proposals/${proposal}/requirement-batches/${batchId}/apply`,
        "POST",
        {
          expectedRevision: revision,
          items: [{ id: batch.candidates[0].id, text: "客户已确认的强度需求" }],
        },
      )
    ).status,
    409,
  );
  batchId = (
    await call(e, `/proposals/${proposal}/requirement-batches`, "POST", {
      expectedRevision: revision,
      versionIds: [docs.customer.versionId],
    })
  ).id;
  batches = await call(e, `/proposals/${proposal}/requirement-batches`);
  batch = batches.find((b: any) => b.id === batchId);
  await call(
    e,
    `/proposals/${proposal}/requirement-batches/${batchId}/apply`,
    "POST",
    {
      expectedRevision: revision,
      items: [
        {
          id: batch.candidates[0].id,
          text: "客户确认强度阈值不低于18 MPa，工况待验证。",
        },
      ],
    },
  );
  p = await get();
  assert.match(p.body.requirements, /手工基线/);
  assert.equal(p.body.confirmedRequirements.length, 1);
  assert.equal(
    (
      await request(
        e,
        `/proposals/${proposal}/requirement-batches/${batchId}/apply`,
        "POST",
        {
          expectedRevision: revision,
          items: [{ id: batch.candidates[0].id, text: "重复" }],
        },
      )
    ).status,
    409,
  );
  await call(e, `/proposals/${proposal}/risks`, "POST", {
    title: "需要补充验证依据",
    ownerId: e.id,
    blocking: true,
  });
  let risks = await call(e, `/proposals/${proposal}/risks`);
  riskId = risks[0].id;
  assert.ok((await call(e, "/inbox")).risks.some((r: any) => r.id === riskId));
  assert.ok(
    (await call(e, `/proposals/${proposal}/precheck`)).issues.some(
      (s: string) => s.includes("未关闭"),
    ),
  );
  assert.equal(
    (
      await request(e, `/proposals/${proposal}/risks/${riskId}`, "POST", {
        action: "submit",
        expectedRevision: 1,
        note: "没有原文不能提交",
        citations: [],
      })
    ).status,
    422,
  );
  const citations = [
    { versionId: docs.tds.versionId, quote: docs.tds.text, start: 0 },
  ];
  await call(e, `/proposals/${proposal}/risks/${riskId}`, "POST", {
    action: "submit",
    expectedRevision: 1,
    note: "已补充合成技术资料待复核",
    citations,
  });
  assert.ok(
    (await call(clients.chemist, "/inbox")).riskReviews.some(
      (r: any) => r.id === riskId,
    ),
  );
  assert.equal(
    (
      await request(e, `/proposals/${proposal}/risks/${riskId}`, "POST", {
        action: "close",
        expectedRevision: 2,
        note: "自我关闭不允许",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        clients.chemist,
        `/proposals/${proposal}/risks/${riskId}`,
        "POST",
        { action: "close", expectedRevision: 1, note: "旧版本不允许关闭" },
      )
    ).status,
    409,
  );
  await call(
    clients.chemist,
    `/proposals/${proposal}/risks/${riskId}`,
    "POST",
    {
      action: "close",
      expectedRevision: 2,
      note: "独立复核原文，合成问题已关闭",
    },
  );
  p = await get();
  p.body.sections.forEach((s: any, i: number) => {
    if (s.enabled === false) return;
    s.content = "合成章节，不作为真实应用建议。";
    s.evidence = "人工核对后的合成依据";
    s.citations = [
      {
        versionId: docs[i === 5 ? "sds" : "tds"].versionId,
        quote: docs[i === 5 ? "sds" : "tds"].text,
        start: 0,
      },
    ];
  });
  await save(p.body);
  p = await get();
  assert.equal(p.body.template.id, t2);
  assert.equal(p.body.confirmedRequirements.length, 1);
  assert.deepEqual(
    (await call(e, `/proposals/${proposal}/precheck`)).issues,
    [],
  );
  await call(e, `/proposals/${proposal}/submit`, "POST", {
    expectedRevision: revision,
    note: "高优先级功能合成场景集成验收",
    assignments,
  });
  assert.equal(
    (await call(clients.chemist, "/inbox")).reviews.filter(
      (r: any) => r.id === proposal,
    ).length,
    1,
  );
  assert.equal((await call(clients.outsider, "/inbox")).reviews.length, 0);
  p = await get();
  for (const role of ["chemist", "compliance", "leader"]) {
    const step = p.requests[0].steps.find((s: any) => s.role === role);
    await call(clients[role], `/proposals/${proposal}/decide`, "POST", {
      stepId: step.id,
      decision: "approved",
      comment: "合成场景验证通过",
    });
  }
  p = await get();
  assert.equal(p.status, "APPROVED");
  const [snapshot] = await rows(
    "SELECT snapshot FROM sp_approval_requests WHERE id=?",
    [p.requests[0].id],
  );
  const snap = parse(snapshot.snapshot);
  assert.equal(snap.riskSnapshot[0].status, "closed");
  assert.equal(snap.body.confirmedRequirements.length, 1);
  assert.equal(snap.body.template.version, 2);
  await call(e, "/documents/" + docs.customer.versionId + "/review", "POST", {
    decision: "withdraw",
    note: "验证需求原件失效提醒",
  });
  assert.ok(
    (await call(e, "/inbox")).alerts
      .find((a: any) => a.id === proposal)
      .issues.some((s: string) => s.includes("需求来源失效")),
  );
  assert.equal(
    (await request(e, `/proposals/${proposal}/export.docx`)).status,
    422,
  );
  assert.equal(
    (
      await request(
        e,
        `/proposals/${proposal}/confirmed-requirements/remove`,
        "POST",
        {
          expectedRevision: revision,
          id: p.body.confirmedRequirements[0].id,
          note: "批准版不得直接撤销确认",
        },
      )
    ).status,
    409,
  );
  await call(e, `/proposals/${proposal}/new-version`, "POST");
  p = await get();
  await call(
    e,
    `/proposals/${proposal}/confirmed-requirements/remove`,
    "POST",
    {
      expectedRevision: revision,
      id: p.body.confirmedRequirements[0].id,
      note: "原客户资料已撤回，重新办理确认",
    },
  );
  p = await get();
  assert.equal(p.body.confirmedRequirements.length, 0);
  assert.match(p.body.requirements, /客户确认强度/);
  assert.equal(
    (
      await request(e, "/account/password", "POST", {
        currentPassword: "wrong",
        newPassword: randomBytes(20).toString("hex"),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        e,
        "/users/" + clients.outsider.id + "/reset-password",
        "POST",
        { newPassword: randomBytes(20).toString("hex") },
      )
    ).status,
    403,
  );
  const nextPassword = randomBytes(20).toString("hex");
  await call(
    admin,
    "/users/" + clients.outsider.id + "/reset-password",
    "POST",
    { newPassword: nextPassword },
  );
  assert.equal((await request(clients.outsider, "/me")).status, 401);
  const oldLogin = await request({}, "/login", "POST", {
    email: clients.outsider.email,
    password: clients.outsider.password,
  });
  assert.equal(oldLogin.status, 401);
  clients.outsider = {
    ...(await login(clients.outsider.email, nextPassword)),
    id: clients.outsider.id,
  };
  const selfPassword = randomBytes(20).toString("hex");
  await call(clients.outsider, "/account/password", "POST", {
    currentPassword: nextPassword,
    newPassword: selfPassword,
  });
  assert.equal((await request(clients.outsider, "/me")).status, 401);
  clients.outsider = {
    ...(await login(clients.outsider.email, selfPassword)),
    id: clients.outsider.id,
  };
  console.log(
    "五项真实MySQL/HTTP验证通过：模板版本/启停/快照、需求原文/确认/旧批次、个人待办/失效提醒、风险补证/独立复核/并发、密码修改/重置/撤销会话。",
  );
  if (ui) {
    console.log("工程师界面验证就绪，回车后清理");
    await new Promise<void>((r) => process.stdin.once("data", () => r()));
    process.stdin.pause();
  }
} finally {
  if (proposal) {
    await pool.execute(
      "DELETE e FROM sp_job_events e JOIN sp_jobs j ON j.id=e.job_id WHERE j.proposal_id=?",
      [proposal],
    );
    await pool.execute("DELETE FROM sp_jobs WHERE proposal_id=?", [proposal]);
    await pool.execute("DELETE FROM sp_exports WHERE proposal_id=?", [
      proposal,
    ]);
    await pool.execute(
      "DELETE a FROM sp_artifacts a JOIN sp_approval_requests r ON r.id=a.request_id WHERE r.proposal_id=?",
      [proposal],
    );
    await pool.execute(
      "DELETE s FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id WHERE r.proposal_id=?",
      [proposal],
    );
    await pool.execute("DELETE FROM sp_approval_requests WHERE proposal_id=?", [
      proposal,
    ]);
    await pool.execute("DELETE FROM sp_proposal_versions WHERE proposal_id=?", [
      proposal,
    ]);
    await pool.execute(
      "DELETE FROM sp_requirement_batches WHERE proposal_id=?",
      [proposal],
    );
    await pool.execute("DELETE FROM sp_risks WHERE proposal_id=?", [proposal]);
    await pool.execute(
      "DELETE v FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE d.proposal_id=?",
      [proposal],
    );
    await pool.execute("DELETE FROM sp_documents WHERE proposal_id=?", [
      proposal,
    ]);
    await pool.execute("DELETE FROM sp_proposals WHERE id=?", [proposal]);
  }
  if (customer)
    await pool.execute("DELETE FROM sp_customers WHERE id=?", [customer]);
  for (const id of templateIds) {
    await pool.execute("DELETE FROM sp_templates WHERE id=?", [id]);
    await pool.execute(
      "DELETE FROM sp_audit_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(details,'$.templateId'))=?",
      [id],
    );
  }
  if (clients.engineer) {
    await pool.execute("DELETE FROM sp_review_assignments WHERE owner_id=?", [
      clients.engineer.id,
    ]);
    await pool.execute(
      "DELETE FROM sp_audit_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(details,'$.ownerId'))=?",
      [clients.engineer.id],
    );
  }
  for (const id of ids) {
    await pool.execute(
      "DELETE FROM sp_audit_logs WHERE actor_id=? OR JSON_UNQUOTE(JSON_EXTRACT(details,'$.userId'))=?",
      [id, id],
    );
    await pool.execute("DELETE FROM sp_sessions WHERE user_id=?", [id]);
    await pool.execute("DELETE FROM sp_users WHERE id=?", [id]);
  }
  if (clients.admin)
    await pool.execute("DELETE FROM sp_sessions WHERE token_hash=?", [
      hash(clients.admin.cookie.slice(11)),
    ]);
  await pool.end();
  console.log("五项验收临时数据已清理");
}
