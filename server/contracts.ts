import { z } from "zod";
export const citationSchema = z.object({
  versionId: z.string().uuid(),
  quote: z.string().min(4).max(4000),
  start: z.number().int().nonnegative(),
});
