import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, GitCompareArrows, MessageSquare, X } from "lucide-react";
import type { EngineeringView } from "@epm/domain";
import type { EngineeringFeedback, EngineeringFeedbackTarget } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { engineeringFeedbackScopeValid, engineeringFeedbackTargetExists } from "../../../../../packages/domain/src/engineering-feedback.ts";
import type { EngineeringApi } from "../../engineering-api.ts";
import { engineeringNodeName } from "../engineering/node-names.ts";
import { timeLabel } from "../engineering/shared.ts";
import { projectNodeInspector } from "./inspector-selectors.ts";
import { projectDeliveryRelations, projectDeliverySummary } from "./delivery-selectors.ts";
import type { ProjectDetailTab } from "./types.ts";
import "./graph-feedback-card.css";

import { graphFeedbackRecordStatus } from "./feedback-status.ts";
import { projectFeedbackArtifacts, projectFeedbackComparison } from "./feedback-comparison.ts";
import { GraphFeedbackResult } from "./GraphFeedbackResult.tsx";
import { projectFeedbackExecution } from "./feedback-execution.ts";
export { graphFeedbackRecordStatus, graphFeedbackStatus } from "./feedback-status.ts";

const sameTarget = (left: EngineeringFeedbackTarget, right: EngineeringFeedbackTarget) => left.node_id === right.node_id && left.kind === right.kind && left.id === right.id;
const sameScope = (left: readonly string[] = [], right: readonly string[] = []) => left.length === right.length && left.every(id => right.includes(id));

/** Keep range feedback visible at every included node without relabelling its original anchor. */
export function graphFeedbackRecords(view: EngineeringView, target: EngineeringFeedbackTarget, scopeNodeIds: readonly string[] = []) {
  return (view.document.feedbacks ?? []).filter(item => !item.scope_group_id).filter(item => scopeNodeIds.length
    ? sameTarget(item.target, target) && sameScope(item.scope_node_ids, scopeNodeIds)
    : target.kind === "node" ? item.target.node_id === target.node_id || item.scope_node_ids?.includes(target.node_id) : sameTarget(item.target, target)
  ).slice().reverse();
}

export function graphFeedbackContext(view: EngineeringView, target: EngineeringFeedbackTarget, nodeNames?: Record<string, string>, scopeNodeIds: readonly string[] = [], observationUnavailable = false) {
  const nodes = new Map(view.document.nodes.map(node => [node.id, node]));
  const node = nodes.get(target.node_id);
  const recordedRange = view.document.feedbacks?.findLast(item => sameTarget(item.target, target) && sameScope(item.scope_node_ids, scopeNodeIds));
  const name = (id: string) => { const item = nodes.get(id); return item ? engineeringNodeName(item, nodeNames) : recordedRange?.scope_snapshot?.find(entry => entry.node_id === id)?.title ?? "原对象已不存在"; };
  if (!node) return { title: "原位置已不存在", subtitle: "记录仍保留，请选择当前工程中的位置。", fact: "", exists: false };
  const model = projectNodeInspector(view, node.id);
  const fact = observationUnavailable && model?.currentRun?.status === "running"
    ? "执行状态待更新，暂不判断正在运行。"
    : model?.blockers[0] || projectDeliverySummary(view, node.id)?.issues[0] || model?.summary || "本项尚无可核对的执行结果。";
  if (scopeNodeIds.length) return {
    title: `${scopeNodeIds.length} 个部分一起讨论`, subtitle: scopeNodeIds.map(name).join("、"),
    fact: "意见会同时保留所选范围；改法和实际影响仍需核对。",
    exists: engineeringFeedbackScopeValid(view.document, target, [...scopeNodeIds])
  };
  if (target.kind === "relation") {
    if (target.id === "parent") return { title: `${name(node.id)} → ${node.parent_id ? name(node.parent_id) : "上级"}`, subtitle: node.contribution?.summary || "本项怎样共同构成上级成果", fact: node.contributes_to.length ? "这条组成关系关联了上级完成条件。" : "尚未说明本项满足上级哪些完成条件。", exists: engineeringFeedbackTargetExists(view.document, target) };
    const relation = projectDeliveryRelations(view, [...nodes.keys()]).find(item => item.ownerNodeId === target.node_id && item.relationId === target.id);
    return { title: relation?.label || "原联系已变化", subtitle: relation ? `${name(relation.sourceNodeId)} → ${name(relation.targetNodeId)}` : "原意见保留，请核对当前联系。", fact: relation?.problem || relation?.detail || "", exists: engineeringFeedbackTargetExists(view.document, target) };
  }
  if (target.kind === "output") return { title: node.delivery?.outputs.find(item => item.id === target.id)?.title || "原成果已变化", subtitle: name(node.id), fact, exists: engineeringFeedbackTargetExists(view.document, target) };
  if (target.kind === "criterion") return { title: "这条完成条件", subtitle: node.criteria.find(item => item.id === target.id)?.text || "原条件已变化", fact, exists: engineeringFeedbackTargetExists(view.document, target) };
  return { title: name(node.id), subtitle: node.objective || "本项要得到的结果尚未说明。", fact, exists: node.status !== "archived" };
}

interface Props {
  api: EngineeringApi;
  view: EngineeringView;
  target: EngineeringFeedbackTarget;
  scopeNodeIds?: readonly string[];
  selectedFeedbackId?: string;
  nodeNames?: Record<string, string>;
  disabled?: boolean;
  observationUnavailable?: boolean;
  onView: (view: EngineeringView) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onSelectFeedback: (feedback: EngineeringFeedback) => void;
  onOpenDetail: (nodeId: string, tab?: ProjectDetailTab, field?: string) => void;
  onOpenRecords: (feedbackId?: string) => void;
}

/** The diagram owns the target. This card records a human observation; it never dispatches or accepts work. */
export function GraphFeedbackCard({ api, view, target, scopeNodeIds = [], selectedFeedbackId, nodeNames, disabled, observationUnavailable, onView, onDirtyChange, onBusyChange, onClose, onSelectFeedback, onOpenDetail, onOpenRecords }: Props) {
  const context = useMemo(() => graphFeedbackContext(view, target, nodeNames, scopeNodeIds, observationUnavailable), [view, target, nodeNames, scopeNodeIds, observationUnavailable]);
  const node = view.document.nodes.find(item => item.id === target.node_id);
  const [note, setNote] = useState("");
  const [composerOpen, setComposerOpen] = useState(!selectedFeedbackId);
  const [kind, setKind] = useState<"defect" | "requirement_change">("defect");
  const [base, setBase] = useState({ document: view.document.revision, node: node?.revision ?? 0 });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [allRecords, setAllRecords] = useState(false), [expandedRecord, setExpandedRecord] = useState(selectedFeedbackId ?? "");
  const [recordLimit, setRecordLimit] = useState(4);
  const mounted = useRef(true), flight = useRef(false), draft = useRef<HTMLTextAreaElement>(null);
  const dirty = Boolean(note.trim());
  const topRecords = allRecords ? (view.document.feedbacks ?? []).filter(item => !item.scope_group_id).slice().reverse() : graphFeedbackRecords(view, target, scopeNodeIds);
  const selectedRecord = view.document.feedbacks?.find(item => item.id === selectedFeedbackId);
  const records = selectedRecord && !allRecords ? [selectedRecord, ...topRecords.filter(item => item.id !== selectedRecord.id)] : topRecords;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirtyChange(false); onBusyChange(false); }; }, [onDirtyChange, onBusyChange]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) setBase({ document: view.document.revision, node: node?.revision ?? 0 }); }, [view.document.revision, node?.revision, dirty]);
  useEffect(() => { setExpandedRecord(selectedFeedbackId ?? ""); if (!dirty) setComposerOpen(!selectedFeedbackId); }, [selectedFeedbackId]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty || flight.current) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty]);
  const stale = dirty && base.document !== view.document.revision;
  async function save() {
    if (flight.current || disabled || !dirty || stale || !context.exists || !node) return;
    flight.current = true; setBusy(true); onBusyChange(true); setError(""); setMessage("");
    try {
      const next = await api.createFeedback({ expected_revision: base.document, base_node_revision: base.node, target, kind, note: note.trim(), ...(scopeNodeIds.length ? { scope_node_ids: [...scopeNodeIds] } : {}) });
      if (!mounted.current) return;
      const saved = next.document.feedbacks?.findLast(item => sameTarget(item.target, target) && sameScope(item.scope_node_ids, scopeNodeIds) && item.note === note.trim());
      setNote(""); setComposerOpen(false); setMessage("意见已保存到此处，尚未派发给 Agent。"); setExpandedRecord(saved?.id ?? ""); setAllRecords(false); setRecordLimit(4); onView(next);
    } catch (cause) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : String(cause)}。你的意见仍保留。`); }
    finally { flight.current = false; if (mounted.current) { setBusy(false); onBusyChange(false); } }
  }
  return <aside className="gfc-card" aria-label="图上意见" data-feedback-target={target.kind} data-feedback-node={target.node_id}>
    <header className="gfc-header"><span><MessageSquare size={14} aria-hidden="true" />在这里讨论</span><button type="button" aria-label="收起图上意见" disabled={busy || disabled} onClick={onClose}><X size={16} /></button></header>
    <div className="gfc-location"><h2>{context.title}</h2><p title={context.subtitle}>{context.subtitle}</p></div>
    {context.fact && <p className="gfc-fact"><span>当前</span><span className="gfc-fact-text" title={context.fact}>{context.fact}</span></p>}
    {!composerOpen && <button className="gfc-compose-toggle" type="button" disabled={busy || disabled} onClick={() => { setComposerOpen(true); setMessage(""); }}>继续提意见</button>}
    {composerOpen && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="gfc-intent" aria-label="意见类型">{([{ value: "defect", label: "指出问题" }, { value: "requirement_change", label: "提出改进" }] as const).map(item => <button key={item.value} type="button" disabled={busy || disabled} aria-pressed={kind === item.value} onClick={() => setKind(item.value)}>{item.label}</button>)}</div>
      <label className="gfc-composer"><span>你觉得哪里不对，或想怎样改进？</span><textarea ref={draft} rows={3} maxLength={12000} disabled={busy || disabled || !context.exists} value={note} onChange={event => setNote(event.target.value)} placeholder={scopeNodeIds.length ? "例如：这几块的职责有重复，帮我重新分一下。" : "可以只说大致感觉，不必先想好改法。"} /></label>
      {stale && <div className="gfc-notice" role="status">工程刚有更新，请先核对图中位置。<button type="button" disabled={busy || disabled} onClick={() => { setBase({ document: view.document.revision, node: node?.revision ?? 0 }); setError(""); }}>已核对，保留这条意见</button></div>}
      <div className="gfc-submit"><button className="gfc-primary" type="submit" disabled={busy || disabled || !dirty || stale || !context.exists}>{busy ? "正在保存…" : "保存这条意见"}</button>{dirty && <button type="button" disabled={busy || disabled} onClick={() => { setNote(""); setError(""); }}>清空草稿</button>}</div>
      {error && <p className="gfc-error" role="alert">{error}</p>}
      {!!records.length && !dirty && <button className="gfc-compose-hide" type="button" disabled={busy || disabled} onClick={() => setComposerOpen(false)}>收起输入，查看处理结果</button>}
    </form>}
    {message && <p className="gfc-success gfc-saved" role="status">{message}</p>}
    <section className="gfc-records" aria-label="原位置处理记录"><header><h3>{allRecords ? "工程里的意见" : "这里的意见"}<span>{records.length}</span></h3><button type="button" aria-pressed={allRecords} onClick={() => { setAllRecords(value => !value); setRecordLimit(4); }}>{allRecords ? "只看这里" : "全部意见"}</button></header>
      {!records.length && <p className="gfc-empty">{allRecords ? "工程还没有记录意见。" : "这里还没有意见，保存后可以原位查收。"}</p>}
      {records.slice(0, recordLimit).map(item => {
        const expanded = expandedRecord === item.id, status = graphFeedbackRecordStatus(view, item, { observationUnavailable });
        const execution = projectFeedbackExecution(view, item, { observationUnavailable });
        const comparison = projectFeedbackComparison(view, item), result = projectFeedbackArtifacts(view, item);
        const response = item.history.filter(entry => entry.action !== "create").at(-1);
        const ownTarget = sameTarget(item.target, target) && sameScope(item.scope_node_ids, scopeNodeIds);
        return <article key={item.id} data-feedback-id={item.id} data-feedback-status={item.status}>
          <button className="gfc-record-title" type="button" aria-expanded={expanded} disabled={busy || disabled} onClick={() => { if (!ownTarget || selectedFeedbackId !== item.id) { onSelectFeedback(item); return; } setExpandedRecord(expanded ? "" : item.id); }}><span>{item.note}</span><small className={`is-${status.tone}`}>{status.label}</small></button>
          {expanded && <div className="gfc-record-detail">
            {(execution.state === "unlinked" || status.detail !== execution.detail) && <p className="gfc-record-state">{status.detail}</p>}
            {execution.state !== "unlinked" ? <section className="gfc-execution" aria-label="这条意见的处理" data-execution-state={execution.state} data-run-id={execution.runId}>
              <header><strong title={execution.actorIdentity}>{execution.actorLabel ?? execution.sourceLabel}</strong><span>{execution.label}</span></header>
              {execution.actionTitle && <p><small>{execution.state === "running" ? "正在" : "记录动作"}</small>{execution.actionTitle}</p>}
              {(execution.reason || !execution.actionTitle) && <p>{execution.reason || execution.detail}</p>}
              <details><summary>查看处理来源</summary><p>{execution.sourceLabel}{execution.actorIdentity ? ` · ${execution.actorIdentity}` : ""}</p>{execution.runId && <p>运行：{execution.runId}</p>}{response && <p>{response.note}</p>}</details>
            </section> : response && <p className="gfc-response">{response.note}</p>}
            <div className="gfc-loop" aria-label="这条意见的处理闭环"><span>原意见</span><ArrowRight size={12}/><span className={comparison.state === "recorded" ? "is-done" : comparison.state === "historical" || comparison.state === "missing" ? "is-review" : ""}>{comparison.state === "recorded" ? "改动已标图" : comparison.state === "historical" ? "旧改动待核对" : comparison.state === "missing" ? "改动记录需核对" : "等待修改"}</span><ArrowRight size={12}/><span className={result.state === "historical" || result.state === "missing" ? "is-review" : ""}>{result.state === "current" ? "查收成果" : result.state === "historical" ? "旧成果待核对" : result.state === "missing" ? "成果记录需核对" : "等待成果"}</span></div>
            {item.scope_feedback_ids && <div className="gfc-scope-progress" aria-label="所选范围逐项进展">{item.scope_feedback_ids.map(id => {
              const child = view.document.feedbacks?.find(entry => entry.id === id), childNode = child && view.document.nodes.find(entry => entry.id === child.target.node_id);
              const historicalTitle = child && item.scope_snapshot?.find(entry => entry.node_id === child.target.node_id)?.title;
              return child ? <button key={id} type="button" disabled={busy || disabled} onClick={() => onSelectFeedback(child)}><span>{childNode ? engineeringNodeName(childNode, nodeNames) : historicalTitle ?? "原位置已不存在"}</span><small>{graphFeedbackRecordStatus(view, child, { observationUnavailable }).label}</small><ArrowUpRight size={12} /></button> : <p key={id}>本项处理记录暂不可用。</p>;
            })}</div>}
            {(comparison.state === "recorded" || comparison.state === "historical") && comparison.change && <section className="gfc-change" aria-label="本次改动与影响"><header><GitCompareArrows size={14}/><div><strong>{comparison.currentAfter ? "改动已标在工程图上" : "这是历史改动，当前方案已有更新"}</strong><small>{comparison.change.reason} · 记录影响 {comparison.affected.length} 项</small></div></header><p className="gfc-impact-list">{comparison.affected.slice(0, 4).map(node => <span key={node.id} className={node.archived ? "is-archived" : ""}>{node.title}</span>)}{comparison.affected.length > 4 && <span>另 {comparison.affected.length - 4} 项</span>}</p><details className="gfc-before-after"><summary><GitCompareArrows size={12}/>查看前后</summary>{comparison.fields.length ? comparison.fields.map(field => <div key={field.id}><strong>{field.label}</strong><p><span>原来</span>{field.before}</p><p><span>现在</span>{field.after}</p></div>) : <p>这次记录没有可在简版中展示的成果差异。</p>}<button type="button" onClick={() => onOpenDetail(item.target.node_id, "history")}>打开完整变更记录<ArrowUpRight size={12}/></button></details></section>}
            {comparison.state === "missing" && <p className="gfc-result-warning">关联的修改记录已变化，不能据此标记影响。</p>}
            {result.state !== "none" && <GraphFeedbackResult api={api} reference={result} nodeId={item.target.node_id} documentRevision={view.document.revision} onOpenRecords={() => onOpenDetail(item.target.node_id, "runs")} />}
            {result.state === "none" && ["working", "review", "resolved"].includes(item.status) && <p className="gfc-result-warning">尚无与这条意见精确关联的交付，不能显示为已完成。</p>}
            <small>{timeLabel(item.updated_at)}</small><button className="gfc-text-action" type="button" disabled={busy || disabled} onClick={() => onOpenRecords(item.id)}>完整处理记录</button>
          </div>}
        </article>;
      })}
      {records.length > recordLimit && <button className="gfc-more" type="button" onClick={() => setRecordLimit(value => value + 4)}>再看 {Math.min(4, records.length - recordLimit)} 条意见</button>}
    </section>
    <footer className="gfc-footer"><button type="button" disabled={busy || disabled} onClick={() => onOpenDetail(target.node_id, "reading")}>查看依据与高级编辑<ArrowUpRight size={13} /></button></footer>
  </aside>;
}
