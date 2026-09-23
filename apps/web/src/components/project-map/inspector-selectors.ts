import type { EngineeringNode, EngineeringRun, EngineeringView } from "@epm/domain";
import { nodeStatusLabel, ordered } from "../engineering/shared.ts";
import type { ProjectDetailTab } from "./types.ts";

export type InspectorTone = "done" | "current" | "waiting" | "attention" | "unconfigured";
export interface InspectorStage { id: "plan" | "handoff" | "execution" | "checks" | "children" | "integration" | "review"; title: string; note: string; tone: InspectorTone; tab: ProjectDetailTab }
export interface InspectorEvidence {
  artifacts: number; sourceChanges: number; checksPassed: number; checksTotal: number;
  manualPassed: number; manualTotal: number; failed: boolean; checked: boolean; hasAutomatic: boolean;
}
export interface InspectorChild {
  node: EngineeringNode; status: string; accepted: boolean; review: boolean;
  leafAccepted: number; leafTotal: number; running: Array<{ nodeId: string; title: string }>;
}
export interface ProjectInspectorModel {
  node: EngineeringNode; status: string; path: Array<{ id: string; title: string }>; currentRun?: EngineeringRun;
  historicalOnly: boolean; historyCount: number; attempt: number | null; isParent: boolean;
  stages: InspectorStage[]; summary: string; next: { label: string; tab: ProjectDetailTab; action?: "review_list" };
  evidence: InspectorEvidence; children: InspectorChild[]; running: Array<{ nodeId: string; title: string }>;
  acceptedChildren: number; reviewChildren: number; blockers: string[];
  descendantReviews: Array<{ node: EngineeringNode; run: EngineeringRun }>;
  actionTotal: number; actionCompleted: number; currentAction: string | null;
  inheritedRules: Array<{ node_id: string; title: string; text: string }>;
}

const finishedExecution = (run?: EngineeringRun) => !!run && ["review", "accepted", "rejected"].includes(run.status);
const realRunning = (run?: EngineeringRun) => run?.status === "running" && (run.mode !== "external" || run.handoff?.state === "claimed");

/** Shared map/inspector attention semantics. Completion counts are not review counts. */
export function selectDescendantRunAttention(view: EngineeringView, nodeId: string): {
  review: Array<{ node: EngineeringNode; run: EngineeringRun }>;
  running: Array<{ node: EngineeringNode; run: EngineeringRun }>;
} {
  const result: ReturnType<typeof selectDescendantRunAttention> = { review: [], running: [] };
  const parent = view.document.nodes.find(node => node.id === nodeId);
  if (!parent || parent.status === "archived") return result;
  const children = new Map<string, EngineeringNode[]>(), runs = new Map(view.document.runs.map(run => [run.id, run]));
  for (const node of view.document.nodes) if (node.parent_id && node.status !== "archived") children.set(node.parent_id, [...children.get(node.parent_id) ?? [], node]);
  const queue = ordered(children.get(nodeId) ?? []), seen = new Set([nodeId]);
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]; if (seen.has(node.id)) continue; seen.add(node.id);
    const derived = view.derived[node.id], run = runs.get(derived?.latest_run_id ?? "");
    if (run?.node_id === node.id) {
      if (derived?.status === "review" && run.status === "review") result.review.push({ node, run });
      if (derived?.status === "running" && realRunning(run)) result.running.push({ node, run });
    }
    queue.push(...ordered(children.get(node.id) ?? []));
  }
  return result;
}

export function inspectorEvidence(node: EngineeringNode, run?: EngineeringRun): InspectorEvidence {
  const criteria = run?.snapshot.node.criteria ?? node.criteria;
  const automatic = criteria.filter(item => item.kind !== "manual"), manual = criteria.filter(item => item.kind === "manual");
  const checks = run?.evidence.filter(item => item.kind === "check") ?? [];
  const proofs = [run?.source_proof, ...run?.source_integration_proofs ?? []].filter(proof => proof !== undefined);
  const sourceScopes = run?.source_scope ? [run.source_scope] : run?.source_integration_scopes ?? (node.source_scope ? [node.source_scope] : []);
  const sourceExpected = sourceScopes.reduce((sum, scope) => sum + scope.checks.length, 0);
  const sourcePassed = sourceScopes.reduce((sum, scope) => {
    const proof = proofs.find(item => item.root === scope.root && ("contract_sha256" in scope ? item.contract_sha256 === scope.contract_sha256 : true));
    return sum + scope.checks.filter(check => proof?.checks.some(result => result.id === check.id && result.status === "passed" && result.exit_code === 0)).length;
  }, 0);
  const automaticPassed = automatic.filter(criterion => checks.some(check => check.criterion_id === criterion.id && check.passed === true) && !checks.some(check => check.criterion_id === criterion.id && check.passed === false)).length;
  const extraChecks = checks.filter(check => !automatic.some(criterion => criterion.id === check.criterion_id) && !proofs.length);
  const failed = checks.some(check => check.passed === false) || proofs.some(proof => !proof.passed || proof.status !== "passed" || proof.checks.some(check => check.status !== "passed" || check.exit_code !== 0));
  const hasAutomatic = automatic.length + sourceExpected + extraChecks.length > 0;
  const sourceComplete = sourceScopes.every(scope => proofs.some(proof => proof.root === scope.root && ("contract_sha256" in scope ? proof.contract_sha256 === scope.contract_sha256 : true) && proof.passed && proof.status === "passed" && scope.checks.every(check => proof.checks.some(result => result.id === check.id && result.status === "passed" && result.exit_code === 0))));
  return {
    artifacts: new Set(run?.evidence.filter(item => ["artifact", "capability"].includes(item.kind) && item.path && item.sha256).map(item => `${item.path}:${item.sha256}`)).size,
    sourceChanges: proofs.reduce((sum, proof) => sum + proof.changes.length, 0),
    checksPassed: automaticPassed + sourcePassed + extraChecks.filter(check => check.passed === true).length,
    checksTotal: automatic.length + sourceExpected + extraChecks.length,
    manualPassed: manual.filter(criterion => run?.evidence.some(item => item.kind === "human" && item.criterion_id === criterion.id && item.passed === true) && !run.evidence.some(item => item.kind === "human" && item.criterion_id === criterion.id && item.passed === false)).length,
    manualTotal: manual.length, failed, hasAutomatic,
    checked: finishedExecution(run) && hasAutomatic && !failed && automaticPassed === automatic.length && sourceComplete && extraChecks.every(check => check.passed === true)
  };
}

export function projectNodeInspector(view: EngineeringView, nodeId: string): ProjectInspectorModel | undefined {
  const nodes = new Map(view.document.nodes.map(node => [node.id, node]));
  const node = nodes.get(nodeId), derived = view.derived[nodeId]; if (!node || !derived) return undefined;
  const runs = new Map(view.document.runs.map(run => [run.id, run]));
  const current = (id: string) => { const run = runs.get(view.derived[id]?.latest_run_id ?? ""); return run?.node_id === id && run.status !== "stale" ? run : undefined; };
  const run = current(nodeId), history = view.document.runs.filter(item => item.node_id === nodeId);
  const childrenByParent = new Map<string, EngineeringNode[]>();
  for (const item of view.document.nodes) if (item.parent_id && item.status !== "archived") childrenByParent.set(item.parent_id, [...childrenByParent.get(item.parent_id) ?? [], item]);
  const subtree = (id: string) => { const result: EngineeringNode[] = [], queue = nodes.has(id) ? [nodes.get(id)!] : [], seen = new Set<string>(); for (let at = 0; at < queue.length; at++) { const item = queue[at]; if (seen.has(item.id) || item.status === "archived") continue; seen.add(item.id); result.push(item); queue.push(...childrenByParent.get(item.id) ?? []); } return result; };
  const accepted = (id: string) => view.derived[id]?.status === "accepted" && current(id)?.status === "accepted";
  const children = ordered(childrenByParent.get(nodeId) ?? []).map(child => {
    const branch = subtree(child.id), leaves = branch.filter(item => !childrenByParent.get(item.id)?.length);
    return { node: child, status: nodeStatusLabel(view, child), accepted: accepted(child.id), review: view.derived[child.id]?.status === "review" && current(child.id)?.status === "review",
      leafAccepted: leaves.filter(item => accepted(item.id)).length, leafTotal: leaves.length,
      running: branch.filter(item => view.derived[item.id]?.status === "running" && realRunning(current(item.id))).map(item => ({ nodeId: item.id, title: item.title })) };
  });
  const attention = selectDescendantRunAttention(view, nodeId);
  const isParent = children.length > 0, running = attention.running.map(item => ({ nodeId: item.node.id, title: item.node.title })), allChildrenAccepted = isParent && children.every(child => child.accepted);
  const evidence = inspectorEvidence(node, run), actions = run?.snapshot.node.actions ?? node.actions;
  const actionCompleted = actions.filter(action => run?.completed_action_ids.includes(action.id)).length;
  const checking = realRunning(run) && (run?.current_action === "source-verification" || actions.some(action => action.id === run?.current_action && action.type === "check_file"));
  const currentAction = run?.current_action === "source-verification" ? "核对源工程变化并执行实际检查" : actions.find(action => action.id === run?.current_action)?.title ?? null;
  const historicalOnly = !run && history.length > 0, status = run?.status === "running" && !realRunning(run) ? "交接记录待核对" : nodeStatusLabel(view, node);
  const planReady = !!run || derived.status === "ready";
  const planNote = run ? `运行使用已冻结的方案第 ${run.snapshot.node.revision} 版。` : derived.status === "ready" ? "当前方案已标记就绪，仍按执行条件调度。" : !node.objective.trim() ? "先写清要得到什么结果。" : !node.method.trim() ? "目标已有记录，下一步补充具体做法。" : !node.criteria.length ? "目标与做法已有记录，还需验收条件。" : "目标、做法与验收已有记录，执行前需检查方案就绪。";
  const stages: InspectorStage[] = [{ id: "plan", title: "计划与边界", note: planNote, tone: planReady ? "done" : "current", tab: "plan" }];
  const reviewReminder = run?.status === "accepted" ? "人工验收结论见验收记录。" : "仍需人工验收。";
  if (isParent) {
    stages.push({ id: "children", title: "子项推进", note: `${children.filter(child => child.accepted).length} / ${children.length} 个直属子项已验收${running.length ? `；${running.length} 项下级运行记录正在执行` : ""}。`, tone: allChildrenAccepted ? "done" : running.length ? "current" : children.some(child => child.review || ["受阻", "需修改", "已暂停"].includes(child.status)) ? "attention" : "waiting", tab: "reading" });
    const missingIntegrationChecks = finishedExecution(run) && evidence.hasAutomatic && !evidence.checked;
    stages.push({ id: "integration", title: "本层整合", note: !run ? allChildrenAccepted ? "子项均已验收，本层尚未进行整合检查。" : "等待子项分别验收，再核对组合后的结果。" : run.mode !== "integration" ? "现有运行不是本层整合记录，请核对版本。" : checking ? "正在复跑组合后的实际源码检查。" : evidence.failed ? run.reason || "本层整合检查未通过。" : missingIntegrationChecks ? "整合已提交，但缺少完整的实际检查通过记录。" : finishedExecution(run) ? evidence.checked ? `本层整合的实际检查已通过，${reviewReminder}` : `整合结果已提交；本层未配置自动检查，${reviewReminder}` : run.reason || "已登记本层整合运行，等待执行条件。", tone: run?.mode === "integration" ? evidence.failed || missingIntegrationChecks ? "attention" : finishedExecution(run) ? "done" : run.status === "running" ? "current" : "waiting" : allChildrenAccepted ? "current" : "waiting", tab: "runs" });
  } else {
    const external = run?.mode === "external" || !run && (!!node.source_scope || node.actions.some(action => action.type === "agent_artifact"));
    if (external) stages.push({ id: "handoff", title: "交接与领取", note: !run ? "需交给真实负责人；当前尚无冻结交接。" : run.handoff?.state === "awaiting_claim" ? "交接包已冻结，实际负责人尚未领取。" : run.handoff?.state === "claimed" ? run.status === "queued" ? "负责人已领取，仍在等待执行条件。" : "已有负责人领取记录；执行状态以下方运行为准。" : "缺少明确领取记录，请核对实际交接。", tone: !run ? "waiting" : run.handoff?.state === "claimed" ? "done" : run.handoff?.state === "awaiting_claim" ? "current" : "attention", tab: "runs" });
    stages.push({ id: "execution", title: "执行与产出", note: !run ? "当前方案尚未开始运行。" : run.status === "queued" ? run.reason || "等待领取或调度，不计入正在执行。" : currentAction ? `当前动作：${currentAction}。` : actions.length ? `当前运行已记录 ${actionCompleted} / ${actions.length} 个动作完成。` : run.source_scope ? "本步核验实际源工程，不预先编写交付内容。" : "本次执行记录见运行详情。", tone: realRunning(run) && !checking ? "current" : finishedExecution(run) || realRunning(run) && run?.current_action === "source-verification" ? "done" : run && ["blocked", "paused", "rejected"].includes(run.status) && !evidence.failed ? "attention" : run?.status === "running" && !realRunning(run) ? "attention" : "waiting", tab: "actions" });
    stages.push({ id: "checks", title: "证据检查", note: checking ? "正在执行当前冻结范围的实际检查。" : evidence.failed ? run?.reason || "实际检查未通过，需核对失败证据。" : evidence.checked ? `本次 ${evidence.checksPassed} / ${evidence.checksTotal} 项实际检查通过，${reviewReminder}` : !evidence.hasAutomatic ? `未配置自动检查；${reviewReminder}` : `当前 ${evidence.checksPassed} / ${evidence.checksTotal} 项检查有通过记录，完整结论尚待提交。`, tone: evidence.failed ? "attention" : checking ? "current" : evidence.checked ? "done" : !evidence.hasAutomatic ? "unconfigured" : "waiting", tab: "runs" });
  }
  const ownAccepted = accepted(nodeId), reviewTone: InspectorTone = ownAccepted ? "done" : run?.status === "review" ? "current" : run?.status === "rejected" ? "attention" : "waiting";
  stages.push({ id: "review", title: isParent ? "本层人工验收" : "人工验收", note: ownAccepted ? "本层当前版本已有人工验收通过记录。" : run?.status === "rejected" ? run.review_note || "本次验收已退回，修订后需重新执行与验收。" : run?.status === "review" ? "当前运行已提交，请核对证据后明确通过或退回。" : isParent ? "子项通过不替代本层验收。" : "产物与自动检查不能替代人工验收。", tone: reviewTone, tab: "runs" });

  let summary = planNote;
  let next: ProjectInspectorModel["next"] = { label: "完善当前方案", tab: "plan" };
  if (node.status === "archived") { summary = "本项已归档，方案和历史证据仍可查阅。"; next = { label: "查看历史记录", tab: "history" }; }
  else if (historicalOnly) { summary = `当前方案没有有效运行；${history.length} 次历史运行保留，旧证据不计入当前验收。`; next = { label: "核对当前方案与历史", tab: "reading" }; }
  else if (derived.status === "paused") { summary = run?.reason || "本任务已暂停，先核对停止原因与当前方案。"; next = { label: "查看暂停记录", tab: run ? "runs" : "history" }; }
  else if (run?.status === "rejected") { summary = `验收已退回：${run.review_note || run.reason || "需要修订当前方案并重新执行。"}`; next = { label: "修订当前方案", tab: "plan" }; }
  else if (evidence.failed || run?.status === "blocked") { summary = run?.reason || "当前检查或执行受阻，请核对真实记录后处理。"; next = { label: "核对失败证据", tab: "runs" }; }
  else if (ownAccepted) { summary = "本层当前版本已通过人工验收，记录可追溯。"; next = { label: "查看验收依据", tab: "runs" }; }
  else if (run?.status === "review") { summary = isParent ? "子项整合已提交，等待本层人工验收。" : "本次运行已提交，等待逐条人工验收。"; next = { label: "查看证据并验收", tab: "runs" }; }
  else if (run?.status === "queued") { summary = run.mode === "external" && run.handoff?.state === "awaiting_claim" ? "待负责人领取：交接已冻结，尚未开始执行。" : run.mode === "external" && run.handoff?.state === "claimed" ? `负责人已领取，等待执行条件。${run.reason}` : run.reason || "运行已登记，等待调度条件。"; next = { label: "查看交接与等待条件", tab: "runs" }; }
  else if (run?.status === "running") { summary = !realRunning(run) ? "运行记录缺少明确领取信息，请先核对交接。" : checking ? "正在核对实际源文件或执行冻结的检查。" : currentAction ? `运行记录正在执行：${currentAction}。` : "当前运行记录为执行中，等待后续动作与证据。"; next = { label: "查看当前运行", tab: "runs" }; }
  else if (isParent) { summary = running.length > 1 ? `${running.length} 项下级运行记录同时处于执行中；各子项分别交付，本层随后独立整合验收。` : running.length === 1 ? `下级“${running[0].title}”正在执行，其余分支按各自条件推进。` : allChildrenAccepted ? "直属子项均已验收，本层仍需整合检查和人工验收。" : `${children.filter(child => child.accepted).length} / ${children.length} 个直属子项已验收，先分别核对各分支的结果。`; next = { label: allChildrenAccepted ? "查看本层执行条件" : "查看本层要求与分工", tab: "reading" }; }
  else if (derived.status === "ready") { summary = derived.blockers[0] || "方案已标记就绪，可核对负责人及调度条件。"; next = { label: "查看执行条件", tab: "reading" }; }
  if (isParent && attention.review.length && run?.status !== "review" && node.status !== "archived") {
    next = { label: `查看待验收结果（${attention.review.length}）`, tab: "runs", action: "review_list" };
  }
  return { node, status, path: derived.path.map(id => ({ id, title: nodes.get(id)?.title ?? id })), currentRun: run, historicalOnly, historyCount: history.filter(item => item.id !== run?.id).length, attempt: run ? history.findIndex(item => item.id === run.id) + 1 : null,
    isParent, stages, summary, next, evidence, children, running, descendantReviews: attention.review, acceptedChildren: children.filter(child => child.accepted).length, reviewChildren: children.filter(child => child.review).length,
    blockers: [...new Set([...(run?.reason && ["blocked", "paused", "rejected"].includes(run.status) ? [run.reason] : []), ...derived.blockers])], actionTotal: actions.length, actionCompleted, currentAction, inheritedRules: derived.effective.rules.filter(rule => rule.node_id !== nodeId) };
}
