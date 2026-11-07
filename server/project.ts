import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool,rows,tx,parse } from "./db.js";
import { ApiError,requireRole,hash } from "./security.js";
import { validQuote } from "../shared/evidence.js";
import { editableStatus } from "../shared/ai.js";
import { projectWriteSchema,projectProjection,projectDataSchema,commercialCalculation,analyzeTest,searchProjectEvidence,activeProjectRecords,projectConflicts,type ProjectRecord,type ProjectData } from "../shared/project.js";
import { parseWorkspaceResult } from "../shared/workspace.js";

export async function projectRecords(id:string,edition:number,db:any=pool):Promise<ProjectRecord[]> {return (await rows("SELECT * FROM sp_project_records WHERE proposal_id=? AND edition=? ORDER BY created_at,id",[id,edition],db)).map(r=>({...r,data:parse(r.data),dependencies:parse(r.dependencies)}));}
export async function projectControl(p:any,db:any=pool){const [c]=await rows("SELECT * FROM sp_project_controls WHERE proposal_id=? AND edition=?",[p.id,p.edition],db);return c||{proposal_id:p.id,edition:p.edition,revision:0,finance_id:null,quality_id:null,legal_id:null};}
export async function projectSourceChanged(versionId:string,db:any){
  const impacted=await rows("SELECT id,proposal_id,edition FROM sp_project_records WHERE JSON_SEARCH(data,'one',?,NULL,'$.citations[*].versionId') IS NOT NULL",[versionId],db);
  const groups=new Map<string,{proposalId:string;edition:number;ids:string[]}>();
  for(const r of impacted){const key=r.proposal_id+":"+r.edition;const group=groups.get(key)||{proposalId:r.proposal_id,edition:r.edition,ids:[] as string[]};group.ids.push(r.id);groups.set(key,group);}
  for(const g of groups.values()){await db.execute("UPDATE sp_project_controls SET revision=revision+1 WHERE proposal_id=? AND edition=?",[g.proposalId,g.edition]);await db.execute("INSERT INTO sp_project_events(proposal_id,edition,type,payload) VALUES (?,?,'source_changed',?)",[g.proposalId,g.edition,JSON.stringify({versionId,affected:g.ids,reason:"资料状态变化，请复核关联专业对象及方案"})]);}
}
export async function projectReviewer(req:any,p:any,db:any=pool){const c=await projectControl(p,db);return (req.user.roles.includes("finance")&&c.finance_id===req.user.id)||(req.user.roles.includes("quality")&&c.quality_id===req.user.id)||(req.user.roles.includes("legal")&&c.legal_id===req.user.id);}
function owner(req:any,p:any){requireRole(req,"engineer");if(req.user.id!==p.owner_id)throw new ApiError(403,"仅项目负责人可维护");if(!editableStatus(p.status))throw new ApiError(409,"当前版本只读，请撤回或开启新版");}
function privateFinance(req:any,p:any,c:any){return req.user.id===p.owner_id&&req.user.roles.includes("engineer") || req.user.id===c.finance_id&&req.user.roles.includes("finance");}
export async function projectCitations(data:ProjectData,p:any,db:any=pool) {
  if(data.kind==="recommendation")for(const item of data.caseComparisons||[]){if(!data.citations.some(c=>c.versionId===item.sourceVersionId))throw new ApiError(422,"案例比较必须绑定相应原文引用");const [source]=await rows("SELECT kind FROM sp_documents d JOIN sp_document_versions v ON v.document_id=d.id WHERE v.id=?",[item.sourceVersionId],db);if(source?.kind!=="case")throw new ApiError(422,"案例比较必须使用案例类资料");}
  for(const c of data.citations){
    const [s]=await rows("SELECT v.status,v.expires_on,v.text_content,d.proposal_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?",[c.versionId],db);
    const date=s?.expires_on instanceof Date?s.expires_on.toISOString().slice(0,10):String(s?.expires_on||"").slice(0,10);
    if(!s||s.status!=="published"||(s.proposal_id&&s.proposal_id!==p.id)||(date&&date<new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date()))||!validQuote(s.text_content,c))throw new ApiError(422,"专业对象引用已失效、越界或与原文不一致");
  }
}
function refsFor(data:ProjectData){return data.kind==="test_plan"?[data.recommendationId]:data.kind==="test_run"?[data.planId]:data.kind==="conclusion"?[data.runId,data.recommendationId]:[];}
function verifyGraph(record:ProjectRecord,all:ProjectRecord[]){
  const byId=new Map([...all.filter(r=>r.id!==record.id),record].map(r=>[r.id,r]));
  const walk=(r:ProjectRecord,path:Set<string>)=>{if(path.has(r.id))throw new ApiError(422,"专业对象不能形成循环依赖");const next=new Set(path).add(r.id);for(const dep of r.dependencies){const found=byId.get(dep.id);if(!found||found.revision!==dep.revision||found.kind==="commercial"&&record.kind!=="commercial")throw new ApiError(409,"依赖不存在、已变更或属于内部底稿");walk(found,next);}};walk(record,new Set());
}
async function ensureControl(p:any,db:any){await db.execute("INSERT IGNORE INTO sp_project_controls(proposal_id,edition) VALUES (?,?)",[p.id,p.edition]);return projectControl(p,db);}
async function receipt(req:any,p:any,key:string,body:any,db:any){const requestHash=hash(JSON.stringify(body));const [r]=await rows("SELECT * FROM sp_project_receipts WHERE proposal_id=? AND request_id=?",[p.id,key],db);if(r){if(r.actor_id!==req.user.id||r.request_hash!==requestHash)throw new ApiError(409,"请求ID已用于不同内容");return {old:parse(r.result),requestHash};}return {old:null,requestHash};}
async function remember(req:any,p:any,key:string,requestHash:string,result:any,db:any){await db.execute("INSERT INTO sp_project_receipts(proposal_id,request_id,request_hash,actor_id,result) VALUES (?,?,?,?,?)",[p.id,key,requestHash,req.user.id,JSON.stringify(result)]);}
async function change(req:any,p:any,record:ProjectRecord,before:ProjectRecord[],type:string,db:any){
  const after=[...before.filter(r=>r.id!==record.id),record];const projection=projectProjection(after);
  const affected=projection.filter(r=>r.stale||r.blocked).map(r=>r.id);
  await db.execute("UPDATE sp_project_controls SET revision=revision+1 WHERE proposal_id=? AND edition=?",[p.id,p.edition]);
  await db.execute("INSERT INTO sp_project_events(proposal_id,edition,type,payload) VALUES (?,?,?,?)",[p.id,p.edition,type,JSON.stringify({recordId:record.id,kind:record.kind,affected,actorId:req.user.id,visibility:record.kind==="commercial"?"internal":"project"})]);
  // Public proposal content becomes a stale dependent as soon as a referenced business object changes.
  if(p.body?.projectDependencies?.some((d:any)=>d.id===record.id&&d.revision!==record.revision) || affected.some(id=>p.body?.projectDependencies?.some((d:any)=>d.id===id)))
    await db.execute("INSERT INTO sp_project_events(proposal_id,edition,type,payload) VALUES (?,?,'solution_review',?)",[p.id,p.edition,JSON.stringify({recordId:record.id,affected,reason:"已采用正文的专业依据发生变化，须准备新版或复核"})]);
}
export async function projectPublicContext(p:any,db:any=pool){const c=await projectControl(p,db),records=projectProjection(await projectRecords(p.id,p.edition,db));const visible=[];for(const r of records.filter(r=>r.kind!=="commercial")){try{await projectCitations(r.data,p,db);visible.push(r);}catch(e){if(!(e instanceof ApiError))throw e;visible.push({id:r.id,kind:r.kind,revision:r.revision,unavailable:true});}}return {revision:c.revision,records:visible};}

/** Checks the exact project content which is frozen into a new formal approval round. */
export async function projectApproval(p:any,db:any=pool){
  const c=await projectControl(p,db),records=projectProjection(await projectRecords(p.id,p.edition,db));
  const commercial=records.filter(r=>r.kind==="commercial").at(-1);
  if(!commercial||commercial.data.kind!=="commercial")throw new ApiError(422,"请先保存内部商务底稿；纯技术成果也需声明费用及对外承诺范围");
  const d=commercial.data;
  if(commercial.stale||commercial.status==="rejected"||d.supplyCommitment===null||d.legalException===null)throw new ApiError(422,"商务依赖或供应/法务触发条件尚未核对");
  if(d.validUntil<new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date()))throw new ApiError(422,"商务条件已过期");
  const calc=commercialCalculation(d);
  if(d.specialExpense===null||(d.mode==="quote"&&(calc.netRevenue===null||Number(calc.netRevenue)<=0)))throw new ApiError(422,"报价或专项费用数据不完整，未知不能按0处理");
  const assignments:Record<string,string>={finance:c.finance_id};
  if(d.supplyCommitment)assignments.quality=c.quality_id;
  if(d.legalException)assignments.legal=c.legal_id;
  for(const [role,id]of Object.entries(assignments)){const [u]=id?await rows("SELECT active,roles FROM sp_users WHERE id=?",[id],db):[];if(!u?.active||!parse(u.roles).includes(role)||[p.owner_id,p.created_by,commercial.created_by].includes(id))throw new ApiError(422,`请分配独立且启用的${role}审核人，编制人不能自审`);}
  if(projectConflicts(records).length)throw new ApiError(422,"存在已确认应用事实的数值冲突，请先核对并修订或否决冲突事实");
  const activeIds=new Set(activeProjectRecords(records).map(r=>r.id));
  const relevant=records.filter(r=>activeIds.has(r.id));
  if(relevant.some(r=>r.data.kind==="value"&&r.data.equivalence==="confirmed"&&r.status!=="confirmed"))throw new ApiError(422,"效果等效的价值口径须先由独立技术人员确认");
  if(p.body.projectDependencies?.some((dep:any)=>!records.some(r=>r.id===dep.id&&r.revision===dep.revision&&!r.stale)))throw new ApiError(422,"正文引用的专业对象版本已变化，请准备并采用修订");
  for(const r of relevant){await projectCitations(r.data,p,db);if(r.stale)throw new ApiError(422,"存在依赖已变化的专业对象，请先复核");if(r.data.kind==="question"&&r.data.blocking&&!r.data.resolved)throw new ApiError(422,"存在未解决的阻断问题");}
  for(const r of relevant.filter(r=>r.data.kind==="recommendation"&&r.data.decision==="selected")){
    if(r.blocked||r.status!=="confirmed")throw new ApiError(422,"选定路线尚未专业确认，或已被试验结论阻断");
    if(r.data.kind==="recommendation"&&r.data.productId&&!p.body.productIds?.includes(r.data.productId))throw new ApiError(422,"选定产品须在方案编制中关联有效参数版本并完成确定性匹配");
    if(r.data.kind==="recommendation"&&!r.data.validationRequired){let technical=false;for(const c of r.data.citations){const [s]=await rows("SELECT d.kind FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?",[c.versionId],db);if(["tds","application"].includes(s?.kind))technical=true;}if(!technical)throw new ApiError(422,"免试验路线须有有效技术或应用依据，客户资料不能证明性能");}
    if(r.data.kind==="recommendation"&&r.data.validationRequired&&!relevant.some(x=>x.data.kind==="conclusion"&&x.data.recommendationId===r.id&&x.status==="confirmed"&&!x.stale&&(()=>{const run=records.find(t=>t.id===(x.data as any).runId);const plan=run?.data.kind==="test_run"?records.find(t=>t.id===(run.data as any).planId):null;return run?.data.kind==="test_run"&&plan?.data.kind==="test_plan"&&analyzeTest(plan.data,run.data).outcome==="pass";})()))throw new ApiError(422,"选定路线需要有效且已确认的通过试验结论");
  }
  const conclusions=relevant.filter(r=>r.data.kind==="conclusion"&&r.status==="confirmed").map(r=>{const data=r.data as Extract<ProjectData,{kind:"conclusion"}>,run=records.find(x=>x.id===data.runId),plan=run?.data.kind==="test_run"?records.find(x=>x.id===(run.data as any).planId):null;return {id:r.id,revision:r.revision,label:data.label,scope:data.scope,interpretation:data.interpretation,sampleBatch:run?.data.kind==="test_run"?run.data.sampleBatch:"",method:run?.data.kind==="test_run"?run.data.method:"",conditions:run?.data.kind==="test_run"?run.data.conditions:"",analysis:plan?.data.kind==="test_plan"&&run?.data.kind==="test_run"?analyzeTest(plan.data,run.data):null};});
  return {assignments,snapshot:{revision:c.revision,commercialId:commercial.id,commercialRevision:commercial.revision,commercialHash:hash(JSON.stringify(commercial.data)),validUntil:d.validUntil,publicTerms:d.publicTerms,currency:d.currency,quote:d.mode==="quote"?{quantity:d.quantity,netUnitPrice:d.netUnitPrice,discount:d.discount,netRevenue:calc.netRevenue}:null,records:relevant.map(r=>({id:r.id,kind:r.kind,revision:r.revision,label:r.data.label,status:r.status})),conclusions,values:relevant.filter(r=>r.data.kind==="value").map(r=>({label:r.data.label,basis:(r.data as any).basis,period:(r.data as any).period,assumptions:(r.data as any).assumptions,calculation:r.calculation}))}};
}
export async function checkApprovedProject(snapshot:any,db:any=pool){
  if(!snapshot.projectSnapshot)return; // Historical approval rounds retain their original three-role contract.
  const c=await projectControl(snapshot,db);
  if(c.revision!==snapshot.projectSnapshot.revision)throw new ApiError(409,"批准依据的专业对象或商务条件已变化，暂停新的正式交付");
  if(snapshot.projectSnapshot.validUntil<new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date()))throw new ApiError(409,"批准商务条件已过期");
  for(const r of await projectRecords(snapshot.id,snapshot.edition,db))await projectCitations(r.data,snapshot,db);
}

export function projectRouter(access:any,audit:any){
  const router=Router();
  router.post("/proposals/:id/project/import-workspace",async(req,res)=>{
    const b=z.object({requestId:z.string().uuid(),runId:z.string().uuid(),expectedEdition:z.number().int(),expectedProjectRevision:z.number().int()}).strict().parse(req.body);
    const result=await tx(async db=>{
      const p=await access(req,req.params.id,db,true);owner(req,p);if(p.edition!==b.expectedEdition)throw new ApiError(409,"方案版次变化");const replay=await receipt(req,p,b.requestId,b,db);if(replay.old)return replay.old;
      const c=await ensureControl(p,db);if(c.revision!==b.expectedProjectRevision)throw new ApiError(409,"专业对象已变化，请刷新");
      const [run]=await rows("SELECT * FROM sp_workspace_runs WHERE id=? AND proposal_id=?",[b.runId,p.id],db);if(!run||run.status!=="completed"||run.requested_by!==req.user.id)throw new ApiError(422,"没有可整理的本人已完成任务");
      const input=parse(run.input_snapshot);if(input.edition!==p.edition||input.revision!==p.revision||(input.projectRevision||0)!==c.revision)throw new ApiError(409,"任务基于旧修订，请重新生成");
      const read=(await rows("SELECT payload FROM sp_workspace_events WHERE run_id=? AND type='evidence_read'",[run.id],db)).map(e=>parse(e.payload));
      const candidate=parseWorkspaceResult(JSON.stringify(parse(run.result_json)),input,new Set(read.map(e=>e.versionId)));
      const old=await rows("SELECT id FROM sp_project_events WHERE proposal_id=? AND edition=? AND type='workspace_import' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.runId'))=?",[p.id,p.edition,run.id],db);if(old.length)throw new ApiError(409,"本轮任务已整理为专业对象，请维护已保存的候选");
      const values:ProjectData[]=[...candidate.facts.map(f=>({kind:"fact" as const,label:f.label,attributeKey:"",statement:f.text,value:null,unit:"",conditions:"",origin:"customer" as const,sourceNote:"AI整理候选，须核对原文和资料性质",citations:f.citations})),...candidate.questions.map(q=>({kind:"question" as const,label:q.question.slice(0,120),question:q.question,reason:q.reason||"待核实影响",blocking:q.priority==="blocking",answer:"",resolved:false,sourceNote:"",citations:[]}))];
      if(candidate.comparison)values.push({kind:"recommendation",label:"AI路线比较候选",productId:null,rationale:candidate.comparison.slice(0,4000),exclusions:"待核对排除条件",counterEvidence:"待检索反证，不代表不存在",decision:"candidate",validationRequired:true,reconsiderWhen:"待核对重新考虑条件",caseComparisons:[],citations:[]});
      const ids=[];
      for(const data of values){await projectCitations(data,p,db);const record:ProjectRecord={id:randomUUID(),kind:data.kind,revision:1,data:projectDataSchema.parse(data),dependencies:[],status:"candidate",created_by:req.user.id};ids.push(record.id);await db.execute("INSERT INTO sp_project_records(id,proposal_id,edition,kind,revision,data,dependencies,created_by) VALUES (?,?,?,?,1,?,'[]',?)",[record.id,p.id,p.edition,record.kind,JSON.stringify(record.data),req.user.id]);await db.execute("INSERT INTO sp_project_versions(record_id,revision,snapshot,actor_id) VALUES (?,1,?,?)",[record.id,JSON.stringify(record),req.user.id]);}
      await db.execute("UPDATE sp_project_controls SET revision=revision+1 WHERE proposal_id=? AND edition=?",[p.id,p.edition]);await db.execute("INSERT INTO sp_project_events(proposal_id,edition,type,payload) VALUES (?,?,'workspace_import',?)",[p.id,p.edition,JSON.stringify({runId:run.id,ids})]);const result={ids,revision:c.revision+1};await remember(req,p,b.requestId,replay.requestHash,result,db);await audit(db,req,"project.ai_candidates",p.id,{runId:run.id,count:ids.length});return result;
    });res.json(result);
  });
  router.get("/proposals/:id/project",async(req,res)=>{
    const p=await access(req,req.params.id),c=await projectControl(p),all=projectProjection(await projectRecords(p.id,p.edition));
    const canFinance=privateFinance(req,p,c),records=[];
    for(const r of all.filter(r=>r.kind!=="commercial"||canFinance)){try{await projectCitations(r.data,p);records.push(r);}catch(e){if(!(e instanceof ApiError))throw e;records.push({...r,data:{kind:r.kind,label:"来源失效，内容已隐藏"},unavailable:true,stale:true});}}
    const events=(await rows("SELECT * FROM sp_project_events WHERE proposal_id=? AND edition=? ORDER BY id DESC LIMIT 80",[p.id,p.edition])).map(e=>({...e,payload:parse(e.payload)})).filter(e=>canFinance||e.payload.visibility!=="internal");
    res.json({edition:p.edition,revision:c.revision,control:c,records,conflicts:projectConflicts(records.filter((r:any)=>!r.unavailable) as ProjectRecord[]),events,editable:p.owner_id===req.user.id&&req.user.roles.includes("engineer")&&editableStatus(p.status),canFinance,deliveries:await rows("SELECT * FROM sp_deliveries WHERE proposal_id=? ORDER BY created_at DESC",[p.id])});
  });
  router.put("/proposals/:id/project/reviewers",async(req,res)=>{
    const b=z.object({requestId:z.string().uuid(),expectedEdition:z.number().int(),expectedProjectRevision:z.number().int(),financeId:z.string().uuid(),qualityId:z.string().uuid().nullable(),legalId:z.string().uuid().nullable()}).strict().parse(req.body);
    const result=await tx(async db=>{const p=await access(req,req.params.id,db,true);owner(req,p);const r=await receipt(req,p,b.requestId,b,db);if(r.old)return r.old;const c=await ensureControl(p,db);if(c.revision!==b.expectedProjectRevision||p.edition!==b.expectedEdition)throw new ApiError(409,"项目已变化，请刷新");const selected=Object.entries({finance:b.financeId,quality:b.qualityId,legal:b.legalId}).filter(([,id])=>id);if(new Set(selected.map(([,id])=>id)).size!==selected.length)throw new ApiError(422,"各审核人须相互独立");for(const [role,id] of selected){const [u]=await rows("SELECT active,roles FROM sp_users WHERE id=?",[id],db);if(!u?.active||!parse(u.roles).includes(role)||[p.owner_id,p.created_by].includes(id!))throw new ApiError(422,"审核人资格或独立性不满足要求");}await db.execute("UPDATE sp_project_controls SET finance_id=?,quality_id=?,legal_id=?,revision=revision+1 WHERE proposal_id=? AND edition=?",[b.financeId,b.qualityId,b.legalId,p.id,p.edition]);const result={revision:c.revision+1};await remember(req,p,b.requestId,r.requestHash,result,db);await audit(db,req,"project.reviewers",p.id,{financeId:b.financeId,qualityId:b.qualityId,legalId:b.legalId});return result;});res.json(result);
  });
  router.post("/proposals/:id/project/records",async(req,res)=>{
    const b=projectWriteSchema.parse(req.body);
    const result=await tx(async db=>{
      const p=await access(req,req.params.id,db,true);owner(req,p);
      if(p.edition!==b.expectedEdition)throw new ApiError(409,"方案版次已变化");
      const replay=await receipt(req,p,b.requestId,b,db);if(replay.old)return replay.old;
      const c=await ensureControl(p,db);if(c.revision!==b.expectedProjectRevision)throw new ApiError(409,"项目对象已更新，本地输入保留，请重新核对");
      const all=await projectRecords(p.id,p.edition,db),old=all.find(r=>r.id===b.id);
      if(old?.kind==="conclusion"&&old.status==="confirmed")throw new ApiError(422,"已确认结论不可覆盖；请由技术人员明确否决后另建结论");
      if(b.data.kind==="commercial"&&!old&&all.some(r=>r.kind==="commercial"))throw new ApiError(422,"本版次已有商务底稿，请维护其修订，避免多个生效口径");
      if(old?.kind==="test_run"||old?.kind==="test_plan"&&all.some(r=>r.data.kind==="conclusion"&&r.status==="confirmed"&&(()=>{const run=all.find(x=>x.id===(r.data as any).runId);return run?.data.kind==="test_run"&&run.data.planId===old.id;})()))throw new ApiError(422,"原始结果或已用于确认结论的计划不可覆盖，请另建记录保留原始依据");
      const [collision]=old?[]:await rows("SELECT id FROM sp_project_records WHERE id=?",[b.id],db);
      if(collision||(!old&&b.expectedRevision!==0)||(old&&old.revision!==b.expectedRevision)||old&&old.kind!==b.data.kind)throw new ApiError(409,"对象范围、类型或修订不一致");
      await projectCitations(b.data,p,db);
      if(b.data.kind==="question"&&b.data.resolved&&(!b.data.answer.trim()||(!b.data.sourceNote.trim()&&!b.data.citations.length)))throw new ApiError(422,"解决问题须保留答复及来源");
      if(b.data.kind==="task"&&b.data.done&&!b.data.completionNote.trim())throw new ApiError(422,"完成待办须填写完成依据");
      if(b.data.kind==="task"&&b.data.assigneeId){const [assignee]=await rows("SELECT id,active,roles FROM sp_users WHERE id=?",[b.data.assigneeId],db);if(!assignee?.active)throw new ApiError(422,"责任人未启用");try{await access({...req,user:{...assignee,roles:parse(assignee.roles)}},p.id,db);}catch(e){if(!(e instanceof ApiError))throw e;throw new ApiError(422,"责任人须已有项目读取权限，请先配置项目分工");}}
      const dependencies=[...b.dependencies];for(const id of refsFor(b.data)){const r=all.find(r=>r.id===id);if(!r)throw new ApiError(422,"关联对象不存在或不属于当前版次");if(!dependencies.some(d=>d.id===id))dependencies.push({id,revision:r.revision});}
      if(new Set(dependencies.map(d=>d.id)).size!==dependencies.length)throw new ApiError(422,"依赖不能重复");
      if(b.data.kind==="test_plan"){const id=b.data.recommendationId;if(all.find(r=>r.id===id)?.kind!=="recommendation")throw new ApiError(422,"验证计划必须关联本项目推荐路线");}
      if(b.data.kind==="test_run"){const planId=b.data.planId;const plan=all.find(r=>r.id===planId);if(plan?.kind!=="test_plan"||plan.status!=="confirmed"||projectProjection(all).find(r=>r.id===plan.id)?.stale)throw new ApiError(422,"须先由技术人员确认有效验证计划，再登记结果");}
      if(b.data.kind==="conclusion"){const {runId,recommendationId}=b.data;const run=all.find(r=>r.id===runId),planId=run?.data.kind==="test_run"?run.data.planId:null,plan=all.find(r=>r.id===planId);if(plan?.data.kind!=="test_plan"||plan.data.recommendationId!==recommendationId)throw new ApiError(422,"结果与推荐路线不对应");}
      const record:ProjectRecord={id:b.id,revision:(old?.revision||0)+1,kind:b.data.kind,data:b.data,dependencies,status:"candidate",created_by:req.user.id,confirmed_by:null};verifyGraph(record,all);
      if(old)await db.execute("UPDATE sp_project_records SET revision=?,data=?,dependencies=?,status='candidate',confirmed_by=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[record.revision,JSON.stringify(record.data),JSON.stringify(dependencies),record.id]);
      else await db.execute("INSERT INTO sp_project_records(id,proposal_id,edition,kind,revision,data,dependencies,created_by) VALUES (?,?,?,?,?,?,?,?)",[record.id,p.id,p.edition,record.kind,record.revision,JSON.stringify(record.data),JSON.stringify(dependencies),req.user.id]);
      await db.execute("INSERT INTO sp_project_versions(record_id,revision,snapshot,actor_id) VALUES (?,?,?,?)",[record.id,record.revision,JSON.stringify(record),req.user.id]);
      await change(req,p,record,all,"object_changed",db);const result={id:record.id,revision:record.revision,projectRevision:c.revision+1};await remember(req,p,b.requestId,replay.requestHash,result,db);await audit(db,req,"project.saved",p.id,{id:record.id,kind:record.kind,revision:record.revision});return result;
    });res.json(result);
  });
  router.post("/proposals/:id/project/records/:record/confirm",async(req,res)=>{
    const b=z.object({requestId:z.string().uuid(),expectedEdition:z.number().int(),expectedProjectRevision:z.number().int(),expectedRevision:z.number().int(),decision:z.enum(["confirmed","rejected"]),note:z.string().trim().min(4).max(2000)}).strict().parse(req.body);
    const result=await tx(async db=>{
      const p=await access(req,req.params.id,db,true);if(!editableStatus(p.status))throw new ApiError(409,"当前版本只读");if(p.edition!==b.expectedEdition)throw new ApiError(409,"方案版次变化");
      const replay=await receipt(req,p,b.requestId,b,db);if(replay.old)return replay.old;
      const c=await ensureControl(p,db),all=await projectRecords(p.id,p.edition,db),record=all.find(r=>r.id===req.params.record);
      if(!record)throw new ApiError(404,"对象不存在");if(c.revision!==b.expectedProjectRevision||record.revision!==b.expectedRevision)throw new ApiError(409,"对象已更新，请重新核对");
      if(["recommendation","test_plan","conclusion","value"].includes(record.kind)){requireRole(req,"chemist");if([p.owner_id,p.created_by,record.created_by].includes(req.user.id))throw new ApiError(403,"专业对象须独立技术确认");}else owner(req,p);
      await projectCitations(record.data,p,db);const projected=projectProjection(all).find(r=>r.id===record.id)!;
      if(b.decision==="confirmed"&&(projected.stale||projected.blocked))throw new ApiError(422,"依赖失效或试验反证阻断，不能确认");
      if(record.kind==="commercial")throw new ApiError(422,"商务底稿通过正式财务节点复核");
      const next={...record,revision:record.revision+1,status:b.decision,confirmed_by:req.user.id};
      await db.execute("UPDATE sp_project_records SET status=?,revision=revision+1,confirmed_by=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[b.decision,req.user.id,record.id]);await db.execute("INSERT INTO sp_project_versions(record_id,revision,snapshot,actor_id) VALUES (?,?,?,?)",[record.id,next.revision,JSON.stringify({...next,confirmationNote:b.note}),req.user.id]);
      await change(req,p,next,all,"object_confirmed",db);const result={revision:next.revision,projectRevision:c.revision+1};await remember(req,p,b.requestId,replay.requestHash,result,db);await audit(db,req,"project.confirmed",p.id,{id:record.id,decision:b.decision});return result;
    });res.json(result);
  });
  router.get("/proposals/:id/project/records/:record/history",async(req,res)=>{const p=await access(req,req.params.id),c=await projectControl(p);const all=await projectRecords(p.id,p.edition),r=all.find(r=>r.id===req.params.record);if(!r||r.kind==="commercial"&&!privateFinance(req,p,c))throw new ApiError(404,"对象不存在");const history=await rows("SELECT revision,snapshot,actor_id,created_at FROM sp_project_versions WHERE record_id=? ORDER BY revision DESC",[r.id]);const visible=[];for(const h of history){const snapshot=parse(h.snapshot);try{await projectCitations(snapshot.data,p);visible.push({...h,snapshot});}catch(e){if(!(e instanceof ApiError))throw e;visible.push({...h,snapshot:null,unavailable:true});}}res.json(visible);});
  router.post("/proposals/:id/project/records/:record/complete",async(req,res)=>{
    const b=z.object({requestId:z.string().uuid(),expectedEdition:z.number().int(),expectedRevision:z.number().int(),note:z.string().trim().min(4).max(2000)}).strict().parse(req.body);
    const result=await tx(async db=>{const p=await access(req,req.params.id,db,true);if(p.edition!==b.expectedEdition)throw new ApiError(409,"版次已改变");const replay=await receipt(req,p,b.requestId,b,db);if(replay.old)return replay.old;
      const all=await projectRecords(p.id,p.edition,db),r=all.find(r=>r.id===req.params.record);if(r?.data.kind!=="task")throw new ApiError(404,"待办不存在");if(r.data.assigneeId!==req.user.id&&p.owner_id!==req.user.id)throw new ApiError(403,"仅责任人或项目负责人可完成待办");if(r.revision!==b.expectedRevision)throw new ApiError(409,"待办已变化");
      const frozen=!editableStatus(p.status);if(frozen){const approvals=await rows("SELECT snapshot FROM sp_approval_requests WHERE proposal_id=? AND edition=? AND status IN ('pending','approved')",[p.id,p.edition],db);if(approvals.some(a=>parse(a.snapshot).projectSnapshot?.records.some((x:any)=>x.id===r.id)))throw new ApiError(409,"此待办属于固定专业依据，须撤回或开启新版后处理");}
      const next={...r,revision:r.revision+1,data:{...r.data,done:true,completionNote:b.note},status:"confirmed",confirmed_by:req.user.id};await db.execute("UPDATE sp_project_records SET revision=?,data=?,status='confirmed',confirmed_by=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[next.revision,JSON.stringify(next.data),req.user.id,r.id]);await db.execute("INSERT INTO sp_project_versions(record_id,revision,snapshot,actor_id) VALUES (?,?,?,?)",[r.id,next.revision,JSON.stringify(next),req.user.id]);if(!frozen)await change(req,p,next as ProjectRecord,all,"task_completed",db);else await db.execute("INSERT INTO sp_project_events(proposal_id,edition,type,payload) VALUES (?,?,'task_completed',?)",[p.id,p.edition,JSON.stringify({recordId:r.id})]);const result={revision:next.revision};await remember(req,p,b.requestId,replay.requestHash,result,db);await audit(db,req,"project.task_completed",p.id,{id:r.id});return result;
    });res.json(result);
  });
  router.post("/proposals/:id/project/events/:event/resolve",async(req,res)=>{const b=z.object({note:z.string().min(4).max(2000)}).parse(req.body);await tx(async db=>{const p=await access(req,req.params.id,db,true);owner(req,p);await db.execute("UPDATE sp_project_events SET resolved=TRUE WHERE id=? AND proposal_id=? AND edition=?",[req.params.event,p.id,p.edition]);await audit(db,req,"project.impact_acknowledged",p.id,{eventId:req.params.event,note:b.note});});res.json({ok:true});});
  router.post("/proposals/:id/project/evidence-search",async(req,res)=>{const p=await access(req,req.params.id);const b=z.object({query:z.string().max(200),versionIds:z.array(z.string().uuid()).max(30)}).parse(req.body);const sources=[];for(const id of new Set(b.versionIds)){const [s]=await rows("SELECT v.id,v.text_content AS text,v.status,v.expires_on,d.title,d.kind,d.proposal_id FROM sp_document_versions v JOIN sp_documents d ON d.id=v.document_id WHERE v.id=?",[id]);if(!s||s.status!=="published"||s.proposal_id&&s.proposal_id!==p.id)throw new ApiError(422,"来源不可用或超出项目范围");await projectCitations({kind:"fact",label:"检索",statement:"检索",value:null,unit:"",conditions:"",origin:"customer",sourceNote:"检索",citations:[{versionId:id,start:0,quote:s.text.slice(0,Math.min(4,s.text.length))}]} as ProjectData,p);sources.push(s);}res.json({matches:searchProjectEvidence(sources,b.query),coverage:sources.map(s=>({versionId:s.id,totalChars:s.text.length,searchedChars:s.text.length}))});});
  router.post("/proposals/:id/project/deliveries",async(req,res)=>{
    const b=z.object({requestId:z.string().uuid(),approvalId:z.string().uuid(),recipient:z.string().trim().min(1).max(240),channel:z.string().trim().min(1).max(100),deliveredAt:z.iso.datetime(),note:z.string().max(2000)}).strict().parse(req.body);
    const result=await tx(async db=>{const p=await access(req,req.params.id,db,true);requireRole(req,"engineer");if(p.owner_id!==req.user.id)throw new ApiError(403,"仅负责人可登记交付");const replay=await receipt(req,p,b.requestId,b,db);if(replay.old)return replay.old;const [a]=await rows("SELECT * FROM sp_approval_requests WHERE id=? AND proposal_id=? AND status='approved'",[b.approvalId,p.id],db);if(!a)throw new ApiError(422,"只能登记已批准成果");const snapshot=parse(a.snapshot);await checkApprovedProject(snapshot,db);const [artifact]=await rows("SELECT sha256 FROM sp_artifacts WHERE request_id=? AND format='docx'",[a.id],db);if(!artifact)throw new ApiError(422,"请先生成并下载批准版文件，再登记实际交付");const id=randomUUID();await db.execute("INSERT INTO sp_deliveries(id,proposal_id,approval_id,request_id,recipient,channel,delivered_at,artifact_hash,note,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?)",[id,p.id,a.id,b.requestId,b.recipient,b.channel,new Date(b.deliveredAt),artifact.sha256,b.note,req.user.id]);await remember(req,p,b.requestId,replay.requestHash,{id},db);await audit(db,req,"delivery.recorded",p.id,{id,approvalId:a.id,hash:artifact.sha256});return {id};});res.json(result);
  });
  return router;
}
