import { useEffect, useRef, useState } from "react";
import type { EngineeringNode } from "@epm/domain";
import type { EngineeringApi, PlanImportPreview } from "../../engineering-api.ts";
import { actionNames, criterionNames, kindNames } from "./shared.ts";

interface Props {
  open: boolean; api: EngineeringApi; parent: EngineeringNode; revision: number;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  onCommit: (preview: PlanImportPreview, reason: string) => Promise<boolean>;
}
export function PlanImportDialog({ open, api, parent, revision, onClose, onDirtyChange, onBusyChange, onCommit }: Props) {
  const [raw, setRaw] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PlanImportPreview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const generation = useRef(0);
  useEffect(() => { onDirtyChange(!!raw.trim() || !!reason.trim()); }, [raw, reason, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { generation.current++; onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') ?? []).filter((item) => item.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [open, busy, onClose]);
  function edit(value: string) { generation.current++; setRaw(value); setPreview(undefined); setError(""); setDiscard(false); }
  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 1_000_000) { setError("计划文件超过 1 MB，请按阶段拆分后导入。"); return; }
    const token = ++generation.current; setBusy(true); setError("");
    try { const text = await file.text(); if (token === generation.current) edit(text); }
    catch { if (token === generation.current) setError("文件暂时无法读取，请重选或粘贴 JSON。"); }
    finally { setBusy(false); }
  }
  async function prepare() {
    const token = ++generation.current; setBusy(true); setError(""); setPreview(undefined);
    try { let plan: unknown; try { plan = JSON.parse(raw); } catch { throw new Error("JSON 格式无效，请检查引号、逗号和括号。原文已保留。"); } const next = await api.previewImport(parent.id, revision, plan); if (token === generation.current) setPreview(next); }
    catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!preview || !reason.trim()) return;
    setBusy(true); setError("");
    try { if (await onCommit(preview, reason.trim())) { edit(""); setReason(""); onDirtyChange(false); onClose(); } else { setError("导入未完成，输入和预览已保留。请核对当前工程版本；发生版本冲突时重新预览。"); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const titles = new Map(preview?.nodes.map((node) => [node.id, node.title]) ?? []);
  const depth = (node: EngineeringNode) => { let level = 0, current = node; const seen = new Set<string>(); while (current.parent_id !== parent.id && !seen.has(current.id)) { seen.add(current.id); const next = preview?.nodes.find((item) => item.id === current.parent_id); if (!next) break; level++; current = next; } return level; };
  const example = { schema_version: 1, source: { title: "本轮详细实施计划", reference: "计划来源说明或文档路径" }, nodes: [{ key: "phase", parent_key: null, kind: "task", title: "完成本轮改动并留下验证证据", objective: "写明具体结果和使用场景", method: "先核对输入，分步执行，再按条件核对结果", architecture: "说明本任务与上下游的输入输出", constraints: { allow: [], deny: [], rules: ["保存来源和实际变更依据"], resources: [] }, criteria: [{ id: "phase-result", text: "明确说明如何判断本轮结果符合目标", kind: "manual", path: "", expected: "" }], actions: [], capabilities: [], contributes_to: parent.criteria[0] ? [parent.criteria[0].id] : [] }, { key: "step", parent_key: "phase", depends_on: [], kind: "step", title: "核对输入并整理依据", objective: "交付可核对的依据", method: "逐项核对来源，再提交真实结果", constraints: {}, criteria: [{ id: "step-result", text: "结果可追溯到实际来源", kind: "manual", path: "", expected: "" }], actions: [{ id: "step-output", title: "提交核对结果与来源", type: "agent_artifact", path: "artifacts/result.md", content: "", criterion_id: "step-result", capability_id: "" }], contributes_to: ["phase-result"] }] };
  if (!open) return null;
  return <div className="eng-modal-backdrop"><section ref={dialog} className="eng-modal eng-import-modal" role="dialog" aria-modal="true" aria-label="导入详细计划">
    <h2>导入详细计划</h2><p>新增到「{parent.title}」下面。先核对树结构、做法、边界和验收条件；确认后只新增草稿，负责人另行分配。</p>
    {!preview ? <>
      <label>粘贴详细计划 JSON<textarea rows={12} value={raw} disabled={busy} onChange={(event) => edit(event.target.value)} placeholder="粘贴 Agent 提供的详细计划，或选择 JSON 文件。" /></label>
      <label>选择计划 JSON 文件<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <details className="eng-disclosure"><summary>计划格式与可复制示例</summary><p>schema_version 为 1；source 说明计划来源；nodes 用 key、parent_key 描述层级，顶层 parent_key 为 null，depends_on 引用本批步骤的 key。每批 1–100 项。不得传入 owner、status、历史运行或验收结果。contributes_to 引用上级的验收条件编号。</p><textarea aria-label="详细计划格式示例" readOnly rows={12} value={JSON.stringify(example, null, 2)} onFocus={(event) => event.currentTarget.select()} /></details>
    </> : <>
      <div className="eng-import-summary"><strong>将新增 {preview.nodes.length} 项草稿</strong><span>来源：{preview.source.title}</span>{preview.source.reference && <small>{preview.source.reference}</small>}</div>
      {preview.warnings.map((warning, index) => <p key={index} className="eng-notice">{warning}</p>)}
      {!!preview.invalidated_run_ids?.length && <p className="eng-notice">{preview.invalidated_run_ids.length} 次上级或依赖运行结果需要重新核对；原证据保留。</p>}
      <div className="eng-import-tree" aria-label="将新增的计划树">{preview.nodes.map((node) => <details key={node.id} className="eng-import-node" style={{ marginLeft: `${Math.min(depth(node), 5) * 14}px` }} open>
        <summary>{kindNames[node.kind]} · {node.title}</summary><dl className="eng-summary-list"><div><dt>归属任务</dt><dd>{titles.get(node.parent_id!) || parent.title}</dd></div><div><dt>预期结果</dt><dd className="eng-preserve">{node.objective || "尚未填写"}</dd></div><div><dt>执行思路</dt><dd className="eng-preserve">{node.method || "尚未填写"}</dd></div><div><dt>结构与衔接</dt><dd className="eng-preserve">{node.architecture || "尚未填写"}</dd></div><div><dt>前置依赖</dt><dd>{node.dependencies.map((id) => titles.get(id) || id).join("、") || "无"}</dd></div></dl>
        <h3>补充约束</h3><p className="eng-preserve">{node.constraints.rules.join("\n") || "沿用上级规则"}</p><p>交付文件允许：{node.constraints.allow.join("、") || "沿用上级"}；禁止：{node.constraints.deny.join("、") || "无补充"}；共享资源：{node.constraints.resources.join("、") || "无补充"}</p>
        {node.source_scope && <><h3>实际源工程核验</h3><p>源目录：{node.source_scope.root}</p><p>允许改动：{node.source_scope.allow.join("、")}；禁止：{node.source_scope.deny.join("、") || "无补充"}</p>{node.source_scope.checks.map((check) => <p key={check.id}>{check.title} · node {check.args.map((arg) => JSON.stringify(arg)).join(" ")}</p>)}<p>仅用于真实负责人执行的末级步骤；领取后采集起点，完成后实际运行冻结检查。</p></>}
        <h3>验收条件</h3>{node.criteria.length ? <ul>{node.criteria.map((item) => <li key={item.id}>{item.text} · {criterionNames[item.kind]}</li>)}</ul> : <p>尚需补齐后才可执行。</p>}
        <h3>执行动作与能力</h3><ul>{node.actions.map((item) => <li key={item.id}>{item.title} · {actionNames[item.type]} · {item.path || "按关联条件检查"}</li>)}{node.capabilities.map((item) => <li key={item.id}>{item.id} · {item.version} · {item.purpose}</li>)}</ul>
      </details>)}</div>
      {preview.expected_revision !== revision && <p role="alert" className="eng-inline-error">工程已更新。请返回输入，按当前版本重新预览；已输入的计划保留。</p>}
      <label>本次导入原因<textarea rows={2} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} placeholder="说明本批步骤对应哪一阶段、为什么新增。" /></label>
    </>}
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
    {discard && <div className="eng-notice"><p>清空将放弃这份尚未导入的计划和原因。</p><button type="button" disabled={busy} onClick={() => { edit(""); setReason(""); }}>确认清空导入草稿</button><button type="button" onClick={() => setDiscard(false)}>继续保留</button></div>}
    <div className="eng-modal-actions"><button type="button" disabled={busy} onClick={onClose}>关闭并保留输入</button>{(raw || reason) && <button type="button" disabled={busy} onClick={() => setDiscard(true)}>清空草稿</button>}{preview ? <><button type="button" disabled={busy} onClick={() => { setPreview(undefined); setError(""); }}>返回输入</button><button type="button" className="eng-primary" disabled={busy || !reason.trim() || preview.expected_revision !== revision} onClick={() => void commit()}>确认导入草稿</button></> : <button type="button" className="eng-primary" disabled={busy || !raw.trim()} onClick={() => void prepare()}>{busy ? "正在核对…" : "预览将新增的计划"}</button>}</div>
  </section></div>;
}
