import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import mammoth from "mammoth";
import { renderApproval } from "../server/rendering/render.js";

const citation = { versionId: "tds-v2", start: 17, quote: "中文原文<&>：仅适用于已验证工况。\n第二行引用。" };
const customerCitation = { versionId: "customer-v1", start: 0, quote: "客户已确认需求原文" };
const riskCitation = { versionId: "sds-v1", start: 23, quote: "风险补证原文" };
const payload = () => ({
  snapshot: {
    title: "中文方案 <甲 & 乙>", code: "SP-TEST", scene: "耐温应用", edition: 2, revision: 7,
    customer: { name: "测试客户" },
    body: {
      requirements: "需求第一行\n需求第二行",
      confirmedRequirements: [customerCitation],
      sections: [
        { title: "技术方案", content: "## 试验条件\n工况 <80℃ & 湿度>\n### 验证方法\n操作说明", evidence: "待补充客户样品", citations: [citation] },
        { title: "停用章节", enabled: false, content: "不应导出的停用内容", citations: [riskCitation] },
        { title: "可选空章", required: false, content: "  " },
        { title: "安全说明", required: false, content: "保留可选非空内容", citations: [citation] },
      ],
    },
    matchingSnapshot: { products: [{
      code: "PRODUCT-1", name: "合成测试产品", specVersion: 3,
      parameters: [{ citation }],
      results: Array.from({ length: 80 }, (_, i) => ({
        label: `参数${i + 1}`, requirement: "18 MPa", actual: "20 ~ 25 MPa",
        status: i === 0 ? "validation" : "match", reason: `判断原因${i + 1}`,
      })),
    }] },
    riskSnapshot: [{ title: "风险复核", owner_name: "责任工程师", status: "closed", note: "已独立复核", evidence: JSON.stringify([riskCitation, citation]) }],
    evidenceVersions: [{ id: citation.versionId, title: "产品技术资料", version: 2, sha256: "original-sha256" }],
  },
  requestId: "approval-2", approvedOn: "2026/11/3 11:00:00", snapshotHash: "approved-snapshot-sha256",
  steps: [
    { role: "chemist", name: "化学师甲", decidedAt: "2026/11/3 09:00:00", comment: "技术通过" },
    { role: "compliance", name: "合规乙", decidedAt: "2026/11/3 10:00:00", comment: "安全通过" },
    { role: "leader", name: "领导丙", decidedAt: "2026/11/3 11:00:00", comment: "" },
  ],
});

test("Node直接生成Word，保留批准内容、长表、去重引用及三段审批", async () => {
  const { docx, ...other } = await renderApproval(payload());
  assert.deepEqual(other, {}, "只生成Word成果");
  const { value } = await mammoth.extractRawText({ buffer: docx });
  for (const expected of [
    "中文方案 <甲 & 乙>", "V2  修订7  已批准", "SP-TEST", "approval-2", "测试客户",
    "需求第一行", "需求第二行", "PRODUCT-1", "参数版本 3", "参数80", "判断原因80",
    "待验证", "满足已知阈值", "试验条件", "验证方法", "工况 <80℃ & 湿度>",
    "待补充客户样品", "保留可选非空内容", "本章原文引用  1",
    citation.quote.split("\n")[0], "第二行引用。", customerCitation.quote, riskCitation.quote,
    "引用 1  产品技术资料  V2", "原件指纹 original-sha256", "提取文本字符位置 17",
    "风险复核", "责任工程师", "已关闭", "已独立复核",
    "应用化学师", "化学师甲", "技术通过", "合规专员", "合规乙", "安全通过",
    "审批领导", "领导丙", "2026/11/3 11:00:00", "通过", "批准快照指纹 approved-snapshot-sha256",
  ]) assert.ok(value.includes(expected), `缺失导出内容：${expected}`);
  assert.ok(!value.includes("停用章节"));
  assert.ok(!value.includes("不应导出的停用内容"));
  assert.ok(!value.includes("可选空章"));
  assert.equal(value.split(citation.quote.split("\n")[0]).length - 1, 1, "跨章节/参数/风险引用去重");
  assert.ok(!value.includes("引用 4"));
});

test("Word包含A4页面、可重复表头、中文字体和页码域", async () => {
  const { docx } = await renderApproval(payload());
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file("word/document.xml")!.async("string");
  const styles = await zip.file("word/styles.xml")!.async("string");
  const footer = await zip.file("word/footer1.xml")!.async("string");
  const pageSize = xml.match(/<w:pgSz[^>]+>/)?.[0] ?? "";
  const width = Number(pageSize.match(/w:w="(\d+)"/)?.[1]);
  const height = Number(pageSize.match(/w:h="(\d+)"/)?.[1]);
  assert.ok(Math.abs(width * 25.4 / 1440 - 210) < 0.05, "页面宽度为A4");
  assert.ok(Math.abs(height * 25.4 / 1440 - 297) < 0.05, "页面高度为A4");
  assert.match(xml, /w:tblHeader/);
  assert.match(xml, /w:cantSplit/);
  assert.match(styles, /w:eastAsia="[^"]+"/);
  assert.match(footer, /PAGE/);
  assert.ok(xml.includes("&lt;甲 &amp; 乙&gt;"), "正文XML正确转义");
});

test("未登记产品与引用时仍可生成Word，必填空章保留", async () => {
  const input = payload();
  input.snapshot.matchingSnapshot.products = [];
  input.snapshot.body.sections = [{ title: "必填待补", required: true, content: "", citations: [] }];
  input.snapshot.body.confirmedRequirements = [];
  input.snapshot.riskSnapshot = [];
  const { docx } = await renderApproval(input);
  const { value } = await mammoth.extractRawText({ buffer: docx });
  assert.ok(value.includes("本版本未登记结构化产品匹配"));
  assert.ok(value.includes("必填待补"));
  assert.ok(value.includes("审批记录"));
  assert.ok(!value.includes("引用 1"));
});
