import test from "node:test";
import assert from "node:assert/strict";
import { parseCandidate, type AiInput } from "../shared/ai.js";
import { CompatibleModelRuntime, modelConfig } from "../server/model.js";
const id = "6a1d1429-e270-4b0b-9ee9-29b10f943fd7";
const text = "合成测试资料，25℃条件下的示例，不能作为实际产品建议。";
const input: AiInput = {
  proposalId: "p",
  edition: 1,
  revision: 1,
  sectionIndex: 2,
  sectionTitle: "产品推荐",
  scene: "合成场景",
  requirements: "合成需求",
  instruction: "",
  templateInstruction: "保留工况约束",
  sources: [
    {
      id,
      title: "合成TDS",
      kind: "tds",
      sha256: "test",
      text,
      totalChars: text.length,
    },
  ],
  provider: "test",
  model: "synthetic",
};
const candidate = {
  content: "建议核对实际工况后开展验证。",
  citations: [{ versionId: id, quote: text, start: 0 }],
  gaps: ["尚缺真实客户验证"],
};
test("候选只接受真实授权原文、正确位置及对应资料类别", () => {
  assert.deepEqual(parseCandidate(JSON.stringify(candidate), input), candidate);
  assert.throws(() =>
    parseCandidate(
      JSON.stringify({
        ...candidate,
        citations: [{ versionId: id, quote: "不存在的引文", start: 0 }],
      }),
      input,
    ),
  );
  assert.throws(() =>
    parseCandidate(JSON.stringify(candidate), { ...input, sources: [] }),
  );
  assert.throws(() =>
    parseCandidate(JSON.stringify(candidate), { ...input, sectionIndex: 5 }),
  );
  assert.throws(() => parseCandidate("不是JSON", input));
});
test("兼容接口仅发送选择的资料与需求，并校验输出及截断", async (t) => {
  const saved = { ...modelConfig };
  modelConfig.key = "synthetic-test-only";
  modelConfig.baseUrl = "http://127.0.0.1:9999";
  let sent: any;
  const fake = t.mock.method(
    globalThis,
    "fetch",
    async (url: any, options: any) => {
      assert.equal(url, "http://127.0.0.1:9999/chat/completions");
      assert.equal(options.redirect, "error");
      sent = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(candidate) },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
    },
  );
  try {
    const r = await new CompatibleModelRuntime().generate(
      input,
      new AbortController().signal,
    );
    assert.equal(r.usage.totalTokens, 30);
    const payload = JSON.parse(sent.messages[1].content);
    assert.equal(payload.templateInstruction, "保留工况约束");
    assert.equal(payload.sources.length, 1);
    assert.equal(payload.sources[0].versionId, id);
    assert.equal(payload.currentBody, undefined);
    fake.mock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "length" }] }),
        ),
    );
    await assert.rejects(
      () =>
        new CompatibleModelRuntime().generate(
          input,
          new AbortController().signal,
        ),
      /截断/,
    );
    fake.mock.mockImplementation(
      async () => new Response("private provider error", { status: 401 }),
    );
    await assert.rejects(
      () =>
        new CompatibleModelRuntime().generate(
          input,
          new AbortController().signal,
        ),
      /HTTP 401/,
    );
  } finally {
    Object.assign(modelConfig, saved);
  }
});

test("重复关闭Worker不会重复释放所有权连接", async () => {
  const { JobWorker } = await import("../server/jobs.js");
  let releases = 0;
  const worker: any = new JobWorker({
    generate: async () => {
      throw Error("不应调用");
    },
  });
  worker.owner = {
    execute: async () => {
      await new Promise((r) => setTimeout(r, 5));
    },
    release: () => {
      releases++;
    },
  };
  await Promise.all([worker.stop(), worker.stop(), worker.stop()]);
  assert.equal(releases, 1);
});
