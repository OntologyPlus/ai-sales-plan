import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {projectDataSchema,projectProjection,projectConflicts,evidenceCoverage,activeProjectRecords,valueCalculation,commercialCalculation,analyzeTest,searchProjectEvidence,type ProjectRecord} from "../shared/project.js";
import {mayDecide} from "../shared/workflow.js";
import {renderApproval} from "../server/rendering/render.js";
import mammoth from "mammoth";

const value=()=>projectDataSchema.parse({kind:"value",label:"合成测算",basis:"同等合格处理量1000单位",period:"同一期",currency:"CNY",equivalence:"assumed",assumptions:"尚待证明效果等效",outputQuantity:"1000",baseline:[{label:"基线",amount:"2500",source:"合成样板"}],candidate:[{label:"候选",amount:"2420",source:"合成样板"}],citations:[]}) as any;
test("客户价值精确复算、敏感性、未知及零分母",()=>{
  const d=value(),r=valueCalculation(d);assert.equal(r.difference,"80.00");assert.equal(r.savingPercent,"3.2000");assert.equal(r.baselineUnit,"2.500000");assert.match(r.claim,/未证明/);assert.equal(r.sensitivity.length,3);
  d.baseline[0].amount=null;assert.equal(valueCalculation(d).difference,null);
  d.baseline[0].amount="0";d.outputQuantity="0";const zero=valueCalculation(d);assert.equal(zero.savingPercent,null);assert.equal(zero.baselineUnit,null);
});
test("商务十进制保真、费用独立扣减及技术成果不伪造收入",()=>{
  const d=projectDataSchema.parse({kind:"commercial",label:"底稿",mode:"quote",currency:"CNY",quantity:"1000",netUnitPrice:"24",unitCost:"18",discount:"100",specialExpense:"500",validUntil:"2099-01-01",publicTerms:"公开条款",internalNotes:"内部秘密",sourceNote:"合成成本，不含税统一口径",supplyCommitment:false,legalException:false}) as any;
  const r=commercialCalculation(d);assert.equal(r.netRevenue,"23900.00");assert.equal(r.grossProfit,"5900.00");assert.equal(r.contribution,"5400.00");
  d.quantity="999999999999";d.netUnitPrice="999999999999";d.unitCost="0";d.discount="0";d.specialExpense="0";assert.equal(commercialCalculation(d).netRevenue,"999999999998000000000001.00");
  d.mode="technical";assert.equal(commercialCalculation(d).netRevenue,null);
});
const plan=()=>projectDataSchema.parse({kind:"test_plan",label:"合成计划",recommendationId:randomUUID(),objective:"比较合成指标",sampleBatch:"S1",method:"M1",conditions:"C1",control:"基线对照",repeats:3,criteria:[{key:"m",label:"合成指数",unit:"合成单位",operator:"gte",target:"10"}],citations:[]}) as any;
test("试验缺测、异常重复、异方法及失败均不产生通过结论",()=>{
  const p=plan(),r:any={kind:"test_run",planId:randomUUID(),label:"原始值",sampleBatch:"S1",method:"M1",conditions:"C1",rawNotes:"原始记录",measurements:[{key:"m",value:"12",unit:"合成单位",note:""}],citations:[]};
  assert.equal(analyzeTest(p,r).outcome,"pass");r.measurements[0].value="9";assert.equal(analyzeTest(p,r).outcome,"fail");r.measurements[0].value=null;assert.equal(analyzeTest(p,r).outcome,"unknown");r.measurements[0].value="12";r.method="M2";assert.equal(analyzeTest(p,r).outcome,"unknown");r.method="M1";r.measurements.push({...r.measurements[0]});assert.equal(analyzeTest(p,r).outcome,"unknown");
});
test("上游修订使依赖失效；已确认失败不可因改推荐文字消失",()=>{
  const recId=randomUUID(),planId=randomUUID(),runId=randomUUID(),conclusionId=randomUUID(),p=plan();p.recommendationId=recId;
  const row=(id:string,data:any,deps:any[]=[],status:any="confirmed"):ProjectRecord=>({id,kind:data.kind,revision:1,data,dependencies:deps,status,created_by:"e"});
  const records=[row(recId,{kind:"recommendation",label:"路线A",decision:"selected"}),row(planId,p,[{id:recId,revision:1}]),row(runId,{kind:"test_run",label:"失败数据",planId,sampleBatch:"S1",method:"M1",conditions:"C1",measurements:[{key:"m",value:"9",unit:"合成单位"}]},[{id:planId,revision:1}]),row(conclusionId,{kind:"conclusion",label:"不通过",runId,recommendationId:recId},[{id:runId,revision:1},{id:recId,revision:1}])];
  assert.equal(projectProjection(records)[0].blocked,true);records[0].revision=2;const after=projectProjection(records);assert.equal(after[1].stale,true);assert.equal(after[0].blocked,true);
  (records[0].data as any).decision="excluded";assert.equal(activeProjectRecords(records).length,0,"排除的历史路线不强行阻断新路线，但原始失败仍保留");assert.equal(records.length,4);
});
test("长文后段片段能检索并保持UTF16原文位置",()=>{
  const id=randomUUID(),text="前文。".repeat(6000)+"目标反证：该材料在条件Z下不适用。";const results=searchProjectEvidence([{id,title:"长资料",text,kind:"tds"}],"目标反证");assert.ok(results.length);assert.ok(results[0].start>12000);assert.equal(text.slice(results[0].start,results[0].start+results[0].text.length),results[0].text);
});
test("财务前置专业节点及最终授权顺序",()=>{
  const steps=[{role:"chemist",status:"approved"},{role:"compliance",status:"approved"},{role:"quality",status:"pending"},{role:"finance",status:"waiting"},{role:"leader",status:"waiting"}];assert.equal(mayDecide(steps,"finance"),false);steps[2].status="approved";assert.equal(mayDecide(steps,"finance"),true);assert.equal(mayDecide(steps,"leader"),false);steps[3].status="approved";assert.equal(mayDecide(steps,"leader"),true);
});
test("公开Word仅包含公开商务投影，内部成本不从快照附带字段渲染",async()=>{
  const input:any={snapshot:{title:"投影验收",code:"TEST",scene:"合成",edition:1,revision:1,body:{requirements:"合成需求",sections:[]},projectSnapshot:{publicTerms:"公开付款条件",validUntil:"2099-01-01",currency:"CNY",quote:{quantity:"10",netUnitPrice:"20",discount:"0",netRevenue:"200.00"},internalNotes:"绝密内部评语",unitCost:"秘密底价",values:[]}},steps:[],requestId:"test",snapshotHash:"hash"};const out=await renderApproval(input);const text=(await mammoth.extractRawText({buffer:out.docx})).value;assert.match(text,/公开付款条件/);assert.match(text,/200.00/);assert.ok(!text.includes("绝密内部评语"));assert.ok(!text.includes("秘密底价"));
});

 test("同属性同工况数值冲突可识别，否决事实不再参与；异工况不误判",()=>{
 const row=(value:string,conditions="C"):ProjectRecord=>({id:randomUUID(),revision:1,kind:"fact",status:"confirmed",created_by:"e",dependencies:[],data:projectDataSchema.parse({kind:"fact",label:"指标",attributeKey:"m",statement:"原始记录",value,unit:"u",conditions,origin:"observation",sourceNote:"现场记录"})});
 const a=row("1"),b=row("2");assert.equal(projectConflicts([a,b]).length,1);assert.equal(projectConflicts([a,row("2","other")]).length,0);b.status="rejected";assert.equal(projectConflicts([a,b]).length,0);
 });
 test("读取范围合并去重并明确未读区间，不能把可读字符当作已读",()=>{
 const c=evidenceCoverage(100,[{start:10,length:20},{start:20,length:20},{start:90,length:20}]);assert.equal(c.readChars,40);assert.deepEqual(c.unreadRanges,[{start:0,end:10},{start:40,end:90}]);assert.equal(evidenceCoverage(100,[]).readChars,0);
 });
