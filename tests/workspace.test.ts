import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, createAssistantMessageEventStream, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import { parseWorkspaceResult, workspaceStartSchema, workspaceApplySchema, workspaceCanonical, type WorkspaceInput } from "../shared/workspace.js";
import { runWorkspaceAgent, workspaceModels } from "../server/workspace-runtime.js";
import { modelConfig } from "../server/model.js";

function input(scene="合成胶粘剂评估"):WorkspaceInput {
  return {proposalId:randomUUID(),edition:1,revision:1,title:"通用场景",scene,requirements:"",sections:Array.from({length:6},(_,i)=>({title:`章节${i}`,content:""})),instruction:"根据原文诊断缺项",model:"offline",provider:"offline",
    sources:[{id:randomUUID(),title:"合成客户需求",kind:"customer",sha256:"a".repeat(64),text:"合成板件材质待确认。",totalChars:11}]};
}
function result(i:WorkspaceInput) {
  return {summary:"需核实客户材料",facts:[{label:"待核实材料",text:"客户材料信息待核实",citations:[{versionId:i.sources[0].id,quote:i.sources[0].text,start:0}]}],questions:[{question:"实际材料是什么？",reason:"决定兼容性验证范围",priority:"blocking"}],comparison:"暂无产品依据",validationPlan:[],chapters:[],nextActions:["核实客户材料"]};
}
test("同一结果协议覆盖清洗与胶粘场景，不预设专业字段",()=>{
  for(const scene of ["PCBA清洗","结构胶粘接","洁净流体输送"]){const i=input(scene);assert.equal(parseWorkspaceResult(JSON.stringify(result(i)),i,new Set([i.sources[0].id])).facts.length,1);}
});
test("MySQL JSON键序变化不造成依据指纹误报",()=>{
  assert.equal(workspaceCanonical({selected:[{name:"A",id:"1"}],note:"ok"}),workspaceCanonical({note:"ok",selected:[{id:"1",name:"A"}]}));
  assert.notEqual(workspaceCanonical({selected:[{id:"1"}]}),workspaceCanonical({selected:[{id:"2"}]}));
});
test("拒绝伪引文、未读原文、跨方案来源及客户资料证明性能",()=>{
  const i=input(),good=result(i),read=new Set([i.sources[0].id]);
  assert.throws(()=>parseWorkspaceResult(JSON.stringify(good),i,new Set()),/尚未读取/);
  const wrong=structuredClone(good);wrong.facts[0].citations[0].start=2;
  assert.throws(()=>parseWorkspaceResult(JSON.stringify(wrong),i,read),/不一致/);
  wrong.facts[0].citations[0].versionId=randomUUID();
  assert.throws(()=>parseWorkspaceResult(JSON.stringify(wrong),i,read),/授权范围/);
  const chapter={...good,chapters:[{sectionIndex:2,content:"性能已达标",citations:good.facts[0].citations}]};
  assert.throws(()=>parseWorkspaceResult(JSON.stringify(chapter),i,read),/技术或合规/);
});
test("采用选择和运行授权拒绝空选择、伪造身份及重复索引",()=>{
  const base={expectedEdition:1,expectedRevision:1,factIndexes:[],sectionIndexes:[]};
  assert.equal(workspaceApplySchema.safeParse(base).success,false);
  assert.equal(workspaceApplySchema.safeParse({...base,factIndexes:[0,0]}).success,false);
  assert.equal(workspaceStartSchema.safeParse({requestKey:randomUUID(),expectedEdition:1,expectedRevision:1,instruction:"诊断",versionIds:[],consent:true,actorId:randomUUID()}).success,false);
});
test("实际HTTP发送前的权限/预算拒绝不能被Pi钩子忽略",async()=>{
  const originalFetch=globalThis.fetch,originalKey=modelConfig.key;
  let network=0,guards=0;
  modelConfig.key="offline-protocol-test";
  globalThis.fetch=async()=>{network++;throw new Error("不允许真实外发");};
  try{
    const p=workspaceModels(new AbortController().signal,undefined,async()=>{guards++;throw new Error("BUDGET_OR_REVOKED");});
    const answer=await p.models.complete(p.models.getModel(p.provider,p.modelId)!,{messages:[{role:"user",content:"测试拒绝外发",timestamp:Date.now()}]});
    assert.equal(answer.stopReason,"error");assert.equal(guards,1);assert.equal(network,0);
  }finally{globalThis.fetch=originalFetch;modelConfig.key=originalKey;}
});
test("通用Pi真实工具调度、稳定请求恢复及授权撤回（离线模型协议）",{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"workspace-pi-")),i=input();
  const model:Model<"workspace-test">={id:"offline",name:"Offline protocol test",api:"workspace-test",provider:"offline",baseUrl:"",reasoning:false,input:["text"],contextWindow:32000,maxTokens:4000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let requests=0,allowed=true,firstInvalid=true;
  const events:{type:string;payload:any}[]=[];
  const stream=(_m:any,transcript:any)=>{
    requests++;
    const step=transcript.messages.filter((m:any)=>m.role==="toolResult").length;
    const names=["read_proposal","read_evidence","inspect_products"];
    const candidate=result(i);
    if(step===3 && firstInvalid){candidate.facts[0].citations=[];firstInvalid=false;}
    const message:AssistantMessage={role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:step<3?"toolUse":"stop",
      content:step<3?[{type:"toolCall",id:`step-${step}`,name:names[step],arguments:step===1?{versionId:i.sources[0].id}:{}}]:[{type:"text",text:JSON.stringify(candidate)}],
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const e=createAssistantMessageEventStream();e.push({type:"start",partial:message});e.push({type:"done",reason:step<3?"toolUse":"stop",message});return e;
  };
  const models=createModels();models.setProvider(createProvider({id:model.provider,models:[model],auth:{apiKey:{name:"Offline",resolve:async()=>({auth:{}})}},api:{stream,streamSimple:stream}}));
  const deps={path:join(dir,"session.sqlite"),signal:new AbortController().signal,assertCurrent:async()=>{if(!allowed)throw new Error("REVOKED");},beforeRequest:async()=>{if(requests>=6)throw new Error("BUDGET");},event:async(type:string,payload:any)=>{events.push({type,payload});},inspectProducts:async()=>({selected:[]}),readVersions:async()=>new Set<string>(events.filter(e=>e.type==="evidence_read").map(e=>e.payload.versionId)),provider:{models,modelId:model.id,provider:model.provider}};
  try{
    const first=await runWorkspaceAgent(i,deps);assert.equal(first.result.facts.length,1);assert.equal(requests,5);
    assert.equal(events.filter(e=>e.type==="validation_rejected").length,1,"无依据事实须反馈模型纠正，不能直接入库");
    assert.deepEqual(events.filter(e=>e.type==="tool_completed").map(e=>e.payload.name),["read_proposal","read_evidence","inspect_products"]);
    assert.deepEqual(await runWorkspaceAgent(i,deps),first);assert.equal(requests,5,"完成会话不能重复请求模型");
    const changed={...i,revision:2};await assert.rejects(runWorkspaceAgent(changed,deps),/指纹/);
    allowed=false;await assert.rejects(runWorkspaceAgent(i,deps),/REVOKED/);
    allowed=true;requests=0;firstInvalid=false;events.length=0;
    const controller=new AbortController();let pausing=false,notify!:()=>void,inspections=0;
    const entered=new Promise<void>(resolve=>{notify=resolve;});
    const pausedDeps={...deps,path:join(dir,"pause.sqlite"),signal:controller.signal,shouldPause:()=>pausing,
      inspectProducts:async()=>{inspections++;notify();await new Promise<void>((_resolve,reject)=>controller.signal.addEventListener("abort",()=>reject(new Error("HOST_PAUSE")),{once:true}));return {};}};
    const interrupted=runWorkspaceAgent(i,pausedDeps);
    await entered;pausing=true;controller.abort();await assert.rejects(interrupted);
    const resumed=await runWorkspaceAgent(i,{...deps,path:pausedDeps.path,signal:new AbortController().signal,inspectProducts:async()=>{inspections++;return {selected:[]};}});
    assert.equal(resumed.result.facts.length,1);assert.equal(inspections,2,"未完成只读工具应恢复执行");
    assert.equal(events.filter(e=>e.type==="tool_completed" && e.payload.name==="read_proposal").length,1,"平滑关闭后恢复不得重做已提交前序工具");
  }finally{await rm(dir,{recursive:true,force:true});}
});
