export type RequirementCandidate = {
  id: string;
  versionId: string;
  quote: string;
  start: number;
  text: string;
  sha256: string;
};
/** Local extraction deliberately proposes text only; it never invents numeric fields. */
export function extractRequirements(text: string) {
  const candidates: { quote: string; start: number }[] = [];
  const pattern = /[^\n。；]+/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim();
    if (
      value.length < 4 ||
      !/(需求|要求|必须|应当|不得|不低于|不高于|至少|不超过|≥|≤|>=|<=|温度|基材|固化|强度|适用|约束)/.test(
        value,
      )
    )
      continue;
    const start = match.index! + match[0].indexOf(value);
    candidates.push({ quote: value.slice(0, 1200), start });
    if (candidates.length >= 40) break;
  }
  return candidates;
}
