import { Router, type Request } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rows, tx, parse, pool } from "./db.js";
import { ApiError, requireRole } from "./security.js";
import { citationSchema } from "./contracts.js";
import { validQuote } from "../shared/evidence.js";
import {
  compare,
  type Requirement,
  type Parameter,
} from "../shared/matching.js";
const numeric = z.number().finite().min(-1e12).max(1e12).nullable();
export const requirementSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(100),
    operator: z.enum(["gte", "lte", "between"]),
    min: numeric,
    max: numeric,
    unit: z.string().trim().min(1).max(30),
    conditions: z.string().max(200),
    method: z.string().max(200),
    critical: z.boolean(),
  })
  .refine(
    (r) => r.min === null || r.max === null || r.min <= r.max,
    "阈值下限不能大于上限",
  );
const parameterSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(100),
    min: numeric,
    max: numeric,
    unit: z.string().trim().min(1).max(30),
    conditions: z.string().max(200),
    method: z.string().max(200),
    valueKind: z.enum(["guaranteed", "typical", "unknown"]),
    citation: citationSchema,
  })
  .refine(
    (p) => p.min === null || p.max === null || p.min <= p.max,
    "范围下限不能大于上限",
  );
async function validSource(c: any, db: any, lock = false) {
  const [v] = await rows(
    "SELECT v.id,v.version,v.sha256,v.status,v.expires_on,v.text_content,d.kind,d.title,d.proposal_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?" +
      (lock ? " FOR UPDATE" : ""),
    [c.versionId],
    db,
  );
  const date =
    v?.expires_on instanceof Date
      ? v.expires_on.toISOString().slice(0, 10)
      : String(v?.expires_on || "");
  if (
    !v ||
    v.proposal_id ||
    !["tds", "application"].includes(v.kind) ||
    v.status !== "published" ||
    (date &&
      date.slice(0, 10) <
        new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
          new Date(),
        )) ||
    !validQuote(v.text_content, c)
  )
    throw new ApiError(422, "产品参数须引用有效的共享TDS或应用说明连续原文");
  return {
    id: v.id,
    title: v.title,
    version: v.version,
    sha256: v.sha256,
    kind: v.kind,
  };
}
export async function matchingReport(p: any, db: any = pool, lock = false) {
  const requirements: Requirement[] = p.body.matchingRequirements || [],
    selected: string[] = p.body.productIds || [],
    issues: string[] = [];
  if (selected.length && !requirements.length)
    issues.push("已关联产品，请补充结构化需求和可比较的参数依据");
  if (requirements.length && !selected.length)
    issues.push("存在结构化需求，请关联候选产品");
  const products = [];
  const evidenceVersions: any[] = [];
  for (const productId of [...new Set(selected)].sort()) {
    const [product] = await rows(
      "SELECT * FROM sp_products WHERE id=?" + (lock ? " FOR UPDATE" : ""),
      [productId],
      db,
    );
    const specId = p.body.productSpecs?.[productId];
    const [spec] = specId
      ? await rows(
          "SELECT * FROM sp_product_specs WHERE id=? AND product_id=?" +
            (lock ? " FOR UPDATE" : ""),
          [specId, productId],
          db,
        )
      : [];
    let sourceValid = true;
    if (!product?.active || !spec || spec.status !== "published") {
      issues.push("所选产品缺少启用档案或已复核的参数版本");
      sourceValid = false;
    }
    const parameters: Parameter[] = spec ? parse(spec.parameters) : [];
    if (sourceValid)
      for (const attr of parameters) {
        try {
          evidenceVersions.push(await validSource(attr.citation, db, lock));
        } catch {
          sourceValid = false;
          issues.push(
            `产品${product?.code || productId}的参数来源已失效或不符合引用要求`,
          );
        }
      }
    const results = requirements.map((r) => {
      const result = compare(
        r,
        sourceValid ? parameters.find((a) => a.key === r.key) : undefined,
      );
      return sourceValid
        ? result
        : {
            ...result,
            actual: "依据不可用",
            reason: "参数版本或引用依据失效，暂停判定",
          };
    });
    for (const result of results)
      if (result.critical && result.status !== "match")
        issues.push(
          `${product?.code || productId}：关键需求“${result.label}”${result.reason}`,
        );
    products.push({
      productId,
      code: product?.code || "",
      name: product?.name || "",
      specId: spec?.id || null,
      specVersion: spec?.version || null,
      parameters,
      results,
    });
  }
  return {
    issues: [...new Set(issues)],
    requirements,
    products,
    evidenceVersions,
  };
}
export async function requireMatching(p: any, db: any = pool, lock = false) {
  const report = await matchingReport(p, db, lock);
  if (report.issues.length) throw new ApiError(422, report.issues.join("；"));
  return report;
}
export function matchingRouter(
  access: (req: Request, id: string, db?: any, lock?: boolean) => Promise<any>,
  audit: any,
) {
  const r = Router();
  r.get("/product-specs", async (_req, res) =>
    res.json(
      (await rows("SELECT * FROM sp_product_specs ORDER BY created_at DESC"))
        .filter(
          (s) =>
            s.status === "published" ||
            _req.user.roles.some((role: string) =>
              ["admin", "chemist"].includes(role),
            ),
        )
        .map((s) => ({ ...s, parameters: parse(s.parameters) })),
    ),
  );
  r.post("/products/:id/specs", async (req, res) => {
    requireRole(req, "admin");
    const b = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        parameters: z.array(parameterSchema).min(1).max(30),
      })
      .parse(req.body);
    if (new Set(b.parameters.map((p) => p.key)).size !== b.parameters.length)
      throw new ApiError(422, "参数键不能重复");
    const id = randomUUID();
    await tx(async (db) => {
      const [p] = await rows(
        "SELECT id FROM sp_products WHERE id=? FOR UPDATE",
        [req.params.id],
        db,
      );
      if (!p) throw new ApiError(404, "产品不存在");
      const [v] = await rows(
        "SELECT MAX(version) AS n FROM sp_product_specs WHERE product_id=?",
        [p.id],
        db,
      );
      if ((v.n || 0) !== b.expectedVersion)
        throw new ApiError(409, "产品参数已有新版，请刷新");
      for (const attr of b.parameters)
        await validSource(attr.citation, db, true);
      await db.execute(
        "INSERT INTO sp_product_specs(id,product_id,version,parameters,created_by) VALUES (?,?,?,?,?)",
        [
          id,
          p.id,
          b.expectedVersion + 1,
          JSON.stringify(b.parameters),
          req.user.id,
        ],
      );
      await audit(db, req, "product_spec.created", null, {
        specId: id,
        productId: p.id,
      });
    });
    res.json({ id });
  });
  r.post("/product-specs/:id/review", async (req, res) => {
    const b = z
      .object({
        decision: z.enum(["publish", "withdraw"]),
        note: z.string().trim().min(4).max(2000),
      })
      .parse(req.body);
    if (b.decision === "publish") requireRole(req, "chemist");
    else if (!req.user.roles.includes("admin")) requireRole(req, "chemist");
    await tx(async (db) => {
      const [s] = await rows(
        "SELECT * FROM sp_product_specs WHERE id=? FOR UPDATE",
        [req.params.id],
        db,
      );
      if (!s) throw new ApiError(404, "参数版本不存在");
      if (b.decision === "publish") {
        if (s.created_by === req.user.id)
          throw new ApiError(403, "需由另一位应用化学师独立复核");
        if (s.status !== "draft") throw new ApiError(409, "仅草稿可以发布");
        for (const attr of parse(s.parameters))
          await validSource(attr.citation, db, true);
      } else if (s.status === "withdrawn") throw new ApiError(409, "已撤回");
      await db.execute(
        "UPDATE sp_product_specs SET status=?,reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP(3) WHERE id=?",
        [
          b.decision === "publish" ? "published" : "withdrawn",
          req.user.id,
          b.note,
          s.id,
        ],
      );
      await audit(db, req, "product_spec." + b.decision, null, {
        specId: s.id,
      });
    });
    res.json({ ok: true });
  });
  r.get("/proposals/:id/matching", async (req, res) =>
    res.json(await matchingReport(await access(req, req.params.id))),
  );
  return r;
}
