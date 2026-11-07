import { mkdir, writeFile } from "node:fs/promises";
import { renderApproval } from "../server/rendering/render.js";
import { sections } from "../shared/workflow.js";
const out = new URL("../data/qa/", import.meta.url);
await mkdir(out, { recursive: true });
const citation = {
  versionId: "6a1d1429-e270-4b0b-9ee9-29b10f943fd7",
  quote: "合成技术资料，仅用于软件排版测试，不构成实际产品推荐。",
  start: 0,
};
const results = Array.from({ length: 24 }, (_, i) => ({
  label: `参数${i + 1} 基材及耐受条件`,
  requirement: "18 ~ 未知 MPa",
  actual: "20 ~ 25 MPa",
  status: i % 4 === 0 ? "validation" : "match",
  reason:
    i % 4 === 0
      ? "仅有典型值，需要结合真实工况进一步核实适用边界。"
      : "同工况及方法下，保证范围满足已知阈值",
}));
const payload = {
  snapshot: {
    id: "sample",
    title: "合成示例应用方案",
    code: "SP-QA-20261103",
    scene: "化学药剂应用方案软件验收",
    edition: 1,
    revision: 3,
    customer: { name: "合成验证客户" },
    riskSnapshot: [
      {
        title: "合成风险事项",
        owner_name: "工程验证员",
        status: "closed",
        note: "已补充原文并经独立专业复核，仅用于软件验收。",
        evidence: [citation],
      },
    ],
    body: {
      confirmedRequirements: [{ ...citation, text: "合成已确认需求" }],
      requirements:
        "客户要求在明确基材、温度、方法与使用边界后比较候选产品。本样本使用合成资料，专门检查中文分页、长表格、引用和审批记录。",
      sections: sections.map((title, i) => ({
        title,
        enabled: i !== 3,
        required: i !== 3,
        content: Array.from(
          { length: 4 },
          (_, j) =>
            `本节第${j + 1}项验证说明。应分别记录客户需求、技术资料和适用边界。未知的数据保持待确认，不通过文字推断补出测试结果。参数的单位、工况和方法必须对应，具体适用性须经专业人员复核。`,
        ).join("\n"),
        evidence:
          i === 4
            ? "仍需真实客户样品验证。"
            : "适用边界以原文依据及审核意见为准。",
        citations: [citation],
      })),
    },
    evidenceVersions: [
      {
        id: citation.versionId,
        title: "合成TDS排版样本",
        version: 2,
        sha256: "0123456789abcdef".repeat(4),
      },
    ],
    matchingSnapshot: {
      products: [
        {
          code: "QA-01",
          name: "合成验证产品",
          specVersion: 2,
          parameters: [{ citation }],
          results,
        },
      ],
    },
  },
  requestId: "15d5fcb8-a731-4961-b513-cdceee080a11",
  snapshotHash: "fedcba9876543210".repeat(4),
  approvedOn: "2026/11/3 11:00:00",
  steps: [
    {
      role: "chemist",
      name: "技术验证员",
      decidedAt: "2026/11/3 09:00:00",
      comment: "合成场景，仅验证输出排版。",
    },
    {
      role: "compliance",
      name: "合规验证员",
      decidedAt: "2026/11/3 10:00:00",
      comment: "检查引用及安全说明版式。",
    },
    {
      role: "leader",
      name: "审批验证员",
      decidedAt: "2026/11/3 11:00:00",
      comment: "同意用于软件输出验证。",
    },
  ],
};
const result = await renderApproval(payload);
await writeFile(new URL("proposal.docx", out), result.docx);
console.log("中文长表格Word样板已生成到data/qa/proposal.docx，供排版检查。");
