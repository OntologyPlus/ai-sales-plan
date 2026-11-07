import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pool, rows } from "../server/db.js";
import { hash, passwordHash } from "../server/security.js";

const base = process.env.PCBA_VERIFY_BASE || "http://127.0.0.1:3200";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("验收仅允许本机验证服务");
const marker = randomUUID(), ids = [randomUUID(), randomUUID()];
let proposalId = "", customerId = "", documentId = "", versionId = "";
const checks: string[] = [];
const browser = process.argv.includes("--browser");
type Client = { cookie: string; csrf: string; id: string };
async function request(c: Client, path: string, method = "GET", body?: any) {
  return fetch(base + "/api" + path, { method, headers: { origin: base, cookie: c.cookie,
    "x-csrf-token": c.csrf, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function call(c: Client, path: string, method = "GET", body?: any) {
  const r = await request(c, path, method, body), d = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(d)}`); return d;
}
async function status(c: Client, expected: number, path: string, method = "GET", body?: any) {
  const r = await request(c, path, method, body); assert.equal(r.status, expected, await r.text());
}
async function login(id: string): Promise<Client> {
  const password = randomBytes(24).toString("hex"), email = `pcba-${id}@example.test`;
  await pool.execute("INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",
    [id, email, "合成PCBA验收工程师", passwordHash(password), JSON.stringify(["engineer"])]);
  const r = await fetch(base + "/api/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200); const d = await r.json();
  return { id, csrf: d.csrf, cookie: r.headers.get("set-cookie")!.split(";")[0] };
}

async function verifyBrowser(client: Client, title: string) {
  const tabs = await (await fetch("http://127.0.0.1:9333/json")).json();
  const tab = tabs.find((t: any) => t.type === "page");
  assert.ok(tab, "缺少本机9333 Chrome验收页面");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("CDP连接失败")), { once: true }); });
  let seq = 0, dialogs = 0, acceptDialogs = false; const pending = new Map<number, any>();
  ws.addEventListener("message", e => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Page.javascriptDialogOpening") { dialogs++; void send("Page.handleJavaScriptDialog", { accept: acceptDialogs }); return; }
    if (!m.id) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const send = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => { const d = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (d.exceptionDetails) throw new Error(d.exceptionDetails.exception?.description || "浏览器执行失败"); return d.result.value; };
  const until = async (expression: string) => { for (let n = 0; n < 100; n++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("等待页面超时: " + expression); };
  const click = async (text: string) => { assert.ok(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`), "缺少可点击按钮: " + text); };
  const openWorkspace = async () => {
    await until(`document.body.innerText.includes(${JSON.stringify(title)})`);
    await evaluate(`(()=>{const row=[...document.querySelectorAll('tr')].find(x=>x.innerText.includes(${JSON.stringify(title)}));row.querySelector('button').click()})()`);
    await until(`document.body.innerText.includes('PCBA应用工作台 →')`); await click("PCBA应用工作台 →");
    await until(`document.querySelector('.pcba-fact textarea')`);
  };
  try {
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    await send("Network.setCookie", { url: base, name: "sp_session", value: client.cookie.slice("sp_session=".length) });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base }); await openWorkspace();
    await until(`document.querySelector('select[aria-label="客户资料版本"]').options.length>1`);
    await evaluate(`(()=>{const s=document.querySelector('select[aria-label="客户资料版本"]');s.value=${JSON.stringify(versionId)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await until(`document.querySelector('.pcba-source')`);
    await evaluate(`(()=>{const p=document.querySelector('.pcba-source');const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,p.textContent.indexOf('。')+1);const s=window.getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})()`);
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='绑定到“板件、组件与材料”'&&!b.disabled)`);
    await click("绑定到“板件、组件与材料”");
    await click("整理这份资料（规则辅助）");
    await until(`document.body.innerText.includes('按关键词整理了')`);
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='保存应用档案'&&!b.disabled)`);
    await until(`document.querySelector('textarea[aria-label="板件、组件与材料"]').value.length>0`);
    await evaluate(`(()=>{const s=document.querySelector('select[aria-label="板件、组件与材料状态"]');s.value='confirmed';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await until(`document.querySelector('.pcba-stat').innerText.includes('1/8')`);
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='保存应用档案'&&!b.disabled)`);
    await click("保存应用档案"); await until(`document.body.innerText.includes('应用档案已保存')`);
    await click("查看原文 ↗"); await until(`document.querySelector('dialog[open] mark')`);
    assert.ok(await evaluate(`document.querySelector('dialog[open] mark').innerText.includes('板材')`));
    await evaluate(`document.querySelector('dialog[open] button').click()`);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile("data/qa/pcba-application/desktop.png", Buffer.from(shot.data, "base64"));
    await send("Page.reload", { ignoreCache: true }); await openWorkspace();
    assert.equal(await evaluate(`document.querySelector('select[aria-label="板件、组件与材料状态"]').value`), "confirmed");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth+1`), "窄屏出现横向溢出");
    const narrow = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile("data/qa/pcba-application/mobile.png", Buffer.from(narrow.data, "base64"));
    await evaluate(`(()=>{const t=document.querySelector('textarea[aria-label="板件、组件与材料"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,t.value+' 未保存核对');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await until(`document.body.innerText.includes('有未保存修改')`);
    await click("返回方案编制");
    assert.equal(dialogs, 1); assert.ok(await evaluate(`document.querySelector('.pcba-page') !== null`));
    acceptDialogs = true;
    await click("返回方案编制");
    await until(`document.body.innerText.includes('阅读预览 ↗')`);
    await click("阅读预览 ↗"); await until(`document.querySelector('dialog[open] .reader-cover')`);
    await evaluate(`document.querySelector('dialog[open] button').click()`);
    await evaluate(`(()=>{const t=document.querySelector('#requirements textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'合成PCBA正文保存回归');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='保存修改'&&!b.disabled)`);
    await click("保存修改"); await until(`document.body.innerText.includes('正文已保存')`);
    const checked = await call(client, `/proposals/${proposalId}`);
    assert.equal(checked.body.requirements, "合成PCBA正文保存回归");
    assert.equal(checked.body.applicationProfileRevision, 1);
    checks.push("浏览器：方案入口、手工原文绑定、规则整理、原文定位、确认保存、刷新持久化、未保存离开保护及390像素布局");
    checks.push("原有主界面回归：返回编制、整篇阅读、正文编辑保存及档案关联保留");
    // Restore a neutral screen before removing temporary verification accounts.
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Network.deleteCookies", { url: base, name: "sp_session" }); await send("Page.navigate", { url: base });
  } finally { ws.close(); }
}

try {
  await mkdir("data/qa/pcba-application", { recursive: true });
  const owner = await login(ids[0]), outsider = await login(ids[1]);
  customerId = (await call(owner, "/customers", "POST", { name: "合成PCBA档案验证客户", industry: "合成电子", contact: "" })).id;
  const title = "合成PCBA应用档案验收 " + marker.slice(0, 8);
  proposalId = (await call(owner, "/proposals", "POST", { title, customerId, scene: "PCBA清洗 / 合成验证" })).id;
  const path = `/proposals/${proposalId}/application`;
  let data = await call(owner, path);
  assert.equal(data.profile.revision, 0); assert.equal(data.assessment.questions.length, 8);
  await status(outsider, 404, path);
  documentId = randomUUID(); versionId = randomUUID();
  const text = "板材为合成板件A。\n助焊剂残留R-1，焊接历史待核对。\n客户验收方法为合成方法，限值待专业确认。\n敏感元件与标识按模拟清单记录。\n现有工艺有局部可见异常。\n设备为合成设备E-1。\n漂洗和干燥及后续涂覆需要验证。\n样品批次S-1和对照S-0仅供合成验证。";
  await pool.execute("INSERT INTO sp_documents(id,title,kind,proposal_id,created_by) VALUES (?,?,'customer',?,?)", [documentId, "PCBA合成客户问卷", proposalId, owner.id]);
  await pool.execute("INSERT INTO sp_document_versions(id,document_id,version,filename,sha256,storage_provider,storage_key,byte_size,text_content,parse_notes,status,created_by) VALUES (?,?,1,'synthetic.txt',?,'local',?,0,?,?,'published',?)",
    [versionId, documentId, hash(text), `synthetic-verification/${marker}`, text, JSON.stringify({ synthetic: true }), owner.id]);
  const suggestions = await call(owner, path + "/suggestions", "POST", { versionId, expectedEdition: data.edition, expectedProposalRevision: data.proposalRevision });
  const fact = { ...suggestions.candidates.find((f: any) => f.field === "materials"), status: "confirmed" };
  const body = { requestId: randomUUID(), expectedEdition: 1, expectedProposalRevision: data.proposalRevision,
    expectedProfileRevision: 0, changes: [fact] };
  const saved = await call(owner, path, "PATCH", body);
  assert.equal(saved.revision, 1); assert.deepEqual(await call(owner, path, "PATCH", body), saved);
  await status(owner, 409, path, "PATCH", { ...body, changes: [{ ...fact, value: "不同内容" }] });
  await status(owner, 409, path, "PATCH", { ...body, requestId: randomUUID() });
  data = await call(owner, path); assert.equal(data.profile.facts[0].status, "confirmed");
  const proposal = await call(owner, `/proposals/${proposalId}`);
  await call(owner, `/proposals/${proposalId}`, "PUT", { expectedRevision: proposal.revision, body: proposal.body });
  assert.equal((await call(owner, `/proposals/${proposalId}`)).body.applicationProfileRevision, 1);
  data = await call(owner, path);
  const fresh = { ...body, requestId: randomUUID(), expectedProposalRevision: data.proposalRevision, expectedProfileRevision: data.profile.revision };
  await status(owner, 422, path, "PATCH", { ...fresh, changes: [{ ...fact, citations: [{ ...fact.citations[0], start: 1 }] }] });
  await pool.execute("UPDATE sp_document_versions SET status='withdrawn' WHERE id=?", [versionId]);
  const hidden = await call(owner, path); assert.equal(hidden.profile.facts[0].value, null);
  assert.equal(JSON.stringify(hidden).includes(fact.value), false);
  await status(owner, 422, path, "PATCH", fresh);
  await pool.execute("UPDATE sp_document_versions SET status='published' WHERE id=?", [versionId]);
  const concurrent = await Promise.all([request(owner, path, "PATCH", fresh), request(owner, path, "PATCH", { ...fresh, requestId: randomUUID() })]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  await pool.execute("UPDATE sp_proposals SET status='APPROVED' WHERE id=?", [proposalId]);
  assert.equal((await call(owner, path)).editable, false);
  await status(owner, 409, path, "PATCH", { ...fresh, requestId: randomUUID() });
  await call(owner, `/proposals/${proposalId}/new-version`, "POST");
  assert.equal((await call(owner, `/proposals/${proposalId}`)).body.applicationProfileRevision, undefined);
  assert.equal((await call(owner, path)).profile.revision, 0);
  await status(owner, 409, path, "PATCH", body);
  checks.push("真实HTTP：保存/持久化、幂等与冲突、并发、越权、错误引用、来源撤回投影、正文保存保护、批准只读和新版隔离");
  if (browser) await verifyBrowser(owner, title);
  await writeFile("data/qa/pcba-application/result.json", JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), synthetic: true, checks }, null, 2) + "\n");
  console.log("PCBA应用工作台验收通过：" + checks.join("；"));
} finally {
  if (proposalId) {
    for (const table of ["sp_pcba_profile_versions", "sp_pcba_profiles", "sp_proposal_versions", "sp_audit_logs"])
      await pool.execute(`DELETE FROM ${table} WHERE proposal_id=?`, [proposalId]);
    if (versionId) await pool.execute("DELETE FROM sp_document_versions WHERE id=?", [versionId]);
    if (documentId) await pool.execute("DELETE FROM sp_documents WHERE id=?", [documentId]);
    await pool.execute("DELETE FROM sp_proposals WHERE id=?", [proposalId]);
  }
  if (customerId) await pool.execute("DELETE FROM sp_customers WHERE id=?", [customerId]);
  for (const id of ids) {
    await pool.execute("DELETE FROM sp_audit_logs WHERE actor_id=?", [id]);
    await pool.execute("DELETE FROM sp_sessions WHERE user_id=?", [id]);
    await pool.execute("DELETE FROM sp_users WHERE id=?", [id]);
  }
  await pool.end();
}
