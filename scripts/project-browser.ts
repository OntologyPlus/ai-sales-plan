import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
export async function verifyProjectBrowser(base:string,proposalId:string,clients:any,checks:string[]){
  const tabs=await(await fetch("http://127.0.0.1:9333/json")).json(),tab=tabs.find((t:any)=>t.type==="page");assert.ok(tab,"需要独立Chrome9333");
  const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(new Error("CDP连接失败")),{once:true});});
  let seq=0,accept=false,dialogs=0;const pending=new Map<number,any>();
  ws.addEventListener("message",e=>{const m=JSON.parse(String(e.data));if(m.method==="Page.javascriptDialogOpening"){dialogs++;void send("Page.handleJavaScriptDialog",{accept});return;}if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
  function send(method:string,params:any={}):Promise<any>{return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
  async function evalJs(expression:string){const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||"页面执行失败");return r.result.value;}
  async function until(expression:string){for(let n=0;n<140;n++){if(await evalJs(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,100));}throw new Error("页面等待超时："+expression);}
  async function click(text:string){assert.ok(await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),"缺少按钮："+text);}
  async function input(label:string,value:string){await evalJs(`(()=>{const l=[...document.querySelectorAll('.project-editor label')].find(x=>x.firstChild.textContent===${JSON.stringify(label)});const t=l.querySelector('input,textarea');Object.getOwnPropertyDescriptor(t instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(t,${JSON.stringify(value)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`);}
  async function open(c:any){await send("Network.setCookie",{url:base,name:"sp_session",value:c.cookie.slice("sp_session=".length)});await send("Page.navigate",{url:base});await until("[...document.querySelectorAll('tr')].some(x=>x.innerText.includes('三批完整专业与商务闭环验收'))");await evalJs("[...document.querySelectorAll('tr')].find(x=>x.innerText.includes('三批完整专业与商务闭环验收')).querySelector('button').click()");await until("document.querySelector('.project-tabs')");}
  try{
    await mkdir("data/qa/project",{recursive:true});await send("Page.enable");await send("Runtime.enable");await send("Network.enable");await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await open(clients.engineer);await click("应用与路线");await until("document.body.innerText.includes('路线A')");assert.ok(await evalJs("document.body.innerText.includes('暂停推荐')"));
    await click("＋ 应用事实");await input("名称","浏览器新增现场事实");await input("事实原话与规范表达","浏览器合成事实，待客户核实");await input("来源及核对说明","合成软件验收人工输入来源");await click("保存候选");await until("document.body.innerText.includes('专业对象已保存为候选')");
    await click("样品与试验");await until("document.body.innerText.includes('原始结果12')");await click("＋ 原始结果");
    await evalJs("(()=>{const s=document.querySelector('.project-editor select');s.value=[...s.options].find(o=>o.textContent==='B验证计划').value;s.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await until("[...document.querySelectorAll('.project-array input')].some(x=>x.value==='合成单位')");await input("名称","浏览器原始结果");await input("原始记录、异常与缺测说明","合成原始读数和缺测说明，非真实实验");
    await evalJs("(()=>{const inputs=document.querySelectorAll('.project-array input');const t=inputs[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(t,'12');t.dispatchEvent(new Event('input',{bubbles:true}))})()");await click("保存候选");await until("document.body.innerText.includes('专业对象已保存为候选')");
    await click("价值与商务");await until("document.body.innerText.includes('PRIVATE-PROFIT-NOTES-DO-NOT-EXPORT')");
    const shot=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile("data/qa/project/desktop.png",Buffer.from(shot.data,"base64"));
    await click("＋ 客户价值");await input("名称","未保存的合成测算");await click("AI推进");await until("document.querySelector('.project-editor')");assert.ok(dialogs>0);accept=true;await click("AI推进");await until("document.querySelector('.workspace-composer')");
    await click("应用与路线");await until("document.body.innerText.includes('浏览器新增现场事实')");await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});assert.ok(await evalJs("document.documentElement.scrollWidth<=innerWidth+1"),"移动端横向溢出");const mobile=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile("data/qa/project/mobile.png",Buffer.from(mobile.data,"base64"));
    await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await open(clients.chemist);await click("价值与商务");await until("document.body.innerText.includes('客户价值情景')");assert.equal(await evalJs("document.body.innerText.includes('PRIVATE-PROFIT-NOTES-DO-NOT-EXPORT')"),false);
    checks.push("真实Chrome：四工作区、事实保存、原始结果与单位预填、成本隔离、未保存保护、390像素布局");
    await writeFile("data/qa/project/browser.json",JSON.stringify({createdAt:new Date().toISOString(),synthetic:true,realBrowser:true,checks:checks.slice(-1)},null,2));
  }finally{await send("Network.deleteCookies",{url:base,name:"sp_session"});await send("Page.navigate",{url:base});ws.close();}
}
