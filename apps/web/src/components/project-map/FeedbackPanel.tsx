import { useEffect, useMemo, useRef, useState } from "react";
import { engineeringContractKey, type EngineeringView } from "@epm/domain";
import type { EngineeringFeedback, EngineeringFeedbackTarget, EngineeringFeedbackUpdate } from "../../../../../packages/domain/src/engineering-feedback.ts";
import type { EngineeringApi } from "../../engineering-api.ts";
import { projectDeliveryRelations } from "./delivery-selectors.ts";
import { runStatusLabel, timeLabel } from "../engineering/shared.ts";
import { graphFeedbackRecordStatus } from "./feedback-status.ts";

export const feedbackTargetKey = (target: EngineeringFeedbackTarget) => `${target.kind}|${target.id ?? ""}`;
interface Props { api: EngineeringApi; view: EngineeringView; nodeId: string; targetRequest?: { target: EngineeringFeedbackTarget; sequence: number }; observationUnavailable?: boolean; disabled?: boolean; onView: (view: EngineeringView) => void; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onEdit: (nodeId: string, field?: string) => void }

export function FeedbackPanel({ api, view, nodeId, targetRequest, observationUnavailable, disabled, onView, onDirtyChange, onBusyChange, onEdit }: Props) {
  const node = view.document.nodes.find(item => item.id === nodeId)!;
  const [open, setOpen] = useState(false), [targetKey, setTargetKey] = useState("node|"), [kind, setKind] = useState<"defect" | "requirement_change">("defect"), [note, setNote] = useState("");
  const [base, setBase] = useState({ document: view.document.revision, node: node.revision });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [handling, setHandling] = useState(""), [actionNote, setActionNote] = useState(""), [changeId, setChangeId] = useState(""), [runId, setRunId] = useState("");
  const [handlingCollapsed, setHandlingCollapsed] = useState(false);
  const mounted = useRef(true), panel = useRef<HTMLDetailsElement>(null), consumed = useRef<number | undefined>(undefined);
  const actionDirty = Boolean(actionNote.trim() || changeId || runId);
  const dirty = Boolean(note.trim() || actionDirty);
  const targets = useMemo(() => [{ key: "node|", label: "本项成果与边界", target: { kind: "node", node_id: nodeId } as EngineeringFeedbackTarget }, ...node.delivery?.outputs.map(output => ({ key: `output|${output.id}`, label: `成果：${output.title}`, target: { kind: "output", node_id: nodeId, id: output.id } as EngineeringFeedbackTarget })) ?? [], ...node.criteria.map(criterion => ({ key: `criterion|${criterion.id}`, label: `条件：${criterion.text}`, target: { kind: "criterion", node_id: nodeId, id: criterion.id } as EngineeringFeedbackTarget })), ...projectDeliveryRelations(view, view.document.nodes.map(item => item.id)).filter(relation => relation.ownerNodeId === nodeId).map(relation => ({ key: `relation|${relation.relationId}`, label: `关系：${relation.label}（${view.document.nodes.find(item => item.id === (relation.sourceNodeId === nodeId ? relation.targetNodeId : relation.sourceNodeId))?.title ?? "端点待核对"}）`, target: { kind: "relation", node_id: nodeId, id: relation.relationId } as EngineeringFeedbackTarget }))], [view, node, nodeId]);
  const feedbacks = (view.document.feedbacks ?? []).filter(item => item.target.node_id === nodeId).slice().reverse();
  const feedbackStates = new Map(feedbacks.map(item => [item.id, graphFeedbackRecordStatus(view, item, { observationUnavailable })]));
  const selected = feedbacks.find(item => item.id === handling);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirtyChange?.(false); onBusyChange?.(false); }; }, [onDirtyChange, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!note.trim()) setBase({ document: view.document.revision, node: node.revision }); }, [view.document.revision, node.revision, note]);
  useEffect(() => { if (!targetRequest || consumed.current === targetRequest.sequence || targetRequest.target.node_id !== nodeId) return; consumed.current = targetRequest.sequence; setOpen(true); if (dirty) setError("当前反馈尚未提交，请先提交或清空，再切换反馈位置。"); else { setTargetKey(feedbackTargetKey(targetRequest.target)); setError(""); } requestAnimationFrame(() => panel.current?.scrollIntoView({ block: "nearest", behavior: "auto" })); }, [targetRequest, dirty, nodeId]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty, busy]);
  async function mutate(operation: () => Promise<EngineeringView>, success: string) {
    if (busy || disabled) return; setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try { const next = await operation(); if (!mounted.current) return; setNote(""); setActionNote(""); setChangeId(""); setRunId(""); setMessage(success); onView(next); }
    catch (cause) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : String(cause)}。未提交内容仍保留。`); }
    finally { if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
  }
  function create() { const target = targets.find(item => item.key === targetKey)?.target; if (!target || !note.trim()) return; void mutate(() => api.createFeedback({ expected_revision: base.document, base_node_revision: base.node, target, kind, note: note.trim() }), "意见已记录，尚未改变执行约定。采用后会记录具体处理结果。"); }
  function act(action: EngineeringFeedbackUpdate["action"]) { if (!selected || !actionNote.trim() || action === "working" && !workingRuns.some(run => run.id === runId)) return; void mutate(() => api.updateFeedback(selected.id, { expected_revision: view.document.revision, action, note: actionNote.trim(), ...(changeId ? { change_id: changeId } : {}), ...(runId ? { run_id: runId } : {}) }), action === "resolve" ? "已复核并记录解决依据。" : "处理记录已更新，可继续追查修订与交付。"); }
  const changes = selected ? view.document.changes.filter(change => change.node_id === nodeId && change.after.revision > selected.base_node_revision).slice().reverse() : [];
  const runs = selected ? view.document.runs.filter(run => run.node_id === nodeId && run.id !== selected.base_run_id && run.id === view.derived[nodeId]?.latest_run_id && ["review", "accepted"].includes(run.status)) : [];
  // Present only an already started, precisely scoped run as a candidate. Selection
  // does not claim, start, adopt or approve it; the existing authenticated API remains authoritative.
  const adoptedAt = selected?.history.filter(entry => entry.action === "adopt").at(-1)?.at;
  const workingRuns = selected && selected.resolution_kind !== "plan" && selected.adopted_lineage && adoptedAt
    ? view.document.runs.filter(run => run.node_id === nodeId && run.id !== selected.base_run_id
      && run.id === view.derived[nodeId]?.latest_run_id && run.status === "running"
      && run.snapshot.contract_key === engineeringContractKey(view.document, nodeId)
      && JSON.stringify(run.snapshot.lineage) === JSON.stringify(selected.adopted_lineage)
      && Date.parse(run.started_at) >= Date.parse(adoptedAt)
      && (run.mode !== "external" || run.handoff?.state === "claimed" && run.handoff.claimed_by === run.actor && run.handoff.owner === run.actor)) : [];
  const submitted = selected?.submitted_run_id ? view.document.runs.find(run => run.id === selected.submitted_run_id) : undefined;
  const disabledActions = busy || disabled || Boolean(note.trim());
  return <details ref={panel} className="pni-feedback" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>反馈与处理 <span>{feedbacks.filter(item => !feedbackStates.get(item.id)!.closed).length} 项待闭环</span></summary>
    <div className="pni-feedback-body"><p className="pni-helper">意见定位到当前内容和版本；记录意见不等于修改已经生效。</p><fieldset disabled={busy || disabled || actionDirty || node.status === "archived"}>
      <label>反馈位置<select value={targetKey} disabled={Boolean(note.trim())} onChange={event => setTargetKey(event.target.value)}>{targets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}</select></label>
      <label>问题类型<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="defect">结果未达原约定</option><option value="requirement_change">需要改变约定</option></select></label>
      <label>这处需要怎样调整<textarea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="指出具体不符合之处，或说明希望改变什么。" /></label>
      <div className="pni-local-actions"><button type="button" disabled={!note.trim()} onClick={create}>记录这条反馈</button>{note.trim() && <button type="button" onClick={() => { setNote(""); setError(""); }}>清空未提交反馈</button>}</div>{note.trim() && base.document !== view.document.revision && <p className="pni-delivery-issue">工程已有更新。当前意见仍绑定原版本；请复制意见并核对当前内容后重新填写，避免错指对象。</p>}
    </fieldset>
    {note.trim() && base.document !== view.document.revision && <button type="button" disabled={busy || disabled} onClick={() => { setBase({ document: view.document.revision, node: node.revision }); setError(""); setMessage("已切换为当前内容版本，请核对反馈位置和意见再提交。"); }}>我已核对当前内容，更新反馈版本</button>}
    {error && <p role="alert" className="pni-delivery-issue">{error}</p>}{message && <p role="status">{message}</p>}
    {feedbacks.length > 0 && <div className="pni-feedback-records"><h3>已记录的意见</h3>{feedbacks.map(item => <article key={item.id} data-feedback-id={item.id}><button type="button" className="pni-feedback-title" disabled={busy || disabled || dirty && handling !== item.id} aria-expanded={handling === item.id && !handlingCollapsed} onClick={() => { if (handling === item.id) { setHandlingCollapsed(value => !value); return; } setHandling(item.id); setHandlingCollapsed(false); setActionNote(""); setChangeId(""); setRunId(""); }}><strong>{item.note}</strong><span title={feedbackStates.get(item.id)!.detail}>{feedbackStates.get(item.id)!.label}</span></button><small>{targets.find(target => feedbackTargetKey(item.target) === target.key)?.label ?? "原反馈对象已有变化"} · 方案第 {item.base_node_revision} 版 · {timeLabel(item.created_at)}</small>{handling === item.id && !handlingCollapsed && <>
      <p className="pni-helper">{feedbackStates.get(item.id)!.detail}</p>
      <ol className="pni-feedback-history">{item.history.map((entry, index) => <li key={index}><p>{entry.note}</p><small>{entry.actor} · {timeLabel(entry.at)}{entry.change_id ? " · 有关联修订" : ""}{entry.run_id ? " · 有关联运行" : ""}</small></li>)}</ol>
      <fieldset disabled={disabledActions}><label>本次处理说明<textarea rows={2} value={actionNote} onChange={event => setActionNote(event.target.value)} placeholder="记录为什么采用、怎样修复，或这次复核的依据。" /></label>
      {item.status === "open" && item.kind === "requirement_change" && <><p className="pni-helper">先在原对象中保存具体修订，再关联该修订采用反馈；不会为关闭反馈自动降低完成标准。</p><button type="button" disabled={Boolean(actionNote.trim())} onClick={() => onEdit(nodeId, item.target.kind === "relation" ? item.target.id : item.target.kind === "criterion" ? `criterion:${item.target.id}` : undefined)}>修改对应约定</button><label>采用哪次已保存修订<select value={changeId} onChange={event => setChangeId(event.target.value)}><option value="">请选择对应修订…</option>{changes.map(change => <option key={change.id} value={change.id}>{change.reason} · 第 {change.after.revision} 版</option>)}</select></label></>}
      {["adopted", "working"].includes(item.status) && item.resolution_kind !== "plan" && <label>本次处理运行<select value={runId} onChange={event => setRunId(event.target.value)}><option value="">选择正在处理或已交付的运行…</option>{[...workingRuns, ...runs].map(run => <option key={run.id} value={run.id}>{runStatusLabel(run)} · {timeLabel(run.finished_at ?? run.started_at)}</option>)}</select></label>}
      <div className="pni-local-actions">{!item.scope_feedback_ids && ["adopted", "working"].includes(item.status) && item.resolution_kind !== "plan" && workingRuns.length > 0 && <button type="button" disabled={!actionNote.trim() || !workingRuns.some(run => run.id === runId)} onClick={() => act("working")}>关联正在处理的运行</button>}{item.status === "open" && <><button type="button" disabled={!actionNote.trim() || item.kind === "requirement_change" && !changeId} onClick={() => act("adopt")}>采用这条反馈</button><button type="button" disabled={!actionNote.trim()} onClick={() => act("dismiss")}>说明理由并不采用</button></>}{["adopted", "working"].includes(item.status) && <button type="button" disabled={!actionNote.trim() || item.resolution_kind !== "plan" && !runs.some(run => run.id === runId)} onClick={() => act("submit")}>{item.resolution_kind === "plan" ? "提交已保存修订复核" : "关联交付，提交复核"}</button>}{item.status === "review" && <button type="button" disabled={!actionNote.trim() || item.resolution_kind !== "plan" && (submitted?.status !== "accepted" || submitted.id !== view.derived[nodeId]?.latest_run_id)} onClick={() => act("resolve")}>确认本条已解决</button>}{["adopted", "working", "review", "resolved", "dismissed"].includes(item.status) && <button type="button" disabled={!actionNote.trim()} onClick={() => act("reopen")}>重新打开问题</button>}{actionDirty && <button type="button" onClick={() => { setActionNote(""); setChangeId(""); setRunId(""); }}>清空处理草稿</button>}</div>{item.status === "review" && item.resolution_kind !== "plan" && submitted?.status !== "accepted" && <p className="pni-helper">关联交付尚未通过当前版本验收，暂不能关闭问题。</p>}
      </fieldset>
    </>}</article>)}</div>}
    </div>
  </details>;
}
