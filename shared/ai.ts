import { z } from "zod";
import { validQuote, kindSatisfies, type Citation } from "./evidence.js";
export type EvidenceInput = {
  id: string;
  title: string;
  kind: string;
  sha256: string;
  text: string;
  totalChars: number;
};
export type AiInput = {
  proposalId: string;
  edition: number;
  revision: number;
  sectionIndex: number;
  sectionTitle: string;
  scene: string;
  requirements: string;
  instruction: string;
  templateInstruction?: string;
  sources: EvidenceInput[];
  provider: string;
  model: string;
};
export const candidateSchema = z.object({
  content: z.string().trim().min(1).max(50000),
  citations: z
    .array(
      z.object({
        versionId: z.string().uuid(),
        quote: z.string().min(4).max(4000),
        start: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(30),
  gaps: z.array(z.string().max(500)).max(20).default([]),
});
export type Candidate = z.infer<typeof candidateSchema>;
export function parseCandidate(raw: string, input: AiInput): Candidate {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const c = candidateSchema.parse(JSON.parse(text));
  for (const ref of c.citations) {
    const source = input.sources.find((s) => s.id === ref.versionId);
    if (!source || !validQuote(source.text, ref))
      throw new Error("模型引文不属于已授权原文或位置不一致");
  }
  if (
    !kindSatisfies(
      input.sectionIndex,
      c.citations.map(
        (c: Citation) => input.sources.find((s) => s.id === c.versionId)!.kind,
      ),
    )
  )
    throw new Error("模型未引用本章节必需的资料类别");
  return c;
}
export function editableStatus(status: string) {
  return ["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(status);
}
