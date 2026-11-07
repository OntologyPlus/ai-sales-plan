import { mkdir, writeFile } from "node:fs/promises";
import { createPcbaToolbox, PcbaBoundaryError } from "../server/pcba-tools.js";
import { pcbaCases, syntheticPcbaSnapshot } from "../tests/fixtures/pcba.js";

const results = [];
for (const sample of pcbaCases) {
  const snapshot = syntheticPcbaSnapshot(); sample.mutate(snapshot);
  let actual: { error?: string; questions?: number; disposition?: string };
  try {
    const value = await createPcbaToolbox(snapshot, () => {}).compareProducts();
    actual = { questions: value.assessment.questions.length, disposition: value.candidates[0].disposition };
  } catch (e) {
    if (!(e instanceof PcbaBoundaryError)) throw e;
    actual = { error: e.code };
  }
  const passed = Object.entries(sample.expected).every(([key, value]) => actual[key as keyof typeof actual] === value) &&
    (sample.expected.error !== undefined || actual.error === undefined);
  results.push({ id: sample.id, split: sample.split, description: sample.description, passed, expected: sample.expected, actual });
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), synthetic: true,
  scope: "deterministic-engineering-contracts", modelQualityEvaluated: false, professionalSignoff: false,
  passed: results.filter(r => r.passed).length, total: results.length, results };
await mkdir("data/qa/pcba-g0", { recursive: true });
await writeFile("data/qa/pcba-g0/result.json", JSON.stringify(report, null, 2) + "\n");
console.log(`PCBA G0: ${report.passed}/${report.total} engineering cases passed; synthetic data, no model calls or professional signoff.`);
console.log("Report: data/qa/pcba-g0/result.json");
if (report.passed !== report.total) process.exitCode = 1;
