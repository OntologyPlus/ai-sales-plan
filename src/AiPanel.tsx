import React, { useEffect, useRef, useState } from "react";
import type { Api } from "./Knowledge";
import { kindLabels } from "../shared/evidence";
import { jobLabels } from "../shared/workflow";
import { Modal, ReadText, SourceDialog } from "./Presentation";
import { diffLines } from "../shared/presentation";
export function AiPanel({
  api,
  proposal,
  canEdit,
  dirty,
  onApplied,
}: {
  api: Api;
  proposal: any;
  canEdit: boolean;
  dirty: boolean;
  onApplied: () => Promise<void>;
}) {
  const [config, setConfig] = useState<any>(null),
    [docs, setDocs] = useState<any[]>([]),
    [jobs, setJobs] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [section, setSection] = useState(0),
    [ids, setIds] = useState<string[]>([]),
    [instruction, setInstruction] = useState(""),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const [compare, setCompare] = useState(false), [citation, setCitation] = useState<any>(null), [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setSelected(null); setCompare(false); }, [proposal.id, proposal.revision]);
  const refresh = async () => {
    const [c, d, j] = await Promise.all([
      api("/ai/config"),
      api("/documents?proposalId=" + proposal.id),
      api("/proposals/" + proposal.id + "/jobs"),
    ]);
    setConfig(c);
    setDocs(d);
    setJobs(j);
  };
  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let disposed = false;
    void run(refresh);
    let active = false;
    const timer = setInterval(async () => {
      if (active || disposed) return;
      active = true;
      try {
        const j = await api("/proposals/" + proposal.id + "/jobs");
        if (!disposed) setJobs(j);
      } catch (e: any) {
        if (!disposed) setError(e.message);
      } finally {
        active = false;
      }
    }, 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [proposal.id, proposal.revision]);
  useEffect(() => {
    if (!selected || !["queued", "running"].includes(selected.status)) return;
    let disposed = false,
      active = false;
    const timer = setInterval(async () => {
      if (active) return;
      active = true;
      try {
        const s = await api(`/proposals/${proposal.id}/jobs/${selected.id}`);
        if (!disposed) setSelected(s);
      } catch (e: any) {
        if (!disposed) setError(e.message);
      } finally {
        active = false;
      }
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selected?.id, selected?.status, proposal.id]);
  const available = docs.filter(
    (d) => d.status === "published" && d.allow_model,
  );
  return (
    <section className="ai-panel">
      <div className="section-heading">
        <h3>AI章节编制</h3>
        <button disabled={busy} onClick={() => void run(refresh)}>
          刷新
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="hint">
        模型：{config?.model || "读取配置中"}
        <br />
        {config?.configured
          ? config.workerReady
            ? "后台已就绪"
            : "后台暂不可用"
          : "未配置密钥，AI未启用；人工编制可继续"}
      </p>
      {canEdit && (
        <>
          <label>
            生成章节
            <select
              value={section}
              onChange={(e) => setSection(Number(e.target.value))}
            >
              {proposal.body.sections.map((s: any, i: number) => (
                <option key={i} value={i} disabled={s.enabled === false}>
                  {i + 1}. {s.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            选用资料（最多8个版本）
            <select
              multiple
              size={Math.min(6, Math.max(2, available.length))}
              value={ids}
              onChange={(e) => {
                setIds(
                  Array.from(e.target.selectedOptions).map((o) => o.value),
                );
                setConsent(false);
              }}
            >
              {available.map((d) => (
                <option key={d.version_id} value={d.version_id}>
                  {d.title} V{d.version} · {kindLabels[d.kind]}
                </option>
              ))}
            </select>
          </label>
          {!available.length && (
            <p className="hint">
              暂无已发布且允许模型使用的资料。请先上传并由相应人员复核发布。
            </p>
          )}
          <label>
            本次编制要求
            <textarea
              rows={3}
              maxLength={2000}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setConsent(false);
              }}
              placeholder="例如：重点解释应用条件与待验证事项"
            />
          </label>
          <label className="ai-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            确认将已保存的需求、场景、章节标题、模板及本次编制要求、所选资料片段发送至{" "}
            {config?.baseUrl || "已配置模型服务"}。
          </label>
          <p className="hint">
            每份资料仅发送前12,000字符，合计最多60,000字符。未选资料、其他章节正文及产品档案不会自动发送。输出需要人工审核。
          </p>
          {dirty && (
            <p className="error">请先保存当前修改，再发起生成或采用候选。</p>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              dirty ||
              !consent ||
              !ids.length ||
              ids.length > 8 ||
              !config?.configured ||
              !config?.workerReady
            }
            onClick={() =>
              void run(async () => {
                const payload = {
                  expectedRevision: proposal.revision,
                  sectionIndex: section,
                  versionIds: ids,
                  instruction,
                  consent: true,
                };
                const signature = JSON.stringify(payload);
                if (attempt.current?.payload !== signature)
                  attempt.current = {
                    key: crypto.randomUUID(),
                    payload: signature,
                  };
                const j = await api(`/proposals/${proposal.id}/jobs`, "POST", {
                  ...payload,
                  requestKey: attempt.current.key,
                });
                attempt.current = null;
                setSelected(
                  await api(`/proposals/${proposal.id}/jobs/${j.id}`),
                );
                setConsent(false);
                await refresh();
              })
            }
          >
            生成章节候选
          </button>
        </>
      )}
      <h3>最近任务</h3>
      {!jobs.length && <p className="hint">尚无生成任务。</p>}
      {jobs.map((j) => (
        <div className="ai-job" key={j.id}>
          <button
            onClick={() =>
              void run(async () =>
                setSelected(
                  await api(`/proposals/${proposal.id}/jobs/${j.id}`),
                ),
              )
            }
          >
            {j.sectionTitle}
          </button>
          <small>
            V{j.edition}.{j.revision} · {jobLabels[j.status]}
          </small>
          {j.error && <p className="hint">{j.error}</p>}
        </div>
      ))}
      {selected && (
        <div className="ai-candidate">
          <h3>
            {selected.sectionTitle} · {jobLabels[selected.status]}
          </h3>
          {selected.stale && <p className="error">{selected.stale}</p>}
          {selected.error && <p className="error">{selected.error}</p>}
          {["queued", "running"].includes(selected.status) && <div className="generation-status" role="status"><span className="activity-dot"/> {jobLabels[selected.status]} · 已等待 {Math.max(0, Math.floor((now - new Date(selected.events?.[0]?.created_at || now).getTime()) / 1000))} 秒<p>正在按所选资料编制并核对引用，完成后可人工审阅。</p></div>}
          {selected.sources?.map((s: any) => (
            <small key={s.id}>
              {s.title}：已读 {s.readChars}/{s.totalChars} 字符
            </small>
          ))}
          {selected.events?.length > 0 && (
            <details>
              <summary>执行记录</summary>
              {selected.events.map((e: any) => (
                <small key={e.id}>
                  {new Date(e.created_at).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}{" "}
                  ·{" "}
                  {(
                    {
                      queued: "已排队",
                      started: "开始生成",
                      completed: "候选已保存",
                      cancelled: "已取消",
                      failed: "执行失败",
                      applied: "已采用",
                    } as any
                  )[e.type] || e.type}
                </small>
              ))}
            </details>
          )}
          {selected.result && (
            <>
              <h4>候选正文{selected.status === "applied" ? "（已采用）" : "（尚未采用）"}</h4>
              <button className="primary" onClick={() => setCompare(true)}>展开阅读与正文对照 ↗</button>
              <pre className="candidate-content">{selected.result.content}</pre>
              <details>
                <summary>
                  核验后的引用（{selected.result.citations.length}）
                </summary>
                {selected.result.citations.map((c: any, i: number) => (
                  <blockquote key={i}>
                    {c.quote}
                    <button onClick={() => setCitation(c)}>定位原文 ↗</button>
                    <small>
                      位置 {c.start} · {c.versionId}
                    </small>
                  </blockquote>
                ))}
              </details>
              {selected.result.gaps.length > 0 && (
                <div className="error">
                  <strong>仍待补证</strong>
                  <ul>
                    {selected.result.gaps.map((g: string, i: number) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.usage && (
                <small>
                  输入 {selected.usage.inputTokens} / 输出{" "}
                  {selected.usage.outputTokens} tokens
                </small>
              )}
              {canEdit && (
                <>
                  <p className="hint">
                    采用会替换这一章的已保存正文和引用，并保留原修订；其他章节保留。候选通过引文校验不代表技术结论已成立。
                  </p>
                  <button
                    disabled={
                      busy ||
                      dirty ||
                      !!selected.stale ||
                      selected.status !== "completed"
                    }
                    className="primary"
                    onClick={() =>
                      void run(async () => {
                        await api(
                          `/proposals/${proposal.id}/jobs/${selected.id}/apply`,
                          "POST",
                          { expectedRevision: proposal.revision },
                        );
                        setSelected(null);
                        await onApplied();
                        await refresh();
                      })
                    }
                  >
                    确认采用并保存该章
                  </button>
                </>
              )}
            </>
          )}
          {canEdit && ["queued", "running"].includes(selected.status) && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(
                    `/proposals/${proposal.id}/jobs/${selected.id}/cancel`,
                    "POST",
                  );
                  setSelected(
                    await api(`/proposals/${proposal.id}/jobs/${selected.id}`),
                  );
                  await refresh();
                })
              }
            >
              取消任务
            </button>
          )}
        </div>
      )}
      {compare && selected?.result && <Modal title="AI候选与正文对照" onClose={() => setCompare(false)} wide>
        <p>左侧为当前已保存的章节正文，右侧为本次候选。新增与删除按行标记；采用前请核对适用条件与引用。</p>
        {(() => {
          const index = jobs.find(j => j.id === selected.id)?.sectionIndex;
          const before = proposal.body.sections[index]?.content || "";
          const diff = diffLines(before, selected.result.content);
          return <div className="candidate-comparison"><div><h3>当前已保存正文</h3>{diff.filter(l => l.kind !== "added").map((l, i) => <p key={i} className={`diff-line ${l.kind}`}>{l.kind === "removed" && <small>− 原文</small>}{l.text || "\u00a0"}</p>)}</div><div><h3>AI候选 · 待人工确认</h3>{diff.filter(l => l.kind !== "removed").map((l, i) => <p key={i} className={`diff-line ${l.kind}`}>{l.kind === "added" && <small>＋ 候选新增</small>}{l.text || "\u00a0"}</p>)}</div></div>;
        })()}
        <h3>待补证事项</h3>{selected.result.gaps.length ? <ul>{selected.result.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}</ul> : <p>候选未列出额外缺口，仍需专业审核。</p>}
        <h3>引用依据</h3>{selected.result.citations.map((c: any, i: number) => <blockquote key={i}><ReadText text={c.quote}/><button onClick={() => setCitation(c)}>定位原文 ↗</button></blockquote>)}
        <p className="hint">关闭对照窗口后，可在章节编制区确认采用并保存。</p>
      </Modal>}
      {citation && <SourceDialog api={api} citation={citation} onClose={() => setCitation(null)}/>}
    </section>
  );
}
