import React, { useEffect, useRef, useState } from "react";
import type { Api } from "./Knowledge";
import { SourceDialog } from "./Presentation";
import { assessPcbaProfile, pcbaFieldNames, pcbaFields, type PcbaField, type PcbaProfile } from "../shared/pcba";
import type { PcbaFact } from "../shared/pcba-application";

type Loaded = { profile: PcbaProfile; unavailable: string[]; edition: number; proposalRevision: number; updatedAt: string | null; editable: boolean };
const emptyFact = (field: PcbaField): PcbaFact => ({ field, value: null, status: "candidate", citations: [] });
const factMap = (p: PcbaProfile) => Object.fromEntries(pcbaFieldNames.map(f => [f, p.facts.find(x => x.field === f) || emptyFact(f)])) as Record<PcbaField, PcbaFact>;

export function PcbaApplication({ api, proposal, onDirty, onSaved, onBack }: {
  api: Api; proposal: any; onDirty: (dirty: boolean) => void; onSaved: () => Promise<void>; onBack: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Record<PcbaField, PcbaFact> | null>(null);
  const [changed, setChanged] = useState<PcbaField[]>([]);
  const [docs, setDocs] = useState<any[]>([]), [source, setSource] = useState<any>(null);
  const [focused, setFocused] = useState<PcbaField>("materials");
  const [selection, setSelection] = useState<{ quote: string; start: number } | null>(null);
  const [located, setLocated] = useState<any>(null), [comparison, setComparison] = useState<Loaded | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLPreElement>(null), sourceSequence = useRef(0), mounted = useRef(true);
  const requestKey = useRef<string | null>(null);
  const endpoint = `/proposals/${proposal.id}/application`;
  const editable = loaded?.editable && !busy;
  const applyLoaded = (d: Loaded) => { setLoaded(d); setDraft(factMap(d.profile)); setChanged([]); setComparison(null); onDirty(false); requestKey.current = null; };
  const refresh = async () => {
    const [d, sources] = await Promise.all([api(endpoint), api(`/documents?proposalId=${proposal.id}`)]);
    if (!mounted.current) return;
    applyLoaded(d); setDocs(sources.filter((x: any) => x.kind === "customer" && x.proposal_id === proposal.id && x.status === "published"));
  };
  useEffect(() => {
    mounted.current = true;
    refresh().catch(e => { if (mounted.current) { setLoaded(null); setDraft(null); setError(e.message); } });
    return () => { mounted.current = false; sourceSequence.current++; };
  }, [proposal.id, proposal.edition]);
  const run = async (fn: () => Promise<void>) => {
    setError(""); setNotice(""); setBusy(true);
    try { await fn(); } catch (e: any) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const change = (field: PcbaField, fact: PcbaFact) => {
    setDraft(prev => prev ? { ...prev, [field]: fact } : prev);
    setChanged(prev => [...new Set([...prev, field])]); onDirty(true); requestKey.current = null; setComparison(null);
  };
  const readSource = async (id: string) => {
    const seq = ++sourceSequence.current; setSource(null); setSelection(null); setError("");
    if (!id) return;
    try {
      const d = await api(`/documents/${id}`);
      if (mounted.current && seq === sourceSequence.current) setSource(d);
    } catch (e: any) { if (mounted.current && seq === sourceSequence.current) setError(e.message); }
  };
  const assessment = loaded && draft ? assessPcbaProfile({ ...loaded.profile, facts: Object.values(draft) }) : null;
  return <div className="pcba-page">
    <div className="heading"><div><small>APPLICATION WORKSPACE · PCBA清洗</small><h1>理解应用，再形成推荐</h1>
      <p>{proposal.title} · 方案 V{proposal.edition} · 档案修订 {loaded?.profile.revision ?? "—"}{changed.length ? " · 有未保存修改" : ""}</p></div>
      <div className="actions"><button onClick={onBack}>返回方案编制</button><button disabled={busy} onClick={() => {
        if (changed.length && !confirm("刷新将放弃本地档案修改，是否继续？")) return;
        void run(async () => { setSource(null); setLocated(null); await refresh(); });
      }}>刷新档案</button>
      <button className="primary" disabled={!editable || !changed.length} onClick={() => void run(async () => {
        if (!loaded || !draft) return;
        requestKey.current ||= crypto.randomUUID();
        await api(endpoint, "PATCH", { requestId: requestKey.current, expectedEdition: loaded.edition,
          expectedProposalRevision: loaded.proposalRevision, expectedProfileRevision: loaded.profile.revision,
          changes: changed.map(f => ({ ...draft[f], value: draft[f].value?.trim() || null })) });
        if (!mounted.current) return;
        onDirty(false); setChanged([]); requestKey.current = null;
        await onSaved(); await refresh(); setNotice("应用档案已保存，确认记录与引用已留存。");
      })}>{busy ? "处理中…" : "保存应用档案"}</button></div></div>
    {error && <div className="error" role="alert">{error} {draft && <button disabled={busy} onClick={() => void run(async () => {
      try { setComparison(await api(endpoint)); }
      catch (e) { setDraft(null); setLoaded(null); setSource(null); setLocated(null); throw e; }
    })}>读取最新版本比较</button>}</div>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!loaded && !error && <p role="status">正在读取应用档案…</p>}
    {comparison && draft && <section className="pcba-conflict"><h2>最新档案与本地修改</h2><p>本地输入已保留。核对下列差异后再选择基线。</p>
      {changed.map(f => <div key={f}><strong>{pcbaFields[f].label}</strong><p>本地：{draft[f].value || "未知"}</p><p>服务器：{comparison.profile.facts.find(x => x.field === f)?.value || "未知/依据不可用"}</p></div>)}
      <button onClick={() => {
        const next = factMap(comparison.profile);
        for (const f of changed) next[f] = draft[f];
        setLoaded(comparison); setDraft(next); setComparison(null); requestKey.current = null;
        setError(""); setNotice("已采用最新基线，保留本地修改；请核对后再次保存。");
      }}>保留本地修改，采用最新基线</button>
      <button onClick={() => { if (confirm("放弃本地修改并载入服务器档案？")) applyLoaded(comparison); }}>放弃本地修改</button></section>}
    {loaded && draft && assessment && <>
      <section className="pcba-overview"><div><h2>应用条件与判断准备</h2><p>先核对板件、残留、验收和材料限制，再进入候选与验证。档案确认仅表示信息已核对，不代表产品通过验证。</p></div>
        <div className="pcba-stat"><strong>{8 - assessment.questions.length}/8</strong><span>信息已确认</span></div>
        <div className="pcba-stat"><strong>{assessment.questions.length}</strong><span>需要追问或核对</span></div>
      </section>
      {!loaded.editable && <p className="hint">当前为只读档案；仅草稿状态的方案负责人可以修改。</p>}
      {!!loaded.unavailable.length && <p className="error">部分字段原依据已不可用，内容已隐藏。可重新绑定当前有效资料，或保留原记录并处理其他字段。</p>}
      <div className="pcba-layout"><div className="pcba-facts">
        {pcbaFieldNames.map(field => {
          const f = draft[field]; return <section key={field} className={`pcba-fact ${focused === field ? "focused" : ""}`} onFocus={() => setFocused(field)}>
            <div className="section-heading"><h2>{pcbaFields[field].label}</h2><span className={`evidence-status ${f.status === "confirmed" ? "published" : "draft"}`}>{f.status === "confirmed" ? "已确认" : f.status === "conflicted" ? "信息冲突" : "待确认"}</span></div>
            <p className="hint">{pcbaFields[field].why}</p>
            <textarea aria-label={pcbaFields[field].label} rows={3} disabled={!editable} value={f.value || ""} placeholder="未知可留空；在右侧资料中选择原文，绑定后再确认。"
              onChange={e => change(field, { ...f, value: e.target.value || null, status: "candidate" })} />
            <div className="pcba-fact-actions"><button disabled={!editable} onClick={() => setFocused(field)}>{focused === field ? "正在为此字段选择依据" : "为此字段绑定原文"}</button>
              <label>信息状态 <select aria-label={`${pcbaFields[field].label}状态`} disabled={!editable} value={f.status} onChange={e => change(field, { ...f, status: e.target.value as PcbaFact["status"] })}>
                <option value="candidate">待确认</option><option value="confirmed" disabled={!f.value?.trim() || !f.citations.length}>已确认</option><option value="conflicted">信息冲突</option>
              </select></label>
            </div>
            {f.citations.map((c, i) => <div className="pcba-citation" key={`${c.versionId}:${c.start}:${i}`}><blockquote>{c.quote}</blockquote>
              <button onClick={() => setLocated(c)}>查看原文 ↗</button><button disabled={!editable} onClick={() => change(field, { ...f, status: "candidate", citations: f.citations.filter((_, j) => j !== i) })}>解除引用</button></div>)}
          </section>;
        })}
      </div><div className="pcba-evidence" role="complementary" aria-label="客户资料与下一步"><section><small>客户资料 · 原文对照</small><h2>让每个判断有出处</h2><p>选中原文后，绑定到左侧正在核对的字段。资料须先在“管理方案资料”中发布。</p>
        <select aria-label="客户资料版本" value={source?.id || ""} onChange={e => void readSource(e.target.value)}><option value="">选择已发布客户资料</option>
          {docs.map(d => <option key={d.version_id} value={d.version_id}>{d.title} · V{d.version}</option>)}</select>
        {!docs.length && <p className="hint">当前没有已发布的客户资料。返回方案编制，上传并发布客户问卷或沟通记录后即可绑定。</p>}
        {source && <><p className="hint">{source.title} · V{source.version} · {source.allow_model ? "允许模型使用" : "仅人工使用"}</p>
          <pre ref={sourceRef} className="pcba-source" onMouseUp={() => {
            const selected = window.getSelection(); const pre = sourceRef.current;
            if (!selected?.rangeCount || !pre || !pre.contains(selected.anchorNode) || !pre.contains(selected.focusNode)) return;
            const range = selected.getRangeAt(0), before = range.cloneRange(); before.selectNodeContents(pre); before.setEnd(range.startContainer, range.startOffset);
            const quote = selected.toString(), start = before.toString().length;
            setSelection(quote.length >= 4 && quote.length <= 4000 && source.text_content.slice(start, start + quote.length) === quote ? { quote, start } : null);
          }}>{source.text_content}</pre>
          <p className="hint">当前字段：{pcbaFields[focused].label}。请选择4—4000个字符的连续原文。</p>
          {selection && <blockquote>{selection.quote}</blockquote>}
          <button className="primary" disabled={!editable || !selection || draft[focused].citations.length >= 3} onClick={() => {
            if (!selection) return;
            const f = draft[focused];
            if (f.citations.some(c => c.versionId === source.id && c.start === selection.start && c.quote === selection.quote)) return;
            change(focused, { ...f, value: f.value || selection.quote, status: "candidate", citations: [...f.citations,
              { versionId: source.id, sha256: source.sha256, ...selection }] }); setSelection(null);
          }}>绑定到“{pcbaFields[focused].label}”</button>
          <button disabled={!editable} onClick={() => void run(async () => {
            const result = await api(endpoint + "/suggestions", "POST", { versionId: source.id,
              expectedEdition: loaded.edition, expectedProposalRevision: loaded.proposalRevision });
            let count = 0;
            for (const candidate of result.candidates as PcbaFact[]) if (!draft[candidate.field].value) { change(candidate.field, candidate); count++; }
            setNotice(`按关键词整理了${count}类待确认线索，已有内容已保留。此功能使用本地规则，不调用模型。`);
          })}>整理这份资料（规则辅助）</button>
        </>}
      </section><section><h2>下一步需确认</h2>{assessment.questions.length ? <ol>{assessment.questions.map(q => <li key={q.field}>
        <button onClick={() => { setFocused(q.field); document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${q.label}"]`)?.focus(); }}>{q.label}</button><p>{q.why}</p>
      </li>)}</ol> : <p>档案关键字段已核对，可准备产品比较与验证；技术结论仍需独立确认。</p>}</section></div></div>
      {located && <SourceDialog api={api} citation={located} onClose={() => setLocated(null)} />}
    </>}
  </div>;
}
