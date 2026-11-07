import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { syntheticPcbaSnapshot } from "../tests/fixtures/pcba.js";
import { openPcbaPoc, pcbaPocPolicyVersion } from "./poc/pcba-runtime.js";

await mkdir("data/qa/pcba-g1", { recursive: true });
const dir = await mkdtemp("data/qa/pcba-g1/session-");
const path = join(dir, "session.sqlite");
const snapshot = syntheticPcbaSnapshot();
snapshot.profile.facts = snapshot.profile.facts.filter(f => f.field !== "materials");
const observations = { modelRequests: 0, tools: [] as string[] };
let allowed = true;
const guard = () => { if (!allowed) throw new Error("REVOKED"); };
const first = await openPcbaPoc(path, snapshot, guard, observations);
let result: Awaited<ReturnType<typeof first.run>>;
try { result = await first.run(); } finally { await first.close(); }
assert.equal(result.result.profile.assessment.questions[0].field, "materials");
assert.equal(result.result.comparison.candidates[0].disposition, "insufficient_evidence");
assert.deepEqual(observations.tools, ["read_application", "read_evidence", "compare_products", "prepare_validation"]);
const counts = structuredClone(observations);
const reopened = await openPcbaPoc(path, snapshot, guard, observations);
try {
  const again = await reopened.run();
  assert.equal(again.submissionId, result.submissionId);
  assert.deepEqual(again.result, result.result);
  assert.deepEqual(observations, counts, "重复请求不能再调用模型或工具");
  allowed = false;
  await assert.rejects(reopened.run(), /REVOKED/);
} finally { await reopened.close(); }
const report = { generatedAt: new Date().toISOString(), policy: pcbaPocPolicyVersion, synthetic: true,
  runtime: "real-pi-1.4.0", provider: "in-process-scripted-fixture", externalModelCalls: 0,
  observations, completedReopenIdempotency: true, revocationBlocked: true,
  crashRecoveryTested: false, modelQualityEvaluated: false, professionalSignoff: false,
  result: result.result };
await writeFile("data/qa/pcba-g1/result.json", JSON.stringify(report, null, 2) + "\n");
console.log(`PCBA Pi PoC passed: ${observations.modelRequests} scripted responses, ${observations.tools.length} real tool executions; completed session reopened without duplicate execution; revoked access blocked.`);
console.log("Report: data/qa/pcba-g1/result.json (not a model-quality or crash-recovery signoff)");
