import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import { pool,rows } from "../server/db.js";
import { hash,passwordHash } from "../server/security.js";
import { storage } from "../server/storage.js";

const base=process.env.WORKSPACE_VERIFY_BASE || "http://127.0.0.1:3201";
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw new Error("验收仅允许本机服务");
const ids=[randomUUID(),randomUUID()],proposals:string[]=[],documents:string[]=[],customers:string[]=[],checks:string[]=[],cases:any[]=[];
type Client={id:string;cookie:string;csrf:string};
async function login(id:string):Promise<Client>{
  const password=randomBytes(24).toString("hex"),email=`workspace-${id}@example.test`;
  await pool.execute("INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",[id,email,"统一工作空间验收工程师",passwordHash(password),JSON.stringify(["engineer"])]);
  const r=await fetch(base+"/api/login",{method:"POST",headers:{origin:base,"content-type":"application/json"},body:JSON.stringify({email,password})});assert.equal(r.status,200);
  return {id,cookie:r.headers.get("set-cookie")!.split(";")[0],csrf:(await r.json()).csrf};
}
async function response(c:Client,path:string,method="GET",body?:any){return fetch(base+"/api"+path,{method,headers:{origin:base,cookie:c.cookie,"x-csrf-token":c.csrf,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});}
async function call(c:Client,path:string,method="GET",body?:any){const r=await response(c,path,method,body),d=await r.json();assert.ok(r.ok,`${path} HTTP ${r.status}: ${JSON.stringify(d)}`);return d;}
async function status(c:Client,n:number,path:string,method="GET",body?:any){const r=await response(c,path,method,body);assert.equal(r.status,n,await r.text());}
async function source(owner:Client,proposalId:string|null,kind:string,text:string){
  const id=randomUUID(),versionId=randomUUID();documents.push(id);const file=await storage.put("documents",Buffer.from(text));
  await pool.execute("INSERT INTO sp_documents(id,title,kind,proposal_id,created_by) VALUES (?,?,?,?,?)",[id,`合成验收${kind}资料`,kind,proposalId,owner.id]);
  await pool.execute("INSERT INTO sp_document_versions(id,document_id,version,filename,sha256,storage_provider,storage_key,byte_size,text_content,parse_notes,status,allow_model,created_by) VALUES (?,?,1,'workspace-synthetic.txt',?,?,?,?,?,?,'published',TRUE,?)",[versionId,id,file.sha256,file.provider,file.key,file.size,text,JSON.stringify({synthetic:true,fixture:true}),owner.id]);
  return versionId;
}
async function settled(owner:Client,path:string,id:string){
  let previous="";
  for(let n=0;n<240;n++){
    const state=await call(owner,path),run=state.runs.find((r:any)=>r.id===id);assert.ok(run);
    const progress=run.status+":"+run.modelRequests;
    if(progress!==previous){console.log("真实模型任务",progress);previous=progress;}
    if(!["queued","running"].includes(run.status)){assert.equal(run.status,"completed",run.error);return run;}
    await new Promise(r=>setTimeout(r,1000));
  }throw new Error("真实Agent任务等待超时");
}
try{
  await mkdir("data/qa/workspace",{recursive:true});
  const owner=await login(ids[0]),outsider=await login(ids[1]);
  const config=await call(owner,"/workspace/config");assert.equal(config.runtime,"pi-durable");assert.ok(config.configured && config.workerReady);
  for(const scene of ["PCBA清洗","结构胶粘接"]){
    console.log("验收场景",scene);
    const customer=(await call(owner,"/customers","POST",{name:`合成${scene}验收客户`,industry:"合成工程验收",contact:""})).id;customers.push(customer);
    const p=(await call(owner,"/proposals","POST",{title:`统一AI工作空间·${scene}验收`,customerId:customer,scene})).id;proposals.push(p);
    const path=`/proposals/${p}/workspace`;
    await status(outsider,404,path);
    const customerText=scene==="PCBA清洗"?"【合成客户资料】客户拟清洗合成板件A的助焊剂残留，实际板材与敏感元件待核实，客户清洁度测试方法和验收限值尚未确认。":"【合成客户资料】客户拟粘接合成金属A与合成塑料B，实际牌号、载荷与老化要求待核实，尚未提供客户试验结果。";
    const customerVersion=await source(owner,p,"customer",customerText),versionIds=[customerVersion];
    if(scene==="结构胶粘接"){
      versionIds.push(await source(owner,null,"tds","【合成技术说明，仅用于软件验收】样板材料S只记录了合成基材的待验证应用建议，没有保证强度数据，不得推断对实际客户基材适用。实际表面状态、固化窗口、承载与耐久性须由应用化学师确认并做样品验证。"));
    }
    const body={requestKey:randomUUID(),expectedEdition:1,expectedRevision:1,versionIds,consent:true,
      instruction:`这是软件工程验收，所有资料均为合成，不作专业结论。先读取方案、检索资料、读取所选原文、检查产品。提取至少一条客户资料候选事实，quote直接使用客户资料完整连续原文且start为0。给出优先追问和待确认的验证计划。${scene==="结构胶粘接"?"仅准备第2索引章节（产品推荐与匹配依据）一章正文候选，明确没有产品保证值、不得推荐具体产品，引用合成技术说明全文且start为0。":"没有技术资料，chapters必须为空。"}不要编造数据。`};
    const started=await call(owner,path+"/runs","POST",body);
    assert.deepEqual(await call(owner,path+"/runs","POST",body),started);
    await status(owner,409,path+"/runs","POST",{...body,instruction:"不同任务"});
    const run=await settled(owner,path,started.id);
    assert.ok(run.modelRequests>0 && run.modelRequests<=10);assert.ok(run.result.questions.length);
    assert.ok(run.events.some((e:any)=>e.type==="tool_completed" && e.payload.name==="read_proposal"));
    const factIndex=run.result.facts.findIndex((f:any)=>f.citations.every((c:any)=>c.versionId===customerVersion));assert.ok(factIndex>=0,"必须有来自客户资料的可确认事实");
    const sections=scene==="结构胶粘接"?[2]:[];
    if(sections.length)assert.ok(run.result.chapters.some((c:any)=>c.sectionIndex===2));else assert.equal(run.result.chapters.length,0);
    const apply={expectedEdition:1,expectedRevision:1,factIndexes:[factIndex],sectionIndexes:sections};
    await pool.execute("UPDATE sp_document_versions SET status='withdrawn' WHERE id=?",[customerVersion]);
    const hidden=(await call(owner,path)).runs.find((r:any)=>r.id===run.id);assert.equal(hidden.result,null);assert.equal(hidden.unavailable,true);
    await status(owner,422,`${path}/runs/${run.id}/apply`,"POST",apply);
    await pool.execute("UPDATE sp_document_versions SET status='published' WHERE id=?",[customerVersion]);
    const adopted=await call(owner,`${path}/runs/${run.id}/apply`,"POST",apply);assert.equal(adopted.revision,2);
    assert.deepEqual(await call(owner,`${path}/runs/${run.id}/apply`,"POST",apply),adopted);
    await status(owner,409,`${path}/runs/${run.id}/apply`,"POST",{...apply,factIndexes:[],sectionIndexes:[1]});
    const saved=await call(owner,`/proposals/${p}`);assert.equal(saved.revision,2);assert.ok(saved.body.confirmedRequirements.length);assert.ok(saved.body.requirements.includes(run.result.facts[factIndex].text));
    if(sections.length)assert.equal(saved.body.sections[2].content,run.result.chapters.find((c:any)=>c.sectionIndex===2).content);
    await status(owner,409,path+"/runs","POST",{...body,requestKey:randomUUID()});
    await pool.execute("UPDATE sp_proposals SET status='APPROVED' WHERE id=?",[p]);
    await status(owner,409,path+"/runs","POST",{...body,requestKey:randomUUID(),expectedRevision:2});
    cases.push({scene,model:config.model,modelRequests:run.modelRequests,toolCalls:run.events.filter((e:any)=>e.type==="tool_completed").map((e:any)=>e.payload.name),result:run.result,usage:run.usage});
    checks.push(`${scene}：真实Pi+模型工具循环、引用校验、候选采用与版本历史、幂等、跨账号隔离、撤回后隐藏/拒绝采用、旧修订冲突及批准版只读`);
  }
  await writeFile("data/qa/workspace/result.json",JSON.stringify({createdAt:new Date().toISOString(),base,synthetic:true,realModel:true,professionalValidation:false,checks,cases},null,2));
  console.log(JSON.stringify({passed:true,checks,cases:cases.map(c=>({scene:c.scene,modelRequests:c.modelRequests,tools:c.toolCalls}))},null,2));
}finally{
  for(const p of proposals){
    await pool.execute("DELETE e FROM sp_workspace_events e JOIN sp_workspace_runs r ON r.id=e.run_id WHERE r.proposal_id=?",[p]);
    await pool.execute("DELETE FROM sp_workspace_runs WHERE proposal_id=?",[p]);
    await pool.execute("DELETE FROM sp_proposal_versions WHERE proposal_id=?",[p]);
    await pool.execute("DELETE FROM sp_audit_logs WHERE proposal_id=?",[p]);
  }
  for(const id of documents){await pool.execute("DELETE FROM sp_document_versions WHERE document_id=?",[id]);await pool.execute("DELETE FROM sp_documents WHERE id=?",[id]);}
  for(const p of proposals)await pool.execute("DELETE FROM sp_proposals WHERE id=?",[p]);
  for(const id of customers)await pool.execute("DELETE FROM sp_customers WHERE id=?",[id]);
  for(const id of ids){await pool.execute("DELETE FROM sp_sessions WHERE user_id=?",[id]);await pool.execute("DELETE FROM sp_audit_logs WHERE actor_id=?",[id]);await pool.execute("DELETE FROM sp_users WHERE id=?",[id]);}
  await pool.end();
}
