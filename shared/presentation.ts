export type DiffLine = { kind: "same" | "removed" | "added"; text: string };
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return before.split("\n").map(text => ({ kind: "same", text }));
  const a = before ? before.split(/\r?\n/) : [], b = after ? after.split(/\r?\n/) : [];
  // Bound memory for unusually large chapters; the two panes still show all text.
  if (a.length * b.length > 250000) return [...a.map(text => ({ kind: "removed" as const, text })), ...b.map(text => ({ kind: "added" as const, text }))];
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: "same", text: a[i++] }); j++; }
    else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) out.push({ kind: "removed", text: a[i++] });
    else out.push({ kind: "added", text: b[j++] });
  }
  return out;
}
