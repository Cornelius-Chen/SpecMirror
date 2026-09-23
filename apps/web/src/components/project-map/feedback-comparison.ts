import type { EngineeringChange, EngineeringNode, EngineeringRun, EngineeringView } from "@epm/domain";
import type { EngineeringFeedback } from "../../../../../packages/domain/src/engineering-feedback.ts";

export interface FeedbackChangeField { id: string; label: string; before: string; after: string }
export interface FeedbackImpactNode { id: string; title: string; archived: boolean }
export interface FeedbackComparison {
  state: "none" | "recorded" | "historical" | "missing";
  change?: EngineeringChange;
  fields: FeedbackChangeField[];
  affected: FeedbackImpactNode[];
  currentAfter: boolean;
}
export interface FeedbackArtifact {
  id: string; title: string; path: string; sha256: string;
}
export interface FeedbackResult {
  state: "none" | "current" | "historical" | "missing";
  run?: EngineeringRun;
  label: string;
  artifacts: FeedbackArtifact[];
}

const text = (value: string | undefined) => value?.trim() || "未说明";
const list = (values: readonly string[]) => values.filter(Boolean).join("、") || "无";
const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const sourceName = (view: EngineeringView, id: string | null) => id ? view.document.nodes.find(node => node.id === id)?.title || "原来源已变化" : "外部来源";

function readableFields(view: EngineeringView, before: EngineeringNode, after: EngineeringNode): FeedbackChangeField[] {
  const fields: Array<{ id: string; label: string; before: unknown; after: unknown; show: (node: EngineeringNode) => string }> = [
    { id: "title", label: "名称", before: before.title, after: after.title, show: node => text(node.title) },
    { id: "objective", label: "目标", before: before.objective, after: after.objective, show: node => text(node.objective) },
    { id: "outputs", label: "交付成果", before: before.delivery?.outputs, after: after.delivery?.outputs, show: node => list((node.delivery?.outputs ?? []).map(item => item.title || "未命名成果")) },
    { id: "inputs", label: "所需输入", before: before.delivery?.inputs, after: after.delivery?.inputs, show: node => list((node.delivery?.inputs ?? []).map(item => `${item.title || "未命名输入"}（${item.source_node_id ? sourceName(view, item.source_node_id) : item.external_source || "来源待补"}）`)) },
    { id: "prerequisites", label: "开工前提", before: [before.dependencies, before.prerequisites], after: [after.dependencies, after.prerequisites], show: node => list([...(node.dependencies ?? []).map(id => sourceName(view, id)), ...(node.prerequisites ?? []).map(item => item.reason || sourceName(view, item.node_id))]) },
    { id: "interactions", label: "使用配合", before: before.interactions, after: after.interactions, show: node => list((node.interactions ?? []).map(item => item.purpose || item.scenario || sourceName(view, item.target_node_id))) },
    { id: "bounds", label: "负责边界", before: [before.delivery?.included, before.delivery?.excluded, before.constraints], after: [after.delivery?.included, after.delivery?.excluded, after.constraints], show: node => `负责：${list(node.delivery?.included ?? [])}；不负责：${list(node.delivery?.excluded ?? [])}` },
    { id: "criteria", label: "完成条件", before: before.criteria, after: after.criteria, show: node => list(node.criteria.map(item => item.text)) },
    { id: "composition", label: "组成关系", before: [before.parent_id, before.contributes_to, before.contribution, before.composition], after: [after.parent_id, after.contributes_to, after.contribution, after.composition], show: node => text(node.contribution?.summary || node.composition?.summary) }
  ];
  return fields.filter(field => !same(field.before, field.after)).map(field => ({ id: field.id, label: field.label, before: field.show(before), after: field.show(after) }));
}

/** Read an already recorded change. The stored affected_ids are authoritative; no impact is inferred here. */
export function projectFeedbackComparison(view: EngineeringView, feedback: EngineeringFeedback): FeedbackComparison {
  if (!feedback.adopted_change_id) return { state: "none", fields: [], affected: [], currentAfter: false };
  const change = view.document.changes.find(item => item.id === feedback.adopted_change_id);
  if (!change || change.node_id !== feedback.target.node_id || change.before.id !== feedback.target.node_id || change.after.id !== feedback.target.node_id) {
    return { state: "missing", fields: [], affected: [], currentAfter: false };
  }
  const current = view.document.nodes.find(node => node.id === change.node_id);
  const affected = [...new Set(change.affected_ids)].map(id => {
    const node = view.document.nodes.find(item => item.id === id);
    return { id, title: node?.title || (id === change.before.id ? change.before.title : "原影响位置已变化"), archived: !node || node.status === "archived" };
  });
  const currentAfter = Boolean(current && current.status !== "archived" && current.revision === change.after.revision);
  return { state: currentAfter ? "recorded" : "historical", change, fields: readableFields(view, change.before, change.after), affected, currentAfter };
}

/** Only a run explicitly linked to this exact feedback and node can supply openable results. */
export function projectFeedbackArtifacts(view: EngineeringView, feedback: EngineeringFeedback): FeedbackResult {
  if (!feedback.submitted_run_id) return { state: "none", label: "尚无关联交付", artifacts: [] };
  const run = view.document.runs.find(item => item.id === feedback.submitted_run_id);
  if (!run || run.node_id !== feedback.target.node_id) return { state: "missing", label: "原交付记录已变化", artifacts: [] };
  const current = view.derived[run.node_id]?.latest_run_id === run.id && run.status !== "stale";
  const artifacts = [...new Map(run.evidence.filter(item => ["artifact", "capability"].includes(item.kind) && item.path && item.sha256)
    .map(item => [item.path + ":" + item.sha256, { id: item.id, title: item.summary || item.path!.split(/[\\/]/).at(-1)!, path: item.path!, sha256: item.sha256! }])).values()];
  const label = current
    ? run.status === "accepted" ? "已记录验收，当前材料待核对" : run.status === "review" ? "已修改，等待你查看" : run.status === "blocked" || run.status === "rejected" ? "本次交付未通过" : "本次交付仍在处理中"
    : "这是历史交付，当前结果需另行核对";
  return { state: current ? "current" : "historical", run, label, artifacts };
}
