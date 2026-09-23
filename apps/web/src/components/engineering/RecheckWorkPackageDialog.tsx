import { useEffect, useRef, useState } from "react";
import type { EngineeringView } from "@epm/domain";
import type { EngineeringApi, RecheckWorkPackagePreview, RecheckWorkPackageRequest } from "../../engineering-api.ts";
import { initialRecheckWorkPackageDraft, prepareRecheckWorkPackageRequest, recheckConfigIndex, recheckWorkPackageCandidates,
  recheckWorkPackageContext, recheckWorkPackagePreviewCurrent, type RecheckWorkPackageDraft } from "./recheck-work-package-state.ts";
import "./work-package.css";

interface Props {
  view: EngineeringView; api: EngineeringApi; disabled?: boolean;
  onClose: () => void; onUpdated: (view: EngineeringView) => void;
}

export function RecheckWorkPackageDialog({ view, api, disabled = false, onClose, onUpdated }: Props) {
  const [draft, setDraft] = useState(() => initialRecheckWorkPackageDraft(view));
  const [prepared, setPrepared] = useState<{ preview: RecheckWorkPackagePreview; workspace: string }>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const busyRef = useRef(false), generation = useRef(0), mounted = useRef(true), dialog = useRef<HTMLElement>(null);
  const latest = useRef({ disabled, onClose, onUpdated }); latest.current = { disabled, onClose, onUpdated };
  const workspace = api.workspaceId ?? "host", context = recheckWorkPackageContext(view, workspace);
  const currentContext = useRef(context); currentContext.current = context;
  const previousContext = useRef(context), previousWorkspace = useRef(workspace);
  const candidates = recheckWorkPackageCandidates(view), locked = busy || disabled;
  let request: RecheckWorkPackageRequest | undefined, inputError = "";
  try { request = prepareRecheckWorkPackageRequest(view, draft); }
  catch (cause) { inputError = cause instanceof Error ? cause.message : String(cause); }
  const previewValid = !!prepared && !!request && recheckWorkPackagePreviewCurrent(prepared.preview, request, view, prepared.workspace, workspace);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (previousContext.current === context) return;
    previousContext.current = context; generation.current++; setPrepared(undefined);
    // Never carry another workspace's correction into the new project.
    if (previousWorkspace.current !== workspace) { setDraft(initialRecheckWorkPackageDraft(view)); previousWorkspace.current = workspace; }
    setError("工程或运行状态已变化，请核对输入并重新预览。");
  }, [context, workspace, view]);
  useEffect(() => {
    if (!disabled) return;
    generation.current++; setPrepared(undefined);
  }, [disabled]);
  useEffect(() => {
    if (!prepared) return;
    const timeout = setTimeout(() => { generation.current++; setPrepared(undefined); setError("预览已过期，输入已保留，请重新预览。"); },
      Math.min(2_147_483_647, Math.max(0, Date.parse(prepared.preview.expires_at) - Date.now())));
    return () => clearTimeout(timeout);
  }, [prepared]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current && !latest.current.disabled) latest.current.onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary") ?? []).filter(item => item.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (!first) event.preventDefault();
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, []);

  function change(next: RecheckWorkPackageDraft) {
    if (busyRef.current || disabled) return;
    generation.current++; setDraft(next); setPrepared(undefined); setError("");
  }
  async function prepare() {
    if (busyRef.current || disabled) return;
    let input: RecheckWorkPackageRequest;
    try { input = prepareRecheckWorkPackageRequest(view, draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const ticket = ++generation.current, captured = context;
    busyRef.current = true; setBusy(true); setPrepared(undefined); setError("");
    try {
      const preview = await api.previewRecheckWorkPackage(input);
      if (!mounted.current || ticket !== generation.current || currentContext.current !== captured || latest.current.disabled) return;
      if (!recheckWorkPackagePreviewCurrent(preview, input, view, workspace, workspace)) throw new Error("返回的预览与本轮修正不一致，请重新预览。");
      setPrepared({ preview, workspace });
    } catch (cause) { if (mounted.current && ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function commit() {
    if (busyRef.current || disabled || !prepared || !request || !recheckWorkPackagePreviewCurrent(prepared.preview, request, view, prepared.workspace, workspace)) return;
    const ticket = ++generation.current, captured = context, input = structuredClone(request), token = prepared.preview.token;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const updated = await api.commitRecheckWorkPackage(token, input);
      if (!mounted.current || ticket !== generation.current || currentContext.current !== captured || latest.current.disabled) return;
      if (updated.document.id !== view.document.id || updated.document.revision <= input.expected_revision ||
        !input.items.every(item => updated.document.runs.some(run => run.id === item.prior_run_id && run.node_id === item.node_id))) throw new Error("返回的工程状态不匹配，请核对工程状态。");
      setPrepared(undefined);
      latest.current.onUpdated(updated); latest.current.onClose();
    } catch (cause) {
      if (mounted.current && ticket === generation.current) {
        setPrepared(undefined); setError(`${cause instanceof Error ? cause.message : String(cause)}。输入已保留，请核对工程状态并重新预览。`);
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="eng-modal-backdrop"><section ref={dialog} className="eng-modal eng-work-package-modal" role="dialog" aria-modal="true" aria-label="修正检查配置并复验" aria-busy={busy}>
    <header><h2>修正检查配置并复验</h2><p>重新检查现有代码，历史执行记录保留。</p></header>
    {prepared && previewValid ? <>
      <div className="eng-work-package-summary" role="status">本轮 {prepared.preview.nodes.length} 项 · 配置路径修正</div>
      <div className="eng-work-package-cards">{prepared.preview.nodes.map(node => <article key={node.id}>
        <h3>{node.title}</h3><details className="eng-work-package-contract"><summary>原负责人、目录与运行</summary><p className="eng-preserve">负责人：{node.owner}</p><p className="eng-preserve">执行目录：{view.document.nodes.find(item => item.id === node.id)?.source_scope?.root}</p><p className="eng-preserve">原运行：{node.prior_run_id}</p></details>
        {node.checks.filter(check => JSON.stringify(check.before_args) !== JSON.stringify(check.args)).map(check => {
          const index = recheckConfigIndex(check.args);
          return <section key={check.id}><h3>{check.title}</h3><p>原路径：<code>{check.before_args[index]}</code></p><p>→ 新路径：<strong className="eng-preserve">{check.args[index]}</strong></p>
            {check.configuration && <p className="eng-preserve">实际配置：{check.configuration.path}</p>}
            {check.configuration && <details className="eng-work-package-contract"><summary>配置文件核对记录</summary><p className="eng-preserve">测试目录：{check.configuration.test_root}</p><p className="eng-preserve">SHA256：{check.configuration.sha256}</p></details>}
            <details className="eng-work-package-contract"><summary>查看完整检查命令（其他参数未变）</summary><p className="eng-preserve">node {check.args.map(arg => JSON.stringify(arg)).join(" ")}</p></details></section>;
        })}
      </article>)}</div><p className="eng-work-package-reason">修正原因：{request!.reason}</p>
      <details className="eng-work-package-contract"><summary>涉及 {prepared.preview.affected_ids.length} 项 · 预览有效至 {new Date(prepared.preview.expires_at).toLocaleTimeString()}</summary><ul>{prepared.preview.affected_ids.map(id => <li key={id}>{view.document.nodes.find(node => node.id === id)?.title ?? id}</li>)}</ul></details>
    </> : <fieldset className="eng-work-package-fields" disabled={locked}>
      <div className="eng-work-package-cards">{candidates.map(({ node, run, unavailable }) => {
        const selected = draft.selected.includes(node.id);
        return <article key={node.id} className={selected ? "is-selected" : ""}>
          <label className="eng-check-row"><input type="checkbox" checked={selected} disabled={!!unavailable || (!selected && draft.selected.length >= 20)} onChange={event => change({ ...draft,
            selected: event.target.checked ? [...draft.selected, node.id] : draft.selected.filter(id => id !== node.id) })} /><span>{node.title}</span></label>
          <p>{unavailable || "只修改检查配置路径"}</p><details className="eng-work-package-contract"><summary>对应历史运行</summary><p className="eng-preserve">{run.id}</p></details>
          {selected && node.source_scope?.checks.map(check => {
            const index = recheckConfigIndex(check.args);
            return <section key={check.id}>{index >= 0 ? <label>{check.title} · 配置路径<input aria-label={`${node.title} · ${check.title} · 配置路径`} value={draft.configPaths[node.id]?.[check.id] ?? check.args[index]}
              onChange={event => change({ ...draft, configPaths: { ...draft.configPaths, [node.id]: { ...draft.configPaths[node.id], [check.id]: event.target.value } } })} /></label> : <p>{check.title} · 本项参数不变</p>}
              <details className="eng-work-package-contract"><summary>原检查命令（只读）</summary><p className="eng-preserve">node {check.args.map(arg => JSON.stringify(arg)).join(" ")}</p></details></section>;
          })}
        </article>;
      })}</div>
      {!candidates.length && <p className="eng-notice">当前没有可复验的暂停或受阻任务。</p>}
      <label>修正原因<textarea rows={2} value={draft.reason} onChange={event => change({ ...draft, reason: event.target.value })} placeholder="简短说明配置路径为什么需要修正" /></label>
    </fieldset>}
    <p className="eng-work-package-boundary">确认后保存配置修正，交回原负责人复验。此次不自动运行代码，也不代表成果验收。</p>
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
    <footer className="eng-modal-actions"><button type="button" disabled={locked} onClick={onClose}>关闭</button>
      {prepared && previewValid ? <><button type="button" disabled={locked} onClick={() => { generation.current++; setPrepared(undefined); setError(""); }}>调整路径</button>
        <button type="button" className="eng-primary" disabled={locked} onClick={() => void commit()}>{busy ? "正在确认…" : "确认修正并准备复验"}</button></> :
        <button type="button" className="eng-primary" disabled={locked || !!inputError} title={inputError || undefined} onClick={() => void prepare()}>{busy ? "正在预览…" : `预览 ${draft.selected.length} 项修正`}</button>}
    </footer>{!prepared && inputError && <p className="eng-work-package-help">{inputError}</p>}
  </section></div>;
}
