import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, access, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openPcbaPoc } from "../scripts/poc/pcba-runtime.js";
import { syntheticPcbaSnapshot } from "./fixtures/pcba.js";

test("真实Pi多步工具、完成会话重开与稳定请求不重复", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pcba-pi-"));
  const path = join(dir, "session.sqlite");
  const obs = { modelRequests: 0, tools: [] as string[] };
  try {
    const s = syntheticPcbaSnapshot();
    const first = await openPcbaPoc(path, s, () => {}, obs);
    let result;
    try { result = await first.run(); } finally { await first.close(); }
    assert.equal(obs.modelRequests, 5); assert.equal(obs.tools.length, 4);
    const reopened = await openPcbaPoc(path, s, () => {}, obs);
    try {
      assert.deepEqual(await reopened.run(), result);
      assert.equal(obs.modelRequests, 5); assert.equal(obs.tools.length, 4);
    } finally { await reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Pi会话固定输入，丢会话不得创建空库伪恢复", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pcba-pi-input-"));
  const path = join(dir, "session.sqlite");
  const obs = { modelRequests: 0, tools: [] as string[] };
  try {
    const s = syntheticPcbaSnapshot();
    const first = await openPcbaPoc(path, s, () => {}, obs);
    await first.close();
    const changed = structuredClone(s); changed.profile.revision++;
    await assert.rejects(openPcbaPoc(path, changed, () => {}, obs), /POC_INPUT_CHANGED/);
    await unlink(path);
    await assert.rejects(openPcbaPoc(path, s, () => {}, obs), /POC_SESSION_MISSING/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("撤权在Pi重开和完成结果读取前生效", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pcba-pi-acl-"));
  const obs = { modelRequests: 0, tools: [] as string[] };
  let allowed = true;
  const guard = () => { if (!allowed) throw new Error("REVOKED"); };
  try {
    const s = syntheticPcbaSnapshot(), path = join(dir, "session.sqlite");
    const session = await openPcbaPoc(path, s, guard, obs);
    try {
      await session.run(); allowed = false;
      await assert.rejects(session.run(), /REVOKED/);
    } finally { await session.close(); }
    await assert.rejects(openPcbaPoc(path, s, guard, obs), /REVOKED/);
    assert.equal(obs.modelRequests, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("子进程在只读工具中被杀后，Pi恢复且不重做已提交的前序工具", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pcba-pi-crash-"));
  const path = join(dir, "session.sqlite"), marker = join(dir, "paused");
  const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/pcba-crash-child.ts", path, marker],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", c => { stderr += c; });
  const exited = once(child, "exit");
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await access(marker); ready = true; break; } catch {}
      if (child.exitCode !== null) break;
      await delay(50);
    }
    assert.equal(ready, true, `Crash checkpoint not reached: ${stderr}`);
    child.kill("SIGKILL"); await exited;
    const obs = { modelRequests: 0, tools: [] as string[] };
    const session = await openPcbaPoc(path, syntheticPcbaSnapshot(), () => {}, obs);
    try {
      const result = await session.run();
      assert.equal(result.result.professionalApproval, false);
      assert.equal(result.result.comparison.candidates[0].disposition, "validation_candidate");
      assert.equal(obs.tools.includes("read_application"), false, "已提交的前序读取不能重复执行");
      assert.deepEqual(obs.tools, ["read_evidence", "compare_products", "prepare_validation"]);
    } finally { await session.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
