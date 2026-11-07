import React, { useEffect, useState } from "react";
import type { Api } from "./Knowledge";
import { CitationPicker } from "./Knowledge";
import { sections, roleLabels } from "../shared/workflow";
function useAction() {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, notice, setNotice, run };
}
const Feedback = ({ state }: { state: ReturnType<typeof useAction> }) => (
  <>
    {state.error && (
      <div className="error" role="alert">
        {state.error}
      </div>
    )}
    {state.notice && (
      <div className="notice" role="status">
        {state.notice}
      </div>
    )}
  </>
);
export function Account({
  api,
  user,
  users,
  onSignedOut,
}: {
  api: Api;
  user: any;
  users: any[];
  onSignedOut: () => void;
}) {
  const a = useAction();
  return (
    <>
      <section className="form-section">
        <h1>账号与密码</h1>
        <p>
          {user.name} · {user.email}
        </p>
        <p className="hint">
          修改密码后，所有设备上的会话立即失效，请使用新密码重新登录。
        </p>
        <Feedback state={a} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              if (d.get("newPassword") !== d.get("confirm"))
                throw Error("两次新密码不一致");
              await api("/account/password", "POST", {
                currentPassword: d.get("currentPassword"),
                newPassword: d.get("newPassword"),
              });
              onSignedOut();
            });
          }}
        >
          <label>
            当前密码
            <input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              maxLength={200}
            />
          </label>
          <label>
            新密码
            <input
              name="newPassword"
              type="password"
              required
              minLength={12}
              maxLength={200}
              autoComplete="new-password"
            />
          </label>
          <label>
            再次输入新密码
            <input
              name="confirm"
              type="password"
              required
              minLength={12}
              maxLength={200}
              autoComplete="new-password"
            />
          </label>
          <button className="primary" disabled={a.busy}>
            修改密码并退出所有会话
          </button>
        </form>
      </section>
      {user.roles.includes("admin") && (
        <section className="form-section">
          <h2>管理员重置账号密码</h2>
          <p className="hint">
            仅重置所选账号，重置后该账号的全部会话失效。请通过既有授权渠道将新密码交给本人。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                d = new FormData(form);
              void a.run(async () => {
                if (d.get("newPassword") !== d.get("confirm"))
                  throw Error("两次密码不一致");
                await api(
                  "/users/" + d.get("userId") + "/reset-password",
                  "POST",
                  { newPassword: d.get("newPassword") },
                );
                form.reset();
                a.setNotice("密码已重置，该账号的全部会话已退出");
              });
            }}
          >
            <label>
              目标账号
              <select name="userId" required>
                <option value="">请选择</option>
                {users
                  .filter((u) => u.id !== user.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} · {u.email}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              新密码
              <input
                name="newPassword"
                required
                type="password"
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
              />
            </label>
            <label>
              确认新密码
              <input
                name="confirm"
                required
                type="password"
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
              />
            </label>
            <button disabled={a.busy}>确认重置并撤销旧会话</button>
          </form>
        </section>
      )}
    </>
  );
}
export function Inbox({
  api,
  onOpen,
}: {
  api: Api;
  onOpen: (id: string) => Promise<void>;
}) {
  const a = useAction(),
    [data, setData] = useState<any>(null);
  const load = async () => setData(await api("/inbox"));
  useEffect(() => {
    void a.run(load);
    let active = false;
    const t = setInterval(async () => {
      if (active) return;
      active = true;
      try {
        await load();
      } catch {
      } finally {
        active = false;
      }
    }, 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <small>MY INBOX</small>
          <h1>个人待办与提醒</h1>
          <p>按本人职责显示，每30秒更新；资料检查覆盖最近200个相关活跃方案。</p>
        </div>
        <button disabled={a.busy} onClick={() => void a.run(load)}>
          刷新待办
        </button>
      </div>
      <Feedback state={a} />
      {data &&
        [
          ["待我审批", data.reviews, "review"],
          ["退回与驳回", data.returned, "returned"],
          ["风险补证", data.risks, "risk"],
          ["风险独立复核", data.riskReviews, "risk"],
          ["待补及失效资料", data.alerts, "alert"],
          ["AI候选与异常", data.jobs, "job"],
          ["项目协作待办", data.projectTasks||[], "project"],
        ].map(([title, items, type]: any) => (
          <section key={title}>
            <h2>
              {title}（{items.length}）
            </h2>
            {!items.length && <p className="hint">暂无待处理事项</p>}
            {items.map((item: any, i: number) => (
              <div className="inbox-item" key={item.step_id || item.id || i}>
                <div>
                  <strong>
                    {type === "risk"
                      ? item.proposal_title + " · " + item.title
                      : item.title}
                  </strong>
                  <p>
                    {type === "review"
                      ? roleLabels[item.role as keyof typeof roleLabels]
                      : type === "returned"
                        ? "请处理审核意见后重新送审"
                        : type === "risk"
                          ? item.status === "submitted"
                            ? "已提交补证，等待独立复核"
                            : "待处理补证"
                          : type === "job"
                            ? item.status === "completed"
                              ? "章节候选等待人工采用"
                              : item.error_message
                            : ""}
                  </p>
                  {item.issues && (
                    <details>
                      <summary>查看问题</summary>
                      <ul>
                        {item.issues.map((s: string) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                <button
                  onClick={() =>
                    void a.run(() => onOpen(item.proposal_id || item.id))
                  }
                >
                  进入处理 →
                </button>
              </div>
            ))}
          </section>
        ))}
    </>
  );
}
export function Templates({ api, user }: { api: Api; user: any }) {
  const a = useAction(),
    [list, setList] = useState<any[]>([]),
    [base, setBase] = useState<any>(null),
    [draft, setDraft] = useState<any>({
      name: "",
      industry: "",
      instruction: "",
      sections: sections.map((title, i) => ({
        title,
        required: i !== 3,
        enabled: true,
      })),
    });
  const load = async () => setList(await api("/templates"));
  useEffect(() => {
    void a.run(load);
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <h1>方案模板与章节规划</h1>
          <p>
            六类核心章节保持稳定；可按行业设置标题、编制要求和竞品章节范围。每次修订生成独立版本。
          </p>
        </div>
        <button onClick={() => void a.run(load)}>刷新</button>
      </div>
      <Feedback state={a} />
      {user.roles.includes("admin") && (
        <section>
          <h2>
            {base ? `修订 ${base.name} V${base.version}` : "新建行业模板"}
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api("/templates", "POST", {
                  name: draft.name,
                  industry: draft.industry,
                  instruction: draft.instruction,
                  sections: draft.sections,
                  ...(base
                    ? {
                        familyId: base.family_id,
                        expectedVersion: Math.max(
                          ...list
                            .filter((t) => t.family_id === base.family_id)
                            .map((t) => t.version),
                        ),
                      }
                    : { expectedVersion: 0 }),
                });
                setBase(null);
                setDraft({
                  name: "",
                  industry: "",
                  instruction: "",
                  sections: sections.map((title, i) => ({
                    title,
                    required: i !== 3,
                    enabled: true,
                  })),
                });
                await load();
                a.setNotice("新模板版本已保存；已有方案快照保持原值");
              });
            }}
          >
            <div className="inline-form">
              <label>
                模板名称
                <input
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                行业
                <input
                  maxLength={100}
                  value={draft.industry}
                  onChange={(e) =>
                    setDraft({ ...draft, industry: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              章节编制要求
              <textarea
                rows={3}
                maxLength={2000}
                value={draft.instruction}
                onChange={(e) =>
                  setDraft({ ...draft, instruction: e.target.value })
                }
              />
            </label>
            {draft.sections.map((s: any, i: number) => (
              <div className="template-row" key={i}>
                <label>
                  第{i + 1}章标题
                  <input
                    required
                    maxLength={120}
                    value={s.title}
                    onChange={(e) => {
                      const next = structuredClone(draft);
                      next.sections[i].title = e.target.value;
                      setDraft(next);
                    }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    disabled={i !== 3}
                    checked={s.enabled !== false}
                    onChange={(e) => {
                      const next = structuredClone(draft);
                      next.sections[i].enabled = e.target.checked;
                      if (!e.target.checked) next.sections[i].required = false;
                      setDraft(next);
                    }}
                  />
                  启用
                </label>
                <label>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    disabled={i !== 3 || s.enabled === false}
                    checked={s.required}
                    onChange={(e) => {
                      const next = structuredClone(draft);
                      next.sections[i].required = e.target.checked;
                      setDraft(next);
                    }}
                  />
                  必填
                </label>
              </div>
            ))}
            <button disabled={a.busy} className="primary">
              保存为新版本
            </button>
            {base && (
              <button type="button" onClick={() => setBase(null)}>
                取消版本关联
              </button>
            )}
          </form>
        </section>
      )}
      {list.map((t) => (
        <section key={t.id}>
          <h2>
            {t.name} · V{t.version} · {t.active ? "启用" : "停用"}
          </h2>
          <p>
            {t.industry || "通用"} ·{" "}
            {t.definition.instruction || "无额外编制要求"}
          </p>
          <ol>
            {t.definition.sections.map((s: any, i: number) => (
              <li key={i}>
                {s.title} ·{" "}
                {s.enabled === false ? "停用" : s.required ? "必填" : "可选"}
              </li>
            ))}
          </ol>
          {user.roles.includes("admin") && (
            <div className="actions">
              <button
                disabled={a.busy}
                onClick={() => {
                  setBase(t);
                  setDraft(structuredClone(t.definition));
                  window.scrollTo(0, 0);
                }}
              >
                基于此版修订
              </button>
              <button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await api("/templates/" + t.id + "/status", "POST", {
                      active: !t.active,
                    });
                    await load();
                  })
                }
              >
                {t.active ? "停用此版本" : "启用此版本"}
              </button>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
export function TemplateApply({
  api,
  proposal,
  disabled,
  onChanged,
}: {
  api: Api;
  proposal: any;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const a = useAction(),
    [templates, setTemplates] = useState<any[]>([]),
    [id, setId] = useState("");
  useEffect(() => {
    api("/templates")
      .then(setTemplates)
      .catch(() => {});
  }, [proposal.id]);
  return (
    <section>
      <h3>章节模板</h3>
      <Feedback state={a} />
      <p>
        {proposal.body.template
          ? `${proposal.body.template.name} V${proposal.body.template.version || 1}`
          : "内置六章结构"}
      </p>
      <p className="hint">
        仅空正文草稿可以采用模板。模板后续修订或停用不会改写本方案。
      </p>
      <select
        aria-label="选择方案模板"
        value={id}
        disabled={disabled}
        onChange={(e) => setId(e.target.value)}
      >
        <option value="">选择启用的模板版本</option>
        {templates
          .filter((t) => t.active)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} V{t.version}
            </option>
          ))}
      </select>
      <button
        disabled={
          disabled ||
          a.busy ||
          !id ||
          proposal.body.sections.some((s: any) => s.content.trim())
        }
        onClick={() =>
          void a.run(async () => {
            await api(`/proposals/${proposal.id}/template`, "POST", {
              templateId: id,
              expectedRevision: proposal.revision,
            });
            await onChanged();
          })
        }
      >
        采用模板与章节规划
      </button>
    </section>
  );
}
export function RequirementIntake({
  api,
  proposal,
  disabled,
  onChanged,
}: {
  api: Api;
  proposal: any;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const a = useAction(),
    [docs, setDocs] = useState<any[]>([]),
    [batches, setBatches] = useState<any[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [selected, setSelected] = useState<any>(null),
    [choices, setChoices] = useState<Record<string, string>>({});
  const load = async () => {
    const [d, b] = await Promise.all([
      api("/documents?proposalId=" + proposal.id),
      api(`/proposals/${proposal.id}/requirement-batches`),
    ]);
    setDocs(
      d.filter(
        (d: any) =>
          d.proposal_id === proposal.id &&
          d.kind === "customer" &&
          d.status === "published",
      ),
    );
    setBatches(b);
  };
  useEffect(() => {
    void a.run(load);
  }, [proposal.id, proposal.revision]);
  return (
    <section>
      <h2 id="requirement-intake" tabIndex={-1}>客户资料需求提取与确认</h2>
      <p className="hint">
        本地规则从客户资料识别需求、阈值和工况语句，不发送模型。识别可能遗漏，请核对原件；不会自动填数值或确认结论。
      </p>
      <Feedback state={a} />
      <button disabled={a.busy} onClick={() => void a.run(load)}>
        刷新客户资料
      </button>
      <label>
        已发布客户资料
        <select
          multiple
          aria-label="提取需求的资料"
          value={ids}
          disabled={disabled}
          onChange={(e) =>
            setIds(Array.from(e.target.selectedOptions).map((o) => o.value))
          }
        >
          {docs.map((d) => (
            <option key={d.version_id} value={d.version_id}>
              {d.title} V{d.version}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary"
        disabled={disabled || a.busy || !ids.length || ids.length > 8}
        onClick={() =>
          void a.run(async () => {
            const b = await api(
              `/proposals/${proposal.id}/requirement-batches`,
              "POST",
              { expectedRevision: proposal.revision, versionIds: ids },
            );
            await load();
            const all = await api(
              `/proposals/${proposal.id}/requirement-batches`,
            );
            const found = all.find((x: any) => x.id === b.id);
            setSelected(found);
            setChoices(
              Object.fromEntries(
                found.candidates.map((c: any) => [c.id, c.text]),
              ),
            );
          })
        }
      >
        提取待确认需求
      </button>
      {batches.length > 0 && (
        <label>
          历史提取批次
          <select
            value={selected?.id || ""}
            onChange={(e) => {
              const b = batches.find((b) => b.id === e.target.value);
              setSelected(b);
              setChoices(
                Object.fromEntries(
                  (b?.candidates || []).map((c: any) => [c.id, c.text]),
                ),
              );
            }}
          >
            <option value="">选择批次</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                V{b.edition}.{b.revision} ·{" "}
                {new Date(b.created_at).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}{" "}
                · {b.applied_at ? "已采用" : "待确认"}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <>
          {!selected.candidates.length && (
            <p className="hint">未识别到需求语句，请查看原件并人工补录。</p>
          )}
          {selected.candidates.map((c: any) => (
            <div className="parameter-card" key={c.id}>
              <label>
                <input
                  style={{ width: "auto" }}
                  type="checkbox"
                  disabled={disabled || !!selected.applied_at}
                  checked={c.id in choices}
                  onChange={(e) =>
                    setChoices((v) => {
                      const n = { ...v };
                      if (e.target.checked) n[c.id] = c.text;
                      else delete n[c.id];
                      return n;
                    })
                  }
                />
                确认该项
              </label>
              <blockquote>{c.quote}</blockquote>
              <small>
                原文位置 {c.start} · 版本 {c.versionId}
              </small>
              {c.id in choices && (
                <label>
                  确认后的需求表述
                  <textarea
                    value={choices[c.id]}
                    disabled={disabled || !!selected.applied_at}
                    maxLength={2000}
                    onChange={(e) =>
                      setChoices({ ...choices, [c.id]: e.target.value })
                    }
                  />
                </label>
              )}
            </div>
          ))}
          <button
            disabled={
              disabled ||
              a.busy ||
              !!selected.applied_at ||
              !Object.keys(choices).length ||
              selected.revision !== proposal.revision ||
              selected.edition !== proposal.edition
            }
            onClick={() =>
              void a.run(async () => {
                await api(
                  `/proposals/${proposal.id}/requirement-batches/${selected.id}/apply`,
                  "POST",
                  {
                    expectedRevision: proposal.revision,
                    items: Object.entries(choices).map(([id, text]) => ({
                      id,
                      text,
                    })),
                  },
                );
                setSelected(null);
                await onChanged();
                await load();
              })
            }
          >
            逐项核对完成，确认并追加到需求
          </button>
        </>
      )}
      <details>
        <summary>
          已确认的有来源需求（{proposal.body.confirmedRequirements?.length || 0}
          ）
        </summary>
        {proposal.body.confirmedRequirements?.map((c: any) => (
          <div className="citation" key={c.id}>
            <p>{c.text}</p>
            <blockquote>{c.quote}</blockquote>
            <small>
              原文位置 {c.start} · {c.versionId}
            </small>
            {!disabled && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void a.run(async () => {
                    await api(
                      `/proposals/${proposal.id}/confirmed-requirements/remove`,
                      "POST",
                      {
                        expectedRevision: proposal.revision,
                        id: c.id,
                        note: d.get("note"),
                      },
                    );
                    await onChanged();
                    await load();
                  });
                }}
              >
                <label>
                  撤销来源确认的原因
                  <input name="note" required minLength={4} maxLength={2000} />
                </label>
                <button disabled={a.busy}>
                  撤销此项来源确认，保留需求正文待核对
                </button>
              </form>
            )}
          </div>
        ))}
      </details>
    </section>
  );
}
export function Risks({
  api,
  proposal,
  user,
  users,
  disabled,
  onChanged,
}: {
  api: Api;
  proposal: any;
  user: any;
  users: any[];
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const a = useAction(),
    [items, setItems] = useState<any[]>([]),
    [evidence, setEvidence] = useState<Record<string, any[]>>({});
  const load = async () => {
    const list = await api(`/proposals/${proposal.id}/risks`);
    setItems(list);
    setEvidence(
      Object.fromEntries(
        list.map((r: any) => [
          r.id,
          typeof r.evidence === "string"
            ? JSON.parse(r.evidence)
            : r.evidence || [],
        ]),
      ),
    );
  };
  useEffect(() => {
    void a.run(load);
  }, [proposal.id, proposal.status]);
  const editable = ["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(
    proposal.status,
  );
  return (
    <section>
      <h2 id="risk-editor" tabIndex={-1}>风险登记 补证与独立复核</h2>
      <Feedback state={a} />
      <button disabled={a.busy} onClick={() => void a.run(load)}>
        刷新风险
      </button>
      {user.id === proposal.owner_id &&
        user.roles.includes("engineer") &&
        editable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = e.currentTarget,
                d = new FormData(f);
              void a.run(async () => {
                await api(`/proposals/${proposal.id}/risks`, "POST", {
                  title: d.get("title"),
                  ownerId: d.get("ownerId"),
                  blocking: d.get("blocking") === "on",
                });
                f.reset();
                await load();
                await onChanged();
              });
            }}
          >
            <label>
              风险事项
              <input name="title" required maxLength={200} />
            </label>
            <label>
              补证责任人
              <select name="ownerId" required defaultValue={proposal.owner_id}>
                {users
                  .filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                name="blocking"
                defaultChecked
                style={{ width: "auto" }}
              />
              阻断送审及正式下载
            </label>
            <button disabled={disabled || a.busy}>登记风险</button>
          </form>
        )}
      {items.map((r) => (
        <div className="parameter-card" key={r.id}>
          <h3>
            {r.title} ·{" "}
            {
              { open: "待补证", submitted: "待独立复核", closed: "已关闭" }[
                r.status as string
              ]
            }
          </h3>
          <p>
            责任人：
            {users.find((u) => u.id === r.owner_id)?.name ||
              "已停用账号"} · {r.blocking ? "阻断风险" : "提示风险"}
          </p>
          {r.note && <p>{r.note}</p>}
          <CitationPicker
            api={api}
            proposalId={proposal.id}
            value={evidence[r.id] || []}
            disabled={
              !editable ||
              disabled ||
              r.status === "closed" ||
              !(user.id === r.owner_id || user.id === proposal.owner_id)
            }
            onChange={(c) => setEvidence({ ...evidence, [r.id]: c })}
          />
          {editable &&
            ((["open", "submitted"].includes(r.status) &&
              (user.id === r.owner_id || user.id === proposal.owner_id)) ||
              (r.status !== "open" &&
                user.id !== r.owner_id &&
                user.id !== proposal.owner_id &&
                user.roles.some((role: string) =>
                  ["chemist", "compliance"].includes(role),
                ))) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void a.run(async () => {
                    await api(
                      `/proposals/${proposal.id}/risks/${r.id}`,
                      "POST",
                      {
                        action: d.get("action"),
                        expectedRevision: r.revision,
                        note: d.get("note"),
                        citations: evidence[r.id] || [],
                      },
                    );
                    await load();
                    await onChanged();
                  });
                }}
              >
                <label>
                  处理意见
                  <textarea
                    name="note"
                    required
                    minLength={4}
                    maxLength={4000}
                  />
                </label>
                <select name="action" aria-label="风险处理动作">
                  {["open", "submitted"].includes(r.status) &&
                    (user.id === r.owner_id ||
                      user.id === proposal.owner_id) && (
                      <option value="submit">提交补证</option>
                    )}
                  {user.id !== r.owner_id &&
                    user.id !== proposal.owner_id &&
                    user.roles.some((x: string) =>
                      ["chemist", "compliance"].includes(x),
                    ) && (
                      <>
                        {r.status === "submitted" && (
                          <option value="close">独立复核并关闭</option>
                        )}
                        {r.status !== "open" && (
                          <option value="reopen">退回或重新打开</option>
                        )}
                      </>
                    )}
                </select>
                <button disabled={disabled || a.busy}>确认处理</button>
              </form>
            )}
        </div>
      ))}
    </section>
  );
}
