import React, { useEffect, useState } from "react";
import { CitationPicker, type Api } from "./Knowledge";
import {
  matchLabels,
  type Requirement,
  type Parameter,
} from "../shared/matching";
const number = (v: string) => (v === "" ? null : Number(v));
const empty = () => ({
  key: "",
  label: "",
  min: null,
  max: null,
  unit: "MPa",
  conditions: "",
  method: "",
  valueKind: "unknown",
  citation: null,
});
export function ProductSpecs({
  api,
  user,
  products,
}: {
  api: Api;
  user: any;
  products: any[];
}) {
  const [specs, setSpecs] = useState<any[]>([]),
    [product, setProduct] = useState(""),
    [attrs, setAttrs] = useState<any[]>([empty()]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => setSpecs(await api("/product-specs"));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(load);
  }, []);
  const update = (i: number, key: string, value: any) =>
    setAttrs(
      attrs.map((a, j) =>
        j !== i
          ? a
          : { ...a, [key]: value, ...(key === "label" ? { key: value } : {}) },
      ),
    );
  return (
    <section>
      <h2>产品参数版本</h2>
      <p className="hint">
        每个参数保留范围、单位、工况、方法、数值性质及TDS原文；管理员录入后由另一位应用化学师复核发布。相同参数名称用于对应客户需求。
      </p>
      {error && <div className="error">{error}</div>}
      {user.roles.includes("admin") && (
        <>
          <label>
            产品
            <select
              value={product}
              onChange={(e) => {
                setProduct(e.target.value);
                setAttrs([empty()]);
              }}
            >
              <option value="">请选择</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
          </label>
          {product && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  if (attrs.some((a) => !a.citation))
                    throw Error("请为每个参数绑定真实TDS或应用说明原文");
                  const expectedVersion = Math.max(
                    0,
                    ...specs
                      .filter((s) => s.product_id === product)
                      .map((s) => s.version),
                  );
                  await api("/products/" + product + "/specs", "POST", {
                    expectedVersion,
                    parameters: attrs,
                  });
                  setAttrs([empty()]);
                  await load();
                });
              }}
            >
              {attrs.map((a, i) => (
                <div className="parameter-card" key={i}>
                  <h3>参数 {i + 1}</h3>
                  <div className="parameter-grid">
                    <label>
                      参数名称
                      <input
                        required
                        maxLength={80}
                        value={a.label}
                        onChange={(e) => update(i, "label", e.target.value)}
                      />
                    </label>
                    <label>
                      单位
                      <input
                        required
                        maxLength={30}
                        value={a.unit}
                        onChange={(e) => update(i, "unit", e.target.value)}
                      />
                    </label>
                    <label>
                      已知下限
                      <input
                        type="number"
                        step="any"
                        value={a.min ?? ""}
                        onChange={(e) =>
                          update(i, "min", number(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      已知上限
                      <input
                        type="number"
                        step="any"
                        value={a.max ?? ""}
                        onChange={(e) =>
                          update(i, "max", number(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      工况
                      <input
                        maxLength={200}
                        value={a.conditions}
                        onChange={(e) =>
                          update(i, "conditions", e.target.value)
                        }
                        placeholder="基材、温度等"
                      />
                    </label>
                    <label>
                      测试方法
                      <input
                        maxLength={200}
                        value={a.method}
                        onChange={(e) => update(i, "method", e.target.value)}
                      />
                    </label>
                    <label>
                      数值性质
                      <select
                        value={a.valueKind}
                        onChange={(e) => update(i, "valueKind", e.target.value)}
                      >
                        <option value="unknown">待确认</option>
                        <option value="typical">典型值</option>
                        <option value="guaranteed">保证指标</option>
                      </select>
                    </label>
                  </div>
                  <CitationPicker
                    api={api}
                    disabled={false}
                    value={a.citation ? [a.citation] : []}
                    onChange={(c) => update(i, "citation", c.at(-1) || null)}
                  />
                  {attrs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}
                    >
                      移除此参数
                    </button>
                  )}
                </div>
              ))}
              <div className="actions">
                <button
                  type="button"
                  disabled={attrs.length >= 30}
                  onClick={() => setAttrs([...attrs, empty()])}
                >
                  添加参数
                </button>
                <button disabled={busy} className="primary">
                  提交参数版本待复核
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <button disabled={busy} onClick={() => void run(load)}>
        刷新参数版本
      </button>
      {specs.map((s) => (
        <div className="parameter-card" key={s.id}>
          <h3>
            {products.find((p) => p.id === s.product_id)?.code || "产品"} · V
            {s.version} ·{" "}
            {
              { draft: "待复核", published: "已发布", withdrawn: "已撤回" }[
                s.status as string
              ]
            }
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>参数</th>
                  <th>范围与单位</th>
                  <th>工况及方法</th>
                  <th>性质</th>
                </tr>
              </thead>
              <tbody>
                {s.parameters.map((a: Parameter) => (
                  <tr key={a.key}>
                    <td>{a.label}</td>
                    <td>
                      {a.min ?? "未知"} ~ {a.max ?? "未知"} {a.unit}
                    </td>
                    <td>
                      {a.conditions || "未知"}
                      <small>{a.method || "未知"}</small>
                    </td>
                    <td>
                      {
                        {
                          guaranteed: "保证指标",
                          typical: "典型值",
                          unknown: "待确认",
                        }[a.valueKind]
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(user.roles.includes("chemist") || user.roles.includes("admin")) &&
            s.status !== "withdrawn" && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void run(async () => {
                    await api("/product-specs/" + s.id + "/review", "POST", {
                      decision: d.get("decision"),
                      note: d.get("note"),
                    });
                    await load();
                  });
                }}
              >
                <label>
                  复核或撤回意见
                  <input name="note" required minLength={4} maxLength={2000} />
                </label>
                <label>
                  处理
                  <select name="decision">
                    {s.status === "draft" && user.roles.includes("chemist") && (
                      <option value="publish">复核发布</option>
                    )}
                    <option value="withdraw">撤回此版本</option>
                  </select>
                </label>
                <button disabled={busy}>确认</button>
              </form>
            )}
        </div>
      ))}
    </section>
  );
}
export function MatchingEditor({
  api,
  proposal,
  body,
  products,
  disabled,
  dirty,
  onChange,
}: {
  api: Api;
  proposal: any;
  body: any;
  products: any[];
  disabled: boolean;
  dirty: boolean;
  onChange: (body: any) => void;
}) {
  const [specs, setSpecs] = useState<any[]>([]),
    [report, setReport] = useState<any>(null),
    [error, setError] = useState("");
  const load = async () => {
    try {
      setError("");
      setSpecs(await api("/product-specs"));
      setReport(await api(`/proposals/${proposal.id}/matching`));
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void load();
  }, [proposal.id, proposal.revision]);
  const reqs: Requirement[] = body.matchingRequirements || [];
  const update = (i: number, key: string, value: any) =>
    onChange({
      ...body,
      matchingRequirements: reqs.map((r, j) =>
        i !== j
          ? r
          : { ...r, [key]: value, ...(key === "label" ? { key: value } : {}) },
      ),
    });
  return (
    <section>
      <h2 id="matching-editor" tabIndex={-1}>结构化需求与参数匹配</h2>
      <p className="hint">
        未知值留空；客户工况和测试方法须独立确认。只有同工况、同方法的保证指标可以判为满足。
      </p>
      {error && <div className="error">{error}</div>}
      {body.productIds.map((id: string) => (
        <label key={id}>
          {products.find((p) => p.id === id)?.name || "关联产品"} 的参数版本
          <select
            disabled={disabled}
            value={body.productSpecs?.[id] || ""}
            onChange={(e) =>
              onChange({
                ...body,
                productSpecs: { ...body.productSpecs, [id]: e.target.value },
              })
            }
          >
            <option value="">请选择已复核的参数版本</option>
            {specs
              .filter((s) => s.product_id === id && s.status === "published")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  V{s.version} ·{" "}
                  {new Date(s.created_at).toLocaleDateString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                </option>
              ))}
          </select>
        </label>
      ))}
      {reqs.map((r, i) => (
        <div className="parameter-card" key={r.id}>
          <div className="parameter-grid">
            <label>
              需求参数名称
              <input
                disabled={disabled}
                required
                maxLength={80}
                value={r.label}
                onChange={(e) => update(i, "label", e.target.value)}
                placeholder="与产品参数名称一致"
              />
            </label>
            <label>
              判断条件
              <select
                disabled={disabled}
                value={r.operator}
                onChange={(e) => update(i, "operator", e.target.value)}
              >
                <option value="gte">不低于</option>
                <option value="lte">不高于</option>
                <option value="between">区间内</option>
              </select>
            </label>
            {r.operator !== "lte" && (
              <label>
                客户下限
                <input
                  disabled={disabled}
                  type="number"
                  step="any"
                  value={r.min ?? ""}
                  onChange={(e) => update(i, "min", number(e.target.value))}
                />
              </label>
            )}
            {r.operator !== "gte" && (
              <label>
                客户上限
                <input
                  disabled={disabled}
                  type="number"
                  step="any"
                  value={r.max ?? ""}
                  onChange={(e) => update(i, "max", number(e.target.value))}
                />
              </label>
            )}
            <label>
              单位
              <input
                disabled={disabled}
                maxLength={30}
                value={r.unit}
                onChange={(e) => update(i, "unit", e.target.value)}
              />
            </label>
            <label>
              客户工况
              <input
                disabled={disabled}
                maxLength={200}
                value={r.conditions}
                onChange={(e) => update(i, "conditions", e.target.value)}
              />
            </label>
            <label>
              测试方法
              <input
                disabled={disabled}
                maxLength={200}
                value={r.method}
                onChange={(e) => update(i, "method", e.target.value)}
              />
            </label>
          </div>
          <label>
            <input
              style={{ width: "auto" }}
              disabled={disabled}
              type="checkbox"
              checked={r.critical}
              onChange={(e) => update(i, "critical", e.target.checked)}
            />{" "}
            关键需求，未满足时阻断送审
          </label>
          {!disabled && (
            <button
              onClick={() =>
                onChange({
                  ...body,
                  matchingRequirements: reqs.filter((_, j) => j !== i),
                })
              }
            >
              移除此需求
            </button>
          )}
        </div>
      ))}
      {!disabled && reqs.length < 30 && (
        <button
          onClick={() =>
            onChange({
              ...body,
              matchingRequirements: [
                ...reqs,
                {
                  id: crypto.randomUUID(),
                  key: "",
                  label: "",
                  operator: "gte",
                  min: null,
                  max: null,
                  unit: "MPa",
                  conditions: "",
                  method: "",
                  critical: true,
                },
              ],
            })
          }
        >
          添加结构化需求
        </button>
      )}
      <button disabled={dirty} onClick={() => void load()}>
        核对已保存版本
      </button>
      {dirty ? (
        <p className="hint">先保存，再查看最新匹配结果。</p>
      ) : (
        report && (
          <>
            <div className="match-summary" aria-label="产品匹配摘要">
              {(["match", "mismatch", "validation", "unknown"] as const).map(status => <div key={status} className={`match-count ${status}`}><b>{report.products.flatMap((p: any) => p.results).filter((r: any) => r.status === status).length}</b><span>{matchLabels[status]}</span></div>)}
            </div>
            <p className="hint">按产品与需求逐项计数；关键项不满足、待验证或无法判定会阻断送审。预检问题 {report.issues.length} 项。</p>
            {report.issues.length > 0 && (
              <div className="error">
                <ul>
                  {report.issues.map((s: string) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {report.products.map((p: any) => (
              <div key={p.productId}>
                <h3>
                  {p.code} · {p.name}
                </h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>需求</th>
                        <th>客户阈值</th>
                        <th>产品参数</th>
                        <th>判断</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.results.map((r: any, i: number) => (
                        <tr key={i}>
                          <td>{r.label}</td>
                          <td>{r.requirement}</td>
                          <td>{r.actual}</td>
                          <td>
                            <span className={`match-badge ${r.status}`}>{matchLabels[r.status]}</span>
                            <small>{r.reason}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )
      )}
    </section>
  );
}
export function Artifacts({
  api,
  proposal,
  allowed,
}: {
  api: Api;
  proposal: any;
  allowed: boolean;
}) {
  const [data, setData] = useState<any>({ approvals: [], files: [] }),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const d = await api(`/proposals/${proposal.id}/artifacts`);
    setData(d);
    setSelected((s) => s || d.approvals[0]?.id || "");
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [proposal.id, proposal.revision, proposal.status]);
  if (!data.approvals.length) return null;
  const files = data.files.filter((f: any) => f.request_id === selected && f.format === "docx");
  return (
    <section id="artifacts">
      <h3>批准版成果</h3>
      {error && <p className="error">{error}</p>}
      <label>
        批准版本
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {data.approvals.map((r: any) => (
            <option value={r.id} key={r.id}>
              V{r.edition}.{r.revision}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        Word从批准快照生成并留存。后续下载取回原文件；依据失效时停止下载。
      </p>
      {allowed && (
        <button
          disabled={busy}
          onClick={async () => {
            setError("");
            setBusy(true);
            try {
              await api(`/proposals/${proposal.id}/artifacts`, "POST", {
                requestId: selected,
              });
              await load();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "正在生成…"
            : files.length > 0
              ? "核对并查看成果"
              : "生成批准版Word"}
        </button>
      )}
      {allowed &&
        files.map((f: any) => (
          <div key={f.id}>
            <a
              className="button"
              href={`/api/proposals/${proposal.id}/export.${f.format}?requestId=${selected}`}
              onClick={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const r = await fetch(
                    `/api/proposals/${proposal.id}/export.${f.format}?requestId=${selected}`,
                  );
                  if (!r.ok) {
                    const d = await r.json();
                    throw new Error(d.error || "下载失败");
                  }
                  const url = URL.createObjectURL(await r.blob());
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${proposal.code}-V${data.approvals.find((r: any) => r.id === selected)?.edition}.${f.format}`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              下载 {f.format.toUpperCase()}
            </a>
            <small className="file-hash">SHA256 {f.sha256}</small>
          </div>
        ))}
    </section>
  );
}
