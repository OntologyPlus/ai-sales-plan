export const documentKinds = [
  "customer",
  "tds",
  "sds",
  "application",
  "regulation",
  "case",
] as const;
export const kindLabels: Record<string, string> = {
  customer: "客户资料",
  tds: "TDS技术数据表",
  sds: "SDS安全数据表",
  application: "应用说明",
  regulation: "合规资料",
  case: "脱敏案例",
};
export type Citation = { versionId: string; quote: string; start: number };
export function validQuote(text: string, c: Citation) {
  return (
    Number.isInteger(c.start) &&
    c.start >= 0 &&
    c.quote.trim().length >= 4 &&
    text.slice(c.start, c.start + c.quote.length) === c.quote
  );
}
export function reviewRole(kind: string) {
  return ["sds", "regulation"].includes(kind)
    ? "compliance"
    : kind === "customer"
      ? "engineer"
      : "chemist";
}
export function chapterKinds(index: number) {
  return index === 1 || index === 2
    ? ["tds", "application"]
    : index === 5
      ? ["sds", "regulation"]
      : null;
}
export function kindSatisfies(index: number, kinds: string[]) {
  const required = chapterKinds(index);
  return !required || kinds.some((k) => required.includes(k));
}
