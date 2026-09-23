import type { EngineeringNode, EngineeringView } from "@epm/domain";
import { engineeringFeedbackTargetExists, type EngineeringFeedback, type EngineeringFeedbackTarget } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { engineeringNodeName } from "../engineering/node-names.ts";
import { overviewIndex, subtreeNodes } from "../engineering/overview-selectors.ts";
import { projectDeliveryRelations, type DeliveryMapRelation } from "./delivery-selectors.ts";
import { graphFeedbackRecordStatus } from "./feedback-status.ts";
import { inspectorEvidence } from "./inspector-selectors.ts";

export type GraphAttentionTag = "attention" | "improvement" | "feedback";
export type GraphAttentionFilter = "all" | GraphAttentionTag;
export interface GraphAttentionItem {
  id: string; nodeId: string; target: EngineeringFeedbackTarget; tags: GraphAttentionTag[];
  tone: "problem" | "review" | "suggestion" | "unknown";
  label: string; detail: string; source: "run" | "contract" | "feedback" | "observation";
  runId?: string; feedbackId?: string; relationId?: string; scopeGroupId?: string; nodeIds?: string[];
}
export interface GraphAttentionCounts { all: number; attention: number; improvement: number; feedback: number }
export interface GraphNodeAttention {
  ownItems: GraphAttentionItem[]; descendantItems: GraphAttentionItem[]; subtreeItems: GraphAttentionItem[];
  ownCounts: GraphAttentionCounts; descendantCounts: GraphAttentionCounts; subtreeCounts: GraphAttentionCounts;
}
export interface GraphAttentionModel {
  items: GraphAttentionItem[]; byNode: Map<string, GraphNodeAttention>;
  byRelation: Map<string, GraphAttentionItem[]>; totals: GraphAttentionCounts;
}

const uniqueItems = (items: readonly GraphAttentionItem[]) => {
  const result = new Map<string, GraphAttentionItem>();
  for (const item of items) {
    const previous = result.get(item.id);
    result.set(item.id, previous ? { ...(byPriority(previous, item) <= 0 ? previous : item), tags: [...new Set([...previous.tags, ...item.tags])] } : item);
  }
  return [...result.values()];
};
export function graphAttentionCounts(items: readonly GraphAttentionItem[]): GraphAttentionCounts {
  const unique = uniqueItems(items);
  return { all: unique.length, attention: unique.filter(item => item.tags.includes("attention")).length,
    improvement: unique.filter(item => item.tags.includes("improvement")).length, feedback: unique.filter(item => item.tags.includes("feedback")).length };
}
const short = (text: string, limit = 18) => { const chars = Array.from(text.trim().replace(/\s+/g, " ")); return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : chars.join(""); };
const byPriority = (a: GraphAttentionItem, b: GraphAttentionItem) => ({ problem: 0, review: 1, unknown: 2, suggestion: 3 }[a.tone] - { problem: 0, review: 1, unknown: 2, suggestion: 3 }[b.tone]) || a.id.localeCompare(b.id);

/** Summarize recorded facts only. Draft omissions and ordinary dependency waits are not failures. */
export function selectGraphAttention(view: EngineeringView, options: { observationUnavailable?: boolean } = {}): GraphAttentionModel {
  const index = overviewIndex(view), items: GraphAttentionItem[] = [];
  const add = (node: EngineeringNode, key: string, item: Omit<GraphAttentionItem, "id" | "nodeId" | "target"> & { target?: EngineeringFeedbackTarget }) => {
    items.push({ id: `${node.id}:${key}`, nodeId: node.id, target: { kind: "node", node_id: node.id }, ...item });
  };
  const currentRun = (node: EngineeringNode) => {
    const run = index.runs.get(view.derived[node.id]?.latest_run_id ?? "");
    return run?.node_id === node.id && run.status !== "stale" ? run : undefined;
  };
  for (const node of index.active) {
    const derived = view.derived[node.id], run = currentRun(node);
    const status = derived?.status ?? node.status;
    if (run) {
      const observation = view.observation?.runs[run.id];
      const unknown = run.status === "running" && (options.observationUnavailable || run.mode === "external" && (run.handoff?.state !== "claimed" || !!view.observation && !["current", "local"].includes(observation?.state ?? "unobserved")));
      if (unknown) add(node, "observation", { tags: [], tone: "unknown", label: "状态待更新", detail: observation?.message || "当前运行缺少有效的执行观测，暂不能确认实际进度。", source: "observation", runId: run.id });
      // Failed evidence belongs to this resolved run, never to an old accepted/rejected attempt.
      const failed = inspectorEvidence(node, run).failed;
      if (run.status === "rejected") add(node, "run", { tags: ["attention"], tone: "problem", label: "验收退回", detail: run.review_note || run.reason || "本次交付已被退回，需要修改后重新提交。", source: "run", runId: run.id });
      else if (failed || run.status === "blocked") add(node, "run", { tags: ["attention"], tone: "problem", label: failed ? "检查未通过" : "执行受阻", detail: run.reason || "当前运行记录需要核对，相关证据尚未通过。", source: "run", runId: run.id });
      else if (run.status === "review" && status === "review") add(node, "run", { tags: ["attention"], tone: "review", label: "成果待查收", detail: "当前版本已有提交记录，尚未通过人工验收。", source: "run", runId: run.id });
      else if (run.status === "paused") add(node, "run", { tags: ["attention"], tone: "review", label: "已暂停", detail: run.reason || "当前运行已暂停，请核对暂停原因。", source: "run", runId: run.id });
    } else if (status === "blocked") add(node, "blocked", { tags: ["attention"], tone: "problem", label: "本项受阻", detail: "本项已明确标记为受阻，需要核对当前原因。", source: "contract" });
    else if (status === "needs_revision") add(node, "revision", { tags: ["attention"], tone: "review", label: index.historical.has(node.id) ? "当前版本待重新交付" : "需要修改", detail: index.historical.has(node.id) ? "已有运行仅属于历史版本，不能作为当前方案的验收依据。" : "当前方案已标记为需要修改。", source: "contract" });
    else if (status === "paused") add(node, "paused", { tags: ["attention"], tone: "review", label: "已暂停", detail: "本项已明确暂停，需要核对暂停原因。", source: "contract" });

    const children = index.children.get(node.id) ?? [];
    // An established responsibility map can have a real coverage gap; an empty draft is not one.
    const coverageDeclared = Boolean(node.composition || node.delivery || children.some(child => child.contributes_to.length));
    if (children.length && coverageDeclared && derived?.uncovered_criteria.length) add(node, "coverage", { tags: ["attention"], tone: "review", label: `${derived.uncovered_criteria.length} 项成果无人承接`, detail: derived.uncovered_criteria.map(id => node.criteria.find(criterion => criterion.id === id)?.text ?? id).join("；"), source: "contract" });
    const ownAccepted = status === "accepted" && run?.status === "accepted";
    if (children.length && !ownAccepted && !run && children.every(child => view.derived[child.id]?.status === "accepted" && currentRun(child)?.status === "accepted")) add(node, "integration", { tags: ["attention"], tone: "review", label: "整体仍待验收", detail: "直属子项均已验收，本层还没有有效的整合交付；子项通过不代表整个项目能用。", source: "contract" });
    for (const output of node.delivery?.outputs ?? []) if (output.criterion_ids.some(id => !node.criteria.some(criterion => criterion.id === id))) add(node, `output:${output.id}`, { tags: ["attention"], tone: "problem", label: "成果条件已失效", detail: `“${output.title || output.id}”引用的完成条件已不存在。`, source: "contract", target: { kind: "output", node_id: node.id, id: output.id } });
  }

  const relations = projectDeliveryRelations(view, index.active.map(node => node.id));
  for (const relation of relations) {
    const owner = index.nodes.get(relation.ownerNodeId)!;
    const source = index.nodes.get(relation.sourceNodeId), target = index.nodes.get(relation.targetNodeId);
    let problem = !source || !target ? "关系端点已不存在" : source.status === "archived" || target.status === "archived" ? "关系端点已归档" : "";
    if (!problem && relation.kind === "input") {
      const input = owner.delivery?.inputs.find(item => `input:${item.id}` === relation.relationId);
      if (input?.source_output_id && !source?.delivery?.outputs.some(output => output.id === input.source_output_id)) problem = "交接引用的成果已不存在";
      else if (input?.external_source.trim()) problem = "交接同时指定了节点与外部来源";
    }
    if (!problem && relation.kind === "interaction") {
      const interaction = owner.interactions?.find(item => `interaction:${item.id}` === relation.relationId);
      if (interaction?.source_output_id && !owner.delivery?.outputs.some(output => output.id === interaction.source_output_id)) problem = "配合引用的输出已不存在";
      else if (interaction?.target_input_id && !target?.delivery?.inputs.some(input => input.id === interaction.target_input_id)) problem = "配合引用的接收输入已不存在";
    }
    if (problem) add(owner, `relation:${relation.relationId}`, { tags: ["attention"], tone: "problem", label: "联系需修复", detail: problem, source: "contract", relationId: relation.id, target: { kind: "relation", node_id: owner.id, id: relation.relationId } });
  }

  type ScopedFeedback = EngineeringFeedback & { scope_node_ids?: string[]; scope_feedback_ids?: string[]; scope_group_id?: string };
  const feedbacks: ScopedFeedback[] = view.document.feedbacks ?? [], feedbackById = new Map(feedbacks.map(feedback => [feedback.id, feedback]));
  const groupItems = new Map<string, GraphAttentionItem>();
  for (const feedback of feedbacks) {
    const targetNode = index.nodes.get(feedback.target.node_id);
    const node = targetNode?.status !== "archived" ? targetNode : feedback.scope_node_ids?.map(id => index.nodes.get(id)).find(item => item && item.status !== "archived");
    if (!node || node.status === "archived") continue;
    const status = graphFeedbackRecordStatus(view, feedback, options), closed = status.closed, improvement = feedback.kind === "requirement_change";
    const tags: GraphAttentionTag[] = ["feedback"];
    if (!closed) tags.push(improvement ? "improvement" : "attention");
    if (!closed && status.tone === "review" && !tags.includes("attention")) tags.push("attention");
    const group = feedback.scope_group_id ? feedbackById.get(feedback.scope_group_id) : undefined;
    const validGroup = group?.scope_node_ids?.includes(node.id) && group.scope_feedback_ids?.includes(feedback.id) ? group : undefined;
    const item: GraphAttentionItem = { id: `feedback:${validGroup?.id ?? feedback.id}`, nodeId: node.id, tags, tone: closed || improvement && status.tone !== "review" ? "suggestion" : "review", label: `${status.label}：${short(feedback.note)}`, detail: `${feedback.note}\n${status.label}：${status.detail}${engineeringFeedbackTargetExists(view.document, feedback.target) ? "" : "；原反馈位置已有变化，请核对原记录。"}`, source: "feedback", target: feedback.target, feedbackId: feedback.id, ...(validGroup ? { scopeGroupId: validGroup.id } : {}), ...(feedback.target.kind === "relation" ? { relationId: `${node.id}:${feedback.target.id}` } : {}) };
    if (feedback.scope_node_ids?.length) {
      item.nodeIds = feedback.scope_node_ids.filter(id => index.nodes.has(id) && index.nodes.get(id)?.status !== "archived");
      groupItems.set(item.id, item);
      // Local actions must open the real child opinion and its own revision-bound lifecycle.
      for (const id of item.nodeIds) if (!feedback.scope_feedback_ids?.some(childId => { const child = feedbackById.get(childId); return child?.scope_group_id === feedback.id && child.target.node_id === id; })) items.push({ ...item, nodeId: id, target: { kind: "node", node_id: id } });
    } else items.push(item);
  }

  const unique = uniqueItems(items).map(item => { const group = groupItems.get(item.id); return group ? { ...group, tags: item.tags, tone: item.tone } : item; }).sort(byPriority), own = new Map<string, GraphAttentionItem[]>(), descendants = new Map<string, GraphAttentionItem[]>(), byRelation = new Map<string, GraphAttentionItem[]>();
  for (const item of items) {
    own.set(item.nodeId, [...own.get(item.nodeId) ?? [], item]);
    if (item.relationId) byRelation.set(item.relationId, [...byRelation.get(item.relationId) ?? [], item]);
    const seen = new Set([item.nodeId]); let parentId = index.nodes.get(item.nodeId)?.parent_id;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId); const parent = index.nodes.get(parentId); if (!parent || parent.status === "archived") break;
      descendants.set(parentId, [...descendants.get(parentId) ?? [], item]); parentId = parent.parent_id;
    }
  }
  const byNode = new Map(index.active.map(node => {
    const ownItems = uniqueItems(own.get(node.id) ?? []).sort(byPriority), descendantItems = uniqueItems(descendants.get(node.id) ?? []).sort(byPriority), subtreeItems = uniqueItems([...ownItems, ...descendantItems]).sort(byPriority);
    return [node.id, { ownItems, descendantItems, subtreeItems, ownCounts: graphAttentionCounts(ownItems), descendantCounts: graphAttentionCounts(descendantItems), subtreeCounts: graphAttentionCounts(subtreeItems) }];
  }));
  return { items: unique, byNode, byRelation, totals: graphAttentionCounts(unique) };
}

/** Matching is a highlight/navigation set. It never removes branches from the source view. */
export function selectGraphMatches(model: GraphAttentionModel, view: EngineeringView, options: { filter: GraphAttentionFilter; query?: string; nodeNames?: Record<string, string> }) {
  const query = (options.query ?? "").trim().toLocaleLowerCase(), index = overviewIndex(view);
  const filtered = model.items.filter(item => options.filter === "all" || item.tags.includes(options.filter));
  const matchingNodeIds = new Set<string>(), ancestorNodeIds = new Set<string>();
  const itemsByNode = new Map<string, GraphAttentionItem[]>();
  const nameMatches = new Set(index.active.filter(node => !query || [node.title, engineeringNodeName(node, options.nodeNames), node.objective, ...node.delivery?.outputs.map(output => output.title) ?? []].some(text => text.toLocaleLowerCase().includes(query))).map(node => node.id));
  const locations = (item: GraphAttentionItem) => (item.nodeIds ?? [item.nodeId]).filter(id => {
    const matchesFilter = options.filter === "all" || !item.nodeIds || model.byNode.get(id)?.ownItems.some(local => local.id === item.id && local.tags.includes(options.filter as GraphAttentionTag));
    return matchesFilter && (!query || nameMatches.has(id) || [item.label, item.detail].some(text => text.toLocaleLowerCase().includes(query)));
  });
  const items = filtered.filter(item => locations(item).length);
  if (options.filter === "all") for (const id of nameMatches) matchingNodeIds.add(id);
  for (const item of items) for (const id of locations(item)) {
    matchingNodeIds.add(id);
    // A range has one summary but each matching node opens its own exact record.
    const local = model.byNode.get(id)?.ownItems.find(entry => entry.id === item.id) ?? item;
    itemsByNode.set(id, [...itemsByNode.get(id) ?? [], local]);
  }
  for (const id of matchingNodeIds) {
    const seen = new Set([id]); let parentId = index.nodes.get(id)?.parent_id;
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = index.nodes.get(parentId); if (!parent || parent.status === "archived") break; ancestorNodeIds.add(parentId); parentId = parent.parent_id; }
  }
  return { matchingNodeIds, ancestorNodeIds, items, itemsByNode };
}

export interface GraphContext {
  scopeNodeIds: Set<string>; relatedNodeIds: Set<string>; ancestorNodeIds: Set<string>;
  upstreamNodeIds: Set<string>; downstreamNodeIds: Set<string>;
  projectedNodeIds: Set<string>; relationIds: Set<string>; relations: DeliveryMapRelation[];
}

/** Only declared adjacent relationships. This is context, not a computed rework or scheduling plan. */
export function selectGraphContext(view: EngineeringView, nodeId: string, visibleNodeIds: readonly string[]): GraphContext {
  const index = overviewIndex(view), scopeNodeIds = new Set(subtreeNodes(index, nodeId).map(node => node.id));
  const relations = projectDeliveryRelations(view, visibleNodeIds).filter(relation => scopeNodeIds.has(relation.sourceNodeId) || scopeNodeIds.has(relation.targetNodeId));
  const upstreamNodeIds = new Set<string>(), downstreamNodeIds = new Set<string>(), relatedNodeIds = new Set(scopeNodeIds), projectedNodeIds = new Set<string>(), ancestorNodeIds = new Set<string>();
  for (const relation of relations) {
    if (!scopeNodeIds.has(relation.sourceNodeId) && index.nodes.get(relation.sourceNodeId)?.status !== "archived" && index.nodes.has(relation.sourceNodeId)) upstreamNodeIds.add(relation.sourceNodeId);
    if (!scopeNodeIds.has(relation.targetNodeId) && index.nodes.get(relation.targetNodeId)?.status !== "archived" && index.nodes.has(relation.targetNodeId)) downstreamNodeIds.add(relation.targetNodeId);
    for (const id of [relation.sourceNodeId, relation.targetNodeId]) if (index.nodes.has(id) && index.nodes.get(id)?.status !== "archived") relatedNodeIds.add(id);
    for (const id of [relation.from, relation.to]) if (visibleNodeIds.includes(id)) projectedNodeIds.add(id);
  }
  for (const id of relatedNodeIds) {
    const seen = new Set([id]); let parentId = index.nodes.get(id)?.parent_id;
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = index.nodes.get(parentId); if (!parent || parent.status === "archived") break; ancestorNodeIds.add(parentId); parentId = parent.parent_id; }
  }
  for (const id of visibleNodeIds) if (relatedNodeIds.has(id)) projectedNodeIds.add(id);
  return { scopeNodeIds, relatedNodeIds, ancestorNodeIds, upstreamNodeIds, downstreamNodeIds, projectedNodeIds, relationIds: new Set(relations.map(relation => relation.id)), relations };
}
