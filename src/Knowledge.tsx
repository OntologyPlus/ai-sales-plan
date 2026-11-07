import React, { useEffect, useState } from "react";
import { SourceDialog } from "./Presentation";
import { kindLabels, reviewRole, type Citation } from "../shared/evidence";
export type Api = (path: string, method?: string, body?: any) => Promise<any>;
const labels: Record<string, string> = {
  draft: "待复核",
  published: "已发布",
  withdrawn: "已撤回",
};
export function Knowledge({
  api,
  user,
  proposalId,
}: {
  api: Api;
  user: any;
  proposalId?: string;
}) {
  const [docs, setDocs] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [base, setBase] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const reload = async () =>
    setDocs(
      await api("/documents" + (proposalId ? "?proposalId=" + proposalId : "")),
    );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(reload);
  }, [proposalId]);
  return (
    <>
      <div className="heading">
        <div>
          <small>EVIDENCE LIBRARY</small>
          <h1>{proposalId ? "方案资料" : "知识库"}</h1>
          <p>保存真实文件与不可变版本，复核发布后可作为方案依据。</p>
        </div>
        <button disabled={busy} onClick={() => void run(reload)}>
          刷新
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {(user.roles.includes("admin") ||
        (proposalId && user.roles.includes("engineer"))) && (
        <section>
          <h2>{base ? `为《${base.title}》上传新版本` : "上传资料"}</h2>
          <form
            key={base?.version_id || "new"}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                d = new FormData(form),
                f = d.get("file") as File;
              if (f.size > 5 * 1024 * 1024) {
                setError("文件不能超过5MB");
                return;
              }
              void run(async () => {
                const base64 = await new Promise<string>((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result).split(",")[1]);
                  r.onerror = () => reject(Error("读取文件失败"));
                  r.readAsDataURL(f);
                });
                await api("/documents", "POST", {
                  title: d.get("title"),
                  kind: d.get("kind"),
                  proposalId: proposalId || null,
                  filename: f.name,
                  base64,
                  allowModel: d.get("allowModel") === "on",
                  expiresOn: d.get("expiresOn") || null,
                  ...(base
                    ? { documentId: base.id, expectedVersion: base.version }
                    : {}),
                });
                setBase(null);
                form.reset();
                await reload();
              });
            }}
          >
            <div className="inline-form">
              <label>
                资料名称
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={base?.title}
                />
              </label>
              <label>
                类别
                <select
                  name="kind"
                  defaultValue={base?.kind || (proposalId ? "customer" : "tds")}
                >
                  {Object.entries(kindLabels).map(([k, l]) => (
                    <option value={k} key={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                有效期（可选）
                <input name="expiresOn" type="date" />
              </label>
            </div>
            <label>
              文件（最大5MB）
              <input
                name="file"
                type="file"
                required
                accept=".txt,.md,.csv,.docx,.pdf"
              />
            </label>
            <label>
              <input
                style={{ width: "auto" }}
                type="checkbox"
                name="allowModel"
              />{" "}
              允许后续模型使用此版本（当前批次未调用模型）
            </label>
            <p className="hint">
              PDF仅解析前50页；Word提取纯文本，不虚构页码。专业资料由另一位相应专业人员复核发布。新版本发布不自动撤回旧版本。
            </p>
            <button className="primary" disabled={busy}>
              {busy ? "处理中…" : "上传并解析"}
            </button>
            {base && (
              <button type="button" onClick={() => setBase(null)}>
                取消新版
              </button>
            )}
          </form>
        </section>
      )}
      <section>
        <div className="section-heading">
          <h2>文档与版本</h2>
          <input
            placeholder="搜索文档名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>资料</th>
                <th>类别</th>
                <th>版本 / 状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {docs
                .filter((d) => d.title.includes(query))
                .map((d) => (
                  <tr key={d.version_id}>
                    <td>
                      <strong>{d.title}</strong>
                      <small>{d.filename}</small>
                    </td>
                    <td>{kindLabels[d.kind]}</td>
                    <td>
                      V{d.version} · {labels[d.status]}
                      <small>
                        {d.allow_model ? "允许模型使用" : "仅人工使用"}
                      </small>
                    </td>
                    <td>
                      <button
                        onClick={() =>
                          void run(async () =>
                            setSelected(
                              await api("/documents/" + d.version_id),
                            ),
                          )
                        }
                      >
                        查看原文
                      </button>
                      {((user.roles.includes("admin") && !d.proposal_id) ||
                        (proposalId && d.proposal_id === proposalId)) && (
                        <button onClick={() => setBase(d)}>上传新版</button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!docs.length && (
          <div className="empty">
            暂无可访问资料，上传后由对应人员复核发布。
          </div>
        )}
      </section>
      {selected && (
        <section>
          <div className="section-heading">
            <h2>
              {selected.title} · V{selected.version}
            </h2>
            <button onClick={() => setSelected(null)}>关闭</button>
          </div>
          <p>
            {kindLabels[selected.kind]} · {labels[selected.status]} ·{" "}
            {selected.sha256}
          </p>
          {selected.parse_notes.map((n: string) => (
            <p className="hint" key={n}>
              {n}
            </p>
          ))}
          <pre className="source-text">{selected.text_content}</pre>
          <a
            className="button"
            href={"/api/documents/" + selected.id + "/download"}
          >
            下载原件
          </a>
          {(user.roles.includes(reviewRole(selected.kind)) ||
            user.roles.includes("admin")) && (
            <form
              className="review-document"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void run(async () => {
                  await api("/documents/" + selected.id + "/review", "POST", {
                    decision: d.get("decision"),
                    note: d.get("note"),
                  });
                  setSelected(await api("/documents/" + selected.id));
                  await reload();
                });
              }}
            >
              <label>
                处理意见
                <input name="note" required minLength={4} maxLength={2000} />
              </label>
              <select name="decision">
                {selected.status === "draft" &&
                  user.roles.includes(reviewRole(selected.kind)) && (
                    <option value="publish">复核并发布</option>
                  )}
                {selected.status !== "withdrawn" && (
                  <option value="withdraw">撤回此版本</option>
                )}
              </select>
              <button disabled={busy || selected.status === "withdrawn"}>
                确认处理
              </button>
            </form>
          )}
          <p className="hint">
            撤回立即阻断使用此版本的新批准与正式导出，历史记录保留。
          </p>
        </section>
      )}
    </>
  );
}
export function CitationPicker({
  api,
  proposalId,
  value,
  onChange,
  disabled,
}: {
  api: Api;
  proposalId?: string;
  value: Citation[];
  onChange: (v: Citation[]) => void;
  disabled: boolean;
}) {
  const [docs, setDocs] = useState<any[]>([]),
    [doc, setDoc] = useState<any>(null),
    [quote, setQuote] = useState(""),
    [error, setError] = useState("");
  const [located, setLocated] = useState<Citation | null>(null);
  useEffect(() => {
    api("/documents" + (proposalId ? "?proposalId=" + proposalId : ""))
      .then(setDocs)
      .catch((e) => setError(e.message));
  }, [proposalId]);
  return (
    <div className="citation-picker">
      <h3>已绑定原文（{value.length}）</h3>
      {error && <p className="error">{error}</p>}
      {value.map((c, i) => (
        <div key={i} className="citation">
          <button
            type="button"
            onClick={() => {
              setLocated(c);
            }}
          >
            查看原文
          </button>
          <blockquote>{c.quote}</blockquote>
          <small>
            {docs.find(d => d.version_id === c.versionId)?.title || "引用资料"} · V{docs.find(d => d.version_id === c.versionId)?.version || "—"} · 字符位置 {c.start}
          </small>
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              移除
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <>
          <button
            type="button"
            onClick={() => {
              api(
                "/documents" + (proposalId ? "?proposalId=" + proposalId : ""),
              )
                .then(setDocs)
                .catch((e) => setError(e.message));
            }}
          >
            刷新可用文档
          </button>
          <select
            aria-label="选择引用版本"
            value={doc?.id || ""}
            onChange={(e) => {
              setQuote("");
              setError("");
              if (e.target.value)
                api("/documents/" + e.target.value)
                  .then(setDoc)
                  .catch((e) => setError(e.message));
              else setDoc(null);
            }}
          >
            <option value="">选择已发布的文档版本</option>
            {docs
              .filter((d) => d.status === "published")
              .map((d) => (
                <option key={d.version_id} value={d.version_id}>
                  {d.title} V{d.version} · {kindLabels[d.kind]}
                </option>
              ))}
          </select>
          {doc && (
            <>
              <details open>
                <summary>{doc.title} · 原文（可复制所需段落）</summary>
                <pre className="source-text">{doc.text_content}</pre>
              </details>
              <textarea
                aria-label="连续原文摘录"
                rows={3}
                placeholder="粘贴至少4个字符的连续原文，系统核对真实字符位置。"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const start = doc.text_content.indexOf(quote);
                  if (quote.trim().length < 4 || start < 0) {
                    setError("引文须为至少4个字符的连续原文");
                    return;
                  }
                  if (
                    value.some(
                      (c) => c.versionId === doc.id && c.quote === quote,
                    )
                  ) {
                    setError("此引文已添加");
                    return;
                  }
                  onChange([...value, { versionId: doc.id, quote, start }]);
                  setQuote("");
                  setError("");
                }}
              >
                绑定这段原文
              </button>
            </>
          )}
        </>
      )}
      {disabled && doc && <pre className="source-text">{doc.text_content}</pre>}
      {located && <SourceDialog api={api} citation={located} onClose={() => setLocated(null)} />}
    </div>
  );
}
export function Assignments({ api, users }: { api: Api; users: any[] }) {
  const [all, setAll] = useState<any[]>([]),
    [owner, setOwner] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api("/review-assignments")
      .then(setAll)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const a = all.find((a) => a.owner_id === owner);
  return (
    <section>
      <h1>审核分配</h1>
      <p>
        按工程师配置技术、合规和领导，配置后送审必须遵循该分工；各审核人可查看该工程师负责的方案和私有依据。
      </p>
      {error && <div className="error">{error}</div>}
      <label>
        工程师
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">请选择</option>
          {users
            .filter((u) => u.active && u.roles.includes("engineer"))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
      </label>
      {owner && (
        <form
          key={owner + ":" + (a?.revision || 0)}
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            api("/review-assignments/" + owner, "PUT", {
              expectedRevision: a?.revision || 0,
              chemist: d.get("chemist"),
              compliance: d.get("compliance"),
              leader: d.get("leader"),
            })
              .then(load)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {["chemist", "compliance", "leader"].map((role) => (
            <label key={role}>
              {
                {
                  chemist: "应用化学师",
                  compliance: "合规专员",
                  leader: "审批领导",
                }[role]
              }
              <select
                name={role}
                defaultValue={a?.[role + "_id"] || ""}
                required
              >
                <option value="">请选择</option>
                {users
                  .filter(
                    (u) => u.active && u.roles.includes(role) && u.id !== owner,
                  )
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          <button className="primary" disabled={busy}>
            保存审核分工
          </button>
        </form>
      )}
    </section>
  );
}
