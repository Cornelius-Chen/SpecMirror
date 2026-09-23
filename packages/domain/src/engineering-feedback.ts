import { z } from "zod";
import { currentEngineeringRun, engineeringContractKey, engineeringLineage, engineeringLineageVersions, type EngineeringDocument, type EngineeringNode } from "./engineering.ts";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
const Note = z.string().trim().min(1).max(12000);
const ScopeNodeIds = z.array(Id).min(2).max(80).refine(ids => new Set(ids).size === ids.length, "反馈范围不能重复选择同一节点。");
export const EngineeringFeedbackTargetSchema = z.object({
  kind: z.enum(["node", "relation", "output", "criterion"]), node_id: Id,
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,339}$/).optional()
}).refine(target => target.kind === "node" || !!target.id, "请指定反馈对应的关系、成果或完成条件。");
export type EngineeringFeedbackTarget = z.infer<typeof EngineeringFeedbackTargetSchema>;
export const EngineeringFeedbackCreateSchema = z.object({
  expected_revision: z.number().int().positive(), base_node_revision: z.number().int().positive(),
  target: EngineeringFeedbackTargetSchema, kind: z.enum(["defect", "requirement_change"]), note: Note,
  scope_node_ids: ScopeNodeIds.optional()
}).strict().refine(value => !value.scope_node_ids || value.target.kind === "node", "多项反馈必须指定共同上级节点，不能扩大某条关系或成果的范围。");
export type EngineeringFeedbackCreate = z.infer<typeof EngineeringFeedbackCreateSchema>;
export const EngineeringFeedbackUpdateSchema = z.object({
  expected_revision: z.number().int().positive(),
  action: z.enum(["adopt", "working", "submit", "resolve", "dismiss", "reopen"]),
  note: Note, change_id: Id.optional(), run_id: Id.optional()
}).strict();
export type EngineeringFeedbackUpdate = z.infer<typeof EngineeringFeedbackUpdateSchema>;

const Lineage = z.array(z.object({ id: Id, revision: z.number().int().positive() }));
export const EngineeringFeedbackScopeSnapshotSchema = z.array(z.object({
  node_id: Id, title: Note, node_revision: z.number().int().positive(), contract_key: z.string(),
  lineage: Lineage, run_id: Id.nullable(), target_snapshot: z.string()
})).min(2).max(80);
export type EngineeringFeedbackScopeSnapshot = z.infer<typeof EngineeringFeedbackScopeSnapshotSchema>;
export const EngineeringFeedbackSchema = z.object({
  id: Id, target: EngineeringFeedbackTargetSchema, kind: z.enum(["defect", "requirement_change"]), note: Note,
  scope_node_ids: ScopeNodeIds.optional(), scope_snapshot: EngineeringFeedbackScopeSnapshotSchema.optional(),
  scope_feedback_ids: ScopeNodeIds.optional(), scope_group_id: Id.optional(),
  status: z.enum(["open", "adopted", "working", "review", "resolved", "dismissed"]),
  base_document_revision: z.number().int().positive(), base_node_revision: z.number().int().positive(),
  base_contract_key: z.string(), base_lineage: Lineage, base_run_id: Id.nullable(), target_snapshot: z.string(),
  adopted_change_id: Id.optional(), adopted_lineage: Lineage.optional(), submitted_run_id: Id.optional(),
  resolution_kind: z.enum(["plan", "delivery"]).optional(),
  created_at: z.string(), updated_at: z.string(),
  history: z.array(z.object({
    at: z.string(), action: z.enum(["create", "adopt", "working", "submit", "resolve", "dismiss", "reopen"]),
    actor: Note, note: Note, change_id: Id.optional(), run_id: Id.optional(), evidence_ids: z.array(Id).optional(),
    basis: z.object({ document_revision: z.number().int().positive(), node_revision: z.number().int().positive(),
      contract_key: z.string(), lineage: Lineage, run_id: Id.nullable(), target_snapshot: z.string(),
      scope_snapshot: EngineeringFeedbackScopeSnapshotSchema.optional() }).optional()
  })).max(1000)
}).refine(value => {
  if (!value.scope_node_ids) return !value.scope_snapshot && !value.scope_feedback_ids;
  return !value.scope_group_id && value.target.kind === "node" && !!value.scope_snapshot && !!value.scope_feedback_ids
    && value.scope_feedback_ids.length === value.scope_node_ids.length && value.scope_node_ids.length === value.scope_snapshot.length
    && value.scope_node_ids.every((id, index) => value.scope_snapshot![index].node_id === id);
}, "反馈范围与保存的节点依据必须完整对应。");
export type EngineeringFeedback = z.infer<typeof EngineeringFeedbackSchema>;

export interface EngineeringObservation {
  captured_at: string;
  source: "local-engineering-service";
  runs: Record<string, {
    state: "current" | "stale" | "unobserved" | "local";
    last_observed_at: string | null;
    message: string;
  }>;
}

/** Read a precise target; relation identities are scoped to the owning node. */
export function engineeringFeedbackTargetValue(node: EngineeringNode, target: EngineeringFeedbackTarget): unknown {
  if (node.id !== target.node_id) return undefined;
  if (target.kind === "node") {
    const { revision, contract_revision, status, created_at, updated_at, ...content } = node;
    return content;
  }
  if (target.kind === "criterion") return node.criteria.find(item => item.id === target.id);
  if (target.kind === "output") return node.delivery?.outputs.find(item => item.id === target.id);
  if (target.id === "parent") return node.parent_id === null ? undefined : { parent_id: node.parent_id, contributes_to: node.contributes_to, contribution: node.contribution };
  const [kind, ...parts] = (target.id ?? "").split(":"), id = parts.join(":");
  if (kind === "input") return node.delivery?.inputs.find(item => item.id === id);
  if (kind === "prerequisite") return node.prerequisites?.find(item => item.id === id);
  if (kind === "interaction") return node.interactions?.find(item => item.id === id);
  if (kind === "dependency") return node.dependencies.includes(id) ? { node_id: id } : undefined;
  return undefined;
}

export function engineeringFeedbackTargetExists(doc: EngineeringDocument, target: EngineeringFeedbackTarget) {
  const node = doc.nodes.find(item => item.id === target.node_id && item.status !== "archived");
  return !!node && engineeringFeedbackTargetValue(node, target) !== undefined;
}

/** Selection is a feedback range, never a new engineering node or an ownership grant. */
export function engineeringFeedbackScopeValid(doc: EngineeringDocument, target: EngineeringFeedbackTarget, ids: string[]) {
  if (target.kind !== "node" || !ScopeNodeIds.safeParse(ids).success || !engineeringFeedbackTargetExists(doc, target)) return false;
  return ids.every(id => {
    const node = doc.nodes.find(item => item.id === id && item.status !== "archived");
    if (!node) return false;
    try {
      const lineage = engineeringLineage(doc, id);
      return lineage.some(item => item.id === target.node_id) && lineage.every(item => item.status !== "archived");
    } catch { return false; }
  });
}

export function engineeringFeedbackScopeSnapshot(doc: EngineeringDocument, ids: string[]): EngineeringFeedbackScopeSnapshot {
  return ids.map(nodeId => {
    const node = doc.nodes.find(item => item.id === nodeId)!;
    return { node_id: nodeId, title: node.title, node_revision: node.revision,
      contract_key: engineeringContractKey(doc, nodeId), lineage: engineeringLineageVersions(doc, nodeId),
      run_id: currentEngineeringRun(doc, nodeId)?.id ?? null,
      target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(node, { kind: "node", node_id: nodeId })) };
  });
}

/** Historical labels remain available when selected nodes are moved, renamed or archived. */
export function engineeringFeedbackScopeState(doc: EngineeringDocument, feedback: EngineeringFeedback): "active" | "changed" | "missing" {
  if (!feedback.scope_node_ids) return "active";
  if (!engineeringFeedbackScopeValid(doc, feedback.target, feedback.scope_node_ids)) return "missing";
  const current = engineeringFeedbackScopeSnapshot(doc, feedback.scope_node_ids);
  return current.every((item, index) => {
    const basis = feedback.scope_snapshot?.[index];
    return basis?.node_id === item.node_id && basis.node_revision === item.node_revision
      && basis.contract_key === item.contract_key && basis.target_snapshot === item.target_snapshot;
  }) ? "active" : "changed";
}

/** A range is complete only when every exact member has independently closed its own loop. */
export function engineeringFeedbackClosureCurrent(doc: EngineeringDocument, feedback: EngineeringFeedback) {
  if (feedback.status !== "resolved" || !engineeringFeedbackTargetExists(doc, feedback.target)) return false;
  const basis = feedback.history.filter(entry => entry.action === "resolve").at(-1)?.basis;
  const node = doc.nodes.find(item => item.id === feedback.target.node_id)!;
  if (!basis || basis.contract_key !== engineeringContractKey(doc, node.id)
    || basis.target_snapshot !== JSON.stringify(engineeringFeedbackTargetValue(node, feedback.target))) return false;
  if (feedback.resolution_kind === "delivery") {
    const run = doc.runs.find(item => item.id === feedback.submitted_run_id);
    return !!run && run.node_id === node.id && run.status === "accepted" && !!run.reviewed_at && run.snapshot.contract_key === basis.contract_key;
  }
  return feedback.resolution_kind === "plan";
}

export function engineeringFeedbackGroupStatus(doc: EngineeringDocument, group: EngineeringFeedback): EngineeringFeedback["status"] {
  if (!group.scope_node_ids || !group.scope_feedback_ids || !engineeringFeedbackScopeValid(doc, group.target, group.scope_node_ids)) return "open";
  const members = group.scope_feedback_ids.map((id, index) => doc.feedbacks?.find(item => item.id === id
    && item.scope_group_id === group.id && item.target.kind === "node" && item.target.node_id === group.scope_node_ids![index]));
  if (members.some(item => !item)) return "open";
  const statuses = members.map(item => {
    if (item!.status !== "resolved") return item!.status;
    return engineeringFeedbackClosureCurrent(doc, item!) ? "resolved" : "open";
  });
  if (statuses.every(status => status === "resolved" || status === "dismissed")) return statuses.includes("resolved") ? "resolved" : "dismissed";
  const active = statuses.filter(status => status !== "resolved" && status !== "dismissed");
  if (active.includes("working")) return "working";
  if (active.every(status => status === "review")) return "review";
  if (active.some(status => status === "adopted" || status === "review")) return "adopted";
  return "open";
}
