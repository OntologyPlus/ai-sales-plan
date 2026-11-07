const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const dir = JSON.parse(fs.readFileSync(path.join(root,'data/demo/latest.json'))).directory;
const m = JSON.parse(fs.readFileSync(path.join(dir,'private-manifest.json')));
const accounts = '# 演示专用账号（仅本机保存）\n\n入口：http://127.0.0.1:3200\n\n' + Object.entries(m.accounts).map(([r,a])=>`- ${a.name}（${r}）\n  - 邮箱：${a.email}\n  - 密码：${a.password}`).join('\n\n')+'\n\n请为各角色使用独立浏览器用户配置；同一浏览器的普通标签页共享登录状态。不要修改真实账号。\n';
fs.writeFileSync(path.join(dir,'演示账号.md'),accounts,{mode:0o600});
const guide = `# 11月4日演示操作手册

本批次全部使用合成客户、产品和资料，不构成真实产品或合规建议。

入口：http://127.0.0.1:3200 。账号见同目录“演示账号.md”，文件仅当前用户可读。

## 开场前

1. 在项目目录运行 npm start（当前服务已启动时无需重复启动）。先确认能连接配置的MySQL服务器；数据库在内网，切换演示场地或网络后须重新确认可达。
2. 为工程师、应用化学师、合规专员和领导分别打开独立浏览器用户配置。普通标签页共享登录，不能同时充当不同角色。
3. 工程师进入方案中心，搜索“合成演示”，确认01—05五个案例均在。
4. 打开本目录“批准版演示方案.docx”，确认本机 Word/WPS 的字体、分页和长表格显示正常。自动检查已核对文本、审批记录、文件指纹；尚未替代人工页面目检。
5. 打开“离线演示备用.html”备用；只含真实调用保存的结果及已批准正文，无模型密钥或登录凭据。

## 8分钟演示顺序

| 时间 | 操作 | 讲解要点 |
|---|---|---|
| 0—1分钟 | 工程师打开02，展示需求与产品A匹配 | 需求门槛18 MPa；保证范围20—25 MPa，比较限定同工况和方法 |
| 1—3分钟 | AI章节编制选第3章、演示TDS，确认发送范围后生成候选；完成后阅读、核对引用，再人工采用 | 真实模型上次技术章20秒、安全章14秒，仅供本次实测参考；点击生成一次即可，结果不自动修改正文 |
| 3—4分钟 | 查看章节已绑定原文；打开05查看预检 | 产品B只有典型值，不能替代保证值；关键需求待验证会阻断送审 |
| 4—6分钟 | 打开03。应用化学师和合规专员分别审批；两项通过后领导终审 | 专业并行审核、领导终审；工程师不能审核自己的方案 |
| 6—8分钟 | 工程师重新打开03，生成并下载Word；或打开04下载预留批准成果 | 固定批准快照、三段审批记录、原文引用与文件指纹均保留 |

03是现场审批用案例，04保持已批准，避免现场生成失败时没有成果。
02是现场工作副本，01保存真实AI任务记录与已采用正文。

## 五项P1展示入口

1. 方案顶部点击“阅读预览”，展示封面、目录、匹配表和整篇正文；修订历史也支持同样的阅读窗口。
2. 在阅读窗口或章节引用中点击“定位原文”，展示版本名称、状态和高亮位置；关闭原文窗口后仍停留在方案预览。
3. 02现场工作副本若有同修订的已完成候选，可在AI最近任务打开并点击“展开阅读与正文对照”。每次新建演示批次不保证该副本已有候选，开场前先检查；没有时可现场生成，或展示离线页中留存的真实候选。修改或采用后修订会变化，旧候选可能失效。
4. 打开05，展示预检阻断摘要，点击“前往处理”定位参数区，展示满足、不满足、待验证和无法判定的数量。
5. 打开03或04，展示技术/合规并行、领导终审和批准交付进度，以及审核人、时间和意见。

## 网络或模型异常时

- 请求仍在运行：继续讲解05匹配拦截，再回到任务查看状态。
- 明确失败：打开01查看已采用的真实AI正文和原文引用，或展示离线页面中的原始候选。旧任务可能因修订变化失效，不依赖旧候选详情作为备用入口。
- 应用或数据库不可用：打开“离线演示备用.html”和“批准版演示方案.docx”。离线材料仅供讲解，不执行审批。
- 不重复点击生成，避免产生不必要的新请求；已完成候选受方案修订约束，修改正文后如提示过期，请用新任务生成。

## 已验收

${m.checks.map(c=>'- '+c.name+(c.seconds?'：'+c.seconds+'秒':'')).join('\n')}

本批准备脚本记录的成功调用返回 ${m.checks.reduce((s,c)=>s+(c.usage?.totalTokens||0),0)} tokens，仅对应这些留存样本，不是供应商累计用量；不估算实际费用，以供应商账单为准。

## 重复准备

需要新的一套案例时运行 node --import tsx scripts/prepare-demo.ts。每次创建独立账号和数据，不清空旧案例，且会产生两次真实模型调用。最新目录记录在 data/demo/latest.json。若中途失败，已有记录保留，private-manifest.json记录失败原因；重跑会创建新的一套。
`;
fs.writeFileSync(path.join(dir,'演示操作手册.md'),guide);
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
let html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>售前方案·离线演示备用</title><style>body{font:16px/1.8 system-ui;max-width:1000px;margin:40px auto;padding:0 24px;background:#f4f7f6;color:#203a34}section{background:white;padding:28px;margin:24px 0;border-radius:12px}pre{white-space:pre-wrap;font:inherit}h1,h2{color:#166957}a{color:#166957}</style><h1>有依据的售前方案</h1><p>合成演示资料 · 以下为真实模型调用的留存结果与已批准正文。此离线页面不执行生成或审批。</p><nav><a href="#tech">技术候选</a> / <a href="#safety">安全候选</a> / <a href="#approved">批准方案</a> / <a href="批准版演示方案.docx">下载留存Word</a></nav>';
for(const [n,id,title] of [[2,'tech','真实模型·技术章候选'],[5,'safety','真实模型·安全章候选']]){const j=JSON.parse(fs.readFileSync(path.join(dir,`real-ai-section-${n}.json`)));html+=`<section id="${id}"><h2>${title}</h2><pre>${esc(j.result.content)}</pre><h3>引用原文</h3>${j.result.citations.map(c=>'<blockquote>'+esc(c.quote)+'</blockquote>').join('')}<h3>待验证事项</h3><ul>${j.result.gaps.map(g=>'<li>'+esc(g)+'</li>').join('')}</ul></section>`;}
html+='<section id="approved"><h2>已批准方案留存正文</h2><pre>'+esc(fs.readFileSync(path.join(dir,'批准版演示方案.txt'),'utf8'))+'</pre></section></html>';
fs.writeFileSync(path.join(dir,'离线演示备用.html'),html);
console.log('已生成本地账号清单、演示手册和离线备用页面（未输出密码）');
