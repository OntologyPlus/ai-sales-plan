import { rows } from "./db.js";
import { ApiError } from "./security.js";
import { validQuote } from "../shared/evidence.js";
export async function checkRiskEvidence(
  citations: any[],
  proposalId: string,
  db: any,
) {
  const versions = [];
  if (!citations.length) throw new ApiError(422, "缺少补证原文");
  for (const c of citations) {
    const [v] = await rows(
      "SELECT v.id,v.version,v.sha256,d.kind,d.title,v.status,v.text_content,v.expires_on,d.proposal_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=? FOR UPDATE",
      [c.versionId],
      db,
    );
    const date =
      v?.expires_on instanceof Date
        ? v.expires_on.toISOString().slice(0, 10)
        : String(v?.expires_on || "");
    if (
      !v ||
      (v.proposal_id && v.proposal_id !== proposalId) ||
      v.status !== "published" ||
      (date &&
        date.slice(0, 10) <
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Shanghai",
          }).format(new Date())) ||
      !validQuote(v.text_content, c)
    )
      throw new ApiError(422, "补证资料无权限、未发布、已过期撤回或原文不符");
    versions.push({
      id: v.id,
      version: v.version,
      sha256: v.sha256,
      kind: v.kind,
      title: v.title,
    });
  }
  return versions;
}
