import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { pool, rows } from "../server/db.js";
import { passwordHash } from "../server/security.js";
const marker = randomUUID(),
  ids: string[] = [],
  clients: any = {};
let proposal = "",
  customer = "";
let productId = "",
  specId = "",
  sharedDocId = "",
  sharedSourceId = "";
async function request(client: any, path: string, method = "GET", body?: any) {
  const r = await fetch("http://127.0.0.1:3200/api" + path, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      cookie: client.cookie || "",
      "x-csrf-token": client.csrf || "",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r;
}
async function call(client: any, path: string, method = "GET", body?: any) {
  const r = await request(client, path, method, body);
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
try {
  for (const role of [
    "engineer",
    "chemist",
    "compliance",
    "leader",
    "outsider",
  ]) {
    const id = randomUUID(),
      password =
        process.argv.includes("--ui") && role === "engineer"
          ? "Ui-temporary-check-2026!"
          : randomBytes(20).toString("hex"),
      email =
        process.argv.includes("--ui") && role === "engineer"
          ? "ui-verify@example.test"
          : `verify-${role}-${marker}@example.test`;
    ids.push(id);
    await pool.execute(
      "INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",
      [
        id,
        email,
        "验证临时账号",
        passwordHash(password),
        JSON.stringify([role === "outsider" ? "engineer" : role]),
      ],
    );
    const r = await request({}, "/login", "POST", { email, password });
    assert.equal(r.status, 200);
    const u = await r.json();
    clients[role] = {
      id,
      csrf: u.csrf,
      cookie: r.headers.get("set-cookie")!.split(";")[0],
    };
  }
  const login = await request({}, "/login", "POST", {
    email: process.env.BOOTSTRAP_EMAIL || "admin@example.test",
    password: process.env.BOOTSTRAP_PASSWORD,
  });
  assert.equal(
    login.status,
    200,
    "需要已有管理员账号配置审核分工，不创建临时管理员",
  );
  const adminUser = await login.json();
  clients.admin = {
    csrf: adminUser.csrf,
    cookie: login.headers.get("set-cookie")!.split(";")[0],
  };
  const e = clients.engineer;
  await call(clients.admin, "/review-assignments/" + e.id, "PUT", {
    expectedRevision: 0,
    chemist: clients.chemist.id,
    compliance: clients.compliance.id,
    leader: clients.leader.id,
  });
  customer = (
    await call(e, "/customers", "POST", {
      name: "自动化验证临时客户",
      industry: "验证",
      contact: "",
    })
  ).id;
  proposal = (
    await call(e, "/proposals", "POST", {
      title: "自动化验证临时方案",
      customerId: customer,
      scene: "测试工况",
    })
  ).id;
  assert.equal(
    (await request(clients.outsider, "/proposals/" + proposal)).status,
    404,
  );
  let p = await call(e, "/proposals/" + proposal);
  const aiConfig = await call(e, "/ai/config");
  if (!aiConfig.configured)
    assert.equal(
      (
        await request(e, `/proposals/${proposal}/jobs`, "POST", {
          requestKey: randomUUID(),
          expectedRevision: 1,
          sectionIndex: 2,
          versionIds: [randomUUID()],
          consent: true,
        })
      ).status,
      503,
    );
  const initial = structuredClone(p.body);
  const assignments = {
    chemist: clients.chemist.id,
    compliance: clients.compliance.id,
    leader: clients.leader.id,
  };
  assert.equal(
    (
      await request(e, `/proposals/${proposal}/submit`, "POST", {
        expectedRevision: 1,
        note: "检查缺失正文能否阻断提交",
        assignments,
      })
    ).status,
    422,
  );
  const text = "合成验证资料，仅用于软件测试，不构成实际产品建议。";
  const uploaded: any = {};
  for (const kind of ["tds", "sds"]) {
    const d = await call(e, "/documents", "POST", {
      title: "验证" + kind,
      kind,
      proposalId: proposal,
      filename: kind + ".txt",
      base64: Buffer.from(text).toString("base64"),
      allowModel: false,
    });
    uploaded[kind] = d;
    assert.equal(
      (await request(clients.outsider, "/documents/" + d.versionId)).status,
      404,
    );
    assert.equal(
      (
        await request(
          clients.outsider,
          "/documents/" + d.versionId + "/download",
        )
      ).status,
      404,
    );
    await call(
      clients[kind === "sds" ? "compliance" : "chemist"],
      "/documents/" + d.versionId + "/review",
      "POST",
      { decision: "publish", note: "独立复核合成测试资料" },
    );
  }
  const next = await call(e, "/documents", "POST", {
    title: "验证tds",
    kind: "tds",
    proposalId: proposal,
    filename: "tds-v2.txt",
    base64: Buffer.from(text + "新版新增内容。").toString("base64"),
    allowModel: false,
    documentId: uploaded.tds.id,
    expectedVersion: 1,
  });
  assert.equal((await call(e, "/documents/" + next.versionId)).status, "draft");
  assert.equal(
    (await call(e, "/documents/" + uploaded.tds.versionId)).text_content,
    text,
  );
  assert.equal(
    (
      await request(e, "/documents", "POST", {
        title: "验证tds",
        kind: "tds",
        proposalId: proposal,
        filename: "tds-v3.txt",
        base64: Buffer.from(text).toString("base64"),
        documentId: uploaded.tds.id,
        expectedVersion: 1,
      })
    ).status,
    409,
  );
  const productCode = "VERIFY-" + marker.slice(0, 16);
  await call(clients.admin, "/products", "POST", {
    code: productCode,
    name: "合成验证产品",
    cas: "",
    description: "仅用于软件验证",
  });
  productId = (await call(e, "/products")).find(
    (p: any) => p.code === productCode,
  ).id;
  const shared = await call(clients.admin, "/documents", "POST", {
    title: "共享合成TDS",
    kind: "tds",
    filename: "shared-tds.txt",
    base64: Buffer.from(text).toString("base64"),
    allowModel: false,
  });
  sharedDocId = shared.id;
  sharedSourceId = shared.versionId;
  await call(
    clients.chemist,
    "/documents/" + sharedSourceId + "/review",
    "POST",
    { decision: "publish", note: "独立复核合成参数依据" },
  );
  specId = (
    await call(clients.admin, `/products/${productId}/specs`, "POST", {
      expectedVersion: 0,
      parameters: [
        {
          key: "强度",
          label: "强度",
          min: 20,
          max: 25,
          unit: "MPa",
          conditions: "25℃ 合成基材",
          method: "合成方法",
          valueKind: "guaranteed",
          citation: { versionId: sharedSourceId, quote: text, start: 0 },
        },
      ],
    })
  ).id;
  assert.ok(
    !(await call(e, "/product-specs")).some((s: any) => s.id === specId),
    "工程师不能读取未复核参数版本",
  );
  await call(clients.chemist, "/product-specs/" + specId + "/review", "POST", {
    decision: "publish",
    note: "核对参数与原文及测试条件",
  });
  initial.productIds = [productId];
  initial.productSpecs = { [productId]: specId };
  initial.matchingRequirements = [
    {
      id: randomUUID(),
      key: "强度",
      label: "强度",
      operator: "gte",
      min: 18000,
      max: null,
      unit: "kPa",
      conditions: "25℃ 合成基材",
      method: "合成方法",
      critical: true,
    },
  ];
  initial.requirements = "测试需求，不构成实际产品建议";
  for (const s of initial.sections) {
    s.content = "合成验证正文";
    s.evidence = "合成验证资料 第1节，仅用于软件测试";
    s.citations = [
      {
        versionId:
          uploaded[s === initial.sections[5] ? "sds" : "tds"].versionId,
        quote: text,
        start: 0,
      },
    ];
  }
  await call(e, "/proposals/" + proposal, "PUT", {
    expectedRevision: 1,
    body: initial,
  });
  assert.equal(
    (
      await request(e, "/proposals/" + proposal, "PUT", {
        expectedRevision: 1,
        body: initial,
      })
    ).status,
    409,
  );
  const matching = await call(e, `/proposals/${proposal}/matching`);
  assert.deepEqual(matching.issues, []);
  assert.equal(matching.products[0].results[0].status, "match");
  await call(e, `/proposals/${proposal}/submit`, "POST", {
    expectedRevision: 2,
    note: "验证并行审核及终审状态转换",
    assignments,
  });
  assert.deepEqual(
    (await call(e, `/proposals/${proposal}/precheck`)).issues,
    [],
  );
  p = await call(e, "/proposals/" + proposal);
  let steps = p.requests[0].steps;
  assert.equal(
    (
      await request(clients.leader, `/proposals/${proposal}/decide`, "POST", {
        stepId: steps.find((s: any) => s.role === "leader").id,
        decision: "approved",
        comment: "",
      })
    ).status,
    409,
  );
  const cs = steps.find((s: any) => s.role === "chemist");
  await call(clients.chemist, `/proposals/${proposal}/decide`, "POST", {
    stepId: cs.id,
    decision: "changes_requested",
    comment: "验证退回修改",
  });
  assert.equal(
    (
      await request(
        clients.compliance,
        `/proposals/${proposal}/decide`,
        "POST",
        {
          stepId: steps.find((s: any) => s.role === "compliance").id,
          decision: "approved",
          comment: "",
        },
      )
    ).status,
    409,
  );
  p = await call(e, "/proposals/" + proposal);
  assert.equal(p.status, "CHANGES_REQUESTED");
  await call(e, "/proposals/" + proposal, "PUT", {
    expectedRevision: 2,
    body: initial,
  });
  await call(e, `/proposals/${proposal}/submit`, "POST", {
    expectedRevision: 3,
    note: "修改完成后重新办理全部审核",
    assignments,
  });
  p = await call(e, "/proposals/" + proposal);
  steps = p.requests[0].steps;
  for (const role of ["chemist", "compliance", "leader"]) {
    const s = steps.find((s: any) => s.role === role);
    await call(clients[role], `/proposals/${proposal}/decide`, "POST", {
      stepId: s.id,
      decision: "approved",
      comment: "验证通过",
    });
    assert.equal(
      (
        await request(clients[role], `/proposals/${proposal}/decide`, "POST", {
          stepId: s.id,
          decision: "approved",
          comment: "",
        })
      ).status,
      409,
    );
  }
  p = await call(e, "/proposals/" + proposal);
  assert.equal(p.status, "APPROVED");
  assert.equal(
    (
      await request(e, "/proposals/" + proposal, "PUT", {
        expectedRevision: 3,
        body: initial,
      })
    ).status,
    409,
  );
  const out = await request(e, `/proposals/${proposal}/export.docx`);
  assert.equal(out.status, 200);
  const bytes = Buffer.from(await out.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  const outAgain = await request(e, `/proposals/${proposal}/export.docx`);
  assert.equal(outAgain.status, 200);
  assert.deepEqual(
    Buffer.from(await outAgain.arrayBuffer()),
    bytes,
    "同批准版本必须取回相同Word原文件",
  );
  const pdf = await request(e, `/proposals/${proposal}/export.pdf`);
  assert.equal(pdf.status, 404);
  const artifactList = await call(e, `/proposals/${proposal}/artifacts`);
  assert.equal(artifactList.files.length, 1);
  assert.equal(artifactList.files[0].format, "docx");

  assert.equal(
    (await request(clients.chemist, `/proposals/${proposal}/export.docx`))
      .status,
    403,
  );
  await call(e, `/proposals/${proposal}/new-version`, "POST");
  p = await call(e, "/proposals/" + proposal);
  assert.equal(p.edition, 2);
  assert.equal(p.status, "DRAFT");
  await call(clients.chemist, "/product-specs/" + specId + "/review", "POST", {
    decision: "withdraw",
    note: "验证参数失效后暂停导出",
  });
  assert.equal(
    (await request(e, `/proposals/${proposal}/export.docx`)).status,
    422,
  );
  await call(
    clients.compliance,
    "/documents/" + uploaded.sds.versionId + "/review",
    "POST",
    { decision: "withdraw", note: "验证撤回阻断正式导出" },
  );
  assert.equal(
    (await request(e, `/proposals/${proposal}/export.docx`)).status,
    422,
  );
  assert.ok(
    (await call(e, `/proposals/${proposal}/precheck`)).issues.some(
      (s: string) => s.includes("撤回"),
    ),
  );
  console.log(
    "文档私有范围、文件解析、独立发布、结构化引文、撤回导出拦截、审核分配验证通过；真实MySQL/HTTP验证通过：范围隔离、预检、并发修订、并行审核、退回重提、终审门槛、重复审批、批准后锁定、Word下载、新版。",
  );
  if (process.argv.includes("--ui")) {
    console.log("界面验证已就绪，回车结束并清理临时业务账号");
    await new Promise<void>((r) => process.stdin.once("data", () => r()));
    process.stdin.pause();
  }
} finally {
  if (proposal) {
    await pool.execute("DELETE FROM sp_exports WHERE proposal_id=?", [
      proposal,
    ]);
    await pool.execute(
      "DELETE s FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id WHERE r.proposal_id=?",
      [proposal],
    );
    await pool.execute(
      "DELETE a FROM sp_artifacts a JOIN sp_approval_requests r ON r.id=a.request_id WHERE r.proposal_id=?",
      [proposal],
    );
    await pool.execute("DELETE FROM sp_approval_requests WHERE proposal_id=?", [
      proposal,
    ]);
    await pool.execute("DELETE FROM sp_proposal_versions WHERE proposal_id=?", [
      proposal,
    ]);
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
  if (clients.engineer)
    await pool.execute("DELETE FROM sp_review_assignments WHERE owner_id=?", [
      clients.engineer.id,
    ]);
  if (clients.admin)
    await pool.execute("DELETE FROM sp_sessions WHERE token_hash=?", [
      (await import("../server/security.js")).hash(
        clients.admin.cookie.slice("sp_session=".length),
      ),
    ]);
  await pool.execute(
    "DELETE FROM sp_audit_logs WHERE action='review_assignment.saved' AND JSON_UNQUOTE(JSON_EXTRACT(details,'$.ownerId'))=?",
    [clients.engineer?.id || ""],
  );
  if (specId)
    await pool.execute("DELETE FROM sp_product_specs WHERE id=?", [specId]);
  if (productId)
    await pool.execute("DELETE FROM sp_products WHERE id=?", [productId]);
  if (sharedDocId) {
    await pool.execute("DELETE FROM sp_document_versions WHERE document_id=?", [
      sharedDocId,
    ]);
    await pool.execute("DELETE FROM sp_documents WHERE id=?", [sharedDocId]);
  }
  for (const id of [specId, productId, sharedDocId])
    if (id)
      await pool.execute(
        "DELETE FROM sp_audit_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(details,'$.specId'))=? OR JSON_UNQUOTE(JSON_EXTRACT(details,'$.id'))=? OR JSON_UNQUOTE(JSON_EXTRACT(details,'$.documentId'))=?",
        [id, id, id],
      );
  for (const id of ids) {
    await pool.execute("DELETE FROM sp_audit_logs WHERE actor_id=?", [id]);
    await pool.execute("DELETE FROM sp_sessions WHERE user_id=?", [id]);
    await pool.execute("DELETE FROM sp_users WHERE id=?", [id]);
  }
  await pool.end();
  console.log("验证临时数据已清理");
}
