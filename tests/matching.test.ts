import test from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  convert,
  type Parameter,
  type Requirement,
} from "../shared/matching.js";
const r: Requirement = {
  id: "x",
  key: "强度",
  label: "强度",
  operator: "gte",
  min: 18000,
  max: null,
  unit: "kPa",
  conditions: "25℃ 铝基材",
  method: "测试方法 A",
  critical: true,
};
const p: Parameter = {
  key: "强度",
  label: "强度",
  min: 20,
  max: 25,
  unit: "MPa",
  conditions: "25℃ 铝基材",
  method: "测试方法 A",
  valueKind: "guaranteed",
  citation: { versionId: "x", quote: "合成验证原文", start: 0 },
};
test("同工况方法的保证范围按压力及时间单位转换判断", () => {
  assert.equal(convert(1, "h", "min"), 60);
  assert.equal(convert(1, "MPa", "kPa"), 1000);
  assert.equal(convert(1, "℃", "MPa"), null);
  assert.equal(compare(r, p).status, "match");
  assert.equal(compare({ ...r, min: 30000 }, p).status, "mismatch");
  assert.equal(compare({ ...r, min: 22000 }, p).status, "validation");
});
test("典型值、未知值、异工况、异方法和异维度不作满足承诺", () => {
  assert.equal(compare(r, { ...p, valueKind: "typical" }).status, "validation");
  assert.equal(compare(r, { ...p, min: null, max: null }).status, "unknown");
  assert.equal(
    compare(r, { ...p, conditions: "60℃ 铝基材" }).status,
    "unknown",
  );
  assert.equal(compare(r, { ...p, method: "不同标准" }).status, "unknown");
  assert.equal(compare(r, { ...p, unit: "h" }).status, "unknown");
  assert.equal(compare({ ...r, min: null }, p).status, "unknown");
});
test("零值不当缺失，区间必须整体满足，浮点换算容差不抹去实际差异", () => {
  assert.equal(
    compare({ ...r, min: 0, unit: "MPa" }, { ...p, min: 0, max: 0 }).status,
    "match",
  );
  assert.equal(
    compare({ ...r, operator: "between", min: 19, max: 26, unit: "MPa" }, p)
      .status,
    "match",
  );
  assert.equal(
    compare({ ...r, operator: "between", min: 21, max: 26, unit: "MPa" }, p)
      .status,
    "validation",
  );
  assert.equal(
    compare({ ...r, min: 20000.1 }, { ...p, min: 20, max: 20 }).status,
    "mismatch",
  );
});

test("大数量级的可表示差异仍判定不满足", () => {
  assert.equal(
    compare(
      { ...r, min: 100000000000.1, unit: "MPa" },
      { ...p, min: 100000000000, max: 100000000000 },
    ).status,
    "mismatch",
  );
});
