export type Requirement = {
  id: string;
  key: string;
  label: string;
  operator: "gte" | "lte" | "between";
  min: number | null;
  max: number | null;
  unit: string;
  conditions: string;
  method: string;
  critical: boolean;
};
export type Parameter = {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
  unit: string;
  conditions: string;
  method: string;
  valueKind: "guaranteed" | "typical" | "unknown";
  citation: { versionId: string; quote: string; start: number };
};
export type MatchResult = {
  key: string;
  label: string;
  status: "match" | "mismatch" | "unknown" | "validation";
  reason: string;
  requirement: string;
  actual: string;
  critical: boolean;
};
const units: Record<string, [string, number]> = {
  Pa: ["pressure", 1],
  kPa: ["pressure", 1000],
  MPa: ["pressure", 1000000],
  s: ["time", 1],
  min: ["time", 60],
  h: ["time", 3600],
  "℃": ["temperature", 1],
  "°C": ["temperature", 1],
  "mg/L": ["concentration", 0.001],
  "g/L": ["concentration", 1],
  "mPa·s": ["viscosity", 0.001],
  "Pa·s": ["viscosity", 1],
  "%": ["percent", 1],
  N: ["force", 1],
  mm: ["length", 1],
  cm: ["length", 10],
  m: ["length", 1000],
};
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function convert(
  value: number,
  from: string,
  to: string,
): number | null {
  if (from === to && from.trim()) return value;
  const a = units[from],
    b = units[to];
  return a && b && a[0] === b[0] ? (value * a[1]) / b[1] : null;
}
export function compare(r: Requirement, p?: Parameter): MatchResult {
  const interval = (lo: number | null, hi: number | null, unit: string) =>
    `${lo ?? "未知"} ~ ${hi ?? "未知"} ${unit}`;
  const base = {
    key: r.key,
    label: r.label,
    critical: r.critical,
    requirement: interval(
      r.operator === "lte" ? null : r.min,
      r.operator === "gte" ? null : r.max,
      r.unit,
    ),
    actual: p ? interval(p.min, p.max, p.unit) : "无参数",
  };
  const result = (
    status: MatchResult["status"],
    reason: string,
  ): MatchResult => ({ ...base, status, reason });
  if (!p) return result("unknown", "未提供对应参数");
  if (
    !r.conditions.trim() ||
    !r.method.trim() ||
    !p.conditions.trim() ||
    !p.method.trim()
  )
    return result("unknown", "工况或测试方法尚未确认");
  if (
    normalize(r.conditions) !== normalize(p.conditions) ||
    normalize(r.method) !== normalize(p.method)
  )
    return result("unknown", "工况或测试方法不同，不能直接比较");
  const lo = p.min === null ? null : convert(p.min, p.unit, r.unit),
    hi = p.max === null ? null : convert(p.max, p.unit, r.unit);
  if ((p.min !== null && lo === null) || (p.max !== null && hi === null))
    return result("unknown", "单位不兼容或未配置换算");
  if (p.valueKind === "unknown" || (lo === null && hi === null))
    return result("unknown", "参数范围或数值性质未知");
  const min = r.operator === "lte" ? null : r.min,
    max = r.operator === "gte" ? null : r.max;
  if (
    (min === null && max === null) ||
    (r.operator === "between" && (min === null || max === null))
  )
    return result("unknown", "客户阈值尚未确认");
  const less = (a: number, b: number) =>
    a < b - Math.max(1, Math.abs(a), Math.abs(b)) * Number.EPSILON * 8;
  const outside =
    (min !== null && hi !== null && less(hi, min)) ||
    (max !== null && lo !== null && less(max, lo));
  if (p.valueKind === "typical")
    return result(
      "validation",
      outside
        ? "典型值与需求不符，仍需实际验证"
        : "仅有典型值，不能作为保证指标",
    );
  if (outside) return result("mismatch", "已知参数范围与客户阈值不相交");
  const inside =
    (min === null || (lo !== null && !less(lo, min))) &&
    (max === null || (hi !== null && !less(max, hi)));
  return inside
    ? result("match", "同工况及方法下，保证范围满足已知阈值")
    : result("validation", "范围仅部分满足或缺少边界，需进一步验证");
}
export const matchLabels: Record<string, string> = {
  match: "满足已知阈值",
  mismatch: "不满足",
  unknown: "无法判定",
  validation: "待验证",
};
