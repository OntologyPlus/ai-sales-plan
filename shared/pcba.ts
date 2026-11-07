import { z } from "zod";

/** Engineering vocabulary, not a released customer process or test standard. */
export const pcbaFields = {
  materials: { label: "板件、组件与材料", why: "影响材料相容性和候选适用范围", priority: 1 },
  residues: { label: "残留物与焊接历史", why: "影响清洗对象及验证路线", priority: 1 },
  acceptance: { label: "客户验收指标、方法与限值", why: "决定如何判断效果；外观、离子残留与电气可靠性不可互相替代", priority: 1 },
  compatibility: { label: "敏感元件、涂层与标识限制", why: "需验证元件、材料和标识影响，不能只检查去污效果", priority: 1 },
  process: { label: "现有清洗过程与异常", why: "建立对照，区分客户观察和原因假设", priority: 2 },
  equipment: { label: "设备与可用工艺", why: "实验条件不能自动迁移到客户设备", priority: 2 },
  rinseDry: { label: "漂洗、干燥与后续过程", why: "清洗、残留和后续涂覆等条件需要一起核对", priority: 2 },
  samples: { label: "样品批次、对照与验证对象", why: "原板、试验载体及客户现场结果的适用范围不同", priority: 2 },
} as const;
export type PcbaField = keyof typeof pcbaFields;
export const pcbaFieldNames = Object.keys(pcbaFields) as PcbaField[];

export const pcbaCitationSchema = z.object({
  versionId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  quote: z.string().min(4),
  start: z.number().int().nonnegative(),
}).strict();

export const pcbaProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  application: z.literal("pcba-cleaning"),
  facts: z.array(z.object({
    field: z.enum(pcbaFieldNames as [PcbaField, ...PcbaField[]]),
    value: z.string().trim().min(1).nullable(),
    status: z.enum(["candidate", "confirmed", "conflicted"]),
    citations: z.array(pcbaCitationSchema),
  }).strict()).max(pcbaFieldNames.length),
}).strict().superRefine((profile, ctx) => {
  if (new Set(profile.facts.map(f => f.field)).size !== profile.facts.length)
    ctx.addIssue({ code: "custom", message: "同一字段不能静默保存多份当前事实" });
});
export type PcbaProfile = z.infer<typeof pcbaProfileSchema>;
export type PcbaCitation = z.infer<typeof pcbaCitationSchema>;

export const pcbaSourceSchema = z.object({
  versionId: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.enum(["customer", "tds", "sds", "coa", "test", "case"]),
  text: z.string().max(200_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  active: z.boolean(),
  canRead: z.boolean(),
  canUseModel: z.boolean(),
}).strict();
export type PcbaSource = z.infer<typeof pcbaSourceSchema>;

export type PcbaQuestion = {
  field: PcbaField;
  label: string;
  why: string;
  priority: number;
  reason: "missing" | "unconfirmed" | "conflicted";
};

/** Does not extract, confirm, or infer client facts. */
export function assessPcbaProfile(value: unknown) {
  const profile = pcbaProfileSchema.parse(value);
  const questions: PcbaQuestion[] = [];
  for (const field of pcbaFieldNames) {
    const fact = profile.facts.find(f => f.field === field);
    const reason = !fact || fact.value === null ? "missing"
      : fact.status === "conflicted" ? "conflicted"
      : fact.status !== "confirmed" || !fact.citations.length ? "unconfirmed" : null;
    if (reason) questions.push({ field, ...pcbaFields[field], reason });
  }
  questions.sort((a, b) => a.priority - b.priority);
  return { profileId: profile.id, revision: profile.revision, questions,
    readiness: questions.length ? "needs_clarification" as const : "ready_for_comparison" as const,
    professionalApproval: false as const };
}
