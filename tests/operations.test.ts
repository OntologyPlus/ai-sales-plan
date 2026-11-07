import test from "node:test";
import assert from "node:assert/strict";
import { extractRequirements } from "../shared/intake.js";
import { templateDefinitionSchema } from "../shared/templates.js";
import { sections } from "../shared/workflow.js";
test("本地需求提取保留精确字符位置，不将无关备注变成需求", () => {
  const text =
    "  客户要求强度不低于18 MPa。必须核对25℃铝基材。仅用于软件验证。";
  const list = extractRequirements(text);
  assert.equal(list.length, 2);
  for (const c of list)
    assert.equal(text.slice(c.start, c.start + c.quote.length), c.quote);
  assert.equal(extractRequirements("普通备注，没有可识别关键词。").length, 0);
});
test("模板允许竞品章节可选或停用，关键技术与安全章节不能取消", () => {
  const d = {
    name: "测试",
    industry: "",
    instruction: "",
    sections: sections.map((title, i) => ({
      title,
      required: i !== 3,
      enabled: i !== 3,
    })),
  };
  assert.doesNotThrow(() => templateDefinitionSchema.parse(d));
  assert.throws(() =>
    templateDefinitionSchema.parse({
      ...d,
      sections: d.sections.map((s, i) =>
        i === 5 ? { ...s, required: false, enabled: false } : s,
      ),
    }),
  );
  assert.throws(() =>
    templateDefinitionSchema.parse({ ...d, sections: d.sections.slice(0, 5) }),
  );
});
