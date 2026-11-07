import test from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../shared/presentation.js";
test("正文对照保留重复行及中文，双方均可完整还原", () => {
  for (const [a, b] of [["甲\n重复\n乙\n重复", "甲\n重复\n丙\n重复"], ["", "新增"], ["删除", ""], ["不变", "不变"], ["<script>\n安全", "<script>\n更正"], ["甲\r\n乙", "甲\n丙"]]) {
    const lines = diffLines(a, b);
    assert.equal(lines.filter(l => l.kind !== "added").map(l => l.text).join("\n"), a.replaceAll("\r\n", "\n"));
    assert.equal(lines.filter(l => l.kind !== "removed").map(l => l.text).join("\n"), b.replaceAll("\r\n", "\n"));
  }
});
test("超长章节对照限制计算规模，保留双方全部正文", () => {
  const before = Array.from({ length: 600 }, (_, i) => `原文${i}`).join("\n");
  const after = Array.from({ length: 600 }, (_, i) => `候选${i}`).join("\n");
  const lines = diffLines(before, after);
  assert.equal(lines.filter(l => l.kind !== "added").map(l => l.text).join("\n"), before);
  assert.equal(lines.filter(l => l.kind !== "removed").map(l => l.text).join("\n"), after);
});
