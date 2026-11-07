import React, { useEffect, useRef, useState } from "react";
import { Knowledge, type Api } from "./Knowledge";
import { SourceDialog } from "./Presentation";
import { statusLabels, jobLabels } from "../shared/workflow";
import { kindLabels } from "../shared/evidence";
import type { WorkspaceResult } from "../shared/workspace";
import { ProjectPanel } from "./ProjectPanel";

const tools: Record<string,string> = { read_proposal:"理解当前方案", search_evidence:"检索授权资料", read_evidence:"读取证据原文", inspect_products:"核对产品与匹配依据",read_project:"核对专业对象、试验与价值" };
export function Workspace({ api, proposal, user, onEdit, onSaved, onDirty }: {
  api:Api; proposal:any; user:any; onEdit:()=>void; onSaved:()=>Promise<void>; onDirty:(dirty:boolean)=>void;
}) {
  const [state,setState]=useState<any>(null),[config,setConfig]=useState<any>(null),[docs,setDocs]=useState<any[]>([]);
  const [selected,setSelected]=useState<string[]>([]),[instruction,setInstruction]=useState("");
  const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [showDocs,setShowDocs]=useState(false),[focused,setFocused]=useState<string|null>(null),[located,setLocated]=useState<any>(null);
  const [facts,setFacts]=useState<number[]>([]),[chapters,setChapters]=useState<number[]>([]);
  const [view,setView]=useState("ai"),[projectDirty,setProjectDirty]=useState(false);
  const mounted=useRef(true),pending=useRef<any>(null),initialized=useRef(false);
  const endpoint=`/proposals/${proposal.id}/workspace`;
  const reload=async()=>{
    const [s,c,d]=await Promise.all([api(endpoint),api("/workspace/config"),api(`/documents?proposalId=${proposal.id}`)]);
    if(!mounted.current)return;
    setState(s);setConfig(c);setDocs(d);
    if(!initialized.current){setSelected(d.filter((v:any)=>v.proposal_id===proposal.id && v.kind==="customer" && v.status==="published" && v.allow_model).map((v:any)=>v.version_id).slice(0,8));initialized.current=true;}
  };
  useEffect(()=>{mounted.current=true;void reload().catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};},[proposal.id,proposal.edition]);
  useEffect(()=>{onDirty(!!instruction.trim()||projectDirty);},[instruction,projectDirty]);
  const active=state?.runs.some((r:any)=>["queued","running"].includes(r.status));
  useEffect(()=>{
    if(!active)return;
    const timer=setInterval(()=>{void reload().catch(e=>{if(mounted.current)setError(e.message);});},1800);
    return()=>clearInterval(timer);
  },[active,endpoint]);
  useEffect(()=>{setFacts([]);setChapters([]);},[focused]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError("");setNotice("");try{await fn();}catch(e:any){if(mounted.current)setError(e.message);}finally{if(mounted.current)setBusy(false);}};
  const changePrompt=(text:string)=>{setInstruction(text);pending.current=null;};
  const current=state?.runs.find((r:any)=>r.id===focused) || state?.runs[0];
  const result:WorkspaceResult|undefined=current?.result;
  const eligible=docs.filter(d=>d.status==="published" && d.allow_model && (!d.expires_on || String(d.expires_on).slice(0,10)>=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date())));
  const refs=(citations:any[])=><div className="workspace-refs">{citations.map((c,i)=><button key={i} onClick={()=>setLocated(c)}>↗ {current.sources.find((s:any)=>s.id===c.versionId)?.title || "原文依据"}</button>)}</div>;
  return <div className="ai-workspace">
    <div className="heading"><div><small>{proposal.code} · V{state?.edition || proposal.edition}.{state?.revision || proposal.revision}</small><h1>{proposal.title}</h1><p>{proposal.scene} <span className={`badge ${proposal.status}`}>{statusLabels[proposal.status]}</span></p></div>
      <div className="actions"><button onClick={()=>void run(reload)} disabled={busy}>刷新工作空间</button><button onClick={()=>setShowDocs(!showDocs)}>{showDocs?"返回工作空间":"方案资料"}</button><button onClick={onEdit}>方案编制与送审 →</button></div></div>
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    <nav className="project-tabs" aria-label="专业工作区">{[["ai","AI推进"],["application","应用与路线"],["experiments","样品与试验"],["value","价值与商务"],["delivery","商机、待办与交付"]].map(([id,label])=><button className={view===id?"selected":""} key={id} onClick={()=>{if(projectDirty&&!confirm("有未保存的专业对象，确定切换？"))return;setProjectDirty(false);setShowDocs(false);setView(id);}}>{label}</button>)}</nav>
    {showDocs ? <Knowledge api={api} user={user} proposalId={proposal.id}/> : view!=="ai"?<ProjectPanel key={view} api={api} proposal={proposal} user={user} view={view} onDirty={setProjectDirty} onPrepare={text=>{setProjectDirty(false);setView("ai");changePrompt(text);}}/> : <>
      <div className="workspace-intro"><div><small>AI APPLICATION WORKSPACE</small><h2>围绕客户目标，推进下一步</h2><p>告诉 AI 需要解决什么。它会读取你许可的资料，检查依据、发现缺项并准备可核对的结果。</p></div><span className="workspace-model">{config?.configured ? config.model : "模型未配置"} · {config?.workerReady ? "Agent已就绪" : "任务服务未就绪"}</span></div>
      <div className="workspace-grid"><div className="workspace-main">
        <section className="workspace-composer"><h2>这一步，要推进什么？</h2>
          <div className="workspace-shortcuts">{["诊断当前客户需求，找出阻断方案的缺项并给出优先追问。","结合已选资料核对候选产品，说明证据差距并制定验证计划。","基于当前需求和有效技术、合规资料，准备可追溯的方案正文候选。"].map((t,i)=><button key={i} disabled={!state?.editable || busy} onClick={()=>changePrompt(t)}>{["诊断与追问","产品与验证","准备方案候选"][i]}</button>)}</div>
          <textarea aria-label="给AI的任务或补充信息" rows={4} value={instruction} maxLength={4000} disabled={!state?.editable || busy} onChange={e=>changePrompt(e.target.value)} placeholder="例如：客户希望解决什么问题？补充了哪些现场信息？这次需要AI帮你推进到哪一步？"/>
          <p className="hint">后续可在这里回答 AI 的追问。相同资料范围内的最近讨论会接续到下一次任务；尚未采用的信息保留为候选。</p>
          <details className="workspace-source-select"><summary>本次资料 · 已选择 {selected.length} 份</summary>
            <p className="hint">仅使用已发布且许可模型使用的资料；最多8份、已解析全文总计60万字符。AI按相关片段检索和分段读取，引用使用整份原文位置。</p>
            {eligible.map(d=><label className="workspace-check" key={d.version_id}><input type="checkbox" checked={selected.includes(d.version_id)} disabled={busy || !state?.editable || (!selected.includes(d.version_id)&&selected.length>=8)} onChange={e=>{setSelected(e.target.checked?[...selected,d.version_id]:selected.filter(id=>id!==d.version_id));pending.current=null;}}/><span>{d.title} · V{d.version}<small>{kindLabels[d.kind as keyof typeof kindLabels]}</small></span></label>)}
            {!eligible.length && <p>没有可供模型使用的资料。可先诊断缺项，或在「方案资料」上传、复核并许可使用资料。</p>}
          </details>
          <label className="workspace-check workspace-consent"><input type="checkbox" checked={consent} disabled={!state?.editable || busy} onChange={e=>{setConsent(e.target.checked);pending.current=null;}}/><span>允许将本次任务、当前方案内容及选定资料发送至已配置的模型服务</span></label>
          <div className="workspace-submit"><small>AI只生成候选；采用、专业审核和对外交付由人决定。</small><button className="primary" disabled={busy || active || !state?.editable || !config?.configured || !config?.workerReady || !consent || !instruction.trim()} onClick={()=>void run(async()=>{
            pending.current ||= {requestKey:crypto.randomUUID(),expectedEdition:state.edition,expectedRevision:state.revision,instruction,versionIds:selected,consent:true};
            const r=await api(endpoint+"/runs","POST",pending.current);
            if(!mounted.current)return;
            pending.current=null;setInstruction("");onDirty(false);setFocused(r.id);setFacts([]);setChapters([]);await reload();
          })}>{active?"Agent正在处理…":"交给 AI 推进 →"}</button></div>
          {!state?.editable && <p className="hint">当前账号或方案状态仅允许查看。负责人可在可编辑版本发起任务。</p>}
        </section>
        {current ? <section className="workspace-result" aria-label="AI任务结果"><div className="section-heading"><h2>AI 工作记录</h2><span className="badge">{jobLabels[current.status] || current.status}</span></div>
          <div className="workspace-user-message">{current.instruction}</div>
          <details open={["running","queued"].includes(current.status)} className="workspace-trace"><summary>执行过程 · {current.modelRequests} 次模型请求</summary><ol>{current.events.map((e:any)=><li key={e.id}>{e.type==="tool_completed" ? tools[e.payload.name] || e.payload.name : e.type==="evidence_read" ? "已读取一份授权原文" : e.type==="model_response" ? `模型服务响应 ${e.payload.httpStatus}` : ({queued:"任务已入队",model_request:"模型正在分析下一步",validation_rejected:"候选未通过校验，正在修正",completed:"结果已通过结构及引用校验"} as any)[e.type] || e.type}</li>)}</ol></details>
          {!!current.coverage?.length&&<details><summary>原文读取覆盖范围</summary>{current.coverage.map((c:any)=><div key={c.versionId}><b>{c.title}</b><p>已读 {c.readChars} / 已解析 {c.totalChars} 字符</p><p>未读范围：{c.unreadRanges.length?c.unreadRanges.map((r:any)=>`${r.start}—${r.end}`).join("、"):"全部已读"}</p></div>)}</details>}
          {current.error && <p className="error">{current.error}</p>}{current.unavailable && <p className="notice">关联资料已撤回、过期或取消模型许可，原结果已隐藏，请核对资料后重新运行。</p>}
          {result && <><div className="workspace-summary"><small>诊断摘要 · 待人工核对</small><p>{result.summary}</p></div>
            {current.status==="completed"&&!current.stale&&state.editable&&<button disabled={busy||active} onClick={()=>void run(async()=>{const project=await api(`/proposals/${proposal.id}/project`);await api(`/proposals/${proposal.id}/project/import-workspace`,"POST",{requestId:crypto.randomUUID(),runId:current.id,expectedEdition:project.edition,expectedProjectRevision:project.revision});await reload();setView("application");setNotice("已整理为应用事实、问题和路线候选；请核对并独立确认。");})}>整理为可持续维护的应用对象 →</button>}
            {!!result.facts.length && <div className="workspace-block"><h3>有依据的候选事实</h3><p className="hint">可勾选客户资料中的事实作为已确认需求。技术资料中的事实供核对，须随正文完成专业审核。</p>{result.facts.map((f,i)=>{
              const adoptable=f.citations.every(c=>current.sources.find((s:any)=>s.id===c.versionId)?.kind==="customer" && c.quote.length<=1200);
              return <div className="workspace-fact" key={i}><label className="workspace-check"><input type="checkbox" aria-label={`确认事实：${f.label}`} disabled={!current.canApply || busy || !adoptable} checked={facts.includes(i)} onChange={e=>setFacts(e.target.checked?[...facts,i]:facts.filter(x=>x!==i))}/><span><b>{f.label}</b><p>{f.text}</p></span></label>{refs(f.citations)}</div>;
            })}</div>}
            {!!result.questions.length && <div className="workspace-block"><h3>需追问与补证</h3>{result.questions.map((q,i)=><div className="workspace-question" key={i}><span className={`badge ${q.priority==="blocking"?"CHANGES_REQUESTED":"DRAFT"}`}>{({blocking:"阻断项",important:"需确认",optional:"可补充"})[q.priority]}</span><b>{q.question}</b><p>{q.reason}</p><button disabled={!state.editable} onClick={()=>{changePrompt(`针对上一轮问题「${q.question}」，客户补充：`);document.querySelector<HTMLTextAreaElement>('[aria-label="给AI的任务或补充信息"]')?.focus();}}>补充这条信息 ↑</button></div>)}</div>}
            {result.comparison && <div className="workspace-block"><h3>产品与证据比较</h3><p className="workspace-prose">{result.comparison}</p></div>}
            {!!result.validationPlan.length && <div className="workspace-block"><h3>验证计划候选</h3>{result.validationPlan.map((v,i)=><div className="workspace-validation" key={i}><b>{i+1}. {v.task}</b><p>验收：{v.acceptance}</p><small>建议负责：{v.owner} · 待专业确认</small></div>)}</div>}
            {!!result.chapters.length && <div className="workspace-block"><h3>方案正文候选</h3>{result.chapters.map(c=><div className="workspace-chapter" key={c.sectionIndex}><label className="workspace-check"><input type="checkbox" aria-label={`采用章节：${proposal.body.sections[c.sectionIndex].title}`} disabled={!current.canApply || busy} checked={chapters.includes(c.sectionIndex)} onChange={e=>setChapters(e.target.checked?[...chapters,c.sectionIndex]:chapters.filter(x=>x!==c.sectionIndex))}/><b>{proposal.body.sections[c.sectionIndex].title}</b></label><details><summary>查看候选正文及当前正文</summary><h4>候选正文</h4><p className="workspace-prose">{c.content}</p><h4>当前保存正文</h4><p className="workspace-prose">{proposal.body.sections[c.sectionIndex].content || "尚无正文"}</p></details>{refs(c.citations)}</div>)}</div>}
            {!!result.nextActions.length && <div className="workspace-block"><h3>下一步行动</h3><ol>{result.nextActions.map((a,i)=><li key={i}>{a}</li>)}</ol></div>}
            {current.canApply && <div className="workspace-apply"><p>确认所选事实；所选章节将替换当前正文。采用后生成新修订，仍须原有专业审核。</p><button className="primary" disabled={busy || active || (!facts.length&&!chapters.length)} onClick={()=>void run(async()=>{
              if(chapters.length && !confirm(`将替换${chapters.length}个章节正文，是否采用已勾选候选？`))return;
              await api(`${endpoint}/runs/${current.id}/apply`,"POST",{expectedEdition:state.edition,expectedRevision:state.revision,factIndexes:facts,sectionIndexes:chapters});
              if(!mounted.current)return;
              setFacts([]);setChapters([]);await onSaved();await reload();setNotice("已采用到方案新修订，可进入方案编制与送审核对。");
            })}>确认采用 {facts.length} 条事实、{chapters.length} 个章节</button></div>}
            {current.stale && current.status!=="applied" && <p className="notice">方案已更新，此结果作为历史参考。请基于最新修订继续推进。</p>}
            {current.status==="applied" && <p className="notice">已采用到 V{current.edition}.{current.appliedRevision}，可在方案版本历史中追溯。</p>}
          </>}
          {["running","queued"].includes(current.status) && state.editable && <button disabled={busy} onClick={()=>void run(async()=>{await api(`${endpoint}/runs/${current.id}/cancel`,"POST");await reload();})}>取消此任务</button>}
        </section> : <section className="workspace-empty"><h2>从客户问题开始</h2><p>不需要先填满表格。先给出目标，让 AI 找出当前缺少的资料、关键边界和下一步。</p><p>所有应用场景共用此工作空间，诊断内容随场景和证据变化。</p></section>}
      </div><div className="workspace-sidebar" role="complementary" aria-label="方案上下文与任务历史">
        <section><h2>当前方案</h2><p>{proposal.body.requirements || "尚未保存客户需求，可先与AI梳理，再确认采用。"}</p><small>已确认来源 {proposal.body.confirmedRequirements?.length || 0} 条 · 已有正文 {proposal.body.sections.filter((s:any)=>s.content?.trim()).length} / {proposal.body.sections.length} 章</small><button onClick={onEdit}>核对需求、产品与正文 →</button></section>
        <section><h2>任务历史</h2>{state?.runs.map((r:any)=><button className={`workspace-history ${current?.id===r.id?"selected":""}`} key={r.id} onClick={()=>{setFocused(r.id);setFacts([]);setChapters([]);}}><span>{r.instruction}</span><small>{jobLabels[r.status] || r.status} · V{r.edition}.{r.revision}</small></button>)}{!state?.runs.length && <p className="hint">任务、工具执行过程和可采用结果会持续保存在这里。</p>}</section>
      </div></div>
    </>}
    {located && <SourceDialog api={api} citation={located} onClose={()=>setLocated(null)}/>}
  </div>;
}
