import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Api } from "./Knowledge";
import { roleLabels, statusLabels, type Role } from "../shared/workflow";

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return createPortal(<dialog ref={ref} className={`presentation-modal ${wide ? "wide" : ""}`} onCancel={onClose} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button autoFocus onClick={onClose} aria-label="关闭窗口">关闭 ×</button></div>
    <div className="modal-body">{children}</div>
  </dialog>, document.body);
}

export function SourceDialog({ api, citation, onClose }: { api: Api; citation: any; onClose: () => void }) {
  const [doc, setDoc] = useState<any>(null), [error, setError] = useState("");
  const mark = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    api(`/documents/${citation.versionId}`).then(d => { if (active) setDoc(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [api, citation.versionId]);
  useEffect(() => { if (doc) mark.current?.scrollIntoView({ block: "center" }); }, [doc]);
  const valid = doc && doc.text_content.slice(citation.start, citation.start + citation.quote.length) === citation.quote;
  const labels: Record<string, string> = { published: "已发布", draft: "草稿", withdrawn: "已撤回" };
  return <Modal title="原文定位" onClose={onClose}>
    {error && <p role="alert" className="error">{error}</p>}
    {!doc && !error && <p role="status">正在读取授权原文…</p>}
    {doc && <>
      <h2>{doc.title} · V{doc.version}</h2>
      <p><span className={`evidence-status ${doc.status}`}>{labels[doc.status] || doc.status}</span> · 字符位置 {citation.start}—{citation.start + citation.quote.length}</p>
      {doc.expires_on && <p>有效期至 {String(doc.expires_on).slice(0, 10)}</p>}
      {!valid && <p className="error">引用与此版本原文不一致，请重新核对。下方展示完整原文。</p>}
      <pre className="located-source">{valid ? <>{doc.text_content.slice(0, citation.start)}<mark ref={mark}>{citation.quote}</mark>{doc.text_content.slice(citation.start + citation.quote.length)}</> : doc.text_content}</pre>
      <small>版本指纹 {doc.sha256}</small>
    </>}
  </Modal>;
}

export function ReadText({ text }: { text: string }) {
  return <div className="read-text">{(text || "").split(/\r?\n/).filter(Boolean).map((line, i) => /^#{1,3} /.test(line)
    ? <h3 key={i}>{line.replace(/^#{1,3} /, "")}</h3> : <p key={i}>{line}</p>)}</div>;
}

export function ApprovalProgress({ proposal }: { proposal: any }) {
  const request = proposal.requests?.[0];
  const approved = request?.status === "approved";
  const active = request?.status === "pending";
  const labels: Record<string, string> = { waiting: "等待前序", pending: "待审核", approved: "已通过", changes_requested: "退回修改", rejected: "已驳回", closed: "已关闭" };
  return <section className="approval-progress" aria-label="审批流程">
    <div className="section-heading"><h2>审批进度</h2><span>{request ? `最近送审 V${request.edition}.${request.revision}` : "尚未送审"}</span></div>
    <div className="approval-track">
      <div className="approval-parallel"><small>专业审核 · 并行办理</small><div className="parallel-cards">{(["chemist", "compliance",...(["quality","legal"] as Role[]).filter(role=>request?.steps.some((s:any)=>s.role===role))] as Role[]).map(role => {
        const step = request?.steps.find((s: any) => s.role === role);
        return <div key={role} className={`approval-card ${step?.status || "waiting"}`}><strong>{roleLabels[role]}</strong><span>{step?.assignee_name || "送审时分配"}</span><b>{step ? labels[step.status] : "未开始"}</b>{step?.decided_at && <small>{new Date(step.decided_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small>}{step?.comment && <p>{step.comment}</p>}</div>;
      })}</div></div>
      <span className="flow-arrow" aria-hidden="true">→</span>
      {request?.steps.some((s:any)=>s.role==="finance")&&<><div className={`approval-card ${request.steps.find((s:any)=>s.role==="finance").status}`}><strong>独立财务复核</strong><span>{request.steps.find((s:any)=>s.role==="finance").assignee_name}</span><b>{labels[request.steps.find((s:any)=>s.role==="finance").status]}</b></div><span className="flow-arrow" aria-hidden="true">→</span></>}
      {(() => { const step = request?.steps.find((s: any) => s.role === "leader"); return <div className={`approval-card ${step?.status || "waiting"}`}><strong>领导终审</strong><span>{step?.assignee_name || "送审时分配"}</span><b>{step ? labels[step.status] : "等待专业审核"}</b>{step?.decided_at && <small>{new Date(step.decided_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small>}{step?.comment && <p>{step.comment}</p>}</div>; })()}
      <span className="flow-arrow" aria-hidden="true">→</span><div className={`approval-card ${approved ? "approved" : "waiting"}`}><strong>批准交付</strong><b>{approved ? "已批准，可核对成果" : active ? "审核办理中" : statusLabels[proposal.status] || "待批准"}</b><small>固定快照 · 留存原文件</small></div>
    </div>
  </section>;
}

export function PrecheckSummary({ precheck, dirty, onNavigate }: { precheck: any; dirty: boolean; onNavigate: (target: string) => void }) {
  const issues: string[] = precheck?.issues || [];
  return <section className="precheck-summary" aria-label="送审预检摘要"><div className="section-heading"><h2>送审准备</h2><span className={dirty || issues.length ? "status-warning" : "status-success"}>{dirty ? "修改尚未核对" : !precheck ? "正在核对" : issues.length ? `${issues.length} 项待处理` : "预检通过"}</span></div>
    {dirty ? <p>请先保存修改，再检查当前版本。下方结果属于此前保存的版本。</p> : <p>{issues.length ? "先处理阻断项，再提交专业审核。" : "结构与引用检查通过，技术结论仍需专业审核。"}</p>}
    {!!issues.length && <ul>{issues.map((issue, i) => {
      const chapter = issue.match(/第(\d+)章/);
      const target = chapter ? `section-${Number(chapter[1]) - 1}` : /风险|补证/.test(issue) ? "risk-editor" : /需求来源/.test(issue) ? "requirement-intake" : /产品|参数|阈值|匹配|关键需求|典型|保证|工况|单位/.test(issue) ? "matching-editor" : /客户需求/.test(issue) ? "requirements" : "review-controls";
      return <li key={i}><span>{issue}</span><button onClick={() => onNavigate(target)}>前往处理 →</button></li>;
    })}</ul>}
  </section>;
}

export function ProposalReader({ snapshot, api, onClose, historical = false, dirty = false }: { snapshot: any; api: Api; onClose: () => void; historical?: boolean; dirty?: boolean }) {
  const [citation, setCitation] = useState<any>(null);
  const body = snapshot.body || snapshot;
  const sections = (body.sections || []).map((s: any, i: number) => ({ ...s, index: i })).filter((s: any) => s.enabled !== false && (s.required !== false || s.content?.trim()));
  const products = snapshot.matchingSnapshot?.products || [];
  return <Modal title={historical ? "历史版本阅读" : "方案阅读预览"} onClose={onClose} wide>
    <article className="proposal-reader">
      <div className="reader-cover"><small>{historical ? "历史留存快照" : dirty ? "当前未保存草稿预览" : "当前已保存方案"}</small><h1>{snapshot.title || "应用方案"}</h1><p>{snapshot.code} · V{snapshot.edition}.{snapshot.revision} · {statusLabels[snapshot.status] || "历史修订"}</p><p>{snapshot.scene}</p></div>
      <nav className="reader-nav" aria-label="阅读目录"><a href="#read-requirements">客户需求</a>{sections.map((s: any) => <a key={s.index} href={`#read-section-${s.index}`}>{s.index + 1}. {s.title}</a>)}</nav>
      <section id="read-requirements"><h2>客户需求与产品匹配</h2><ReadText text={body.requirements}/>{products.map((p: any) => <div key={p.code}><h3>{p.code} · {p.name}</h3><div className="table-wrap"><table><thead><tr><th>需求</th><th>客户阈值</th><th>产品范围</th><th>判断及原因</th></tr></thead><tbody>{p.results.map((r: any, i: number) => <tr key={i}><td>{r.label}</td><td>{r.requirement}</td><td>{r.actual}</td><td>{({ match: "满足", mismatch: "不满足", validation: "待验证", unknown: "无法判定" } as any)[r.status]}<small>{r.reason}</small></td></tr>)}</tbody></table></div></div>)}</section>
      {sections.map((s: any) => <section key={s.index} id={`read-section-${s.index}`}><h2><span className="number">{s.index + 1}</span>{s.title}</h2>{s.content ? <ReadText text={s.content}/> : <p className="hint">本章尚待编制。</p>}{s.evidence && <div className="reader-evidence"><strong>适用条件与待补证说明</strong><ReadText text={s.evidence}/></div>}{s.citations?.map((c: any, i: number) => <div key={i} className="reader-citation"><blockquote>{c.quote}</blockquote><button onClick={() => setCitation(c)}>定位原文 ↗</button></div>)}</section>)}
      {!!snapshot.requests?.length && <ApprovalProgress proposal={snapshot}/>}
      {historical && <p className="hint">历史正文来自固定快照；打开原文时仍按当前权限及资料状态核对。</p>}
    </article>
    {citation && <SourceDialog api={api} citation={citation} onClose={() => setCitation(null)}/>}
  </Modal>;
}
