import { createHash } from "node:crypto";
import { z } from "zod";
import { compare, type Parameter, type Requirement } from "../shared/matching.js";
import { assessPcbaProfile, pcbaProfileSchema, pcbaSourceSchema,
  type PcbaCitation, type PcbaSource } from "../shared/pcba.js";

const citation = z.object({ versionId: z.string().min(1), quote: z.string().min(4), start: z.number().int().nonnegative() }).strict();
const numeric = z.number().finite().nullable();
const requirement = z.object({ id: z.string(), key: z.string(), label: z.string(),
  operator: z.enum(["gte", "lte", "between"]), min: numeric, max: numeric,
  unit: z.string(), conditions: z.string(), method: z.string(), critical: z.boolean(),
}).strict().superRefine((r, ctx) => {
  if (r.min !== null && r.max !== null && r.min > r.max)
    ctx.addIssue({ code: "custom", message: "需求上下界颠倒" });
});
const parameter = z.object({ key: z.string(), label: z.string(), min: numeric, max: numeric,
  unit: z.string(), conditions: z.string(), method: z.string(),
  valueKind: z.enum(["guaranteed", "typical", "unknown"]), citation,
}).strict().superRefine((p, ctx) => {
  if (p.min !== null && p.max !== null && p.min > p.max)
    ctx.addIssue({ code: "custom", message: "参数上下界颠倒" });
});
export const pcbaSnapshotSchema = z.object({
  synthetic: z.literal(true),
  profile: pcbaProfileSchema,
  sources: z.array(pcbaSourceSchema).max(20),
  requirements: z.array(requirement).max(40),
  products: z.array(z.object({ id: z.string().min(1), name: z.string().min(1),
    parameters: z.array(parameter).max(40) }).strict()).max(20),
}).strict().superRefine((s, ctx) => {
  for (const ids of [s.sources.map(x => x.versionId), s.products.map(x => x.id), s.requirements.map(x => x.key)])
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "对象标识重复" });
  for (const p of s.products)
    if (new Set(p.parameters.map(x => x.key)).size !== p.parameters.length)
      ctx.addIssue({ code: "custom", message: "产品参数键重复" });
});
export type PcbaSnapshot = z.infer<typeof pcbaSnapshotSchema>;

export class PcbaBoundaryError extends Error {
  constructor(public readonly code: "SOURCE_DENIED" | "SOURCE_CHANGED" | "INVALID_CITATION") {
    super(code); this.name = "PcbaBoundaryError";
  }
}

function checkSource(source: PcbaSource, projectId: string) {
  if (source.projectId !== projectId || !source.canRead || !source.canUseModel || !source.active)
    throw new PcbaBoundaryError("SOURCE_DENIED");
  if (createHash("sha256").update(source.text).digest("hex") !== source.sha256)
    throw new PcbaBoundaryError("SOURCE_CHANGED");
}

function checkCitation(ref: Omit<PcbaCitation, "sha256"> & { sha256?: string }, sources: PcbaSource[]) {
  const source = sources.find(s => s.versionId === ref.versionId);
  if (!source || (ref.sha256 !== undefined && ref.sha256 !== source.sha256) ||
      source.text.slice(ref.start, ref.start + ref.quote.length) !== ref.quote)
    throw new PcbaBoundaryError("INVALID_CITATION");
  return source;
}

/** PoC tools only. Production must supply a current server-side ACL/revision guard. */
export function createPcbaToolbox(input: unknown, assertCurrent: () => void | Promise<void>) {
  // Parse once to detach from the caller's mutable object. Recheck grants before every read.
  const snapshot = pcbaSnapshotSchema.parse(input);
  async function guard() {
    await assertCurrent();
    for (const s of snapshot.sources) checkSource(s, snapshot.profile.projectId);
    for (const f of snapshot.profile.facts)
      for (const ref of f.citations) checkCitation(ref, snapshot.sources);
    for (const product of snapshot.products)
      for (const p of product.parameters) checkCitation(p.citation, snapshot.sources);
  }
  return {
    async readProfile() {
      await guard();
      return structuredClone({ profile: snapshot.profile, assessment: assessPcbaProfile(snapshot.profile) });
    },
    async readEvidence(versionId: string) {
      await guard();
      const source = snapshot.sources.find(s => s.versionId === versionId);
      if (!source) throw new PcbaBoundaryError("SOURCE_DENIED");
      return structuredClone(source);
    },
    async compareProducts() {
      await guard();
      const assessment = assessPcbaProfile(snapshot.profile);
      const candidates = snapshot.products.map(product => {
        const results = snapshot.requirements.map((r: Requirement) => {
          const p: Parameter | undefined = product.parameters.find(p => p.key === r.key);
          const source = p ? checkCitation(p.citation, snapshot.sources) : undefined;
          // A genuine quote in an SDS/CoA is not proof of application performance.
          if (source && !["tds", "test"].includes(source.kind))
            return { ...compare(r), reason: "此来源类型不能作为本工具的应用性能依据" };
          return compare(r, p);
        });
        const excluded = results.some(r => r.critical && r.status === "mismatch");
        const enough = snapshot.requirements.length > 0 &&
          assessment.questions.length === 0 && results.every(r => r.status === "match");
        return { id: product.id, name: product.name, results,
          disposition: excluded ? "excluded" as const : enough ? "validation_candidate" as const : "insufficient_evidence" as const,
          // Parameter comparisons never grant complete PCBA reliability/compatibility approval.
          professionalApproval: false as const };
      });
      return { assessment, candidates, synthetic: true as const };
    },
    async prepareValidationPlan() {
      await guard();
      return { status: "draft_requires_technical_review" as const,
        openQuestions: assessPcbaProfile(snapshot.profile).questions,
        checks: ["确认客户验收方法和判据，不内置通用离子残留限值", "记录样品/批次、板件或试验载体与对照",
          "记录设备、方法和实际条件及偏离", "核对材料/元件/标识影响及漂洗干燥", "按技术确认的适用方法核验残留与必要的电气可靠性",
          "保存原始值、缺测、异常与独立技术结论"],
        operatingParameters: null, professionalApproval: false as const };
    },
  };
}
