import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
const base="http://127.0.0.1:3200";
const latest=JSON.parse(await readFile("data/demo/latest.json","utf8"));
const manifest=JSON.parse(await readFile(latest.directory+"/private-manifest.json","utf8"));
let cookie="",csrf="";
async function api(path:string,method="GET",body?:any){const r=await fetch(base+"/api"+path,{method,headers:{origin:base,cookie,"x-csrf-token":csrf,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert.ok(r.ok,`${path}: ${r.status}`);if(path==="/login"){cookie=r.headers.get("set-cookie")!.split(";")[0];csrf=d.csrf;}return d;}
await api("/login","POST",{email:manifest.accounts.engineer.email,password:manifest.accounts.engineer.password});
const sample=JSON.parse(await readFile("data/demo/pcba-sample.json","utf8"));
const docs=await api(`/documents?proposalId=${sample.id}`);
const old=docs.find((d:any)=>d.proposal_id===sample.id && d.kind==="customer");assert.ok(old);
if(!docs.some((d:any)=>d.proposal_id===sample.id && d.kind==="customer" && d.status==="published" && d.allow_model)){
  const text=(await api("/documents/"+old.version_id)).text_content;
  const uploaded=await api("/documents","POST",{documentId:old.id,expectedVersion:old.version,proposalId:sample.id,title:old.title,kind:"customer",filename:"PCBA合成客户需求.txt",base64:Buffer.from(text).toString("base64"),allowModel:true});
  await api(`/documents/${uploaded.versionId}/review`,"POST",{decision:"publish",note:"合成软件演示材料，许可本次工程验收使用模型，不代表真实客户事实或专业审核"});
}
const tabs=await(await fetch("http://127.0.0.1:9333/json")).json();
const tab=tabs.find((t:any)=>t.type==="page");assert.ok(tab);
const ws=new WebSocket(tab.webSocketDebuggerUrl);
await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(new Error("Chrome连接失败")),{once:true});});
let seq=0,acceptDialogs=false,dialogs=0;const pending=new Map<number,any>();
ws.addEventListener("message",e=>{const m=JSON.parse(String(e.data));if(m.method==="Page.javascriptDialogOpening"){dialogs++;void send("Page.handleJavaScriptDialog",{accept:acceptDialogs});return;}if(!m.id)return;const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});
function send(method:string,params:any={}):Promise<any>{return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression:string){const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||"页面执行失败");return r.result.value;}
async function until(expression:string,tries=120){for(let i=0;i<tries;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,250));}throw new Error("页面等待超时: "+expression);}
async function click(text:string){assert.ok(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),"缺少按钮："+text);}
async function open(title:string){await until(`document.body.innerText.includes(${JSON.stringify(title)})`);await evaluate(`(()=>{const row=[...document.querySelectorAll('tr')].find(r=>r.innerText.includes(${JSON.stringify(title)}));row.querySelector('button').click()})()`);await until(`document.querySelector('.workspace-composer textarea')`);}
const checks:string[]=[];
try{
  await mkdir("data/qa/workspace",{recursive:true});
  await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
  await send("Network.setCookie",{url:base,name:"sp_session",value:cookie.slice("sp_session=".length)});
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:base});
  await open("02 现场生成工作副本");
  assert.ok(await evaluate("document.body.innerText.includes('围绕客户目标，推进下一步')"));
  await click("方案编制与送审 →");await until("document.querySelector('#requirements textarea')");
  await click("阅读预览 ↗");await until("document.querySelector('dialog[open]')");await click("关闭 ×");
  await click("AI工作空间 →");await until("document.querySelector('.workspace-composer')");
  checks.push("原有胶粘演示方案默认进入统一工作空间；原正文编制与阅读预览可用");
  await send("Page.navigate",{url:base});await open(sample.title);
  await until("document.querySelector('.workspace-submit .primary')");
  assert.ok(await evaluate("document.querySelector('.workspace-composer').getBoundingClientRect().width>500"),"桌面主工作区必须有足够可读宽度，不能继承旧编制网格");
  if(!process.argv.includes("--layout-only")) {
  const prompt="这是合成软件演示。先读取当前方案，检索并读取本次客户资料，检查候选产品。围绕PCBA清洗提出优先追问和验证计划，并提取少量有原文引用的候选事实。引用可使用完整连续客户原文，start为0。没有技术说明，chapters为空，不给出真实产品或工艺承诺。";
  await evaluate(`(()=>{const t=document.querySelector('.workspace-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(prompt)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until("document.querySelector('.workspace-composer textarea').value.length>0");
  await click("方案编制与送审 →");await until("document.querySelector('.workspace-composer textarea')?.value.length>0");assert.ok(dialogs>0,"未提交信息离开保护");
  await evaluate("document.querySelector('.workspace-consent input').click()");
  await until("!document.querySelector('.workspace-submit .primary').disabled");
  await click("交给 AI 推进 →");
  await until("document.querySelector('.workspace-result') && document.body.innerText.includes('有依据的候选事实')",1200);
  await until("document.querySelector('.workspace-fact input:not(:disabled)')");
  await evaluate("document.querySelector('.workspace-refs button').click()");await until("document.querySelector('dialog[open] mark')");await click("关闭 ×");
  const desktop=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile("data/qa/workspace/desktop.png",Buffer.from(desktop.data,"base64"));
  await evaluate("document.querySelector('.workspace-fact input:not(:disabled)').click()");
  await until("!document.querySelector('.workspace-apply button').disabled");await evaluate("document.querySelector('.workspace-apply button').click()");
  await until("document.body.innerText.includes('已采用到方案新修订')");
  const saved=await api(`/proposals/${sample.id}`);assert.ok(saved.body.confirmedRequirements.length>0);
  checks.push("浏览器真实模型发起任务、工具过程、候选事实、原文高亮及确认采用保存");
  }
  await send("Page.reload");await open(sample.title);await until("document.body.innerText.includes('已采用到 V')");
  await send("Runtime.evaluate",{expression:"scrollTo(0,0)"});
  const layout=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile("data/qa/workspace/desktop.png",Buffer.from(layout.data,"base64"));
  await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),"390像素页面不能横向溢出");
  const mobile=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile("data/qa/workspace/mobile.png",Buffer.from(mobile.data,"base64"));
  checks.push("刷新后历史与采用结果持久化、桌面可读宽度、390像素无横向溢出");
  await writeFile(`data/qa/workspace/${process.argv.includes("--layout-only")?"layout":"browser"}.json`,JSON.stringify({createdAt:new Date().toISOString(),realBrowser:true,realModel:!process.argv.includes("--layout-only"),synthetic:true,checks},null,2));
  console.log(JSON.stringify({passed:true,checks},null,2));
}finally{
  await send("Network.deleteCookies",{url:base,name:"sp_session"});await send("Page.navigate",{url:base});ws.close();await api("/logout","POST");
}
