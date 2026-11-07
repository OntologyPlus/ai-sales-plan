import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { roleLabels, statusLabels, type Role } from "../shared/workflow";
import "./style.css";
import { Knowledge, CitationPicker, Assignments } from "./Knowledge";
import { AiPanel } from "./AiPanel";
import { Workspace } from "./Workspace";
import { ProductSpecs, MatchingEditor, Artifacts } from "./Matching";
import { ApprovalProgress, PrecheckSummary, ProposalReader } from "./Presentation";
import {
  Account,
  Inbox,
  Templates,
  TemplateApply,
  RequirementIntake,
  Risks,
} from "./Operations";
let csrf = "";
async function api(path: string, method = "GET", body?: any) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (r.status === 401 && path !== "/login" && path !== "/me")
    window.dispatchEvent(new Event("session-expired"));
  if (!r.ok) throw new Error(data.error || "请求失败");
  return data;
}
function App() {
  const [user, setUser] = useState<any>(null),
    [ready, setReady] = useState(false),
    [page, setPage] = useState("dashboard"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [list, setList] = useState<any[]>([]),
    [users, setUsers] = useState<any[]>([]),
    [customers, setCustomers] = useState<any[]>([]),
    [products, setProducts] = useState<any[]>([]),
    [current, setCurrent] = useState<any>(null),
    [draft, setDraft] = useState<any>(null),
    [dirty, setDirty] = useState(false),
    [search, setSearch] = useState(""),
    [audit, setAudit] = useState<any[]>([]);
  const [precheck, setPrecheck] = useState<any>(null);
  const [showSources, setShowSources] = useState(false);
  const [reader, setReader] = useState<any>(null);
  const has = (r: string) => user?.roles.includes(r);
  const clearSession = () => {
    csrf = "";
    setUser(null);
    setPage("dashboard");
    setCurrent(null);
    setDraft(null);
    setDirty(false);
    setReader(null);
    setPrecheck(null);
    setShowSources(false);
    setList([]);
    setUsers([]);
    setCustomers([]);
    setProducts([]);
    setAudit([]);
    setSearch("");
    setError("");
    setNotice("");
  };
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
  const refresh = async () => {
    const [p, u, c, pr] = await Promise.all([
      api("/proposals"),
      api("/users"),
      api("/customers"),
      api("/products"),
    ]);
    setList(p);
    setUsers(u);
    setCustomers(c);
    setProducts(pr);
  };
  useEffect(() => {
    const expired = () => {
      clearSession();
      setError("会话已失效，请重新登录");
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    api("/me")
      .then((u) => {
        csrf = u.csrf;
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (user) void run(refresh);
  }, [user]);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);
  const navigate = (p: string) => {
    if (dirty && !confirm("有未保存修改，确定离开？")) return;
    setDirty(false);
    setPage(p);
    setCurrent(null);
    setError("");
    if (p === "audit") void run(async () => setAudit(await api("/audit")));
  };
  const open = async (id: string) => {
    if (dirty && !confirm("有未保存修改，确定重新载入？")) return;
    const p = await api("/proposals/" + id);
    setCurrent(p);
    setShowSources(false);
    setReader(null);
    setPrecheck(await api(`/proposals/${id}/precheck`));
    setDraft(structuredClone(p.body));
    setDirty(false);
    setPage("workspace");
  };
  const mutate = async (action: string, b?: any) => {
    await api(`/proposals/${current.id}/${action}`, "POST", b);
    setDirty(false);
    await open(current.id);
    await refresh();
    setNotice("操作已完成");
  };
  const field = (e: React.FormEvent<HTMLFormElement>) =>
    Object.fromEntries(new FormData(e.currentTarget));
  const submitForm = (
    e: React.FormEvent<HTMLFormElement>,
    fn: (v: any) => Promise<void>,
  ) => {
    e.preventDefault();
    const form = e.currentTarget;
    const value = field(e);
    void run(async () => {
      await fn(value);
      form.reset();
      setNotice("已保存");
    });
  };
  if (!ready) return <div className="loading">正在连接工作台…</div>;
  if (!user)
    return (
      <div className="login">
        <div className="login-story">
          <div className="brand-mark">SP</div>
          <small>APPLICATION INTELLIGENCE</small>
          <h1>
            让每一份推荐，
            <br />
            都有依据。
          </h1>
          <p>
            从客户需求到技术与合规审核，
            <br />
            在同一工作台完成售前方案。
          </p>
          <span>应用匹配 / 技术依据 / 合规留痕</span>
        </div>
        <form
          className="login-form"
          onSubmit={(e) =>
            submitForm(e, async (b) => {
              const u = await api("/login", "POST", b);
              csrf = u.csrf;
              setUser(u);
            })
          }
        >
          <small>售前方案平台</small>
          <h2>登录工作台</h2>
          <p>使用管理员分配的账号继续</p>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <label>
            邮箱
            <input type="email" name="email" required autoComplete="username" />
          </label>
          <label>
            密码
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
            />
          </label>
          <button disabled={busy} className="primary">
            {busy ? "登录中…" : "登录 →"}
          </button>
          <p className="hint">首次使用请由部署人员初始化管理员账号。</p>
        </form>
      </div>
    );
  const pending = list.filter((x) => x.status === "IN_REVIEW");
  const canEdit =
    current &&
    has("engineer") &&
    current.owner_id === user.id &&
    ["DRAFT", "CHANGES_REQUESTED", "REJECTED"].includes(current.status);
  const table = (items: any[]) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>方案 / 编号</th>
            <th>客户与场景</th>
            <th>负责人</th>
            <th>版本</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.title}</strong>
                <small>{p.code}</small>
              </td>
              <td>
                {p.customer_name}
                <small>{p.scene}</small>
              </td>
              <td>{p.owner_name}</td>
              <td>
                V{p.edition}.{p.revision}
              </td>
              <td>
                <span className={"badge " + p.status}>
                  {statusLabels[p.status]}
                </span>
              </td>
              <td>
                <button onClick={() => void run(() => open(p.id))}>
                  打开 →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="empty">{has("engineer")
          ? "暂无方案。点击顶部“新建方案”，即可开始编制。"
          : "暂无可访问的方案，已分配的方案和审核任务将在此显示。"}</div>
      )}
    </div>
  );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <b>
            SP<span>售前方案</span>
          </b>
          <small>应用匹配 · 证据驱动</small>
        </div>
        <small className="nav-label">工作空间</small>
        {[
          ["dashboard", "◫", "工作台"],
          ["inbox", "☑", "个人待办"],
          ["templates", "▦", "方案模板"],
          ["account", "♙", "账号维护"],
          ["proposals", "▤", "方案中心"],
          ["approval", "✓", "审批中心"],
          ["customers", "◉", "客户管理"],
          ["products", "◇", "产品档案"],
          ["knowledge", "▧", "知识库"],
          ...(has("admin")
            ? [
                ["users", "♙", "用户与角色"],
                ["audit", "≡", "审计日志"],
                ["assignments", "⇄", "审核分配"],
              ]
            : []),
        ].map(([id, icon, label]) => (
          <button
            className={page === id ? "selected" : ""}
            key={id}
            onClick={() => navigate(id)}
          >
            <i>{icon}</i>
            {label}
            {id === "approval" && pending.length > 0 && (
              <em>{pending.length}</em>
            )}
          </button>
        ))}
        <div className="side-footer">
          <div className="avatar">{user.name.slice(0, 1)}</div>
          <strong>{user.name}</strong>
          <small>
            {user.roles.map((r: Role) => roleLabels[r]).join(" / ")}
          </small>
        </div>
      </aside>
      <main>
        <header>
          <span>
            售前应用 /{" "}
            {page === "editor"
              ? "方案工作区"
              : (
                  {
                    dashboard: "工作台",
                    workspace: "AI工作空间",
                    inbox: "个人待办",
                    templates: "方案模板",
                    account: "账号维护",
                    new: "新建方案",
                    proposals: "方案中心",
                    approval: "审批中心",
                    customers: "客户管理",
                    products: "产品档案",
                    knowledge: "知识库",
                    assignments: "审核分配",
                    users: "用户与角色",
                    audit: "审计日志",
                  } as any
                )[page]}
          </span>
          <div className="header-actions" aria-label="常用操作">
          <span className="today">
            {new Date().toLocaleDateString("zh-CN", {
              timeZone: "Asia/Shanghai",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </span>
          <button
            className="primary"
            disabled={busy}
            onClick={() => navigate("new")}
          >
            ＋ 新建方案
          </button>
          <button
            className="account-entry"
            onClick={() => navigate("account")}
            title={user.roles.map((r: Role) => roleLabels[r]).join(" / ")}
          >
            {user.name}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (dirty && !confirm("有未保存修改，确定退出？")) return;
              void run(async () => {
                await api("/logout", "POST");
                clearSession();
              });
            }}
          >
            退出登录
          </button>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {page === "inbox" && <Inbox api={api} onOpen={open} />}
          {page === "templates" && <Templates api={api} user={user} />}
          {page === "account" && (
            <Account
              api={api}
              user={user}
              users={users}
              onSignedOut={() => {
                clearSession();
                setNotice("密码已修改，请用新密码重新登录");
              }}
            />
          )}
          {(page === "dashboard" ||
            page === "proposals" ||
            page === "approval") && (
            <>
              <div className="heading">
                <div>
                  <small>WORKSPACE</small>
                  <h1>
                    {page === "dashboard"
                      ? `${user.name}，欢迎回来`
                      : page === "approval"
                        ? "审批中心"
                        : "方案中心"}
                  </h1>
                  <p>
                    {page === "approval"
                      ? "打开审核中的方案，查看固定版本并办理本人待办。"
                      : "把客户需求转化为有技术依据、可追溯的应用方案。"}
                  </p>
                </div>
              </div>
              {page === "dashboard" && (
                <div className="stats">
                  {[
                    ["全部方案", list.length, "当前可访问范围"],
                    [
                      "编制中",
                      list.filter((x) =>
                        ["DRAFT", "CHANGES_REQUESTED"].includes(x.status),
                      ).length,
                      "完善需求与技术依据",
                    ],
                    ["审核中", pending.length, "技术 · 合规 · 领导"],
                    [
                      "已批准",
                      list.filter((x) => x.status === "APPROVED").length,
                      "可导出正式版本",
                    ],
                  ].map(([n, v, s]) => (
                    <div key={n}>
                      <span>{n}</span>
                      <b>{v}</b>
                      <small>{s}</small>
                    </div>
                  ))}
                </div>
              )}
              <section>
                <div className="section-heading">
                  <h2>{page === "approval" ? "审核中的方案" : "方案记录"}</h2>
                  <input
                    aria-label="搜索方案"
                    placeholder="搜索方案、客户或编号"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <button disabled={busy} onClick={() => void run(refresh)}>
                    刷新
                  </button>
                </div>
                {table(
                  (page === "approval" ? pending : list).filter((p) =>
                    `${p.title} ${p.customer_name} ${p.code}`.includes(search),
                  ),
                )}
              </section>
            </>
          )}
          {page === "new" && !has("engineer") && (
            <section className="form-section">
              <h1>新建方案</h1>
              <p>新建方案需要“售前应用工程师”角色。当前账号角色：{user.roles.map((r: Role) => roleLabels[r]).join(" / ")}。</p>
              <p>{has("admin")
                ? "请在用户与角色中为需要编制方案的账号分配售前应用工程师角色，再使用该账号创建客户和方案。"
                : "请联系管理员分配售前应用工程师角色，或使用具备该角色的账号登录。"}</p>
              {has("admin") && (
                <button className="primary" onClick={() => navigate("users")}>
                  前往用户与角色
                </button>
              )}
            </section>
          )}
          {page === "new" && has("engineer") && (
            <section className="form-section">
              <h1>创建应用方案</h1>
              <p>先建立任务，再逐步确认需求、补充正文和依据。</p>
              <form
                onSubmit={(e) =>
                  submitForm(e, async (b) => {
                    const p = await api("/proposals", "POST", b);
                    await refresh();
                    await open(p.id);
                  })
                }
              >
                <label>
                  方案名称
                  <input name="title" required maxLength={160} />
                </label>
                <label>
                  客户
                  <select name="customerId" required>
                    <option value="">选择本人负责的客户</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!customers.length && (
                  <div className="notice">
                    <p>创建方案前，请先建立本人负责的客户。</p>
                    <button type="button" onClick={() => navigate("customers")}>
                      前往创建客户
                    </button>
                  </div>
                )}
                <label>
                  行业应用场景
                  <input
                    name="scene"
                    required
                    maxLength={200}
                    placeholder="例如：动力电池结构粘接"
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy || !customers.length}
                >
                  创建并进入工作空间 →
                </button>
              </form>
            </section>
          )}
          {page === "workspace" && current && <Workspace key={`${current.id}:${current.edition}`} api={api} proposal={current} user={user}
            onDirty={setDirty} onSaved={async () => {
              const p = await api(`/proposals/${current.id}`); setCurrent(p); setDraft(structuredClone(p.body));
              setPrecheck(await api(`/proposals/${current.id}/precheck`)); await refresh();
            }} onEdit={() => {
              if (dirty && !confirm("有未保存的专业对象或尚未提交给AI的信息，确定离开？")) return;
              setDirty(false);void run(async()=>{const p=await api(`/proposals/${current.id}`);setCurrent(p);setDraft(structuredClone(p.body));setPrecheck(await api(`/proposals/${current.id}/precheck`));setPage("editor");});
            }} />}
          {page === "editor" && current && draft && (
            <>
              <div className="heading">
                <div>
                  <small>
                    {current.code} · V{current.edition}.{current.revision}
                  </small>
                  <h1>{current.title}</h1>
                  <p>
                    {current.scene}{" "}
                    <span className={"badge " + current.status}>
                      {statusLabels[current.status]}
                    </span>
                    {dirty && " · 有未保存修改"}
                  </p>
                </div>
                <div className="actions">
                  <button disabled={busy || dirty} onClick={() => { setDirty(false); setPage("workspace"); }}>AI工作空间 →</button>
                  <button className="primary" disabled={busy} onClick={() => void run(async () => {
                    const matchingSnapshot = dirty ? undefined : await api(`/proposals/${current.id}/matching`);
                    setReader({ snapshot: { ...current, body: structuredClone(draft), matchingSnapshot }, dirty });
                  })}>阅读预览 ↗</button>
                  {canEdit && (
                    <button
                      className="primary"
                      disabled={busy || !dirty}
                      onClick={() =>
                        void run(async () => {
                          await api("/proposals/" + current.id, "PUT", {
                            expectedRevision: current.revision,
                            body: draft,
                          });
                          setDirty(false);
                          const p = await api("/proposals/" + current.id);
                          setCurrent(p);
                          setDraft(structuredClone(p.body));
                          setPrecheck(await api(`/proposals/${current.id}/precheck`));
                          await refresh();
                          setNotice("正文已保存");
                        })
                      }
                    >
                      保存修改
                    </button>
                  )}
                  {current.status === "IN_REVIEW" &&
                    current.owner_id === user.id &&
                    has("engineer") && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => mutate("withdraw"))}
                      >
                        撤回修改
                      </button>
                    )}
                  {current.status === "APPROVED" &&
                    current.owner_id === user.id &&
                    has("engineer") && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => mutate("new-version"))}
                      >
                        开启新版本
                      </button>
                    )}
                  {current.requests.some((r: any) => r.status === "approved") &&
                    ((current.owner_id === user.id && has("engineer")) ||
                      has("leader")) && (
                      <a className="button" href="#artifacts">
                        查看批准成果
                      </a>
                    )}
                </div>
              </div>
              <ApprovalProgress proposal={current} />
              <PrecheckSummary precheck={precheck} dirty={dirty} onNavigate={(target) => {
                document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
                document.getElementById(target)?.focus({ preventScroll: true });
              }} />
              {reader && <ProposalReader api={api} snapshot={reader.snapshot} historical={reader.historical} dirty={reader.dirty} onClose={() => setReader(null)} />}
              <button onClick={() => setShowSources(!showSources)}>
                {showSources ? "收起方案资料" : "管理方案资料"}
              </button>
              {showSources && (
                <Knowledge api={api} user={user} proposalId={current.id} />
              )}
              <div className="workspace">
                <nav className="outline">
                  <h3>方案大纲</h3>
                  <a href="#requirements">需求与产品</a>

                  {draft.sections.map((s: any, i: number) => (
                    <a key={i} href={"#section-" + i}>
                      {String(i + 1).padStart(2, "0")} {s.title}
                    </a>
                  ))}
                  <p className="hint">
                    每章保留引用依据。专业审核通过后，仍需领导终审。
                  </p>
                </nav>
                <div className="document">
                  <TemplateApply
                    api={api}
                    proposal={current}
                    disabled={!canEdit || dirty}
                    onChanged={async () => {
                      await open(current.id);
                      await refresh();
                    }}
                  />
                  <section id="requirements">
                    <h2>需求与产品</h2>
                    <label>
                      已确认的客户需求
                      <textarea
                        disabled={!canEdit}
                        value={draft.requirements}
                        rows={5}
                        placeholder="记录目标、约束、单位、基材及工况，并注明来源。"
                        onChange={(e) => {
                          setDraft({ ...draft, requirements: e.target.value });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label>
                      关联产品
                      <select
                        multiple
                        disabled={!canEdit}
                        value={draft.productIds}
                        onChange={(e) => {
                          setDraft({
                            ...draft,
                            productIds: Array.from(
                              e.target.selectedOptions,
                            ).map((o) => o.value),
                          });
                          setDirty(true);
                        }}
                      >
                        {products
                          .filter((p) => p.active)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.code} · {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </section>
                  <RequirementIntake
                    api={api}
                    proposal={current}
                    disabled={!canEdit || dirty}
                    onChanged={async () => {
                      await open(current.id);
                      await refresh();
                    }}
                  />
                  <Risks
                    api={api}
                    proposal={current}
                    user={user}
                    users={users}
                    disabled={dirty}
                    onChanged={async () => {
                      await open(current.id);
                      await refresh();
                    }}
                  />
                  <MatchingEditor
                    api={api}
                    proposal={current}
                    body={draft}
                    products={products}
                    disabled={!canEdit}
                    dirty={dirty}
                    onChange={(body) => {
                      setDraft(body);
                      setDirty(true);
                    }}
                  />
                  {draft.sections.map((s: any, i: number) => (
                    <section key={i} id={"section-" + i}>
                      <h2>
                        <span className="number">{i + 1}</span>
                        {s.title}{" "}
                        {s.enabled === false
                          ? "（停用）"
                          : s.required === false
                            ? "（可选）"
                            : ""}
                      </h2>
                      <label>
                        章节正文
                        <textarea
                          rows={8}
                          disabled={!canEdit || s.enabled === false}
                          value={s.content}
                          onChange={(e) => {
                            const next = structuredClone(draft);
                            next.sections[i].content = e.target.value;
                            setDraft(next);
                            setDirty(true);
                          }}
                        />
                      </label>
                      <label>
                        引用依据与适用条件
                        <textarea
                          rows={3}
                          disabled={!canEdit || s.enabled === false}
                          placeholder="补充工况、测试条件及适用限制；下方绑定真实文档原文。"
                          value={s.evidence}
                          onChange={(e) => {
                            const next = structuredClone(draft);
                            next.sections[i].evidence = e.target.value;
                            setDraft(next);
                            setDirty(true);
                          }}
                        />
                      </label>
                      <CitationPicker
                        api={api}
                        proposalId={current.id}
                        disabled={!canEdit || s.enabled === false}
                        value={s.citations || []}
                        onChange={(value) => {
                          const next = structuredClone(draft);
                          next.sections[i].citations = value;
                          setDraft(next);
                          setDirty(true);
                        }}
                      />
                    </section>
                  ))}
                </div>
                <div className="review-panel">
                  <Artifacts
                    api={api}
                    proposal={current}
                    allowed={
                      (current.owner_id === user.id && has("engineer")) ||
                      has("leader")
                    }
                  />
                  <AiPanel
                    api={api}
                    proposal={current}
                    canEdit={canEdit}
                    dirty={dirty}
                    onApplied={async () => {
                      await open(current.id);
                      await refresh();
                      setNotice("候选已采用为新修订，请核对后送审");
                    }}
                  />
                  <section>
                    <h3 id="review-controls" tabIndex={-1}>送审与版本</h3>
                    <button
                      disabled={busy || dirty}
                      onClick={() =>
                        void run(async () =>
                          setPrecheck(
                            await api(`/proposals/${current.id}/precheck`),
                          ),
                        )
                      }
                    >
                      检查已保存版本
                    </button>
                    {dirty && (
                      <p className="hint">请先保存，再检查引用及送审。</p>
                    )}
                    {precheck && (
                      <div
                        className={precheck.issues.length ? "error" : "notice"}
                      >
                        {precheck.issues.length ? (
                          <details>
                            <summary>
                              预检待处理 {precheck.issues.length} 项
                            </summary>
                            <ul>
                              {precheck.issues.map((issue: string) => (
                                <li key={issue}>{issue}</li>
                              ))}
                            </ul>
                          </details>
                        ) : (
                          "结构及原文引用检查通过，仍需专业审核。"
                        )}
                      </div>
                    )}
                    <p className="hint">
                      技术、合规及适用专业节点通过后，由财务复核，再进入领导终审。请先在工作空间维护商务底稿和财务分工。正文修改需重新送审。
                    </p>
                    {canEdit && (
                      <form
                        onSubmit={(e) =>
                          submitForm(e, async (b) => {
                            if (dirty) throw new Error("请先保存正文再送审");
                            await mutate("submit", {
                              expectedRevision: current.revision,
                              note: b.note,
                              assignments: {
                                chemist: b.chemist,
                                compliance: b.compliance,
                                leader: b.leader,
                              },
                            });
                          })
                        }
                      >
                        {(["chemist", "compliance", "leader"] as Role[]).map(
                          (role) => (
                            <label key={role}>
                              {roleLabels[role]}
                              <select
                                key={
                                  role +
                                  String(precheck?.assignment?.revision || 0)
                                }
                                name={role}
                                required
                                defaultValue={
                                  precheck?.assignment?.[role + "_id"] || ""
                                }
                              >
                                <option value="">请选择</option>
                                {users
                                  .filter(
                                    (u) =>
                                      u.active &&
                                      u.roles.includes(role) &&
                                      u.id !== current.owner_id &&
                                      u.id !== current.created_by,
                                  )
                                  .map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          ),
                        )}
                        <label>
                          提交说明
                          <textarea
                            name="note"
                            required
                            minLength={10}
                            maxLength={2000}
                          />
                        </label>
                        <button className="primary" disabled={busy || dirty}>
                          提交审核
                        </button>
                      </form>
                    )}
                    {current.requests.map((r: any) => (
                      <div className="request" key={r.id}>
                        <strong>
                          V{r.edition}.{r.revision} ·{" "}
                          {
                            (
                              {
                                pending: "审核中",
                                approved: "已批准",
                                withdrawn: "已撤回",
                                changes_requested: "退回修改",
                                rejected: "已驳回",
                              } as any
                            )[r.status]
                          }
                        </strong>
                        <p>{r.note}</p>
                        {r.steps.map((s: any) => (
                          <div key={s.id} className="step">
                            <b>{roleLabels[s.role as Role]}</b>
                            <span>
                              {s.assignee_name} ·{" "}
                              {
                                (
                                  {
                                    waiting: "等待前序",
                                    pending: "待审核",
                                    approved: "通过",
                                    changes_requested: "退回修改",
                                    rejected: "驳回",
                                    closed: "已关闭",
                                  } as any
                                )[s.status]
                              }
                            </span>
                            {s.comment && <p>{s.comment}</p>}
                            {s.status === "pending" &&
                              s.assignee_id === user.id && (
                                <form
                                  onSubmit={(e) =>
                                    submitForm(e, async (b) => {
                                      await mutate("decide", {
                                        stepId: s.id,
                                        ...b,
                                      });
                                    })
                                  }
                                >
                                  <textarea
                                    name="comment"
                                    placeholder="审核意见；退回、驳回必填"
                                    maxLength={4000}
                                  />
                                  <select name="decision">
                                    <option value="approved">通过</option>
                                    <option value="changes_requested">
                                      退回修改
                                    </option>
                                    <option value="rejected">驳回</option>
                                  </select>
                                  <button disabled={busy}>确认审核</button>
                                </form>
                              )}
                          </div>
                        ))}
                      </div>
                    ))}
                    <details>
                      <summary>修订历史（{current.versions.length}）</summary>
                      {current.versions.map((v: any) => (
                        <button
                          key={v.id}
                          onClick={() =>
                            void run(async () => {
                              const h = await api(
                                `/proposals/${current.id}/history/${v.id}`,
                              );
                              setReader({ snapshot: h.snapshot, historical: true });
                            })
                          }
                        >
                          查看 V{v.edition}.{v.revision}
                        </button>
                      ))}
                    </details>
                  </section>
                </div>
              </div>
            </>
          )}
          {page === "knowledge" && <Knowledge api={api} user={user} />}
          {page === "assignments" && has("admin") && (
            <Assignments api={api} users={users} />
          )}
          {page === "customers" && (
            <>
              <div className="heading">
                <div>
                  <small>CUSTOMERS</small>
                  <h1>客户管理</h1>
                  <p>维护本人客户档案，为需求和应用方案建立业务背景。</p>
                </div>
              </div>
              {has("engineer") && (
                <section>
                  <h2>新增客户</h2>
                  <form
                    className="inline-form"
                    onSubmit={(e) =>
                      submitForm(e, async (b) => {
                        await api("/customers", "POST", b);
                        await refresh();
                      })
                    }
                  >
                    <label>
                      客户名称
                      <input name="name" required maxLength={160} />
                    </label>
                    <label>
                      行业
                      <input name="industry" maxLength={100} />
                    </label>
                    <label>
                      联系人
                      <input name="contact" maxLength={160} />
                    </label>
                    <button disabled={busy} className="primary">
                      保存客户
                    </button>
                  </form>
                </section>
              )}
              <section>
                <table>
                  <thead>
                    <tr>
                      <th>客户</th>
                      <th>行业</th>
                      <th>联系人</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.industry || "—"}</td>
                        <td>{c.contact || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!customers.length && <div className="empty">暂无客户档案</div>}
              </section>
            </>
          )}
          {page === "products" && (
            <>
              <div className="heading">
                <div>
                  <small>PRODUCTS</small>
                  <h1>产品档案</h1>
                  <p>
                    统一维护型号、CAS号及技术说明；具体适用性由专业人员审核。
                  </p>
                </div>
              </div>
              {has("admin") && (
                <section>
                  <h2>新增产品</h2>
                  <form
                    className="inline-form"
                    onSubmit={(e) =>
                      submitForm(e, async (b) => {
                        await api("/products", "POST", b);
                        await refresh();
                      })
                    }
                  >
                    <label>
                      产品型号
                      <input name="code" required maxLength={80} />
                    </label>
                    <label>
                      名称
                      <input name="name" required maxLength={160} />
                    </label>
                    <label>
                      CAS号
                      <input name="cas" maxLength={80} />
                    </label>
                    <label>
                      技术说明
                      <textarea name="description" maxLength={20000} />
                    </label>
                    <button disabled={busy} className="primary">
                      保存产品
                    </button>
                  </form>
                </section>
              )}
              <ProductSpecs api={api} user={user} products={products} />
              <div className="product-grid">
                {products.map((p) => (
                  <section key={p.id}>
                    <small>{p.code}</small>
                    <h2>{p.name}</h2>
                    <span className="badge">CAS {p.cas || "未填写"}</span>
                    <p className="pre-wrap">
                      {p.description || "尚未提供技术说明"}
                    </p>
                  </section>
                ))}
              </div>
              {!products.length && (
                <section className="empty">
                  暂无产品，请管理员建立档案。
                </section>
              )}
            </>
          )}
          {page === "users" && has("admin") && (
            <>
              <div className="heading">
                <div>
                  <small>ADMINISTRATION</small>
                  <h1>用户与角色</h1>
                  <p>
                    五类固定角色，可兼任；每轮审核仍执行独立人员与禁止自审规则。
                  </p>
                </div>
              </div>
              <section>
                <h2>创建账号</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget),
                      v = Object.fromEntries(data),
                      form = e.currentTarget;
                    void run(async () => {
                      await api("/users", "POST", {
                        ...v,
                        roles: data.getAll("roles"),
                      });
                      form.reset();
                      await refresh();
                      setNotice("账号已创建");
                    });
                  }}
                >
                  <div className="inline-form">
                    <label>
                      姓名
                      <input name="name" required maxLength={80} />
                    </label>
                    <label>
                      邮箱
                      <input name="email" type="email" required />
                    </label>
                    <label>
                      初始密码
                      <input
                        name="password"
                        type="password"
                        minLength={12}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                  <div className="checks">
                    {Object.entries(roleLabels).map(([r, l]) => (
                      <label key={r}>
                        <input type="checkbox" name="roles" value={r} />
                        {l}
                      </label>
                    ))}
                  </div>
                  <button className="primary" disabled={busy}>
                    创建账号
                  </button>
                </form>
              </section>
              <section>
                <table>
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>邮箱</th>
                      <th>角色</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.name}</td>
                        <td>{u.email}</td>
                        <td>
                          {u.roles.map((r: Role) => roleLabels[r]).join(" / ")}
                        </td>
                        <td>
                          <details>
                            <summary>
                              {u.active ? "启用" : "停用"} · 管理
                            </summary>
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                const d = new FormData(e.currentTarget);
                                void run(async () => {
                                  await api("/users/" + u.id, "PUT", {
                                    roles: d.getAll("roles"),
                                    active: d.get("active") === "on",
                                  });
                                  await refresh();
                                  setNotice("用户权限已更新");
                                });
                              }}
                            >
                              {Object.entries(roleLabels).map(([r, l]) => (
                                <label key={r}>
                                  <input
                                    style={{ width: "auto" }}
                                    type="checkbox"
                                    name="roles"
                                    value={r}
                                    defaultChecked={u.roles.includes(r)}
                                  />
                                  {l}
                                </label>
                              ))}
                              <label>
                                <input
                                  style={{ width: "auto" }}
                                  type="checkbox"
                                  name="active"
                                  defaultChecked={!!u.active}
                                />
                                启用账号
                              </label>
                              <button disabled={busy}>保存权限</button>
                            </form>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
          {page === "audit" && has("admin") && (
            <>
              <div className="heading">
                <div>
                  <small>AUDIT TRAIL</small>
                  <h1>审计日志</h1>
                  <p>最近200条业务操作，包含送审、审核、版本和正式导出。</p>
                </div>
              </div>
              <section>
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>操作人</th>
                      <th>操作</th>
                      <th>方案</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <td>
                          {new Date(a.created_at).toLocaleString("zh-CN", {
                            timeZone: "Asia/Shanghai",
                          })}
                        </td>
                        <td>{a.actor_name}</td>
                        <td>{a.action}</td>
                        <td>{a.proposal_id || "系统管理"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
          <footer>化学药剂售前方案平台 · 技术依据与审批记录贯穿每个版本</footer>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
