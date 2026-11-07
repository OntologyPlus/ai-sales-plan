import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import mammoth from "mammoth";
import { hash } from "../server/security.js";
import { pool } from "../server/db.js";

// A new, separate case on each run. Never reset or overwrite business records.
const base = process.env.DEMO_BASE_URL || "http://127.0.0.1:3200";
const marker = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const dir = resolve("data/demo", marker);
await mkdir(dir, { recursive: true });
const report: any = { createdAt: new Date().toISOString(), base, synthetic: true, accounts: {}, proposals: {}, checks: [], model: {}, status: "preparing" };
const save = async () => {
  await writeFile(resolve(dir, "private-manifest.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(resolve("data/demo/latest.json"), JSON.stringify({ directory: dir, status: report.status }), { mode: 0o600 });
};
const request = (client: any, path: string, method = "GET", body?: any) => fetch(base + "/api" + path, {
  method, headers: { origin: base, cookie: client?.cookie || "", "x-csrf-token": client?.csrf || "", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function api(client: any, path: string, method = "GET", body?: any) {
  const response = await request(client, path, method, body);
  const data = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function login(email: string, password: string) {
  const response = await request(null, "/login", "POST", { email, password });
  assert.equal(response.status, 200, "登录失败，请核对本地账号配置");
  return { ...await response.json(), cookie: response.headers.get("set-cookie")!.split(";")[0] };
}
try {
  const admin = await login(process.env.BOOTSTRAP_EMAIL!, process.env.BOOTSTRAP_PASSWORD!);
  const clients: any = {};
  for (const [role, name] of Object.entries({ engineer: "演示·售前工程师", chemist: "演示·应用化学师", compliance: "演示·合规专员", leader: "演示·审批领导", admin: "演示·管理员" })) {
    const email = `demo-${role}-${marker}@example.test`, password = "Demo!" + randomBytes(12).toString("hex");
    await api(admin, "/users", "POST", { email, password, name, roles: [role] });
    clients[role] = await login(email, password);
    report.accounts[role] = { email, password, name };
    await save();
  }
  const e = clients.engineer, assignments = { chemist: clients.chemist.id, compliance: clients.compliance.id, leader: clients.leader.id };
  await api(admin, `/review-assignments/${e.id}`, "PUT", { expectedRevision: 0, ...assignments });
  const config = await api(e, "/ai/config");
  assert.ok(config.configured && config.workerReady, "真实模型密钥或后台未就绪");
  report.model = { model: config.model, baseUrl: config.baseUrl };
  const texts = {
    tds: "【合成演示资料，不构成真实产品推荐】\nDEMO-A保证剪切强度范围为20至25 MPa；DEMO-B典型剪切强度范围为14至16 MPa。\n测试条件：25℃ 合成金属基材；测试方法：演示搭接剪切法。\n仅限已验证基材，实际客户基材、老化与长期耐久性须另行试验。",
    sds: "【合成演示资料，不替代真实SDS】\n操作时佩戴防护手套和护目镜，保持通风，避免皮肤和眼睛接触。\n储存于阴凉干燥处；泄漏时隔离区域并按现场规程收集。\n真实危险分类、法规符合性及废弃处置要求尚待真实资料核实，不作安全或合规承诺。",
    customer: "【合成演示客户需求】\n客户拟评估金属部件粘接方案。\n要求：25℃ 合成金属基材条件下，按演示搭接剪切法测得保证剪切强度不低于18 MPa。\n需说明适用边界、安全措施及样品验证计划。实际批量应用需客户验证。",
  };
  const sources: any = {};
  await writeFile(resolve(dir, "客户需求.txt"), texts.customer);
  for (const kind of ["tds", "sds"] as const) {
    const title = kind === "tds" ? "演示产品技术说明 TDS" : "演示安全说明 SDS";
    const d = await api(admin, "/documents", "POST", { title, kind, filename: `${kind}-demo.txt`, base64: Buffer.from(texts[kind]).toString("base64"), allowModel: true });
    await api(clients[kind === "tds" ? "chemist" : "compliance"], `/documents/${d.versionId}/review`, "POST", { decision: "publish", note: "独立核对合成演示资料，仅供软件演示" });
    sources[kind] = d.versionId;
    await writeFile(resolve(dir, `${kind}.txt`), texts[kind]);
  }
  const products: any[] = [];
  for (const [i, label] of ["A", "B"].entries()) {
    const code = `DEMO-${label}-${marker}`;
    await api(admin, "/products", "POST", { code, name: `合成粘接方案 ${label}`, cas: "", description: "仅用于演示，非真实产品" });
    const product = (await api(e, "/products")).find((p: any) => p.code === code);
    const spec = await api(admin, `/products/${product.id}/specs`, "POST", { expectedVersion: 0, parameters: [{ key: "剪切强度", label: "剪切强度", min: i ? 14 : 20, max: i ? 16 : 25, unit: "MPa", conditions: "25℃ 合成金属基材", method: "演示搭接剪切法", valueKind: i ? "typical" : "guaranteed", citation: { versionId: sources.tds, start: 0, quote: texts.tds } }] });
    await api(clients.chemist, `/product-specs/${spec.id}/review`, "POST", { decision: "publish", note: "独立核对参数、性质、工况与原文，仅供演示" });
    products.push({ ...product, specId: spec.id });
  }
  const customer = await api(e, "/customers", "POST", { name: `演示客户·精密部件制造 ${marker}`, industry: "合成金属部件粘接", contact: "演示资料，无真实联系方式" });
  let body: any;
  async function createCase(key: string, title: string, productIndex = 0) {
    const p = await api(e, "/proposals", "POST", { title, customerId: customer.id, scene: "合成金属部件粘接评估，仅供软件演示" });
    const loaded = await api(e, `/proposals/${p.id}`);
    const b = body ? structuredClone(body) : loaded.body;
    b.requirements = texts.customer;
    b.productIds = [products[productIndex].id];
    b.productSpecs = { [products[productIndex].id]: products[productIndex].specId };
    b.matchingRequirements = [{ id: randomUUID(), key: "剪切强度", label: "剪切强度", operator: "gte", min: 18, max: null, unit: "MPa", conditions: "25℃ 合成金属基材", method: "演示搭接剪切法", critical: true }];
    if (!body) for (const [i, s] of b.sections.entries()) {
      s.content = ["客户拟在合成金属基材上评估粘接方案，已知门槛为保证剪切强度至少18 MPa。", "比较须限定25℃、合成金属基材及演示搭接剪切法，其他工况不能外推。", "方案A的保证范围为20至25 MPa，符合本次已知数值门槛；实际客户适用性待样品验证。", "方案B仅有14至16 MPa典型值，不能作为满足保证门槛的依据。", "建议先确认真实基材、表面处理和固化工艺，再执行样品、老化与耐久试验。", "佩戴防护手套和护目镜并保持通风。真实危险分类、法规和处置要求仍须专业核实。"][i];
      s.evidence = "仅供合成演示，实际工况与真实资料须另行验证。";
      s.citations = [{ versionId: sources[i === 5 ? "sds" : "tds"], quote: texts[i === 5 ? "sds" : "tds"], start: 0 }];
    }
    await api(e, `/proposals/${p.id}`, "PUT", { expectedRevision: 1, body: b });
    report.proposals[key] = { id: p.id, title, code: loaded.code };
    await save();
    return await api(e, `/proposals/${p.id}`);
  }
  let draft = await createCase("ai", "01 AI编制与原文追溯（合成演示）");
  for (const sectionIndex of [2, 5]) {
    const started = Date.now();
    const job = await api(e, `/proposals/${draft.id}/jobs`, "POST", { requestKey: randomUUID(), expectedRevision: draft.revision, sectionIndex, versionIds: [sources[sectionIndex === 5 ? "sds" : "tds"]], consent: true, instruction: "用于合成软件演示。生成约300字清晰正文，区分已知事实和待验证事项。引用可直接使用所给资料的完整原文并令start为0，准确保留原文，不补造结论。" });
    let result: any;
    for (let n = 0; n < 600; n++) {
      result = await api(e, `/proposals/${draft.id}/jobs/${job.id}`);
      if (!["queued", "running"].includes(result.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await writeFile(resolve(dir, `real-ai-section-${sectionIndex}.json`), JSON.stringify(result, null, 2));
    assert.equal(result.status, "completed", `真实模型生成失败：${result.error || result.status}`);
    assert.ok(result.result.citations.length);
    assert.equal((await api(e, `/proposals/${draft.id}`)).revision, draft.revision, "生成不能自动修改正文");
    const before = draft.revision;
    await api(e, `/proposals/${draft.id}/jobs/${job.id}/apply`, "POST", { expectedRevision: before });
    draft = await api(e, `/proposals/${draft.id}`);
    assert.equal(draft.revision, before + 1);
    assert.equal((await request(e, `/proposals/${draft.id}/jobs/${job.id}/apply`, "POST", { expectedRevision: draft.revision })).status, 409);
    report.checks.push({ name: `真实AI章节${sectionIndex + 1}生成、引用校验、人工采用、重复采用拒绝`, seconds: Math.round((Date.now() - started) / 1000), usage: result.usage });
    console.log(`真实模型章节${sectionIndex + 1}验收通过`);
    await save();
  }
  body = draft.body;
  const live = await createCase("live", "02 现场生成工作副本（合成演示）");
  const pending = await createCase("pending", "03 待专业审核（合成演示）");
  const approved = await createCase("approved", "04 批准版交付（合成演示）");
  const blocked = await createCase("blocked", "05 典型值待验证·送审拦截（合成演示）", 1);
  assert.ok((await api(e, `/proposals/${blocked.id}/precheck`)).issues.length);
  assert.equal((await request(e, `/proposals/${blocked.id}/submit`, "POST", { expectedRevision: blocked.revision, note: "验证典型值不能满足关键保证门槛", assignments })).status, 422);
  for (const p of [pending, approved]) await api(e, `/proposals/${p.id}/submit`, "POST", { expectedRevision: p.revision, note: "合成演示：核对资料依据、应用边界与风险声明", assignments });
  let p = await api(e, `/proposals/${approved.id}`);
  assert.equal((await request(clients.leader, `/proposals/${p.id}/decide`, "POST", { stepId: p.requests[0].steps.find((s: any) => s.role === "leader").id, decision: "approved", comment: "验证领导不能越过专业审核" })).status, 409);
  for (const role of ["chemist", "compliance", "leader"]) {
    p = await api(e, `/proposals/${approved.id}`);
    await api(clients[role], `/proposals/${p.id}/decide`, "POST", { stepId: p.requests[0].steps.find((s: any) => s.role === role).id, decision: "approved", comment: "合成演示独立审核通过；实际业务仍需真实样品及正式资料确认" });
  }
  const download = await request(e, `/proposals/${approved.id}/export.docx`);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(hash(bytes), download.headers.get("x-content-sha256"));
  const again = await request(e, `/proposals/${approved.id}/export.docx`);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes);
  const content = (await mammoth.extractRawText({ buffer: bytes })).value;
  assert.ok(content.includes("审批记录") && content.includes("演示·合规专员"));
  await writeFile(resolve(dir, "批准版演示方案.docx"), bytes);
  await writeFile(resolve(dir, "批准版演示方案.txt"), content);
  assert.equal((await request(clients.chemist, `/proposals/${approved.id}/export.docx`)).status, 403);
  assert.equal((await request(e, `/proposals/${approved.id}/export.pdf`)).status, 404);
  report.checks.push({ name: "典型值阻断送审、三段独立审核、领导提前审核拦截、Word下载/指纹/重复下载一致、下载权限、PDF关闭", passed: true });
  report.status = "ready";
  await save();
  execFileSync(process.execPath, ["scripts/build-demo-guide.cjs"], { stdio: "inherit" });
  console.log(`演示案例及私人账号清单已保存：${dir}`);
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "准备失败";
  await save();
  console.error(report.error);
  process.exitCode = 1;
} finally { await pool.end(); }
