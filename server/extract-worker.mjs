import {parentPort,workerData} from 'node:worker_threads';
try{
 const bytes=Buffer.from(workerData.bytes),name=workerData.filename;let text='',notes=[];
 if(/\.docx$/i.test(name)){const m=await import('mammoth');text=(await m.extractRawText({buffer:bytes})).value;notes.push('Word按提取纯文本定位，不提供原文件页码。');}
 else if(/\.pdf$/i.test(name)){const {PDFParse}=await import('pdf-parse');const p=new PDFParse({data:bytes});try{const r=await p.getText({first:50,pageJoiner:''});text=r.pages.map(x=>`[[第${x.num}页]]\n${x.text}`).join('\n');if(r.total>50)notes.push(`共${r.total}页，仅读取前50页；其余未读取。`);}finally{await p.destroy();}}
 else {if(bytes.includes(0))throw Error();text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);notes.push('按UTF-8文本及字符位置定位。');}
 if(!text.trim())throw Error();if(text.length>200000)throw Error();parentPort.postMessage({text,notes});
}catch{parentPort.postMessage({error:'无法提取文本：请检查文件是否损坏、加密、扫描件或超过20万字符；扫描件需提供可读版本。'});}
