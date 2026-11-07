import { z } from "zod";
import { pcbaProfileSchema, pcbaCitationSchema, pcbaFields, type PcbaField, type PcbaCitation } from "./pcba.js";

export const pcbaFactSchema = pcbaProfileSchema.shape.facts.element.extend({
  value: z.string().trim().min(1).max(4000).nullable(),
  citations: z.array(pcbaCitationSchema.extend({ versionId: z.string().uuid(), quote: z.string().min(4).max(4000) })).max(3),
});
export type PcbaFact = z.infer<typeof pcbaFactSchema>;
export const pcbaSaveSchema = z.object({
  requestId: z.string().uuid(),
  expectedEdition: z.number().int().positive(),
  expectedProposalRevision: z.number().int().positive(),
  expectedProfileRevision: z.number().int().nonnegative(),
  changes: z.array(pcbaFactSchema).min(1).max(8),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.changes.map(f => f.field)).size !== b.changes.length)
    ctx.addIssue({ code: "custom", message: "不能重复提交同一个档案字段" });
  for (const f of b.changes)
    if (f.status === "confirmed" && (!f.value || !f.citations.length))
      ctx.addIssue({ code: "custom", message: `${pcbaFields[f.field].label}确认前需要有效内容与原文依据` });
});

const patterns: Record<PcbaField, RegExp> = {
  materials: /基材|板材|板件|阻焊|连接器/,
  residues: /助焊剂|残留物|焊接历史|污染物/,
  acceptance: /验收|限值|判据|离子污染|表面绝缘电阻/,
  compatibility: /敏感|相容|兼容|标识|材料影响/,
  process: /现用|现有工艺|基线|白斑|异常/,
  equipment: /设备|喷淋|超声|清洗机/,
  rinseDry: /漂洗|干燥|后续涂覆/,
  samples: /样品|批次|对照|试验载体/,
};

/** Explicitly local rules, not a model judgement. Outputs remain unconfirmed. */
export function suggestPcbaFacts(text: string, source: Pick<PcbaCitation, "versionId" | "sha256">): PcbaFact[] {
  const parts = [...text.matchAll(/[^\n。；]+[。；]?/g)];
  return (Object.keys(patterns) as PcbaField[]).flatMap(field => {
    const hit = parts.find(m => m[0].trim().length >= 4 && patterns[field].test(m[0]));
    if (!hit) return [];
    const quote = hit[0].trim().slice(0, 1200);
    return [{ field, value: quote, status: "candidate" as const,
      citations: [{ ...source, quote, start: hit.index! + hit[0].indexOf(quote) }] }];
  });
}
