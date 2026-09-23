import { useEffect, useRef, useState } from "react";
import type { EngineeringNode, EngineeringView } from "@epm/domain";
import type { EngineeringApi, WorkPackagePreview, WorkPackageRequest } from "../../engineering-api.ts";
import { CompositionEditor } from "./CompositionEditor.tsx";
import { initialWorkPackageDraft, prepareWorkPackageRequest, workPackageCandidates, workPackagePreviewCurrent, type WorkPackageDraft, type WorkPackageOwner } from "./work-package-state.ts";
import "./work-package.css";

interface Props {
  open: boolean; api: EngineeringApi; root: EngineeringNode; view: EngineeringView;
  owners: WorkPackageOwner[]; ownersError: string; onOwners: () => Promise<void>; disabled?: boolean;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  onCommit: (preview: WorkPackagePreview, request: WorkPackageRequest) => Promise<boolean>;
}

export function WorkPackageDialog({ open, api, root, view, owners, ownersError, onOwners, disabled = false, onClose, onDirtyChange, onBusyChange, onCommit }: Props) {
  const [draft, setDraft] = useState<WorkPackageDraft>(() => initialWorkPackageDraft(root));
  const initial = useRef(JSON.stringify(draft));
  const [prepared, setPrepared] = useState<{ preview: WorkPackagePreview; workspace: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const workspace = api.workspaceId ?? "host";
  const context = JSON.stringify([workspace, root.id, view.document.revision, owners.map(owner => [owner.id, owner.available])]);
  const currentContext = useRef(context); currentContext.current = context;
  const previousContext = useRef(context);
  const availableOwners = owners.filter(owner => owner.available && owner.id.startsWith("codex:"));
  const candidates = workPackageCandidates(view, root.id);
  const selectedCount = Object.keys(draft.assignments).length;
  const locked = busy || disabled;
  let request: WorkPackageRequest | undefined, inputError = "";
  try { request = prepareWorkPackageRequest(view, root.id, draft, owners); }
  catch (cause) { inputError = cause instanceof Error ? cause.message : String(cause); }
  const previewValid = !!prepared && !!request && workPackagePreviewCurrent(prepared.preview, request, prepared.workspace, workspace);

  useEffect(() => { onDirtyChange(JSON.stringify(draft) !== initial.current); }, [draft, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { generation.current++; onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (previousContext.current === context) return;
    previousContext.current = context; generation.current++;
    setPrepared(undefined);
    if (!busyRef.current) setError("工程版本或负责人连接已变化，输入已保留，请重新预览。");
  }, [context]);
  useEffect(() => {
    if (!prepared) return;
    const timeout = setTimeout(() => { setPrepared(undefined); setError("预览已过期，输入已保留，请重新预览。"); }, Math.min(2_147_483_647, Math.max(0, Date.parse(prepared.preview.expires_at) - Date.now())));
    return () => clearTimeout(timeout);
  }, [prepared]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLElement>("button:not(:disabled), textarea, input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current && !disabledRef.current) closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') ?? []).filter(item => item.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, [open]);

  function change(next: WorkPackageDraft) {
    if (busyRef.current || disabled) return;
    generation.current++; setDraft(next); setPrepared(undefined); setError("");
  }
  async function prepare() {
    if (busyRef.current || disabled) return;
    let input: WorkPackageRequest;
    try { input = prepareWorkPackageRequest(view, root.id, draft, owners); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const ticket = ++generation.current, capturedContext = context;
    busyRef.current = true; setBusy(true); setError(""); setPrepared(undefined);
    try {
      const preview = await api.previewWorkPackage(input);
      if (ticket !== generation.current || currentContext.current !== capturedContext) return;
      if (!workPackagePreviewCurrent(preview, input, workspace, workspace)) throw new Error("返回的预览与本轮分工不一致，请重新预览。");
      setPrepared({ preview, workspace });
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function commit() {
    if (busyRef.current || disabled || !prepared || !request || !workPackagePreviewCurrent(prepared.preview, request, prepared.workspace, workspace)) return;
    busyRef.current = true; setBusy(true); setError("");
    const input = structuredClone(request), preview = prepared.preview;
    // Keep the reviewed package visible while Hello is open. Failed or uncertain commits
    // must obtain a fresh preview, never automatically replay approval.
    try {
      if (await onCommit(preview, input)) {
        initial.current = JSON.stringify(draft); onDirtyChange(false); onClose();
      } else { setPrepared(undefined); setError("本轮分工尚未确认。输入已保留；请刷新工程状态并重新预览，避免重复提交。"); }
    } catch (cause) { setPrepared(undefined); setError(`${cause instanceof Error ? cause.message : String(cause)}。输入已保留，请重新预览。`); }
    finally { busyRef.current = false; setBusy(false); }
  }

  function contract(node: EngineeringNode, source = node.source_scope) {
    return <details className="eng-work-package-contract"><summary>改动范围、交付与检查</summary>
      {source && <><p className="eng-preserve">源工程：{source.root}</p><strong>允许改动</strong><ul>{source.allow.map(path => <li key={path}>{path}</li>)}</ul>{source.deny.length > 0 && <><strong>禁止改动</strong><ul>{source.deny.map(path => <li key={path}>{path}</li>)}</ul></>}</>}
      <strong>交付结果</strong><ul>{node.delivery?.outputs.map(output => <li key={output.id}>{output.title}</li>)}</ul>
      <strong>完成依据</strong><ul>{node.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul>
      {source?.checks.map(check => <details key={check.id}><summary>{check.title}</summary><p className="eng-preserve">node {check.args.map(arg => JSON.stringify(arg)).join(" ")}</p><p>最长 {Math.ceil((check.timeout_ms ?? 30_000) / 1000)} 秒</p></details>)}
      <strong>执行约定</strong><ul>{(view.derived[node.id]?.effective.rules ?? []).map((rule, index) => <li key={index}>{rule.text}</li>)}</ul>
    </details>;
  }

  if (!open) return null;
  return <div className="eng-modal-backdrop"><section ref={dialog} className="eng-modal eng-work-package-modal" role="dialog" aria-modal="true" aria-label="确认本轮分工并开工" aria-busy={busy}>
    <header><span className="eng-eyebrow">{root.title}</span><h2>一次确认本轮分工</h2><p>把谁做哪项、整体怎样接起来放在一起核对。预览不需要 PIN，最终确认时验证一次。</p></header>
    {prepared && previewValid ? <>
      <div className="eng-work-package-summary" role="status">本轮 {prepared.preview.nodes.length} 项 · 确认后负责人可按约定领取执行</div>
      <section className="eng-work-package-composition"><h3>这些成果如何接起来</h3><p>{request!.composition.summary}</p><p>{request!.composition.scenario}</p><details><summary>整体完成条件</summary><ul>{request!.composition.integration_criterion_ids.map(id => <li key={id}>{root.criteria.find(item => item.id === id)?.text}</li>)}</ul></details></section>
      <div className="eng-work-package-cards">{prepared.preview.nodes.map(item => {
        const node = view.document.nodes.find(candidate => candidate.id === item.id)!;
        return <article key={item.id}><div className="eng-work-package-card-heading"><h3>{item.title}</h3><span>{owners.find(owner => owner.id === item.owner)?.label ?? item.owner}</span></div><p>{node.objective}</p>{contract(node, item.source_scope)}</article>;
      })}</div><p className="eng-work-package-reason">本轮目的：{request!.reason}</p>
      <details className="eng-work-package-contract"><summary>本轮关联范围（{prepared.preview.affected_ids.length} 项）</summary><p>本轮更新总项组合说明与所选任务分工，以下关联项会一起核对。</p><ul>{prepared.preview.affected_ids.map(id => <li key={id}>{view.document.nodes.find(node => node.id === id)?.title ?? id}</li>)}</ul></details>
    </> : <fieldset className="eng-work-package-fields" disabled={locked}>
      <CompositionEditor node={{ ...root, composition: draft.composition }} view={view} onChange={node => change({ ...draft, composition: node.composition! })} />
      <section className="eng-work-package-assignments"><div className="eng-section-heading"><h3>本轮谁做哪些项</h3><button type="button" onClick={() => { setPrepared(undefined); void onOwners(); }}>刷新负责人</button></div>
        <p>选择要开工的小项。同一负责人也可以承担多个区域。</p>
        {ownersError && <p className="eng-inline-error" role="alert">{ownersError}</p>}
        {!availableOwners.length && <p className="eng-notice">暂无近期已连接的负责人。先让对应 Codex 任务连接本工程，再刷新。</p>}
        <div className="eng-work-package-cards">{candidates.map(({ node, unavailable }) => {
          const selected = Object.hasOwn(draft.assignments, node.id), owner = draft.assignments[node.id] ?? "";
          return <article key={node.id} className={selected ? "is-selected" : ""}>
            <label className="eng-check-row"><input type="checkbox" checked={selected} disabled={!!unavailable || (!selected && selectedCount >= 20)} onChange={event => {
              const assignments = { ...draft.assignments };
              if (event.target.checked) assignments[node.id] = availableOwners.some(item => item.id === node.owner) ? node.owner : "";
              else delete assignments[node.id];
              change({ ...draft, assignments });
            }} /><span>{node.title}</span></label>
            <p>{unavailable || node.objective}</p>
            {selected && <label>负责人：{node.title}<select value={owner} onChange={event => change({ ...draft, assignments: { ...draft.assignments, [node.id]: event.target.value } })}>
              <option value="">请选择真实负责人</option>{owner && !availableOwners.some(item => item.id === owner) && <option value={owner} disabled>原负责人连接已过期，请重新选择</option>}
              {availableOwners.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>}{contract(node)}
          </article>;
        })}</div>
        {!candidates.length && <p className="eng-notice">请先在总项下建立实际要做的小项，再确认本轮分工。</p>}
      </section>
      <label>本轮分工目的<textarea rows={2} value={draft.reason} onChange={event => change({ ...draft, reason: event.target.value })} placeholder="例如：两项按共同接口并行，最后在原节点查收完整成果。" /></label>
    </fieldset>}
    <p className="eng-work-package-boundary">本次只保存整体组合、负责人和就绪状态。超出范围的调整或成果验收，另行确认。</p>
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
    <footer className="eng-modal-actions"><button type="button" disabled={locked} onClick={onClose}>关闭并保留输入</button>
      {!prepared && JSON.stringify(draft) !== initial.current && <button type="button" disabled={locked} onClick={() => { const restored = initialWorkPackageDraft(root); initial.current = JSON.stringify(restored); change(restored); }}>放弃本轮输入</button>}
      {prepared && previewValid ? <><button type="button" disabled={locked} onClick={() => { setPrepared(undefined); setError(""); }}>调整分工</button><button type="button" className="eng-primary" disabled={locked} onClick={() => void commit()}>{busy ? "正在确认本轮分工…" : "确认本轮分工并开工"}</button></> : <button type="button" className="eng-primary" disabled={locked || !!inputError} title={inputError || undefined} onClick={() => void prepare()}>{busy ? "正在处理…" : `预览本轮 ${selectedCount} 项分工`}</button>}
    </footer>{!prepared && inputError && <p className="eng-work-package-help">{inputError}</p>}
  </section></div>;
}
