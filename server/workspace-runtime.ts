import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, Type, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Harness, AssistantEntry, createRegistry, defineExtension, defineTool, section, hook, GenerationTask, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { modelConfig } from "./model.js";
import { ApiError } from "./security.js";
import { z } from "zod";
import { parseWorkspaceResult, workspacePrompt, type WorkspaceInput } from "../shared/workspace.js";
import { searchProjectEvidence } from "../shared/project.js";

export function workspaceModels(signal: AbortSignal, onStatus?: (status:number)=>Promise<void>, beforeFetch?:()=>Promise<void>) {
  const url = new URL(modelConfig.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("模型地址配置无效");
  if (!Number.isInteger(modelConfig.maxTokens) || modelConfig.maxTokens < 512 || modelConfig.maxTokens > 32768) throw new Error("模型输出长度配置无效");
  const api = openAICompletionsApi();
  const model: Model<"openai-completions"> = {
    id: modelConfig.model, name: modelConfig.model, api: "openai-completions", provider: "workspace",
    baseUrl: modelConfig.baseUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, ""),
    reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: modelConfig.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = createModels();
  const opts = (options: any) => ({ ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
    maxTokens: modelConfig.maxTokens, maxRetries: 0, timeoutMs: Math.min(modelConfig.timeoutSeconds * 1000, 180000),
    fetch: async (request: any, init: any) => {
      await beforeFetch?.();
      const response = await fetch(request,{...init,redirect:"error"});
      await onStatus?.(response.status);
      return response;
    } });
  models.setProvider(createProvider({ id: model.provider, models: [model],
    auth: { apiKey: { name: "平台模型配置", resolve: async () => ({ auth: { apiKey: modelConfig.key } }) } },
    api: { stream: (m,c,o) => api.stream(m,c,opts(o)), streamSimple: (m,c,o) => api.streamSimple(m,c,opts(o)) },
  }));
  return { models, modelId: model.id, provider: model.provider };
}

export type WorkspaceRuntimeDeps = {
  path: string; signal: AbortSignal; assertCurrent: () => Promise<void>;
  beforeRequest: () => Promise<void>; event: (type: string, payload: any) => Promise<void>;
  inspectProducts: () => Promise<unknown>; readVersions: () => Promise<Set<string>>;
  shouldPause?: () => boolean;
  readRanges?:()=>Promise<{versionId:string;start:number;length:number}[]>;
  // Dependency injection is available to tests; production always builds the configured real provider.
  provider?: { models: Models; modelId: string; provider: string };
};

export async function runWorkspaceAgent(input: WorkspaceInput, deps: WorkspaceRuntimeDeps) {
  const context = BACKGROUND_CONTEXT;
  await deps.assertCurrent();
  const fingerprint = createHash("sha256").update(JSON.stringify({ policy: "workspace-1", input })).digest("hex");
  await mkdir(dirname(deps.path), { recursive: true, mode: 0o700 });
  try {
    const saved = JSON.parse(await readFile(deps.path + ".json", "utf8"));
    if (saved.fingerprint !== fingerprint) throw new Error("Agent会话输入指纹不一致");
    await access(deps.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // A journal without its manifest must not be reused with a different input.
    try { await access(deps.path); throw new Error("Agent会话缺少输入指纹"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(deps.path + ".json", JSON.stringify({ fingerprint }), { flag: "wx", mode: 0o600 });
  }
  let failureStatus=0;
  const provider = deps.provider || workspaceModels(deps.signal,async status=>{
    if(status>=400)failureStatus=status;
    await deps.event("model_response",{httpStatus:status});
  },async()=>{await deps.assertCurrent();await deps.beforeRequest();});
  const registry = createRegistry();
  const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const empty = Type.Object({}, { additionalProperties: false });
  const execute = async (name: string, fn: () => Promise<unknown>) => {
    await deps.assertCurrent();
    const value = await fn();
    await deps.event("tool_completed", { name });
    return output(value);
  };
  registry.install(defineExtension({ name: "workspace-1",
    sections: [section("workspace-policy", () => workspacePrompt(input), { tag: false })],
    tools: [
      defineTool({ name: "read_proposal", description: "读取当前方案目标、应用场景、已保存需求与章节；没有专业确认权", parameters: empty, replay: "safe",
        execute: async () => execute("read_proposal", async () => ({ title: input.title, scene: input.scene, requirements: input.requirements, sections: input.sections,
          authorizedSources:input.sources.map(s=>({versionId:s.id,title:s.title,kind:s.kind,readChars:s.text.length,totalChars:s.totalChars})),
          previousDiscussion: input.conversation || [], note: "历史讨论为待确认候选，当前保存的需求优先；新补充信息不能自动成为已确认事实" })) }),
      defineTool({ name: "search_evidence", description: "搜索本次授权资料目录；返回固定版本和可读取字符数，不自动读取全文", replay: "safe",
        parameters: Type.Object({ query: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        execute: async args => execute("search_evidence", async () => {
          const matches=searchProjectEvidence(input.sources,args.query);
          for(const m of matches)await deps.event("evidence_read",{versionId:m.versionId,start:m.start,length:m.text.length});
          return matches;
        }) }),
      defineTool({ name: "read_evidence", description: "分段读取授权资料任意位置原文。start为整份原文的UTF16偏移；返回start与text。引用须使用整份原文偏移", replay: "safe",
        parameters: Type.Object({ versionId: Type.String(),start:Type.Optional(Type.Integer({minimum:0})),length:Type.Optional(Type.Integer({minimum:4,maximum:4000})) }, { additionalProperties: false }),
        execute: async args => execute("read_evidence", async () => {
          const s = input.sources.find(s => s.id === args.versionId);
          if (!s) throw new Error("资料不在本次授权范围");
          const start=args.start||0,text=s.text.slice(start,start+(args.length||4000));
          await deps.event("evidence_read", { versionId: s.id,start,length:text.length });
          return {versionId:s.id,title:s.title,kind:s.kind,start,text,totalChars:s.totalChars};
        }) }),
      defineTool({ name: "inspect_products", description: "查询当前候选产品、有效且获模型许可的参数及确定性比对；缺证据时不得判为适配", parameters: empty, replay: "safe",
        execute: async () => execute("inspect_products", deps.inspectProducts) }),
      defineTool({name:"read_project",description:"读取当前事实、假设、推荐、试验原始结果和确定性比较、已确认结论及客户价值测算；内部成本底稿不在此工具范围",parameters:empty,replay:"safe",execute:async()=>execute("read_project",async()=>input.projectContext||{records:[]})}),
    ],
    hooks: [hook(GenerationTask, { beforeRequest: async () => { await deps.assertCurrent(); if(deps.provider)await deps.beforeRequest(); return undefined; } }),
      hook(ToolTask, { beforeTool: async () => { await deps.assertCurrent(); return undefined; } })],
  }));
  const harness = await Harness.open(await openNodeSqliteStorage(deps.path), { models: provider.models, registry,
    settings: { retry: { enabled: false }, compaction: { enabled: false }, toolExecution: "sequential" } }, context);
  const root = await harness.root(context, { agent: { model: { provider: provider.provider, modelId: provider.modelId } } });
  const abort = () => { if(deps.shouldPause?.())void harness.close(context);else void root.abort(context, { background: true }); };
  deps.signal.addEventListener("abort", abort, { once: true });
  try {
    deps.signal.throwIfAborted();
    let content=input.instruction;
    const usage=[];
    for(let attempt=0;attempt<3;attempt++) {
      const submission = await root.submit({ type: "input", requestId: attempt ? `workspace-repair-${attempt}` : "workspace-run", content }, context);
      harness.resume();
      const settled = await submission.wait(context);
      deps.signal.throwIfAborted();
      await deps.assertCurrent();
      if (settled.status !== "done" || settled.type !== "input") throw new Error("Agent未完成，可重新发起任务");
      const answer = await root.commit(t => t.entry(AssistantEntry, settled.answer), context);
      const messages = answer?.model || [];
      const text = messages.flatMap(m => typeof m.content === "string" ? [m.content] : m.content.filter(c => c.type === "text").map(c => c.text)).join("\n");
      usage.push(...messages.filter(m => m.role === "assistant").map(m => m.usage));
      try {
        const result = parseWorkspaceResult(text, input, await deps.readVersions(),await deps.readRanges?.());
        return { result, usage };
      } catch(error) {
        if(attempt===2)throw error;
        const issues=error instanceof z.ZodError ? error.issues.map(e=>`${e.path.join(".")}: ${e.message}`).slice(0,12) : [error instanceof SyntaxError ? "必须输出完整、可解析的JSON对象" : (error as Error).message];
        await deps.event("validation_rejected",{attempt:attempt+1,issues});
        content=`上一份候选未通过服务器校验：${JSON.stringify(issues)}。请修正后重新输出完整JSON。facts每项必须有有效原文引用；方案状态/空需求等没有文档出处的描述只能放摘要，不能加入facts。非原文开头的引文必须使用正确的字符偏移，不能一律填0；可选择从0开始的完整连续原文。不补造来源，不降低规则，必要时删除无法核实的事实或章节。`;
      }
    }
    throw new Error("Agent结果校验未通过");
  } catch (error) {
    if(failureStatus===401 || failureStatus===403)throw new ApiError(503,"模型服务鉴权失败，请更新 MODEL_API_KEY 后重新发起任务");
    if(failureStatus>=400)throw new ApiError(502,`模型服务返回HTTP ${failureStatus}，请检查配置或额度后重试`);
    throw error;
  } finally {
    deps.signal.removeEventListener("abort", abort);
    await harness.close(context);
  }
}
