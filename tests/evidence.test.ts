import test from "node:test";
import assert from "node:assert/strict";
import { validQuote, kindSatisfies, reviewRole } from "../shared/evidence.js";
import { extract } from "../server/extract.js";
test("引文必须绑定连续原文及正确偏移，不能仅包含相同词语", () => {
  const text = "工况：25℃，仅供验证。";
  assert.equal(
    validQuote(text, { versionId: "x", quote: "25℃，仅供验证", start: 3 }),
    true,
  );
  assert.equal(
    validQuote(text, { versionId: "x", quote: "25℃，仅供验证", start: 0 }),
    false,
  );
  assert.equal(
    validQuote(text, { versionId: "x", quote: "25℃验证", start: 3 }),
    false,
  );
});
test("关键章节需要对应技术或安全资料，客户资料不能代替", () => {
  assert.equal(kindSatisfies(2, ["customer"]), false);
  assert.equal(kindSatisfies(2, ["tds"]), true);
  assert.equal(kindSatisfies(5, ["tds"]), false);
  assert.equal(kindSatisfies(5, ["sds"]), true);
  assert.equal(reviewRole("sds"), "compliance");
  assert.equal(reviewRole("application"), "chemist");
});
test("真实解析UTF8，拒绝空文件、不支持格式和损坏PDF", async () => {
  const r = await extract(
    "客户.txt",
    Buffer.from("合成验证资料，不构成产品建议。"),
  );
  assert.match(r.text, /合成验证/);
  await assert.rejects(() => extract("损坏.pdf", Buffer.from("not a PDF")));
  assert.throws(() => extract("脚本.exe", Buffer.from("test")));
  assert.throws(() => extract("空.txt", Buffer.alloc(0)));
});

test("未发布、撤回、过期、跨方案及篡改引文均阻断送审", async () => {
  const { inspectEvidence, requireEvidence } =
    await import("../server/evidence.js");
  const quote = "合成验证资料，仅供软件测试";
  const p: any = {
    id: "p1",
    body: {
      requirements: "已确认",
      sections: Array.from({ length: 6 }, (_, i) => ({
        content: "合成正文",
        citations: [{ versionId: i === 5 ? "s" : "t", quote, start: 0 }],
      })),
    },
  };
  const record = (id: string) => ({
    id,
    title: "合成资料",
    kind: id === "s" ? "sds" : "tds",
    status: "published",
    text_content: quote,
    proposal_id: "p1",
    version: 1,
    sha256: "x",
    allow_model: false,
  });
  const db = (change: any) => ({
    execute: async (_sql: string, args: string[]) => [
      [{ ...record(args[0]), ...change }],
    ],
  });
  assert.deepEqual((await inspectEvidence(p, db({}))).issues, []);
  await assert.doesNotReject(() => requireEvidence(p, db({})));
  for (const change of [
    { status: "draft" },
    { status: "withdrawn" },
    { expires_on: "2000-01-01" },
    { proposal_id: "other" },
    { text_content: "原文已经不同" },
  ])
    await assert.rejects(() => requireEvidence(p, db(change)), { status: 422 });
});
