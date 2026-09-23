import { engineeringRunResolver, type EngineeringNode, type EngineeringRun, type EngineeringView } from "@epm/domain";
import { inspectorEvidence, selectDescendantRunAttention, type InspectorStage, type ProjectInspectorModel } from "./inspector-selectors.ts";

export interface ProjectProcessMotion {
  state: "running" | "waiting" | "blocked" | "idle" | "complete";
  stageId: InspectorStage["id"] | null;
  label: string;
  runningNodeIds?: string[];
}

/** Use the same contract resolver as execution; stale derived pointers cannot animate. */
function currentRunReader(view: EngineeringView, _nodes: Map<string, EngineeringNode>) {
  const resolve = engineeringRunResolver(view.document);
  return (id: string) => {
    const run = resolve(id);
    return run?.id === view.derived[id]?.latest_run_id ? run : undefined;
  };
}

/** Motion describes real activity, independently of the process's visual/current tone. */
export function projectProcessMotion(view: EngineeringView, nodeId: string, model: ProjectInspectorModel): ProjectProcessMotion {
  const nodes = new Map(view.document.nodes.map(node => [node.id, node]));
  const node = nodes.get(nodeId), derived = view.derived[nodeId];
  const result = (state: ProjectProcessMotion["state"], stageId: InspectorStage["id"] | null, label: string): ProjectProcessMotion => {
    const available = stageId === null || model.stages.some(stage => stage.id === stageId);
    return { state: !available && state === "running" ? "blocked" : state, stageId: available ? stageId : null, label: !available && state === "running" ? "当前过程信息待更新，请核对运行记录。" : label };
  };
  if (!node || !derived || model.node.id !== nodeId) return result("idle", null, "当前任务信息不可用。");

  const stoppedBy = (id: string, status: "paused" | "archived") => {
    const seen = new Set<string>();
    for (let item = nodes.get(id); item && !seen.has(item.id); item = item.parent_id ? nodes.get(item.parent_id) : undefined) {
      if (item.status === status || view.derived[item.id]?.status === status) return true;
      seen.add(item.id);
    }
    return false;
  };
  if (stoppedBy(nodeId, "archived")) return result("idle", null, "本项或上级已归档，仅供查阅历史过程。");
  if (stoppedBy(nodeId, "paused")) return result("blocked", null, "本项或上级已暂停，当前过程已停止。");

  // Recheck the contract as well as the derived pointer: a previous valid run or
  // another node's reference must not restart motion while a view is refreshed.
  const current = currentRunReader(view, nodes);
  const run = current(nodeId);
  const isParent = view.document.nodes.some(child => child.parent_id === nodeId && child.status !== "archived");
  const checking = (item: EngineeringRun) => item.current_action === "source-verification" || item.snapshot.node.actions.some(action => action.id === item.current_action && action.type === "check_file");
  const workStage = (item?: EngineeringRun, stopped = false): InspectorStage["id"] => isParent ? "integration" : item && (checking(item) || stopped && inspectorEvidence(node, item).failed) ? "checks" : "execution";
  const descendantMotion = (): ProjectProcessMotion | undefined => {
    if (!isParent) return undefined;
    const attention = selectDescendantRunAttention(view, nodeId);
    const active = (item: { node: { id: string }; run: EngineeringRun }) => !stoppedBy(item.node.id, "paused") && !stoppedBy(item.node.id, "archived") && current(item.node.id)?.id === item.run.id;
    const running = attention.running.filter(active).filter(item => !view.observation || item.run.mode !== "external" || ["current", "local"].includes(view.observation.runs[item.run.id]?.state ?? "unobserved")), review = attention.review.filter(active);
    if (running.length) {
      const projected = result("running", "children", `${running.length} 项下级正在执行${review.length ? `，另有 ${review.length} 项等待验收` : ""}；本层仍需独立整合与验收。`);
      return projected.state === "running" ? { ...projected, runningNodeIds: running.map(item => item.node.id) } : projected;
    }
    if (review.length) return result("waiting", "children", `${review.length} 项下级等待人工验收，本层尚未完成。`);
    return undefined;
  };

  if (run && derived.status === "running" && run.status === "running") {
    const observation = view.observation?.runs[run.id];
    if (view.observation && run.mode === "external" && (!observation || !["current", "local"].includes(observation.state))) return result("waiting", workStage(run), observation?.message || "实际活动尚未确认，状态待更新。");
    if (model.currentRun?.id !== run.id) return result("blocked", null, "当前运行与过程信息尚未同步。");
    if (run.mode === "external" && run.handoff?.state !== "claimed") return result(run.handoff?.state === "awaiting_claim" ? "waiting" : "blocked", "handoff", run.handoff?.state === "awaiting_claim" ? "等待负责人实际领取，尚未开始执行。" : "缺少实际领取记录，请核对交接。");
    if (isParent && run.mode !== "integration") return result("blocked", "integration", "当前记录不是本层整合运行，请核对执行记录。");
    const stage = workStage(run);
    return result("running", stage, stage === "integration" ? checking(run) ? "正在核对组合后的结果并执行实际整合检查。" : "本层正在进行整合。" : stage === "checks" ? "正在执行当前冻结范围的实际检查。" : "当前任务正在执行并形成成果。");
  }
  if (run?.status === "review" && derived.status === "review") return result("waiting", "review", isParent ? "整合结果已提交，等待本层人工验收。" : "结果已提交，等待人工验收。");
  if (run?.status === "accepted" && derived.status === "accepted") return result("complete", "review", "本项当前版本已通过人工验收。");
  if (run?.status === "queued") {
    const descendant = descendantMotion(); if (descendant) return descendant;
    if (run.mode === "external" && run.handoff?.state !== "claimed") return result("waiting", "handoff", run.handoff?.state === "awaiting_claim" ? "等待负责人实际领取，尚未开始执行。" : "等待核对实际领取记录，尚未开始执行。");
    return result("waiting", workStage(run), "已登记运行，等待执行条件，尚未开始执行。");
  }
  if (derived.status === "ready" && run && ["rejected", "blocked", "paused"].includes(run.status)) return result("waiting", "plan", "当前方案已就绪，等待新的执行。");
  if (run?.status === "rejected") return result("blocked", "review", "人工验收已退回，等待修订后重新执行。");
  if (run?.status === "blocked" || derived.status === "blocked") return result("blocked", workStage(run, true), "执行或检查已受阻，请核对停止原因。");

  if (isParent) {
    // New descendants may be running after an older parent integration became
    // stale. Animate only their activity, never that obsolete integration.
    const descendant = descendantMotion(); if (descendant) return descendant;
    const children = view.document.nodes.filter(child => child.parent_id === nodeId && child.status !== "archived");
    if (children.every(child => view.derived[child.id]?.status === "accepted" && current(child.id)?.status === "accepted")) return result("waiting", "integration", "直属子项已验收，等待本层整合与人工验收。");
  }
  if (!run && view.document.runs.some(item => item.node_id === nodeId)) return result("blocked", "plan", "当前版本没有有效运行，旧过程与证据仅供追溯。");
  if (derived.status === "needs_revision") return result("blocked", "plan", "当前方案需要修订，尚未开始新的执行。");
  if (isParent) return result("waiting", "children", "等待下级分别执行并提交成果。");
  if (derived.status === "ready") return result("waiting", "plan", "方案已就绪，等待实际执行。");
  return result("idle", "plan", "当前方案尚未开始执行。");
}
