import test from "node:test";
import assert from "node:assert/strict";
import { assessPcbaProfile, pcbaProfileSchema } from "../shared/pcba.js";
import { createPcbaToolbox, PcbaBoundaryError } from "../server/pcba-tools.js";
import { pcbaCases, syntheticPcbaSnapshot } from "./fixtures/pcba.js";

for (const sample of pcbaCases) test(`${sample.id} ${sample.description}`, async () => {
  const snapshot = syntheticPcbaSnapshot(); sample.mutate(snapshot);
  const tools = createPcbaToolbox(snapshot, () => {});
  if (sample.expected.error) {
    await assert.rejects(tools.compareProducts(), (e: unknown) => e instanceof PcbaBoundaryError && e.code === sample.expected.error);
    return;
  }
  const result = await tools.compareProducts();
  if (sample.expected.questions !== undefined) assert.equal(result.assessment.questions.length, sample.expected.questions);
  if (sample.expected.disposition) assert.equal(result.candidates[0].disposition, sample.expected.disposition);
  assert.equal(result.candidates[0].professionalApproval, false);
});

test("当前授权在每次调用复核，快照不能冻结旧许可", async () => {
  let allowed = true;
  const tools = createPcbaToolbox(syntheticPcbaSnapshot(), () => { if (!allowed) throw new Error("REVOKED"); });
  await tools.readProfile(); allowed = false;
  await assert.rejects(tools.readEvidence("synthetic-tds-v1"), /REVOKED/);
  await assert.rejects(tools.prepareValidationPlan(), /REVOKED/);
});

test("候选事实、空值、重复字段和无出处不能直接进入已就绪", () => {
  const s = syntheticPcbaSnapshot(); s.profile.facts[0].status = "candidate";
  assert.equal(assessPcbaProfile(s.profile).questions[0].reason, "unconfirmed");
  s.profile.facts[0].value = null;
  assert.equal(assessPcbaProfile(s.profile).questions[0].reason, "missing");
  s.profile.facts.push(s.profile.facts[0]);
  assert.equal(pcbaProfileSchema.safeParse(s.profile).success, false);
});

test("跨项目、失效、未知来源和引用指纹均阻断", async () => {
  for (const change of [
    (s: ReturnType<typeof syntheticPcbaSnapshot>) => { s.sources[0].projectId = "other"; },
    (s: ReturnType<typeof syntheticPcbaSnapshot>) => { s.sources[0].active = false; },
    (s: ReturnType<typeof syntheticPcbaSnapshot>) => { s.profile.facts[0].citations[0].versionId = "other"; },
    (s: ReturnType<typeof syntheticPcbaSnapshot>) => { s.profile.facts[0].citations[0].sha256 = "0".repeat(64); },
  ]) {
    const s = syntheticPcbaSnapshot(); change(s);
    await assert.rejects(createPcbaToolbox(s, () => {}).readProfile(), PcbaBoundaryError);
  }
});

test("读取返回副本，缺指标不等于全部满足，验证计划无执行参数", async () => {
  const s = syntheticPcbaSnapshot();
  const tools = createPcbaToolbox(s, () => {});
  const first = await tools.readProfile(); first.profile.facts.length = 0;
  s.profile.facts.length = 0;
  assert.equal((await tools.readProfile()).profile.facts.length, 8);
  await assert.rejects(tools.readEvidence("unselected"), PcbaBoundaryError);
  const plan = await tools.prepareValidationPlan();
  assert.equal(plan.operatingParameters, null); assert.equal(plan.professionalApproval, false);
  const empty = syntheticPcbaSnapshot(); empty.requirements = [];
  assert.equal((await createPcbaToolbox(empty, () => {}).compareProducts()).candidates[0].disposition, "insufficient_evidence");
});
