import test from "node:test";
import assert from "node:assert/strict";
import { pcbaSaveSchema, suggestPcbaFacts } from "../shared/pcba-application.js";
import { migratePcbaProfiles } from "../server/pcba-migration.js";

test("客户原文整理保持真实字符位置，所有线索仍为候选", () => {
  const text = "  板材为合成板件A。\n助焊剂残留待核对；\n客户验收方法由技术确认。";
  const source = { versionId: "v1", sha256: "a".repeat(64) };
  const items = suggestPcbaFacts(text, source);
  assert.ok(items.some(f => f.field === "materials"));
  assert.ok(items.some(f => f.field === "residues"));
  assert.ok(items.some(f => f.field === "acceptance"));
  for (const f of items) {
    assert.equal(f.status, "candidate");
    const c = f.citations[0];
    assert.equal(text.slice(c.start, c.start + c.quote.length), c.quote);
    assert.equal(c.sha256, source.sha256);
  }
  assert.deepEqual(suggestPcbaFacts("无相关线索", source), []);
});

test("确认必须有依据，重复字段和伪造身份不被接受", () => {
  const input = { requestId: "95a941eb-759f-426a-a3b8-e1a937f2f289", expectedEdition: 1,
    expectedProposalRevision: 1, expectedProfileRevision: 0,
    changes: [{ field: "materials", value: "模拟材料", status: "confirmed", citations: [] }] };
  assert.equal(pcbaSaveSchema.safeParse(input).success, false);
  input.changes[0].status = "candidate";
  assert.equal(pcbaSaveSchema.safeParse(input).success, true);
  assert.equal(pcbaSaveSchema.safeParse({ ...input, actorId: "forged" }).success, false);
  assert.equal(pcbaSaveSchema.safeParse({ ...input, changes: [...input.changes, ...input.changes] }).success, false);
});

test("迁移沿用父键排序规则，仅创建新表，不改写旧业务表", async () => {
  const sql: string[] = [];
  const db = { execute: async (s: string) => {
    sql.push(s);
    return [s.startsWith("SELECT") ? [{ charsetName: "utf8mb4", collationName: "utf8mb4_0900_ai_ci" }] : []];
  } };
  await migratePcbaProfiles(db);
  assert.equal(sql.filter(s => s.startsWith("CREATE TABLE")).length, 2);
  assert.ok(sql.filter(s => s.startsWith("CREATE TABLE")).every(s => s.includes("COLLATE utf8mb4_0900_ai_ci")));
  assert.equal(sql.some(s => /ALTER TABLE|UPDATE sp_proposals/.test(s)), false);
  const invalid = { execute: async () => [[{ charsetName: "utf8mb4", collationName: "bad; SQL" }]] };
  await assert.rejects(migratePcbaProfiles(invalid), /排序规则/);
});
