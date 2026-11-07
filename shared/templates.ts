import { z } from "zod";
export const templateDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    industry: z.string().max(100),
    familyId: z.string().uuid().optional(),
    expectedVersion: z.number().int().nonnegative().default(0),
    sections: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(120),
          required: z.boolean(),
          enabled: z.boolean().default(true),
        }),
      )
      .length(6),
    instruction: z.string().max(2000),
  })
  .refine(
    (d) =>
      d.sections.every(
        (s, i) =>
          !(i === 0 || i === 1 || i === 2 || i === 4 || i === 5) ||
          (s.required && s.enabled),
      ),
    "客户、性能、推荐、验证、安全章节必须启用且必填",
  )
  .refine(
    (d) => d.sections.every((s) => !s.required || s.enabled),
    "必填章节不能停用",
  );
