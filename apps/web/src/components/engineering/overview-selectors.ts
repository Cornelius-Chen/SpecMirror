import type { EngineeringCriterion, EngineeringEvidence, EngineeringNode, EngineeringRun, EngineeringView } from "@epm/domain";
import { ordered } from "./shared.ts";

export const OVERVIEW_GRAPH_LIMIT = 16;
export const OVERVIEW_EDGE_LIMIT = 40;
export const OVERVIEW_LIST_PAGE = 20;
export interface NodeReadState { run?: EngineeringRun; produced: boolean; checked: boolean; checkFailed: boolean; accepted: boolean; historicalOnly: boolean; evidenceCount: number }
export interface ReadingIssue { node: EngineeringNode; reason: string; action: string; tab?: string; priority: number }
export interface OverviewIndex {
  view: EngineeringView; nodes: Map<string, EngineeringNode>; children: Map<string, EngineeringNode[]>;
  runs: Map<string, EngineeringRun>; historical: Set<string>; active: EngineeringNode[];
}
export function overviewIndex(view: EngineeringView): OverviewIndex {
  const active = view.document.nodes.filter(node => node.status !== "archived"), children = new Map<string, EngineeringNode[]>();
  for (const node of active) if (node.parent_id) children.set(node.parent_id, [...(children.get(node.parent_id) ?? []), node]);
  for (const [id, values] of children) children.set(id, ordered(values));
  return { view, nodes: new Map(view.document.nodes.map(node => [node.id, node])), children, runs: new Map(view.document.runs.map(run => [run.id, run])), historical: new Set(view.document.runs.map(run => run.node_id)), active };
}
export function subtreeNodes(index: OverviewIndex, id: string): EngineeringNode[] {
  const found = index.nodes.get(id); if (!found || found.status === "archived") return [];
  const result: EngineeringNode[] = [], queue = [found], seen = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor++) { const node = queue[cursor]; if (seen.has(node.id)) continue; seen.add(node.id); result.push(node); queue.push(...index.children.get(node.id) ?? []); }
  return result;
}
export function nodeReadState(index: OverviewIndex, id: string): NodeReadState {
  const derived = index.view.derived[id], run = derived?.latest_run_id ? index.runs.get(derived.latest_run_id) : undefined;
  const node = index.nodes.get(id);
  const checks = run?.evidence.filter(evidence => evidence.kind === "check") ?? [];
  const sourceChecks = [run?.source_proof, ...run?.source_integration_proofs ?? []].filter(proof => proof !== undefined);
  const checkFailed = checks.some(check => check.passed === false) || sourceChecks.some(proof => !proof.passed);
  const automaticComplete = (node?.criteria ?? []).filter(criterion => criterion.kind !== "manual").every(criterion => checks.some(check => check.criterion_id === criterion.id && check.passed === true));
  const sourceComplete = (!node?.source_scope || run?.source_proof?.passed === true) && (!run?.source_integration_scopes?.length || run.source_integration_proofs?.length === run.source_integration_scopes.length);
  const checked = Boolean(run && ["review", "accepted", "rejected"].includes(run.status)) && !checkFailed && automaticComplete && sourceComplete && (checks.length > 0 || sourceChecks.length > 0) && checks.every(check => check.passed === true) && sourceChecks.every(proof => proof.passed);
  return { run, produced: Boolean(run?.evidence.some(evidence => ["artifact", "capability"].includes(evidence.kind) && evidence.path && evidence.sha256) || run?.source_proof?.changes.length), checked, checkFailed,
    accepted: derived?.status === "accepted" && run?.status === "accepted", historicalOnly: !run && index.historical.has(id), evidenceCount: run?.evidence.length ?? 0 };
}
export function subtreeProgress(index: OverviewIndex, id: string) {
  const nodes = subtreeNodes(index, id), leaves = nodes.filter(node => !index.children.get(node.id)?.length), states = leaves.map(node => nodeReadState(index, node.id));
  return { total: leaves.length, produced: states.filter(state => state.produced).length, checked: states.filter(state => state.checked).length, accepted: states.filter(state => state.accepted).length, unresolved: nodes.filter(node => !nodeReadState(index, node.id).accepted).length };
}
export function currentReadingPhase(index: OverviewIndex, chosen?: string | null) {
  const phases = index.children.get(index.view.document.root_id) ?? [];
  const explicit = phases.find(phase => phase.id === chosen);
  const recent = [...phases].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.order - a.order || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))[0];
  return { phases, phase: explicit ?? recent ?? index.nodes.get(index.view.document.root_id), suggested: !explicit && Boolean(recent) };
}
export function readingIssues(index: OverviewIndex): ReadingIssue[] {
  return index.active.flatMap(node => {
    const derived = index.view.derived[node.id], state = nodeReadState(index, node.id), status = derived?.status ?? node.status;
    if (status === "accepted") return [];
    if (status === "review") return [{ node, reason: "当前运行已提交，仍需逐条人工核对。", action: "查看证据并验收", tab: "runs", priority: 0 }];
    if (["blocked", "needs_revision", "paused"].includes(status)) return [{ node, reason: state.run?.reason || derived?.blockers[0] || (state.historicalOnly ? "方案已有变化，历史证据不能作为当前版本交付。" : "需要核对停止原因并修订当前方案。"), action: state.run ? "核对运行情况" : "查看任务说明", ...(state.run ? { tab: "runs" } : {}), priority: 1 }];
    if (!node.criteria.length) return [{ node, reason: "尚未写出可以逐条核对的验收条件。", action: "补充验收条件", tab: "criteria", priority: 2 }];
    if (derived?.uncovered_criteria.length) return [{ node, reason: derived.uncovered_criteria.length + " 条验收条件还没有子任务承接。", action: "查看验收条件", tab: "criteria", priority: 3 }];
    if (state.historicalOnly) return [{ node, reason: "仅有旧版本运行记录，当前方案还没有有效证据。", action: "查看历史与当前方案", tab: "runs", priority: 4 }];
    if (!node.owner.trim() || node.owner === "未分配") return [{ node, reason: "还没有明确负责人，进入步骤后分配并核对执行条件。", action: "查看任务说明", priority: 5 }];
    if (state.run?.handoff?.state === "awaiting_claim") return [{ node, reason: "交接包已冻结，实际负责人尚未领取。", action: "查看交接包", tab: "runs", priority: 6 }];
    if (status !== "running" && derived?.blockers.length) return [{ node, reason: derived.blockers[0], action: "查看下一步", priority: 7 }];
    return [];
  }).sort((a, b) => a.priority - b.priority || a.node.order - b.node.order || a.node.id.localeCompare(b.node.id));
}

export interface DependencyLink { id: string; from: string; to: string; origin: string; inherited: boolean; crossPhase: boolean }
export interface LocalDependencyView { nodes: EngineeringNode[]; externalIds: Set<string>; links: DependencyLink[]; hiddenNodes: number; hiddenDescendants: number; hiddenPeers: number; hiddenExternalNodes: number; hiddenLinks: number; missingIds: string[]; totalPhaseNodes: number; levelTotal: number }
export function effectiveDependencyLinks(index: OverviewIndex, nodeId: string): DependencyLink[] {
  const path = index.view.derived[nodeId]?.path ?? [nodeId], links: DependencyLink[] = [];
  for (const origin of path) for (const prerequisite of index.nodes.get(origin)?.dependencies ?? []) links.push({ id: prerequisite + "→" + nodeId + "@" + origin, from: prerequisite, to: nodeId, origin, inherited: origin !== nodeId, crossPhase: false });
  return links;
}
export function localDependencyView(index: OverviewIndex, phaseId: string, maxNodes = OVERVIEW_GRAPH_LIMIT): LocalDependencyView {
  const branch = subtreeNodes(index, phaseId), children = index.children.get(phaseId) ?? [], level = children.length ? children : branch.slice(0, 1), phaseNodes = children.length ? branch.slice(1) : branch;
  const levelIds = new Set(level.map(node => node.id));
  const rootPhase = (id: string) => index.view.derived[id]?.path[1] ?? index.view.document.root_id;
  const bound = Math.max(2, Math.min(OVERVIEW_GRAPH_LIMIT, maxNodes)), inside = level.slice(0, Math.max(1, bound - 4)), insideIds = new Set(inside.map(node => node.id));
  const edges = new Map<string, DependencyLink>();
  for (const node of phaseNodes) for (const link of effectiveDependencyLinks(index, node.id)) edges.set(link.id, { ...link, crossPhase: rootPhase(link.from) !== rootPhase(link.to) });
  // Include downstream dependencies outside the focus without expanding the full project graph.
  for (const node of index.active) if (!levelIds.has(node.id)) for (const link of effectiveDependencyLinks(index, node.id)) if (levelIds.has(link.from)) edges.set(link.id, { ...link, crossPhase: rootPhase(link.from) !== rootPhase(link.to) });
  const branchIds = new Set(branch.map(node => node.id));
  // Descendant execution details stay folded. A deeper task is only a visible
  // neighbour when a task at this reading level explicitly needs it first.
  const all = [...edges.values()], adjacent = all.filter(link => insideIds.has(link.to) || (insideIds.has(link.from) && !branchIds.has(link.to)));
  const externalCandidates = [...new Set(adjacent.flatMap(link => [link.from, link.to]).filter(id => !levelIds.has(id)))];
  const external = externalCandidates.map(id => index.nodes.get(id)).filter((node): node is EngineeringNode => Boolean(node)).slice(0, bound - inside.length);
  const nodes = [...inside, ...external], visibleIds = new Set(nodes.map(node => node.id));
  const visible = all.filter(link => visibleIds.has(link.from) && visibleIds.has(link.to));
  const links = visible.slice(0, OVERVIEW_EDGE_LIMIT);
  return { nodes, externalIds: new Set(external.map(node => node.id)), links, hiddenNodes: phaseNodes.filter(node => !visibleIds.has(node.id)).length, hiddenDescendants: phaseNodes.filter(node => !levelIds.has(node.id) && !visibleIds.has(node.id)).length, hiddenPeers: level.length - inside.length, hiddenExternalNodes: externalCandidates.filter(id => index.nodes.has(id)).length - external.length, hiddenLinks: all.length - links.length,
    missingIds: [...new Set(all.flatMap(link => [link.from, link.to]).filter(id => !index.nodes.has(id)))], totalPhaseNodes: phaseNodes.length, levelTotal: level.length };
}

export interface AcceptanceContributor { node: EngineeringNode; state: NodeReadState }
export interface AcceptanceRow {
  id: string; owner: EngineeringNode; criterion: EngineeringCriterion; inherited: boolean;
  contributors: AcceptanceContributor[]; uncovered: boolean; direct: boolean;
  evidence: EngineeringEvidence[]; ownerState: NodeReadState; historicalOnly: boolean;
}
export function acceptanceRows(index: OverviewIndex, nodeId: string): AcceptanceRow[] {
  const path = index.view.derived[nodeId]?.path ?? [nodeId], target = index.nodes.get(nodeId); if (!target) return [];
  const result: AcceptanceRow[] = [];
  for (let level = path.length - 1; level >= 0; level--) {
    const owner = index.nodes.get(path[level]); if (!owner) continue;
    const inherited = owner.id !== nodeId, branch = inherited ? index.nodes.get(path[level + 1]) : undefined, children = index.children.get(owner.id) ?? [], ownerState = nodeReadState(index, owner.id);
    const criteria = inherited ? owner.criteria.filter(criterion => branch?.contributes_to.includes(criterion.id)) : owner.criteria;
    for (const criterion of criteria) {
      const direct = !inherited && !children.length;
      const contributors = direct ? [owner] : children.filter(child => child.contributes_to.includes(criterion.id) && (!inherited || child.id === branch?.id));
      result.push({ id: owner.id + "/" + criterion.id, owner, criterion, inherited, contributors: contributors.map(node => ({ node, state: nodeReadState(index, node.id) })), uncovered: children.length > 0 && contributors.length === 0, direct,
        evidence: ownerState.run?.evidence.filter(evidence => evidence.criterion_id === criterion.id) ?? [], ownerState, historicalOnly: ownerState.historicalOnly });
    }
  }
  return result;
}
