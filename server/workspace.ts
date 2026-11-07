import { Router } from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pool, rows, tx, parse } from "./db.js";
import { ApiError, requireRole, hash } from "./security.js";
import { loadAiSource } from "./jobs.js";
import { matchingReport } from "./matching.js";
import { editableStatus } from "../shared/ai.js";
import { validQuote } from "../shared/evidence.js";
import { modelReady, modelConfig, providerFingerprint } from "./model.js";
import { workspaceStartSchema, workspaceApplySchema, parseWorkspaceResult, workspaceCanonical, type WorkspaceInput } from "../shared/workspace.js";
import { runWorkspaceAgent } from "./workspace-runtime.js";
import { projectControl,projectPublicContext,projectRecords } from "./project.js";
import { activeProjectRecords,evidenceCoverage } from "../shared/project.js";
import { compare,type Parameter } from "../shared/matching.js";

function assertOwner(req: any, p: any) {
  requireRole(req, "engineer");
  if (p.owner_id !== req.user.id) throw new ApiError(403, "仅方案负责人可运行或采用Agent结果");
  if (!editableStatus(p.status)) throw new ApiError(409, "当前方案只读，请撤回审核或开启新版本");
}
export async function workspaceProducts(p: any, sources: WorkspaceInput["sources"], db: any = pool) {
  const report = await matchingReport(p, db);
  const allowed = new Set(sources.filter(s => ["tds", "application"].includes(s.kind)).map(s => s.id));
  const selected = [];
  for (const p of report.products) {
      const [spec] = p.specId ? await rows("SELECT s.status,p.active FROM sp_product_specs s JOIN sp_products p ON p.id=s.product_id WHERE s.id=? AND p.id=?",[p.specId,p.productId],db) : [];
      const authorized = p.parameters.length > 0 && p.parameters.every(a => allowed.has(a.citation.versionId));
      const valid = authorized && spec?.status === "published" && !!spec.active && p.parameters.every(a => validQuote(sources.find(s=>s.id===a.citation.versionId)!.text,a.citation)) && !p.results.some(r => r.actual === "依据不可用");
      selected.push({ productId: p.productId, code: p.code, name: p.name, specId: p.specId,
        parameters: valid ? p.parameters : [], results: valid ? p.results : [],
        evidenceAvailable: valid, note: valid ? "数值比对仅针对已登记需求与工况，不代表专业批准" : "须选取已许可的有效产品技术资料并核对参数版本，不作符合性判定" });
  }
  const discovered=[];
  const specs=await rows("SELECT s.id,s.product_id,s.version,s.parameters,p.code,p.name FROM sp_product_specs s JOIN sp_products p ON p.id=s.product_id WHERE s.status='published' AND p.active=1 ORDER BY s.created_at DESC LIMIT 120",[],db);
  const seen=new Set<string>();
  for(const spec of specs){const parameters:Parameter[]=parse(spec.parameters);if(seen.has(spec.product_id)||!parameters.length||!parameters.every(a=>allowed.has(a.citation.versionId)&&validQuote(sources.find(s=>s.id===a.citation.versionId)!.text,a.citation)))continue;seen.add(spec.product_id);discovered.push({productId:spec.product_id,code:spec.code,name:spec.name,specId:spec.id,specVersion:spec.version,parameters,results:(p.body.matchingRequirements||[]).map((r:any)=>compare(r,parameters.find(a=>a.key===r.key))),note:"从本次获准技术资料发现的候选，不代表已关联或专业批准；须核对不可比项及工况后采用"});}
  return {
    selected,
    discovered,
    catalog: await rows("SELECT id,code,name FROM sp_products WHERE active=1 ORDER BY code LIMIT 60", [], db),
    note: "目录仅用于发现候选产品；没有参数依据的名称不构成产品推荐。新增候选须在方案编制中关联和核实版本。",
  };
}
export async function checkWorkspaceSources(input: WorkspaceInput, db: any = pool, lock = false) {
  for (const s of input.sources) {
    const v = await loadAiSource(s.id, input.proposalId, db, lock);
    if (v.sha256 !== s.sha256) throw new ApiError(409, "资料版本指纹已改变");
  }
}
async function authorizeRun(run: any, db: any = pool, lock = false) {
  const input: WorkspaceInput = parse(run.input_snapshot);
  const [p] = await rows("SELECT * FROM sp_proposals WHERE id=?" + (lock ? " FOR UPDATE" : ""), [run.proposal_id], db);
  const [u] = await rows("SELECT active,roles FROM sp_users WHERE id=?", [run.requested_by], db);
  if (!p || !u?.active || !parse(u.roles).includes("engineer") || p.owner_id !== run.requested_by || !editableStatus(p.status)) throw new ApiError(409, "负责人权限或方案状态已改变");
  if (p.edition !== input.edition || p.revision !== input.revision) throw new ApiError(409, "方案已修订，请基于最新内容重新发起Agent任务");
  if((await projectControl(p,db)).revision!==(input.projectRevision||0))throw new ApiError(409,"专业对象已变化，请基于最新事实重新运行");
  await checkWorkspaceSources(input, db, lock);
  return { ...p, body: parse(p.body) };
}
async function addEvent(id: string, type: string, payload: any, db: any = pool) {
  await db.execute("INSERT INTO sp_workspace_events(run_id,type,payload) VALUES (?,?,?)", [id,type,JSON.stringify(payload)]);
}
async function readVersions(id: string, db: any = pool) {
  return new Set<string>((await rows("SELECT payload FROM sp_workspace_events WHERE run_id=? AND type='evidence_read'", [id],db)).map(e => parse(e.payload).versionId));
}

export function workspaceRouter(access: any, audit: any, worker: WorkspaceWorker) {
  const r = Router();
  r.get("/workspace/config", (_req,res) => res.json({ configured: modelReady(), workerReady: worker.ready, model: modelConfig.model, runtime: "pi-durable", maxRequests: 10 }));
  r.get("/proposals/:id/workspace", async (req,res) => {
    const p = await access(req,req.params.id);
    const runs = await rows("SELECT * FROM sp_workspace_runs WHERE proposal_id=? ORDER BY created_at DESC LIMIT 20",[p.id]);
    const serialized = [];
    for (const run of runs) {
      const input: WorkspaceInput = parse(run.input_snapshot);
      let unavailable = false;
      try { await checkWorkspaceSources(input); } catch(e) { if (!(e instanceof ApiError)) throw e; unavailable = true; }
      const stale = p.edition !== input.edition || p.revision !== input.revision || (await projectControl(p)).revision!==(input.projectRevision||0);
      const events = await rows("SELECT id,type,payload,created_at FROM sp_workspace_events WHERE run_id=? ORDER BY id DESC LIMIT 80",[run.id]);
      const reads=await rows("SELECT payload FROM sp_workspace_events WHERE run_id=? AND type='evidence_read'",[run.id]);
      serialized.push({ id:run.id, status:run.applied_at ? "applied" : run.status, instruction:input.instruction,
        edition:input.edition, revision:input.revision, createdAt:run.created_at, stale, unavailable,
        model: input.model, modelRequests:run.model_requests, usage:parse(run.usage_json),
        error:run.error_message, result: unavailable ? null : parse(run.result_json),
        appliedRevision:run.applied_revision, sources:unavailable ? [] : input.sources.map(s=>({id:s.id,title:s.title,kind:s.kind})),
        coverage:unavailable?[]:input.sources.map(s=>({versionId:s.id,title:s.title,...evidenceCoverage(s.totalChars,reads.map(e=>parse(e.payload)).filter(e=>e.versionId===s.id))})),
        events:events.reverse().map(e=>({...e,payload:parse(e.payload)})),
        canApply:!stale && !unavailable && run.status === "completed" && !run.applied_at && p.owner_id === req.user.id && req.user.roles.includes("engineer") && editableStatus(p.status),
      });
    }
    res.json({ edition:p.edition, revision:p.revision, editable:p.owner_id===req.user.id && req.user.roles.includes("engineer") && editableStatus(p.status), runs:serialized });
  });
  r.post("/proposals/:id/workspace/runs", async (req,res) => {
    const b = workspaceStartSchema.parse(req.body), requestHash = hash(JSON.stringify(b));
    const id = await tx(async db => {
      const p = await access(req,req.params.id,db,true); assertOwner(req,p);
      if(p.edition!==b.expectedEdition) throw new ApiError(409,"方案版次已变化，请刷新");
      const [old] = await rows("SELECT id,request_hash,requested_by FROM sp_workspace_runs WHERE proposal_id=? AND request_key=?",[p.id,b.requestKey],db);
      if(old) { if(old.request_hash!==requestHash || old.requested_by!==req.user.id) throw new ApiError(409,"幂等键已用于不同任务"); return old.id; }
      if(p.revision!==b.expectedRevision) throw new ApiError(409,"方案已修改，请刷新后发起任务");
      if(!modelReady() || !worker.ready) throw new ApiError(503,"模型或Agent任务服务尚未就绪");
      const [active] = await rows("SELECT COUNT(*) AS n FROM sp_workspace_runs WHERE proposal_id=? AND status IN ('queued','running')",[p.id],db);
      if(active.n) throw new ApiError(409,"本方案已有进行中的Agent任务，可先取消或等待完成");
      const [count] = await rows("SELECT COUNT(*) AS n FROM sp_workspace_runs WHERE requested_by=? AND status IN ('queued','running')",[req.user.id],db);
      if(count.n>=3) throw new ApiError(429,"最多同时运行3个Agent任务");
      const sources:WorkspaceInput["sources"] = [];
      for(const id of [...new Set(b.versionIds)].sort()) {
        const s = await loadAiSource(id,p.id,db,true);
        sources.push({id:s.id,title:s.title,kind:s.kind,sha256:s.sha256,text:s.text_content,totalChars:s.text_content.length});
      }
      if(sources.reduce((n,s)=>n+s.text.length,0)>600000) throw new ApiError(422,"资料总量超过60万字符，请减少选择");
      const input:WorkspaceInput = {proposalId:p.id,edition:p.edition,revision:p.revision,title:p.title,scene:p.scene,
        requirements:p.body.requirements || "", sections:p.body.sections.map((s:any)=>({title:s.title,content:s.content,enabled:s.enabled})),
        instruction:b.instruction,sources,model:modelConfig.model,provider:providerFingerprint(),productContext:await workspaceProducts(p,sources,db)};
      const context=await projectPublicContext(p,db);
      input.projectRevision=context.revision;
      input.projectContext={...context,records:context.records.filter((r:any)=>!r.unavailable&&r.data.citations.every((c:any)=>sources.some(s=>s.id===c.versionId)))};
      const previous=await rows("SELECT input_snapshot,result_json FROM sp_workspace_runs WHERE proposal_id=? AND status='completed' ORDER BY created_at DESC LIMIT 3",[p.id],db);
      input.conversation=previous.reverse().flatMap(run=>{
        const old:WorkspaceInput=parse(run.input_snapshot), result=parse(run.result_json);
        if(old.edition!==p.edition || !result || !old.sources.every(s=>sources.some(n=>n.id===s.id && n.sha256===s.sha256)))return [];
        return [{instruction:old.instruction,summary:result.summary,questions:result.questions.map((q:any)=>q.question)}];
      });
      if(JSON.stringify(input).length>900000) throw new ApiError(422,"方案及资料过长，请减少范围后再运行");
      const id=randomUUID();
      await db.execute("INSERT INTO sp_workspace_runs(id,proposal_id,requested_by,request_key,request_hash,input_snapshot) VALUES (?,?,?,?,?,?)",[id,p.id,req.user.id,b.requestKey,requestHash,JSON.stringify(input)]);
      await addEvent(id,"queued",{},db);
      await audit(db,req,"workspace.started",p.id,{runId:id,sourceCount:sources.length,edition:p.edition,revision:p.revision});
      return id;
    });
    res.json({id});
  });
  r.post("/proposals/:id/workspace/runs/:run/cancel", async (req,res) => {
    await tx(async db => {
      const p=await access(req,req.params.id,db,true);
      requireRole(req,"engineer"); if(p.owner_id!==req.user.id) throw new ApiError(403,"仅负责人可取消任务");
      const [run]=await rows("SELECT id,status FROM sp_workspace_runs WHERE id=? AND proposal_id=? FOR UPDATE",[req.params.run,p.id],db);
      if(!run)throw new ApiError(404,"任务不存在");
      await db.execute("UPDATE sp_workspace_runs SET cancel_requested=TRUE,status=IF(status='queued','cancelled',status) WHERE id=? AND status IN ('queued','running')",[run.id]);
      await audit(db,req,"workspace.cancel_requested",p.id,{runId:run.id});
    }); res.json({ok:true});
  });
  r.post("/proposals/:id/workspace/runs/:run/apply", async (req,res) => {
    const b=workspaceApplySchema.parse(req.body), applyHash=hash(JSON.stringify(b));
    const revision=await tx(async db => {
      const p=await access(req,req.params.id,db,true); assertOwner(req,p);
      if(p.edition!==b.expectedEdition)throw new ApiError(409,"方案版次已改变");
      const [run]=await rows("SELECT * FROM sp_workspace_runs WHERE id=? AND proposal_id=? FOR UPDATE",[req.params.run,p.id],db);
      if(!run)throw new ApiError(404,"任务不存在");
      if(run.requested_by!==req.user.id)throw new ApiError(403,"只能采用本人发起的任务");
      if(run.applied_at){if(run.apply_hash!==applyHash)throw new ApiError(409,"任务已按另一选择采用");return run.applied_revision;}
      if(run.status!=="completed")throw new ApiError(409,"任务尚无可采用结果");
      if(p.revision!==b.expectedRevision)throw new ApiError(409,"方案已更新，本地选择保留，请刷新并重新核对");
      await authorizeRun(run,db,true);
      const input:WorkspaceInput=parse(run.input_snapshot);
      if(workspaceCanonical(await workspaceProducts(p,input.sources,db))!==workspaceCanonical(input.productContext))throw new ApiError(409,"产品档案或参数依据已变化，请重新运行");
      const result=parseWorkspaceResult(JSON.stringify(parse(run.result_json)),input,await readVersions(run.id,db));
      const body=structuredClone(p.body), confirmed=body.confirmedRequirements || [];
      if(b.sectionIndexes.length){const context=await projectPublicContext(p,db),active=new Set(activeProjectRecords(await projectRecords(p.id,p.edition,db)).map(r=>r.id));if(context.records.some((r:any)=>active.has(r.id)&&(r.stale||r.blocked||r.unavailable)))throw new ApiError(422,"专业依据有失效或试验阻断，请先复核路线后再采用正文");body.projectDependencies=context.records.filter((r:any)=>active.has(r.id)&&r.status==="confirmed").map((r:any)=>({id:r.id,revision:r.revision}));}
      for(const i of b.factIndexes){
        const f=result.facts[i]; if(!f)throw new ApiError(422,"选择的事实不存在");
        if(f.citations.some(c=>input.sources.find(s=>s.id===c.versionId)?.kind!=="customer" || c.quote.length>1200))throw new ApiError(422,"仅可将客户资料中的短引文事实确认为客户需求");
        for(const c of f.citations) if(!confirmed.some((v:any)=>v.versionId===c.versionId && v.start===c.start && v.text===f.text)) confirmed.push({id:randomUUID(),...c,text:f.text,sha256:input.sources.find(s=>s.id===c.versionId)!.sha256});
        if(!body.requirements.includes(f.text))body.requirements+=(body.requirements?"\n":"")+f.text;
      }
      if(body.requirements.length>20000 || confirmed.length>100)throw new ApiError(422,"采用后的需求超过长度或引用数量上限，请减少选择");
      body.confirmedRequirements=confirmed;
      for(const i of b.sectionIndexes){const c=result.chapters.find(c=>c.sectionIndex===i);if(!c)throw new ApiError(422,"选择的章节不存在");body.sections[i]={...body.sections[i],content:c.content,citations:c.citations,evidence:"由AI工作空间生成，负责人已选择采用；仍须完成专业审核"};}
      await db.execute("INSERT INTO sp_proposal_versions(proposal_id,edition,revision,snapshot,actor_id) VALUES (?,?,?,?,?)",[p.id,p.edition,p.revision,JSON.stringify(p),req.user.id]);
      await db.execute("UPDATE sp_proposals SET body=?,revision=revision+1,status='DRAFT',updated_at=UTC_TIMESTAMP(3) WHERE id=?",[JSON.stringify(body),p.id]);
      await db.execute("UPDATE sp_workspace_runs SET apply_hash=?,applied_revision=?,applied_at=UTC_TIMESTAMP(3) WHERE id=?",[applyHash,p.revision+1,run.id]);
      await audit(db,req,"workspace.applied",p.id,{runId:run.id,factIndexes:b.factIndexes,sectionIndexes:b.sectionIndexes,revision:p.revision+1});
      return p.revision+1;
    });res.json({ok:true,revision});
  });
  return r;
}

export class WorkspaceWorker {
  ready=false;
  private stopping=false;
  private loop?:Promise<void>;
  private active?:AbortController;
  private owner=randomUUID();
  async start(){
    try { await rows("SELECT id FROM sp_workspace_runs LIMIT 1");this.ready=true;this.loop=this.work(); }
    catch { console.error("Agent工作空间未就绪，请运行数据库迁移9"); }
  }
  async stop(){this.stopping=true;this.ready=false;this.active?.abort();await this.loop;}
  private async work(){
    while(!this.stopping){
      try {
        const run=await tx(async db=>{
          const [run]=await rows("SELECT * FROM sp_workspace_runs WHERE status='queued' OR (status='running' AND lease_until<UTC_TIMESTAMP(3)) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",[],db);
          if(!run)return null;
          await db.execute("UPDATE sp_workspace_runs SET status='running',lease_owner=?,lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 90 SECOND),started_at=COALESCE(started_at,UTC_TIMESTAMP(3)) WHERE id=?",[this.owner,run.id]);return run;
        });
        if(run)await this.execute(run);
        else await new Promise(r=>setTimeout(r,700));
      }catch(e){console.error("Agent任务循环失败：",(e as any).code || (e as any).name);await new Promise(r=>setTimeout(r,1500));}
    }
  }
  private async execute(run:any){
    const controller=new AbortController();this.active=controller;
    const input:WorkspaceInput=parse(run.input_snapshot);
    const guard=async()=>{
      controller.signal.throwIfAborted();
      const [latest]=await rows("SELECT status,cancel_requested,lease_owner FROM sp_workspace_runs WHERE id=?",[run.id]);
      if(latest?.cancel_requested)throw new Error("任务已取消");
      if(latest?.lease_owner!==this.owner || latest.status!=="running")throw new Error("任务执行权已改变");
      if(input.provider!==providerFingerprint() || input.model!==modelConfig.model)throw new Error("模型配置已改变，请重新运行");
      const p=await authorizeRun(run);
      if(workspaceCanonical(await workspaceProducts(p,input.sources))!==workspaceCanonical(input.productContext))throw new Error("产品依据已变化，请重新运行");
    };
    let checking=false;
    const heartbeat=setInterval(()=>{if(checking)return;checking=true;void (async()=>{try{await guard();await pool.execute("UPDATE sp_workspace_runs SET lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 90 SECOND) WHERE id=? AND lease_owner=? AND status='running'",[run.id,this.owner]);}catch{controller.abort();}finally{checking=false;}})();},2000);
    const timeout=setTimeout(()=>controller.abort(),Math.min(modelConfig.timeoutSeconds,600)*1000);
    try {
      await guard();
      const result=await runWorkspaceAgent(input,{
        path:resolve("data/workspace",run.id+".sqlite"),signal:controller.signal,assertCurrent:guard,
        shouldPause:()=>this.stopping,
        event:(type,payload)=>addEvent(run.id,type,payload),readVersions:()=>readVersions(run.id),
        inspectProducts:async()=>input.productContext,
        readRanges:async()=>(await rows("SELECT payload FROM sp_workspace_events WHERE run_id=? AND type='evidence_read'",[run.id])).map(e=>parse(e.payload)),
        beforeRequest:async()=>{
          const [updated]:any=await pool.execute("UPDATE sp_workspace_runs SET model_requests=model_requests+1 WHERE id=? AND lease_owner=? AND status='running' AND model_requests<10",[run.id,this.owner]);
          if(!updated.affectedRows)throw new Error("已达到10次模型请求上限");
          await addEvent(run.id,"model_request",{});
        },
      });
      await guard();
      await tx(async db=>{
        await authorizeRun(run,db,true);
        const [current]=await rows("SELECT status,cancel_requested,lease_owner FROM sp_workspace_runs WHERE id=? FOR UPDATE",[run.id],db);
        if(current.cancel_requested || current.status!=="running" || current.lease_owner!==this.owner)throw new Error("任务已取消或失去执行权");
        await db.execute("UPDATE sp_workspace_runs SET status='completed',result_json=?,usage_json=?,finished_at=UTC_TIMESTAMP(3),lease_until=NULL WHERE id=?",[JSON.stringify(result.result),JSON.stringify(result.usage),run.id]);
        await addEvent(run.id,"completed",{},db);
      });
    }catch(e){
      const [current]=await rows("SELECT cancel_requested FROM sp_workspace_runs WHERE id=?",[run.id]);
      if(this.stopping && !current?.cancel_requested){await pool.execute("UPDATE sp_workspace_runs SET lease_until=UTC_TIMESTAMP(3) WHERE id=? AND lease_owner=?",[run.id,this.owner]);}
      else {
        const cancelled=!!current?.cancel_requested;
        const message=cancelled?"任务已取消":controller.signal.aborted?"任务超时或权限/资料已变化，请核对后重试":e instanceof ApiError?e.message:"Agent执行未完成或结果未通过引用校验，请重试或缩小任务范围";
        await pool.execute("UPDATE sp_workspace_runs SET status=?,error_message=?,finished_at=UTC_TIMESTAMP(3),lease_until=NULL WHERE id=? AND lease_owner=? AND status='running'",[cancelled?"cancelled":"failed",message,run.id,this.owner]);
        console.error("Agent任务结束：",run.id,(e as any).name);
      }
    }finally{clearInterval(heartbeat);clearTimeout(timeout);this.active=undefined;}
  }
}
