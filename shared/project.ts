import { z } from "zod";
import { workspaceCitation } from "./workspace.js";

export const decimal = z.string().regex(/^-?\d{1,12}(?:\.\d{1,6})?$/, "请使用最多6位小数的十进制字符串");
export const nonnegative = decimal.refine(v=>!v.startsWith("-"),"不能为负数");
const text=z.string().trim().min(1).max(4000), short=z.string().trim().min(1).max(200);
const citations=z.array(workspaceCitation).max(12).default([]);
const criterion=z.object({key:short,label:short,unit:short,operator:z.enum(["gte","lte","eq"]),target:decimal}).strict();
export const projectDataSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("fact"),label:short,attributeKey:z.string().max(100).default(""),statement:text,value:decimal.nullable().default(null),unit:z.string().max(80).default(""),conditions:z.string().max(1000).default(""),origin:z.enum(["customer","observation","expert"]),sourceNote:text,citations}).strict(),
  z.object({kind:z.literal("hypothesis"),label:short,statement:text,support:text,counterEvidence:text,citations}).strict(),
  z.object({kind:z.literal("question"),label:short,question:text,reason:text,blocking:z.boolean(),answer:z.string().max(4000).default(""),resolved:z.boolean().default(false),sourceNote:z.string().max(1000).default(""),citations}).strict(),
  z.object({kind:z.literal("recommendation"),label:short,productId:z.string().uuid().nullable().default(null),rationale:text,exclusions:text,counterEvidence:text,reconsiderWhen:z.string().max(2000).default(""),caseComparisons:z.array(z.object({sourceVersionId:z.string().uuid(),outcome:z.enum(["success","failure","unknown"]),sourceConditions:text,targetConditions:text,differences:text}).strict()).max(10).default([]),decision:z.enum(["candidate","selected","excluded"]),validationRequired:z.boolean(),citations}).strict(),
  z.object({kind:z.literal("test_plan"),label:short,recommendationId:z.string().uuid(),objective:text,sampleBatch:short,method:short,conditions:text,control:text,repeats:z.number().int().min(1).max(1000),criteria:z.array(criterion).min(1).max(20),citations}).strict().refine(p=>new Set(p.criteria.map(c=>c.key)).size===p.criteria.length,"指标键不能重复"),
  z.object({kind:z.literal("test_run"),label:short,planId:z.string().uuid(),sampleBatch:short,method:short,conditions:text,rawNotes:text,measurements:z.array(z.object({key:short,value:decimal.nullable(),unit:z.string().max(80).default(""),note:z.string().max(1000).default("")}).strict()).min(1).max(20),citations}).strict(),
  z.object({kind:z.literal("conclusion"),label:short,runId:z.string().uuid(),recommendationId:z.string().uuid(),scope:text,interpretation:text,citations}).strict(),
  z.object({kind:z.literal("task"),label:short,description:text,assigneeId:z.string().uuid().nullable().default(null),dueOn:z.string().date().nullable().default(null),done:z.boolean().default(false),completionNote:z.string().max(2000).default(""),citations}).strict(),
  z.object({kind:z.literal("opportunity"),label:short,problem:text,source:short,priority:z.enum(["high","normal","low"]),targetDate:z.string().date().nullable().default(null),stage:z.enum(["reported","accepted","paused","closed"]),reason:text,citations}).strict(),
  z.object({kind:z.literal("value"),label:short,basis:text,period:short,currency:z.enum(["CNY","USD","EUR"]),equivalence:z.enum(["unknown","assumed","confirmed"]),assumptions:text,outputQuantity:nonnegative.nullable(),baseline:z.array(z.object({label:short,amount:nonnegative.nullable(),source:text}).strict()).min(1).max(20),candidate:z.array(z.object({label:short,amount:nonnegative.nullable(),source:text}).strict()).min(1).max(20),citations}).strict(),
  z.object({kind:z.literal("commercial"),label:short,mode:z.enum(["technical","quote"]),currency:z.enum(["CNY","USD","EUR"]),quantity:nonnegative.nullable(),netUnitPrice:nonnegative.nullable(),unitCost:nonnegative.nullable(),discount:nonnegative.nullable(),specialExpense:nonnegative.nullable(),validUntil:z.string().date(),publicTerms:text,internalNotes:text,sourceNote:text,supplyCommitment:z.boolean().nullable(),legalException:z.boolean().nullable(),citations}).strict(),
]);
export type ProjectData=z.infer<typeof projectDataSchema>;
export const projectKinds=["fact","hypothesis","question","recommendation","test_plan","test_run","conclusion","value","commercial","opportunity","task"] as const;
export type ProjectKind=typeof projectKinds[number];
export const projectLabels:Record<ProjectKind,string>={fact:"应用事实",hypothesis:"诊断假设",question:"待确认问题",recommendation:"推荐路线",test_plan:"验证计划",test_run:"原始结果",conclusion:"技术结论",value:"客户价值",commercial:"内部商务底稿",opportunity:"商机受理",task:"协作待办"};
export type Dependency={id:string;revision:number};
export type ProjectRecord={id:string;revision:number;kind:ProjectKind;data:ProjectData;dependencies:Dependency[];status:"candidate"|"confirmed"|"rejected";created_by:string;confirmed_by?:string|null;created_at?:string;updated_at?:string};
export const projectWriteSchema=z.object({requestId:z.string().uuid(),expectedEdition:z.number().int().positive(),expectedProjectRevision:z.number().int().nonnegative(),id:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),dependencies:z.array(z.object({id:z.string().uuid(),revision:z.number().int().positive()}).strict()).max(30),data:projectDataSchema}).strict();

const SCALE=1_000_000n;
export function fixed(v:string):bigint {decimal.parse(v);const negative=v.startsWith("-");const [whole,fraction=""]=(negative?v.slice(1):v).split(".");const n=BigInt(whole)*SCALE+BigInt(fraction.padEnd(6,"0"));return negative?-n:n;}
export function projectConflicts(records:ProjectRecord[]) {
  const facts=records.filter(r=>r.data.kind==="fact"&&r.status==="confirmed"&&r.data.attributeKey&&r.data.value!==null);
  const conflicts:{left:string;right:string;attributeKey:string;reason:string}[]=[];
  for(let i=0;i<facts.length;i++)for(let j=i+1;j<facts.length;j++){const a=facts[i].data as Extract<ProjectData,{kind:"fact"}>,b=facts[j].data as Extract<ProjectData,{kind:"fact"}>;if(a.attributeKey===b.attributeKey&&a.unit.trim()&&a.conditions.trim()&&a.unit===b.unit&&a.conditions===b.conditions&&fixed(a.value!)!==fixed(b.value!))conflicts.push({left:facts[i].id,right:facts[j].id,attributeKey:a.attributeKey,reason:"同一属性、单位与工况存在不同已确认数值；须核对原始依据并否决或修订其中一项"});}
  return conflicts;
}
export function evidenceCoverage(total:number,ranges:{start:number;length:number}[]) {
  const merged:{start:number;end:number}[]=[];
  for(const r of ranges.map(r=>({start:Math.max(0,r.start),end:Math.min(total,r.start+r.length)})).filter(r=>Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.end>r.start).sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&r.start<=last.end)last.end=Math.max(last.end,r.end);else merged.push({...r});}
  const unread=[];let cursor=0;for(const r of merged){if(r.start>cursor)unread.push({start:cursor,end:r.start});cursor=r.end;}if(cursor<total)unread.push({start:cursor,end:total});
  return {totalChars:total,readChars:merged.reduce((n,r)=>n+r.end-r.start,0),readRanges:merged,unreadRanges:unread};
}
export function decimalText(v:bigint,places=6):string {const negative=v<0n;let n=negative?-v:v;const divisor=10n**BigInt(6-places);n=(n+divisor/2n)/divisor;const base=10n**BigInt(places);return (negative?"-":"")+(n/base).toString()+(places?"."+(n%base).toString().padStart(places,"0"):"");}
export function multiply(a:string,b:string):bigint{return fixed(a)*fixed(b)/SCALE;}
export function valueCalculation(d:Extract<ProjectData,{kind:"value"}>) {
  const sum=(rows:typeof d.baseline)=>rows.some(r=>r.amount===null)?null:rows.reduce((n,r)=>n+fixed(r.amount!),0n);
  const baseline=sum(d.baseline),candidate=sum(d.candidate),quantity=d.outputQuantity===null?null:fixed(d.outputQuantity);
  const difference=baseline===null||candidate===null?null:baseline-candidate;
  return {formulaVersion:"application-cost-v1",currency:d.currency,baseline:baseline===null?null:decimalText(baseline,2),candidate:candidate===null?null:decimalText(candidate,2),difference:difference===null?null:decimalText(difference,2),baselineUnit:baseline===null||!quantity?null:decimalText(baseline*SCALE/quantity,6),candidateUnit:candidate===null||!quantity?null:decimalText(candidate*SCALE/quantity,6),savingPercent:difference===null||!baseline?null:decimalText(difference*100n*SCALE/baseline,4),claim:d.equivalence==="confirmed"?"在已确认等效口径下的测算，仍非已发生节省":"有条件情景比较，未证明效果等效，不得声称已节省",sensitivity:candidate===null||baseline===null?[]:[-10n,0n,10n].map(percent=>({candidateCostChange:percent.toString()+"%",difference:decimalText(baseline-candidate*(100n+percent)/100n,2)}))};
}
export function commercialCalculation(d:Extract<ProjectData,{kind:"commercial"}>) {
  if(d.mode==="technical")return {formulaVersion:"commercial-v1",currency:d.currency,netRevenue:null,cost:null,grossProfit:null,contribution:null,grossMargin:null,expense:d.specialExpense===null?null:decimalText(fixed(d.specialExpense),2)};
  if([d.quantity,d.netUnitPrice,d.unitCost,d.discount,d.specialExpense].some(v=>v===null))return {formulaVersion:"commercial-v1",currency:d.currency,netRevenue:null,cost:null,grossProfit:null,contribution:null,grossMargin:null,expense:null};
  const revenue=multiply(d.quantity!,d.netUnitPrice!)-fixed(d.discount!),cost=multiply(d.quantity!,d.unitCost!),gross=revenue-cost,contribution=gross-fixed(d.specialExpense!);
  return {formulaVersion:"commercial-v1",currency:d.currency,netRevenue:decimalText(revenue,2),cost:decimalText(cost,2),grossProfit:decimalText(gross,2),contribution:decimalText(contribution,2),grossMargin:revenue>0n?decimalText(gross*100n*SCALE/revenue,4):null,expense:decimalText(fixed(d.specialExpense!),2)};
}
export function analyzeTest(plan:Extract<ProjectData,{kind:"test_plan"}>,run:Extract<ProjectData,{kind:"test_run"}>) {
  const comparable=plan.method===run.method && plan.conditions===run.conditions && plan.sampleBatch===run.sampleBatch;
  const results=plan.criteria.map(c=>{const found=run.measurements.filter(m=>m.key===c.key);const m=found[0];const known=comparable&&found.length===1&&m.value!==null&&m.unit===c.unit;const pass=known?(c.operator==="gte"?fixed(m.value!)>=fixed(c.target):c.operator==="lte"?fixed(m.value!)<=fixed(c.target):fixed(m.value!)===fixed(c.target)):false;return {...c,actual:m?.value??null,status:!known?"unknown":pass?"pass":"fail",reason:!comparable?"样品、方法或工况不同，不能直接比较":!known?"缺测、重复数据或单位不同，保持未知":"按固定判据比较，非因果或统计显著性结论"};});
  return {comparable,results,outcome:results.some(r=>r.status==="fail")?"fail":results.every(r=>r.status==="pass")?"pass":"unknown"};
}
export function projectProjection(records:ProjectRecord[]) {
  const byId=new Map(records.map(r=>[r.id,r]));
  const stale=(r:ProjectRecord,visited=new Set<string>()):boolean=>{
    if(visited.has(r.id))return true;const next=new Set(visited).add(r.id);
    return r.dependencies.some(dep=>{const p=byId.get(dep.id);return !p||p.revision!==dep.revision||p.status==="rejected"||stale(p,next);});
  };
  const negative=new Set(records.filter(r=>r.kind==="conclusion"&&r.status==="confirmed").filter(r=>{
    const d=r.data as Extract<ProjectData,{kind:"conclusion"}>,run=byId.get(d.runId),plan=run?.data.kind==="test_run"?byId.get(run.data.planId):null;
    return run?.data.kind==="test_run"&&plan?.data.kind==="test_plan"&&analyzeTest(plan.data,run.data).outcome!=="pass";
  }).map(r=>(r.data as Extract<ProjectData,{kind:"conclusion"}>).recommendationId));
  return records.map(r=>({...r,stale:stale(r),blocked:r.kind==="recommendation"&&negative.has(r.id),calculation:r.data.kind==="value"?valueCalculation(r.data):r.data.kind==="commercial"?commercialCalculation(r.data):r.data.kind==="test_run"&&byId.get(r.data.planId)?.data.kind==="test_plan"?analyzeTest(byId.get(r.data.planId)!.data as Extract<ProjectData,{kind:"test_plan"}>,r.data):null}));
}

export function evidenceChunks(text:string,size=2500) {const chunks=[];for(let start=0;start<text.length;start+=size-200)chunks.push({start,text:text.slice(start,start+size)});return chunks;}
export function activeProjectRecords(records:ProjectRecord[]) {
  const selected=new Set(records.filter(r=>r.data.kind==="recommendation"&&r.data.decision==="selected"&&r.status!=="rejected").map(r=>r.id));
  const active=new Set(records.filter(r=>selected.has(r.id)||r.kind==="fact"&&r.status==="confirmed"||r.kind==="value"||r.data.kind==="question"&&r.data.blocking||r.data.kind==="conclusion"&&selected.has(r.data.recommendationId)&&r.status==="confirmed").map(r=>r.id));
  const visit=(id:string)=>{const r=records.find(r=>r.id===id);for(const d of r?.dependencies||[]){if(!active.has(d.id)){active.add(d.id);visit(d.id);}}};for(const id of [...active])visit(id);
  return records.filter(r=>active.has(r.id)&&r.status!=="rejected");
}
export function searchProjectEvidence(sources:{id:string;title:string;text:string;kind:string}[],query:string,limit=12) {
  const terms=query.toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  return sources.flatMap(s=>evidenceChunks(s.text).map(c=>({versionId:s.id,title:s.title,kind:s.kind,...c,score:terms.reduce((n,t)=>n+(c.text.toLowerCase().includes(t)?1:0),0)})))
    .filter(c=>!terms.length||c.score>0).sort((a,b)=>b.score-a.score||a.start-b.start).slice(0,limit);
}
