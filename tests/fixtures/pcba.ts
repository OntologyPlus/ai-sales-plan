import { createHash } from "node:crypto";
import { pcbaFieldNames, type PcbaSource } from "../../shared/pcba.js";
import type { PcbaSnapshot } from "../../server/pcba-tools.js";

export function syntheticPcbaSnapshot(): PcbaSnapshot {
  const projectId = "synthetic-pcba-001";
  const values = {
    materials: "合成板件A；板材、阻焊、连接器及标识按模拟清单M-1记录，不代表已证实相容。",
    residues: "合成残留R-1；模拟焊接后助焊剂残留，组成和焊接历史仅为样板。",
    acceptance: "模拟方法SYNTHETIC-PCBA-TEST-1，残留指标不高于10合成指数，不是IPC或真实客户限值。",
    compatibility: "模拟敏感件及标识清单C-1；材料影响须另作技术确认，不预设通过。",
    process: "模拟基线P-1；观察到局部可见残留，原因尚未确定。",
    equipment: "模拟设备E-1；能力边界按样板记录，不直接提供执行参数。",
    rinseDry: "模拟漂洗干燥路径D-1，后续有涂覆需求；迁移仍需验证。",
    samples: "合成样品S-1、对照S-0及批次B-1；电气可靠性须按适用范围另行验证。",
  };
  const text = pcbaFieldNames.map(f => values[f]).join("\n");
  const customer: PcbaSource = { versionId: "synthetic-customer-v1", projectId, kind: "customer", text,
    sha256: createHash("sha256").update(text).digest("hex"), active: true, canRead: true, canUseModel: true };
  const performanceText = "合成性能记录：0至5合成指数；这不是实际产品性能或客户标准。";
  const tds: PcbaSource = { ...customer, versionId: "synthetic-tds-v1", kind: "tds", text: performanceText,
    sha256: createHash("sha256").update(performanceText).digest("hex") };
  return {
    synthetic: true,
    profile: { schemaVersion: 1, id: "pcba-profile-001", projectId, revision: 1,
      application: "pcba-cleaning", facts: pcbaFieldNames.map(field => {
        const quote = values[field];
        return { field, value: quote, status: "confirmed", citations: [{ versionId: customer.versionId,
          sha256: customer.sha256, quote, start: text.indexOf(quote) }] };
      }) },
    sources: [customer, tds],
    requirements: [{ id: "synthetic-r1", key: "syntheticResidueIndex", label: "残留指标（合成）",
      operator: "lte", min: null, max: 10, unit: "合成指数", conditions: "合成板件A / 模拟条件",
      method: "SYNTHETIC-PCBA-TEST-1", critical: true }],
    products: [{ id: "synthetic-product-A", name: "合成清洗候选A（非实际产品）", parameters: [{
      key: "syntheticResidueIndex", label: "残留指标（合成）", min: 0, max: 5, unit: "合成指数",
      conditions: "合成板件A / 模拟条件", method: "SYNTHETIC-PCBA-TEST-1", valueKind: "guaranteed",
      citation: { versionId: tds.versionId, quote: performanceText, start: 0 },
    }] }],
  };
}

export type PcbaCase = {
  id: string;
  split: "development" | "reserved";
  description: string;
  mutate: (s: PcbaSnapshot) => void;
  expected: { questions?: number; disposition?: string; error?: string };
};

// Reserved cases protect the engineering contract. They are NOT a blinded model-quality set.
export const pcbaCases: PcbaCase[] = [
  { id: "PCBA-01", split: "development", description: "完整合成输入只形成待验证候选", mutate: () => {}, expected: { questions: 0, disposition: "validation_candidate" } },
  ...pcbaFieldNames.map((field, i): PcbaCase => ({
    id: `PCBA-${String(i + 2).padStart(2, "0")}`, split: "development",
    description: `缺少${field}需追问`, mutate: s => { s.profile.facts = s.profile.facts.filter(f => f.field !== field); },
    expected: { questions: 1, disposition: "insufficient_evidence" },
  })),
  { id: "PCBA-10", split: "development", description: "典型值不作保证", mutate: s => { s.products[0].parameters[0].valueKind = "typical"; }, expected: { questions: 0, disposition: "insufficient_evidence" } },
  { id: "PCBA-11", split: "development", description: "不同工况不可直接套用", mutate: s => { s.products[0].parameters[0].conditions = "另一合成板件"; }, expected: { disposition: "insufficient_evidence" } },
  { id: "PCBA-12", split: "development", description: "SDS不证明性能", mutate: s => { s.sources[1].kind = "sds"; }, expected: { disposition: "insufficient_evidence" } },
  { id: "PCBA-13", split: "reserved", description: "CoA不能单独证明应用性能", mutate: s => { s.sources[1].kind = "coa"; }, expected: { disposition: "insufficient_evidence" } },
  { id: "PCBA-14", split: "reserved", description: "不同方法不可直接比较", mutate: s => { s.products[0].parameters[0].method = "另一模拟方法"; }, expected: { disposition: "insufficient_evidence" } },
  { id: "PCBA-15", split: "reserved", description: "保证范围不满足时排除", mutate: s => { s.requirements[0].operator = "gte"; s.requirements[0].min = 20; s.requirements[0].max = null; }, expected: { disposition: "excluded" } },
  { id: "PCBA-16", split: "reserved", description: "事实冲突不可绕过", mutate: s => { s.profile.facts[0].status = "conflicted"; }, expected: { questions: 1, disposition: "insufficient_evidence" } },
  { id: "PCBA-17", split: "reserved", description: "原文篡改拒绝使用", mutate: s => { s.sources[0].text += "变化"; }, expected: { error: "SOURCE_CHANGED" } },
  { id: "PCBA-18", split: "reserved", description: "外发未许可拒绝执行", mutate: s => { s.sources[0].canUseModel = false; }, expected: { error: "SOURCE_DENIED" } },
  { id: "PCBA-19", split: "reserved", description: "伪造原文定位拒绝", mutate: s => { s.profile.facts[0].citations[0].start = 1; }, expected: { error: "INVALID_CITATION" } },
  { id: "PCBA-20", split: "reserved", description: "零值不是缺失", mutate: s => { s.products[0].parameters[0].max = 0; s.requirements[0].max = 0; }, expected: { disposition: "validation_candidate" } },
];
