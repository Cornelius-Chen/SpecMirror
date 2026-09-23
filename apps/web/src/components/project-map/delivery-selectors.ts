import { engineeringDeliveryIssues, type EngineeringNode, type EngineeringView } from "@epm/domain";
import type { DependencyPoint, DependencyRect } from "../engineering/dependency-routing.ts";

export interface DeliveryInputView {
  id: string; title: string; sourceNodeId: string | null; sourceOutputId: string;
  sourceTitle: string; outputTitle: string; externalSource: string; problem: string;
}
export interface DeliveryConsumerView { id: string; nodeId: string; title: string; inputTitle: string; outputTitle: string; problem: string }
export interface DeliveryOutputView { id: string; title: string; criteria: EngineeringNode["criteria"]; missingCriteria: string[] }

/** Read the declared handoff, never turn a task's name or position into a dependency. */
export function projectDeliverySummary(view: EngineeringView, nodeId: string) {
  const nodes = new Map(view.document.nodes.map(node => [node.id, node]));
  const node = nodes.get(nodeId); if (!node) return undefined;
  const inputs: DeliveryInputView[] = (node.delivery?.inputs ?? []).map(input => {
    const source = input.source_node_id ? nodes.get(input.source_node_id) : undefined;
    const output = source?.delivery?.outputs.find(item => item.id === input.source_output_id);
    const problem = input.source_node_id
      ? !source ? "来源节点已不存在" : source.status === "archived" ? "来源节点已归档" : !output ? "来源成果已不存在或尚未声明" : input.external_source.trim() ? "节点来源与外部来源同时填写，需核对" : ""
      : !input.external_source.trim() ? "输入来源待补充" : input.source_output_id.trim() ? "外部输入仍引用节点成果，需核对" : "";
    return { id: input.id, title: input.title, sourceNodeId: source && source.status !== "archived" ? source.id : null, sourceOutputId: input.source_output_id,
      sourceTitle: source?.title ?? "", outputTitle: output?.title ?? "", externalSource: input.external_source, problem };
  });
  const outputs: DeliveryOutputView[] = (node.delivery?.outputs ?? []).map(output => ({ ...output,
    criteria: node.criteria.filter(criterion => output.criterion_ids.includes(criterion.id)),
    missingCriteria: output.criterion_ids.filter(id => !node.criteria.some(criterion => criterion.id === id)) }));
  const consumers: DeliveryConsumerView[] = view.document.nodes.filter(item => item.status !== "archived").flatMap(consumer => (consumer.delivery?.inputs ?? []).filter(input => input.source_node_id === nodeId).map(input => {
    const output = node.delivery?.outputs.find(item => item.id === input.source_output_id);
    return { id: consumer.id + ":" + input.id, nodeId: consumer.id, title: consumer.title, inputTitle: input.title, outputTitle: output?.title ?? "", problem: output ? "" : "所需成果已不存在或尚未声明" };
  }));
  const issues = engineeringDeliveryIssues(view.document, nodeId);
  const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
  return { node, configured: Boolean(node.delivery), inputs, outputs, consumers, issues,
    parentContribution: parent ? { nodeId: parent.id, title: parent.title, criteria: parent.criteria.filter(criterion => node.contributes_to.includes(criterion.id)), missingCriteria: node.contributes_to.filter(id => !parent.criteria.some(criterion => criterion.id === id)) } : undefined,
    declaredDependencies: node.dependencies.filter(id => !(node.delivery?.inputs ?? []).some(input => input.source_node_id === id)),
    // This describes the contract only. Actual acceptance always comes from existing run evidence.
    contractComplete: node.status !== "archived" && Boolean(node.delivery) && issues.length === 0 };
}

export interface DeliveryMapRelation {
  id: string; from: string; to: string; sourceNodeId: string; targetNodeId: string;
  inherited: boolean; projected: boolean; label: string; problem: string; renderable: boolean;
  kind: "input" | "prerequisite" | "interaction" | "dependency";
  ownerNodeId: string; relationId: string; detail: string;
}

export interface DeliveryMapRelationRollup {
  id: string; from: string; to: string; inherited: boolean; projected: boolean;
  label: string; problem: string; renderable: boolean; detail: string;
  kind: DeliveryMapRelation["kind"];
  members: readonly DeliveryMapRelation[];
}

/** Fold actual endpoints to visible ancestors, retaining both identities for explanation/navigation. */
export function projectDeliveryRelations(view: EngineeringView, visibleNodeIds: readonly string[]): DeliveryMapRelation[] {
  const nodes = new Map(view.document.nodes.map(node => [node.id, node])), visible = new Set(visibleNodeIds);
  const project = (id: string): string | undefined => {
    const visited = new Set<string>(); let node = nodes.get(id);
    while (node && node.status !== "archived" && !visited.has(node.id)) {
      if (visible.has(node.id)) return node.id;
      visited.add(node.id); node = node.parent_id ? nodes.get(node.parent_id) : undefined;
    }
    return undefined;
  };
  const relations: DeliveryMapRelation[] = [];
  const append = (ownerNodeId: string, relationId: string, kind: DeliveryMapRelation["kind"], sourceNodeId: string, targetNodeId: string, label: string, detail: string, issue = "") => {
    const source = nodes.get(sourceNodeId), target = nodes.get(targetNodeId), from = project(sourceNodeId), to = project(targetNodeId);
    const problem = !source || !target ? "关系端点已不存在" : source.status === "archived" || target.status === "archived" ? "关系端点已归档" : issue;
    const projected = from !== sourceNodeId || to !== targetNodeId;
    relations.push({ id: `${ownerNodeId}:${relationId}`, relationId, ownerNodeId, kind, sourceNodeId, targetNodeId, from: from ?? sourceNodeId, to: to ?? targetNodeId, inherited: projected, projected, label, detail, problem, renderable: Boolean(from && to && from !== to && !problem) });
  };
  for (const node of nodes.values()) {
    if (node.status === "archived") continue;
    for (const input of node.delivery?.inputs ?? []) if (input.source_node_id) {
      const source = nodes.get(input.source_node_id), output = source?.delivery?.outputs.find(item => item.id === input.source_output_id);
      append(node.id, `input:${input.id}`, "input", input.source_node_id, node.id, output?.title || "交接成果待说明", `用于：${input.title}。实际执行使用冻结的有效验收成果。`, output ? "" : "输入未对应有效成果");
    }
    for (const sourceId of node.dependencies) if (!node.delivery?.inputs.some(input => input.source_node_id === sourceId)) append(node.id, `dependency:${sourceId}`, "dependency", sourceId, node.id, "旧方案前置", "保留的硬等待关系；具体等待理由需要核对。");
    for (const prerequisite of node.prerequisites ?? []) append(node.id, `prerequisite:${prerequisite.id}`, "prerequisite", prerequisite.node_id, node.id, "开工前提", prerequisite.reason || "等待理由待说明");
    for (const interaction of node.interactions ?? []) append(node.id, `interaction:${interaction.id}`, "interaction", node.id, interaction.target_node_id, interaction.purpose || "使用联系", interaction.scenario || "组合场景待说明");
  }
  return relations;
}

/**
 * Draw one readable arrow for every directed pair of visible nodes. The atomic
 * declarations remain in `members`, so expanding the tree or opening the
 * relationship list never loses the underlying handoffs.
 */
export function rollupProjectDeliveryRelations(relations: readonly DeliveryMapRelation[]): DeliveryMapRelationRollup[] {
  const grouped = new Map<string, DeliveryMapRelation[]>();
  for (const relation of relations) {
    const key = JSON.stringify([relation.kind, relation.from, relation.to]);
    const members = grouped.get(key);
    if (members) members.push(relation); else grouped.set(key, [relation]);
  }
  return [...grouped.values()].map(members => {
    const first = members[0]!;
    const labels = [...new Set(members.map(member => member.label.trim()).filter(Boolean))]
      .sort((one, two) => Array.from(one).length - Array.from(two).length);
    const details = [...new Set(members.map(member => member.detail.trim()).filter(Boolean))];
    const problems = [...new Set(members.map(member => member.problem.trim()).filter(Boolean))];
    return {
      id: members.length === 1 ? first.id : `rollup:${first.kind}:${encodeURIComponent(first.from)}>${encodeURIComponent(first.to)}`,
      from: first.from,
      to: first.to,
      inherited: members.some(member => member.inherited),
      projected: members.some(member => member.projected),
      label: labels.join(" + ") || "成果联系待说明",
      problem: problems.join("；"),
      renderable: members.some(member => member.renderable),
      detail: details.join("；"),
      kind: members.every(member => member.kind === first.kind) ? first.kind : "interaction",
      members
    };
  });
}

/** Region overviews retain the declared members, but never resurrect a hidden
 * or invalid handoff just because both endpoints belong to different regions. */
export function projectZoneDeliveryRelations(relations: readonly DeliveryMapRelation[], zonesByNode: ReadonlyMap<string, { id: string; root_node_id: string }>, visibleNodeIds: ReadonlySet<string>): DeliveryMapRelationRollup[] {
  return rollupProjectDeliveryRelations(relations.flatMap(relation => {
    const source = zonesByNode.get(relation.sourceNodeId), target = zonesByNode.get(relation.targetNodeId);
    if (!source || !target || source.id === target.id) return [];
    const from = source.root_node_id, to = target.root_node_id;
    return [{ ...relation, from, to, projected: true,
      renderable: relation.renderable && !relation.problem && from !== to && visibleNodeIds.has(from) && visibleNodeIds.has(to) }];
  }));
}

/** Only a previously displayed page may finish exiting. Check original atomic
 * identities instead of projected IDs, which legitimately change on collapse. */
export function retainCollapsedDeliveryRelations(previous: readonly DeliveryMapRelationRollup[], current: readonly DeliveryMapRelation[], visibleNodeIds: ReadonlySet<string>): DeliveryMapRelationRollup[] {
  const byId = new Map(current.map(relation => [relation.id, relation]));
  return previous.filter(edge => (!visibleNodeIds.has(edge.from) || !visibleNodeIds.has(edge.to)) && edge.members.length > 0 && edge.members.every(member => {
    const valid = byId.get(member.id);
    return valid && !valid.problem && valid.sourceNodeId === member.sourceNodeId && valid.targetNodeId === member.targetNodeId;
  }));
}

/** Selection changes emphasis only; it never removes unrelated overview links. */
export function deliveryRelationTouchesNode(relation: DeliveryMapRelationRollup, selectedNodeId: string, rootNodeId: string) {
  return selectedNodeId === rootNodeId || relation.from === selectedNodeId || relation.to === selectedNodeId
    || relation.members.some(member => member.sourceNodeId === selectedNodeId || member.targetNodeId === selectedNodeId);
}

/** Place short labels in existing whitespace; the relationship list always keeps the full text. */
export function deliveryRelationLabel(points: readonly DependencyPoint[], label: string, obstacles: readonly DependencyRect[], width: number, height: number, occupied: readonly DependencyRect[] = []) {
  const text = Array.from(label).length > 18 ? Array.from(label).slice(0, 17).join("") + "…" : label;
  const labelWidth = Array.from(text).reduce((total, char) => total + (/[^\x00-\xff]/.test(char) ? 12 : 7), 14), labelHeight = 22;
  if (width < labelWidth + 12 || height < labelHeight + 12) return undefined;
  const blockers = [...obstacles, ...occupied], padding = 4, canvasPadding = 6;
  const overlaps = (rect: DependencyRect, item: DependencyRect) => rect.left < item.right + padding && rect.right > item.left - padding && rect.top < item.bottom + padding && rect.bottom > item.top - padding;
  const place = (x: number, y: number, anchor: DependencyPoint, leader = false) => {
    const rect = { id: "label", left: x, right: x + labelWidth, top: y, bottom: y + labelHeight };
    if (rect.left < canvasPadding || rect.right > width - canvasPadding || rect.top < canvasPadding || rect.bottom > height - canvasPadding || blockers.some(item => overlaps(rect, item))) return undefined;
    const target = { x: Math.max(rect.left, Math.min(rect.right, anchor.x)), y: Math.max(rect.top, Math.min(rect.bottom, anchor.y)) };
    const connector = leader && (target.x !== anchor.x || target.y !== anchor.y) ? `M ${anchor.x} ${anchor.y} L ${target.x} ${target.y}` : undefined;
    return { x, y, width: labelWidth, height: labelHeight, text, rect, connector };
  };
  const segments = points.slice(1).map((b, index) => ({ a: points[index], b, length: Math.abs(b.x - points[index].x) + Math.abs(b.y - points[index].y) })).sort((a, b) => b.length - a.length);
  for (const { a, b } of segments) for (const fraction of [.5, .3, .7]) for (const offset of [0, -labelWidth / 2 - 8, labelWidth / 2 + 8]) {
    const anchor = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
    const x = Math.max(canvasPadding, Math.min(width - labelWidth - canvasPadding, anchor.x - labelWidth / 2 + offset)), y = anchor.y - labelHeight / 2;
    const placed = place(x, y, anchor, offset !== 0); if (placed) return placed;
  }
  // A short handoff between adjacent cards cannot hold its label on the line.
  // Search all four neighbouring bands and choose the one needing the shortest
  // leader; restricting the fallback to the segment's normal can hide a label
  // when that pair of sides is occupied but another nearby side is free.
  for (const { a, b } of segments) for (const fraction of [.5, .3, .7]) {
    const anchor = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
    const centeredX = Math.max(canvasPadding, Math.min(width - labelWidth - canvasPadding, anchor.x - labelWidth / 2));
    const centeredY = Math.max(canvasPadding, Math.min(height - labelHeight - canvasPadding, anchor.y - labelHeight / 2));
    const candidates = [
      { x: centeredX, y: anchor.y - labelHeight - 8 },
      { x: centeredX, y: anchor.y + 8 },
      { x: anchor.x - labelWidth - 8, y: centeredY },
      { x: anchor.x + 8, y: centeredY },
      ...blockers.filter(item => centeredX < item.right + padding && centeredX + labelWidth > item.left - padding)
        .flatMap(item => [{ x: centeredX, y: item.top - labelHeight - padding }, { x: centeredX, y: item.bottom + padding }]),
      ...blockers.filter(item => centeredY < item.bottom + padding && centeredY + labelHeight > item.top - padding)
        .flatMap(item => [{ x: item.left - labelWidth - padding, y: centeredY }, { x: item.right + padding, y: centeredY }])
    ].filter((candidate, index, values) => values.findIndex(item => item.x === candidate.x && item.y === candidate.y) === index)
      .map((candidate, order) => {
        const targetX = Math.max(candidate.x, Math.min(candidate.x + labelWidth, anchor.x));
        const targetY = Math.max(candidate.y, Math.min(candidate.y + labelHeight, anchor.y));
        return { ...candidate, order, distance: Math.hypot(targetX - anchor.x, targetY - anchor.y) };
      })
      .sort((one, two) => one.distance - two.distance || one.order - two.order);
    for (const candidate of candidates) { const placed = place(candidate.x, candidate.y, anchor, true); if (placed) return placed; }
  }
  return undefined;
}
