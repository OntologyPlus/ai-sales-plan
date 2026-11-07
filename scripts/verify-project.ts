import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import mammoth from "mammoth";
import {pool,rows,parse} from "../server/db.js";
import {passwordHash} from "../server/security.js";
import {storage} from "../server/storage.js";
import {verifyProjectBrowser} from "./project-browser.js";
const base=process.env.PROJECT_VERIFY_BASE||"http://127.0.0.1:3201";
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw new Error("仅允许本机验收");
const ids:string[]=[],docs:string[]=[],clients:any={},checks:string[]=[];let proposal="",customer="";
async function request(c:any,path:string,method="GET",body?:any){return fetch(base+"/api"+path,{method,headers:{origin:base,cookie:c?.cookie||"","x-csrf-token":c?.csrf||"","content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});}
async function call(c:any,path:string,method="GET",body?:any){const r=await request(c,path,method,body);const d=await r.json();assert.ok(r.ok,`${method} ${path} ${r.status}: ${JSON.stringify(d)}`);return d;}
async function status(c:any,n:number,path:string,method="GET",body?:any){const r=await request(c,path,method,body);assert.equal(r.status,n,await r.text());}
async function source(kind:string,text:string,privateDoc=false){const id=randomUUID(),versionId=randomUUID();docs.push(id);const f=await storage.put("documents",Buffer.from(text));await pool.execute("INSERT INTO sp_documents(id,title,kind,proposal_id,created_by) VALUES (?,?,?,?,?)",[id,`合成${kind}验收资料`,kind,privateDoc?proposal:null,clients.engineer.id]);await pool.execute("INSERT INTO sp_document_versions(id,document_id,version,filename,sha256,storage_provider,storage_key,byte_size,text_content,parse_notes,status,allow_model,created_by) VALUES (?,?,1,'synthetic.txt',?,?,?,?,?,?,'published',TRUE,?)",[versionId,id,f.sha256,f.provider,f.key,f.size,text,JSON.stringify({synthetic:true,fixture:true}),clients.engineer.id]);return {versionId,quote:text,start:0};}
async function state(c=clients.engineer){return call(c,`/proposals/${proposal}/project`);}
async function save(data:any,dependencies:any[]=[],old?:any){const s=await state();return call(clients.engineer,`/proposals/${proposal}/project/records`,"POST",{requestId:randomUUID(),expectedEdition:s.edition,expectedProjectRevision:s.revision,id:old?.id||randomUUID(),expectedRevision:old?.revision||0,dependencies,data});}
async function confirm(id:string,client=clients.chemist,decision="confirmed"){const s=await state(),r=s.records.find((r:any)=>r.id===id);return call(client,`/proposals/${proposal}/project/records/${id}/confirm`,"POST",{requestId:randomUUID(),expectedEdition:s.edition,expectedProjectRevision:s.revision,expectedRevision:r.revision,decision,note:"独立核对合成软件验收记录，仅验证工程流程"});}
async function record(id:string){return (await state()).records.find((r:any)=>r.id===id);}
try{
  await mkdir("data/qa/project",{recursive:true});
  for(const role of ["engineer","chemist","compliance","finance","quality","legal","leader","outsider"]){const id=randomUUID(),email=`project-${role}-${id}@example.test`,password=randomBytes(24).toString("hex");ids.push(id);await pool.execute("INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",[id,email,`合成验收·${role}`,passwordHash(password),JSON.stringify([role==="outsider"?"engineer":role])]);const r=await request(null,"/login","POST",{email,password});assert.equal(r.status,200);clients[role]={id,cookie:r.headers.get("set-cookie")!.split(";")[0],csrf:(await r.json()).csrf};}
  const e=clients.engineer;
  customer=(await call(e,"/customers","POST",{name:"三批闭环合成客户",industry:"合成清洗与材料评估",contact:""})).id;
  proposal=(await call(e,"/proposals","POST",{title:"三批完整专业与商务闭环验收",customerId:customer,scene:"合成应用问题，不构成真实工艺建议"})).id;
  const path=`/proposals/${proposal}/project`;
  await pool.execute("INSERT INTO sp_review_assignments(owner_id,chemist_id,compliance_id,leader_id,revision) VALUES (?,?,?,?,1)",[e.id,clients.chemist.id,clients.compliance.id,clients.leader.id]);
  const customerSource=await source("customer","【合成客户资料】需核实材料和验收边界，仅用于软件验收。",true),tds=await source("tds","【合成技术说明】样板路线仅用于比较合成指标，客户适用性必须按固定样品、方法和工况验证，不提供真实性能保证。"),sds=await source("sds","【合成安全说明】真实危险分类、人员防护、废弃处置和合规要求须由专业人员核实，仅用于软件验收。"),long=await source("application","普通段落。".repeat(4000)+"后段反证：合成条件Z不支持迁移。 ");
  const p=await call(e,`/proposals/${proposal}`);p.body.requirements="合成客户问题与验收目标";p.body.sections=p.body.sections.map((s:any,i:number)=>({...s,content:"合成软件验收正文，不构成专业结论。",evidence:"原文核对",citations:[i===5?sds:tds]}));await call(e,`/proposals/${proposal}`,"PUT",{expectedRevision:p.revision,body:p.body});
  await status(clients.outsider,404,path);
  const fact=await save({kind:"fact",label:"材料边界",statement:"实际材料待客户确认",value:null,unit:"",conditions:"合成工况",origin:"customer",sourceNote:"合成客户问卷",citations:[customerSource]});await confirm(fact.id,e);
  const f=await record(fact.id);
  const recData=(name:string,decision="selected")=>({kind:"recommendation",label:name,productId:null,rationale:"仅为合成候选，需验证",exclusions:"条件不一致时排除",counterEvidence:"须保留失败及限制",decision,validationRequired:true,citations:[tds]});
  const a=await save(recData("路线A"),[{id:f.id,revision:f.revision}]);await confirm(a.id);
  const planData=(id:string,label:string)=>({kind:"test_plan",label,recommendationId:id,objective:"比较合成指标",sampleBatch:"SYN-S1",method:"SYN-M1",conditions:"SYN-C1",control:"合成基线对照",repeats:3,criteria:[{key:"metric",label:"合成指数",unit:"合成单位",operator:"gte",target:"10"}],citations:[tds]});
  const pa=await save(planData(a.id,"A验证计划"));await status(e,403,`${path}/records/${pa.id}/confirm`,"POST",{requestId:randomUUID(),expectedEdition:1,expectedProjectRevision:(await state()).revision,expectedRevision:1,decision:"confirmed",note:"不得自己确认专业计划"});await confirm(pa.id);
  const runData=(planId:string,value:string|null)=>({kind:"test_run",label:`原始结果${value??"缺测"}`,planId,sampleBatch:"SYN-S1",method:"SYN-M1",conditions:"SYN-C1",rawNotes:"合成原始记录；非真实化工结果",measurements:[{key:"metric",value,unit:"合成单位",note:"原始值保留，不作统计显著性推断"}],citations:[]});
  const ra=await save(runData(pa.id,"8"));assert.equal((await record(ra.id)).calculation.outcome,"fail");
  const ca=await save({kind:"conclusion",label:"A不支持",runId:ra.id,recommendationId:a.id,scope:"仅对SYN-M1/C1/S1有效",interpretation:"合成指标未达到判据，停止A路线推荐",citations:[]});await confirm(ca.id);assert.equal((await record(a.id)).blocked,true);
  await status(e,422,path+"/records","POST",{requestId:randomUUID(),expectedEdition:1,expectedProjectRevision:(await state()).revision,id:ca.id,expectedRevision:2,dependencies:[],data:{...(await record(ca.id)).data,interpretation:"试图覆盖失败"}});
  const oldA=await record(a.id);await save({...oldA.data,decision:"excluded"},oldA.dependencies,oldA);
  assert.equal((await record(a.id)).blocked,true);
  const b=await save(recData("路线B"),[{id:f.id,revision:f.revision}]);await confirm(b.id);const pb=await save(planData(b.id,"B验证计划"));await confirm(pb.id);const rb=await save(runData(pb.id,"12"));const cb=await save({kind:"conclusion",label:"B有限通过",runId:rb.id,recommendationId:b.id,scope:"仅对固定合成条件有效，不能外推",interpretation:"合成判据通过，真实现场需另行验证",citations:[]});await confirm(cb.id);
  checks.push("应用事实、路线A失败保留并阻断、路线B计划独立确认/原始值/技术结论与依赖闭环");
  const q=await save({kind:"question",label:"阻断追问",question:"确认验收方？",reason:"决定验收口径",blocking:true,resolved:false,answer:"",sourceNote:"",citations:[]});
  const qRow=await record(q.id);await save({...qRow.data,resolved:true,answer:"由合成客户质量代表核对",sourceNote:"合成确认记录"},[],qRow);
  const value=await save({kind:"value",label:"客户价值情景",basis:"同等合格处理量1000单位，待证明等效",period:"同一期",currency:"CNY",equivalence:"assumed",assumptions:"本例只比较条件成本",outputQuantity:"1000",baseline:[{label:"基线应用总成本",amount:"2500",source:"合成底稿"}],candidate:[{label:"候选应用总成本",amount:"2420",source:"合成底稿"}],citations:[]});assert.equal((await record(value.id)).calculation.difference,"80.00");
  const commercial=await save({kind:"commercial",label:"内部商务底稿",mode:"quote",currency:"CNY",quantity:"1000",netUnitPrice:"24",unitCost:"18",discount:"100",specialExpense:"500",validUntil:"2099-01-01",publicTerms:"公开合成报价条件，仅限固定范围",internalNotes:"PRIVATE-PROFIT-NOTES-DO-NOT-EXPORT",sourceNote:"合成不含税成本及专项费用，各项不重复扣减",supplyCommitment:true,legalException:true,citations:[]});assert.equal((await record(commercial.id)).calculation.contribution,"5400.00");
  const config={requestId:randomUUID(),expectedEdition:1,expectedProjectRevision:(await state()).revision,financeId:clients.finance.id,qualityId:clients.quality.id,legalId:clients.legal.id};await call(e,path+"/reviewers","PUT",config);
  assert.ok((await call(clients.finance,"/proposals")).some((x:any)=>x.id===proposal));
  const obligation=await save({kind:"task",label:"交付后核对义务",description:"核对合成客户接收确认，不改变专业结论",assigneeId:clients.quality.id,dueOn:"2099-01-01",done:false,completionNote:"",citations:[]});assert.ok((await call(clients.quality,"/inbox")).projectTasks.some((x:any)=>x.id===obligation.id));
  assert.ok(!(await state(clients.chemist)).records.some((r:any)=>r.kind==="commercial"));assert.ok((await state(clients.finance)).records.some((r:any)=>r.kind==="commercial"));await status(clients.chemist,404,`${path}/records/${commercial.id}/history`);
  const text=JSON.stringify(await call(clients.chemist,`/proposals/${proposal}`));assert.ok(!text.includes("PRIVATE-PROFIT"));
  const found=await call(e,path+"/evidence-search","POST",{query:"后段反证",versionIds:[long.versionId]});assert.ok(found.matches.some((m:any)=>m.start>12000));
  checks.push("长文后段定位、客户价值80元/3.2%复算、内部收入/毛利/贡献复算及跨角色底稿隔离");
  const s=await state(),hypothesisId=randomUUID(),body={requestId:randomUUID(),expectedEdition:1,expectedProjectRevision:s.revision,id:hypothesisId,expectedRevision:0,dependencies:[],data:{kind:"hypothesis",label:"假设记录",statement:"仍为待验证解释",support:"已有观察",counterEvidence:"保留反证",citations:[]}};
  const saved=await call(e,path+"/records","POST",body);assert.deepEqual(await call(e,path+"/records","POST",body),saved);await status(e,409,path+"/records","POST",{...body,requestId:randomUUID()});await status(e,409,path+"/records","POST",{...body,data:{...body.data,statement:"不同内容"}});
  const submit={expectedRevision:2,note:"合成软件验收，固定专业依据和商务口径后进入独立审核",assignments:{chemist:clients.chemist.id,compliance:clients.compliance.id,leader:clients.leader.id}};
  if(process.argv.includes("--browser"))await verifyProjectBrowser(base,proposal,clients,checks);
  if(process.argv.includes("--ai")){
    const task=await call(e,`/proposals/${proposal}/workspace/runs`,"POST",{requestKey:randomUUID(),expectedEdition:1,expectedRevision:2,versionIds:[customerSource.versionId,tds.versionId,long.versionId],consent:true,instruction:"读取方案、read_project中的专业对象与确定性试验结果，核对路线A已经失败且被排除、路线B结论适用范围。检索长文中的后段反证，给出下一步与客户价值的有条件解释。引用使用真实整份原文偏移。不要输出正文章节，不读取内部利润底稿。"});
    let run:any;
    for(let i=0;i<300;i++){run=(await call(e,`/proposals/${proposal}/workspace`)).runs.find((r:any)=>r.id===task.id);if(!["queued","running"].includes(run.status))break;await new Promise(r=>setTimeout(r,1000));}
    assert.equal(run.status,"completed",run.error);assert.ok(run.events.some((x:any)=>x.type==="tool_completed"&&x.payload.name==="read_project"));const [savedInput]=await rows("SELECT input_snapshot FROM sp_workspace_runs WHERE id=?",[task.id]);assert.ok(!JSON.stringify(savedInput).includes("PRIVATE-PROFIT"));assert.ok(!JSON.stringify(run.result).includes("PRIVATE-PROFIT"));checks.push("真实模型读取专业对象、失败/通过结论、长文反证和客户价值，内部底稿不进入模型上下文");await writeFile("data/qa/project/real-agent.json",JSON.stringify({modelRequests:run.modelRequests,result:run.result,synthetic:true},null,2));
  }
  const conflictData=(value:string)=>({kind:"fact",label:"冲突指标",attributeKey:"alignment-metric",statement:"合成现场读数",value,unit:"合成单位",conditions:"同一合成工况",origin:"observation",sourceNote:"合成核对记录",citations:[]});
  const left=await save(conflictData("1")),right=await save(conflictData("2"));await confirm(left.id,e);await confirm(right.id,e);assert.equal((await state()).conflicts.length,1);await status(e,422,`/proposals/${proposal}/submit`,"POST",submit);await confirm(right.id,e,"rejected");assert.equal((await state()).conflicts.length,0);checks.push("显式属性/单位/工况的事实冲突识别、正式送审阻断及否决后解除");
  const caseSource=await source("case","【合成失败案例】原方法M0、条件C0下失败，不能推断当前方法M1有效。",true);
  const caseRoute=await save({...recData("案例比较候选","candidate"),reconsiderWhen:"取得当前工况验证后重新考虑",caseComparisons:[{sourceVersionId:caseSource.versionId,outcome:"failure",sourceConditions:"M0/C0",targetConditions:"M1/C1",differences:"方法和条件不同，须重新验证"}],citations:[caseSource]});assert.equal((await record(caseRoute.id)).data.caseComparisons.length,1);checks.push("案例类来源绑定、失败案例与当前条件差异的独立保存");
  await call(e,`/proposals/${proposal}/submit`,"POST",submit);
  let loaded=await call(e,`/proposals/${proposal}`),approval=loaded.requests[0];assert.equal(approval.steps.length,6);
  const decide=async(role:string)=>{const p=await call(clients[role],`/proposals/${proposal}`),step=p.requests[0].steps.find((s:any)=>s.role===role);return call(clients[role],`/proposals/${proposal}/decide`,"POST",{stepId:step.id,decision:"approved",comment:"独立核对合成软件验收，不作专业质量签收"});};
  const financeStep=approval.steps.find((s:any)=>s.role==="finance");await status(clients.finance,409,`/proposals/${proposal}/decide`,"POST",{stepId:financeStep.id,decision:"approved",comment:"前序未通过"});
  await decide("chemist");await decide("compliance");await decide("quality");assert.equal((await call(e,`/proposals/${proposal}`)).requests[0].steps.find((s:any)=>s.role==="finance").status,"waiting");await decide("legal");await decide("finance");await decide("leader");
  loaded=await call(e,`/proposals/${proposal}`);assert.equal(loaded.status,"APPROVED");approval=loaded.requests[0];
  const delivery={requestId:randomUUID(),approvalId:approval.id,recipient:"合成客户接收人",channel:"人工演示渠道",deliveredAt:new Date().toISOString(),note:"合成实际交付登记，无外部发送"};
  await status(e,422,path+"/deliveries","POST",delivery);
  const file=await request(e,`/proposals/${proposal}/export.docx`);assert.equal(file.status,200);const bytes=Buffer.from(await file.arrayBuffer());const extracted=(await mammoth.extractRawText({buffer:bytes})).value;assert.ok(extracted.includes("23900.00"));assert.ok(extracted.includes("独立财务复核"));assert.ok(extracted.includes("已确认验证结论与适用范围"));assert.ok(extracted.includes("SYN-M1"));assert.ok(!extracted.includes("PRIVATE-PROFIT"));assert.ok(!extracted.includes("5400.00"));
  const completion={requestId:randomUUID(),expectedEdition:1,expectedRevision:1,note:"合成接收确认已核对，不涉及变更批准内容"};const completed=await call(clients.quality,`${path}/records/${obligation.id}/complete`,"POST",completion);assert.deepEqual(await call(clients.quality,`${path}/records/${obligation.id}/complete`,"POST",completion),completed);assert.ok(!(await call(clients.quality,"/inbox")).projectTasks.some((x:any)=>x.id===obligation.id));
  const second=await request(e,`/proposals/${proposal}/export.docx`);assert.deepEqual(Buffer.from(await second.arrayBuffer()),bytes);
  const sent=await call(e,path+"/deliveries","POST",delivery);assert.deepEqual(await call(e,path+"/deliveries","POST",delivery),sent);assert.equal((await state()).deliveries.length,1);
  checks.push("技术/合规/供应/法务→财务→终审六节点顺序、固定公开商务Word、底稿不泄露、原件重取及交付回执幂等");
  await call(e,`/proposals/${proposal}/new-version`,"POST");assert.equal((await state()).records.length,0);assert.ok(!(await call(e,`/proposals/${proposal}`)).body.projectDependencies);assert.equal((await state()).deliveries.length,1);
  await call(clients.chemist,`/documents/${tds.versionId}/review`,"POST",{decision:"withdraw",note:"合成验收资料失效，验证批准文件新使用受限"});await status(e,422,`/proposals/${proposal}/export.docx?requestId=${approval.id}`);
  checks.push("新版隔离、历史交付保留、资料撤回立即阻断批准文件新下载");
  await writeFile("data/qa/project/result.json",JSON.stringify({createdAt:new Date().toISOString(),synthetic:true,professionalValidation:false,checks},null,2));await writeFile("data/qa/project/approved-synthetic.docx",bytes);console.log(JSON.stringify({passed:true,checks},null,2));
}finally{
  if(proposal){await pool.execute("DELETE e FROM sp_workspace_events e JOIN sp_workspace_runs r ON r.id=e.run_id WHERE r.proposal_id=?",[proposal]);await pool.execute("DELETE FROM sp_workspace_runs WHERE proposal_id=?",[proposal]);for(const table of ["sp_deliveries","sp_project_events","sp_project_receipts","sp_project_controls","sp_exports","sp_proposal_versions","sp_audit_logs"])await pool.execute(`DELETE FROM ${table} WHERE proposal_id=?`,[proposal]);await pool.execute("DELETE v FROM sp_project_versions v JOIN sp_project_records r ON r.id=v.record_id WHERE r.proposal_id=?",[proposal]);await pool.execute("DELETE FROM sp_project_records WHERE proposal_id=?",[proposal]);await pool.execute("DELETE a FROM sp_artifacts a JOIN sp_approval_requests r ON r.id=a.request_id WHERE r.proposal_id=?",[proposal]);await pool.execute("DELETE s FROM sp_approval_steps s JOIN sp_approval_requests r ON r.id=s.request_id WHERE r.proposal_id=?",[proposal]);await pool.execute("DELETE FROM sp_approval_requests WHERE proposal_id=?",[proposal]);}
  for(const id of docs){await pool.execute("DELETE FROM sp_document_versions WHERE document_id=?",[id]);await pool.execute("DELETE FROM sp_documents WHERE id=?",[id]);}
  if(proposal)await pool.execute("DELETE FROM sp_proposals WHERE id=?",[proposal]);if(customer)await pool.execute("DELETE FROM sp_customers WHERE id=?",[customer]);
  for(const id of ids){await pool.execute("DELETE FROM sp_review_assignments WHERE owner_id=?",[id]);await pool.execute("DELETE FROM sp_sessions WHERE user_id=?",[id]);await pool.execute("DELETE FROM sp_audit_logs WHERE actor_id=?",[id]);await pool.execute("DELETE FROM sp_users WHERE id=?",[id]);}await pool.end();
}
