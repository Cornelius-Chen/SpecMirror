import { z } from "zod";
import { minimatch } from "minimatch";
import { EngineeringSourceScopeSchema, type FrozenEngineeringSourceScope, type EngineeringSourceBaseline, type EngineeringSourceProof } from "./engineering-source.ts";
import type { EngineeringFeedback, EngineeringObservation } from "./engineering-feedback.ts";

const Text = z.string().trim().max(12000);
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
export const EngineeringCriterionSchema = z.object({
  id: Id, text: Text.min(1), kind: z.enum(["manual", "file_exists", "file_contains", "json_valid"]),
  path: Text.default(""), expected: Text.default("")
});
export const EngineeringConstraintsSchema = z.object({
  allow: z.array(Text.min(1)).max(100).default([]), deny: z.array(Text.min(1)).max(100).default([]),
  rules: z.array(Text.min(1)).max(100).default([]), resources: z.array(Text.min(1)).max(100).default([])
});
export const EngineeringCapabilityBindingSchema = z.object({
  id: Text.min(1), version: Text.min(1), purpose: Text.min(1), input: z.record(z.string(), z.unknown()).default({})
});
export const EngineeringActionSchema = z.object({
  id: Id, title: Text.min(1), type: z.enum(["write_file", "agent_artifact", "check_file", "use_capability"]),
  path: Text.default(""), content: z.string().max(200000).default(""),
  criterion_id: Text.default(""), capability_id: Text.default("")
});
/** Empty content is a saveable draft; identity and supplied references remain strict. */
export const EngineeringDeliveryContractSchema = z.object({
  included: z.array(Text).max(100).default([]), excluded: z.array(Text).max(100).default([]),
  no_extra_exclusions: z.boolean().optional(),
  outputs: z.array(z.object({ id: Id, title: Text.default(""), criterion_ids: z.array(Id).max(100).default([]) })).max(100).default([]),
  inputs: z.array(z.object({
    id: Id, title: Text.default(""), source_node_id: Id.nullable().default(null),
    source_output_id: z.union([Id, z.literal("")]).default(""), external_source: Text.default("")
  })).max(200).default([])
});
export type EngineeringDeliveryContract = z.infer<typeof EngineeringDeliveryContractSchema>;
export const EngineeringCompositionSchema = z.object({
  summary: Text.default(""), integration_criterion_ids: z.array(Id).max(100).default([]), scenario: Text.default("")
});
export const EngineeringPrerequisiteSchema = z.object({ id: Id, node_id: Id, reason: Text.default("") });
export const EngineeringInteractionSchema = z.object({
  id: Id, target_node_id: Id, source_output_id: z.union([Id, z.literal("")]).default(""),
  target_input_id: z.union([Id, z.literal("")]).default(""), purpose: Text.default(""), scenario: Text.default("")
});
export const EngineeringNodeSchema = z.object({
  id: Id, parent_id: Id.nullable(), kind: z.enum(["project", "task", "step"]), title: Text.min(1),
  objective: Text.default(""), method: Text.default(""), architecture: Text.default(""), owner: Text.default("未分配"),
  order: z.number().int().nonnegative(), revision: z.number().int().positive(),
  status: z.enum(["draft", "ready", "running", "review", "accepted", "blocked", "paused", "needs_revision", "archived"]),
  dependencies: z.array(Id).max(200).default([]), contributes_to: z.array(Id).max(100).default([]),
  constraints: EngineeringConstraintsSchema, criteria: z.array(EngineeringCriterionSchema).max(100).default([]),
  capabilities: z.array(EngineeringCapabilityBindingSchema).max(30).default([]),
  actions: z.array(EngineeringActionSchema).max(100).default([]),
  source_scope: EngineeringSourceScopeSchema.optional(),
  delivery: EngineeringDeliveryContractSchema.optional(),
  composition: EngineeringCompositionSchema.optional(),
  contribution: z.object({ summary: Text.default("") }).optional(),
  prerequisites: z.array(EngineeringPrerequisiteSchema).max(200).optional(),
  interactions: z.array(EngineeringInteractionSchema).max(200).optional(),
  contract_revision: z.number().int().positive().optional(),
  legacy_ref: Text.optional(), created_at: z.string(), updated_at: z.string()
});
export type EngineeringNode = z.infer<typeof EngineeringNodeSchema>;
export type EngineeringCriterion = z.infer<typeof EngineeringCriterionSchema>;
export type EngineeringConstraints = z.infer<typeof EngineeringConstraintsSchema>;
export type EngineeringAction = z.infer<typeof EngineeringActionSchema>;
export type EngineeringCapabilityBinding = z.infer<typeof EngineeringCapabilityBindingSchema>;

export interface EffectiveEngineeringConstraints {
  allow_layers: Array<{ node_id: string; title: string; patterns: string[] }>;
  deny: Array<{ node_id: string; title: string; pattern: string }>;
  rules: Array<{ node_id: string; title: string; text: string }>;
  resources: string[];
}
export interface EngineeringEvidence {
  id: string; criterion_id: string; kind: "artifact" | "check" | "human" | "capability";
  summary: string; path?: string; sha256?: string; passed: boolean | null; created_at: string;
}
export interface EngineeringSnapshot {
  node: EngineeringNode; lineage: Array<{ id: string; revision: number }>;
  delivery_lineage?: Array<{ node_id: string; title: string; delivery: EngineeringDeliveryContract }>;
  effective: EffectiveEngineeringConstraints; contract_key: string;
  dependencies: Array<{ node_id: string; run_id: string; contract_key: string }>;
  children: Array<{ node_id: string; run_id: string; contract_key: string }>;
  delivery_inputs?: EngineeringFrozenDeliveryInput[];
  context_lineage?: EngineeringFrozenContext[];
}
export interface EngineeringFrozenContext {
  node_id: string; title: string; objective: string; contract_revision: number;
  criteria: EngineeringCriterion[]; contributes_to: string[];
  composition?: EngineeringNode["composition"]; contribution?: EngineeringNode["contribution"];
  prerequisites?: EngineeringNode["prerequisites"]; interactions?: EngineeringNode["interactions"];
}
/** Provenance of the declared input, not a claim of independently verified output compatibility. */
export interface EngineeringFrozenDeliveryInput {
  consumer_node_id: string; input_id: string; title: string;
  source_node_id: string | null; source_output_id: string;
  source_run_id: string | null; source_contract_key: string | null;
  source_contract_revision: number | null; external_source: string;
}
export interface EngineeringCapabilityUse {
  id: string; node_id: string; run_id: string; capability_id: string; version: string;
  packet_hash: string; packet_path: string; state: "prepared" | "used" | "feedback_recorded";
  summary: string; evidence_ids: string[]; feedback_receipt?: string; created_at: string;
}
export const EngineeringTokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cached_input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reasoning_output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).refine(value => value.cached_input_tokens <= value.input_tokens, "缓存输入不能超过输入用量。");
export const EngineeringTokenUsageSnapshotSchema = EngineeringTokenUsageSchema.extend({ observed_at: z.string().datetime() });
export const EngineeringRunMetricsSchema = z.object({
  source: z.literal("codex_rollout"), attribution: z.literal("assigned_task_window"),
  state: z.enum(["measuring", "observed", "final"]),
  baseline: EngineeringTokenUsageSnapshotSchema, latest: EngineeringTokenUsageSnapshotSchema,
  token_usage: EngineeringTokenUsageSchema
}).refine(value => (["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const)
  .every(field => value.latest[field] >= value.baseline[field] && value.token_usage[field] === value.latest[field] - value.baseline[field]), "运行用量必须等于同一任务窗口的累计差值。");
export type EngineeringTokenUsage = z.infer<typeof EngineeringTokenUsageSchema>;
export type EngineeringTokenUsageSnapshot = z.infer<typeof EngineeringTokenUsageSnapshotSchema>;
export type EngineeringRunMetrics = z.infer<typeof EngineeringRunMetricsSchema>;
export interface EngineeringRun {
  id: string; node_id: string; mode: "controlled" | "external" | "integration";
  status: "queued" | "running" | "review" | "accepted" | "rejected" | "blocked" | "paused" | "stale";
  actor: string; snapshot: EngineeringSnapshot; started_at: string; finished_at: string | null;
  current_action: string; completed_action_ids: string[]; evidence: EngineeringEvidence[];
  output_dir: string; reason: string; review_note: string; reviewed_at: string | null;
  handoff?: EngineeringAgentHandoff;
  source_scope?: FrozenEngineeringSourceScope;
  source_baseline?: EngineeringSourceBaseline;
  source_proof?: EngineeringSourceProof;
  source_integration_scopes?: FrozenEngineeringSourceScope[];
  source_integration_baselines?: EngineeringSourceBaseline[];
  source_integration_proofs?: EngineeringSourceProof[];
  metrics?: EngineeringRunMetrics;
}
export interface EngineeringAgentHandoff {
  state: "awaiting_claim" | "claimed"; owner: string; source_cwd: string;
  document_revision: number; contract_key: string; created_at: string; claimed_at?: string; claimed_by?: string;
}
export interface EngineeringHandoffPacket {
  schema_version: 1; workspace_id: string; node_id: string; run_id: string;
  source_cwd: string; owner: string; document_revision: number; node_revision: number;
  contract_key: string; objective: string; method: string; architecture: string;
  constraints: EffectiveEngineeringConstraints; actions: EngineeringAction[];
  criteria: EngineeringCriterion[]; capabilities: EngineeringCapabilityBinding[];
  handoff: EngineeringAgentHandoff; current: boolean;
  source_scope?: FrozenEngineeringSourceScope;
  delivery?: EngineeringDeliveryContract;
  delivery_lineage?: EngineeringSnapshot["delivery_lineage"];
  delivery_inputs?: EngineeringSnapshot["delivery_inputs"];
  composition?: EngineeringNode["composition"];
  contribution?: EngineeringNode["contribution"];
  prerequisites?: EngineeringNode["prerequisites"];
  interactions?: EngineeringNode["interactions"];
  contract_revision?: number;
  contributes_to?: string[];
  context_lineage?: EngineeringSnapshot["context_lineage"];
}
export interface EngineeringEvent {
  id: string; at: string; node_id: string; run_id?: string;
  kind: "plan" | "execution" | "constraint" | "review" | "capability" | "change";
  message: string; detail?: string;
  readiness_contract_key?: string;
}
export interface EngineeringChange {
  id: string; at: string; node_id: string; reason: string;
  before: EngineeringNode; after: EngineeringNode; affected_ids: string[];
}
export interface EngineeringDocument {
  schema_version: 1; id: string; revision: number; root_id: string; created_at: string; updated_at: string;
  nodes: EngineeringNode[]; runs: EngineeringRun[]; events: EngineeringEvent[];
  changes: EngineeringChange[]; capability_uses: EngineeringCapabilityUse[];
  feedbacks?: EngineeringFeedback[];
}
export interface EngineeringDerivedNode {
  id: string; depth: number; path: string[]; child_ids: string[]; dependent_ids: string[];
  effective: EffectiveEngineeringConstraints; status: EngineeringNode["status"];
  blockers: string[]; can_run: boolean; can_accept: boolean; latest_run_id: string | null;
  counts: { total: number; accepted: number; review: number; running: number; blocked: number };
  uncovered_criteria: string[];
}
export interface EngineeringView {
  document: EngineeringDocument; derived: Record<string, EngineeringDerivedNode>;
  scheduler: { max_parallel: number; active: number; queued: number };
  observation?: EngineeringObservation;
}
export type EngineeringChangeClassification = "none" | "presentation" | "permissions" | "contract";
export interface EngineeringChangePreview {
  node_id: string; affected_ids: string[]; running_ids: string[]; invalidated_run_ids: string[];
  reasons: string[]; warnings: string[];
  classification?: EngineeringChangeClassification;
  impact?: Array<{ node_id: string; disposition: "needs_revision" | "needs_recheck" | "unaffected"; reason: string; path: string[] }>;
}
export interface EngineeringCapability {
  id: string; title: string; version: string; lifecycle: string; purpose: string;
  applies_when: string[]; fails_when: string[]; source: string; record_hash: string;
  usable: boolean; reason: string; parameters?: Record<string, unknown>;
}
export interface EngineeringCapabilityCatalog {
  connected: boolean; source: string; capabilities: EngineeringCapability[]; warnings: string[];
}

export function engineeringLineage(doc: EngineeringDocument, nodeId: string): EngineeringNode[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const result: EngineeringNode[] = [];
  const seen = new Set<string>();
  let node = byId.get(nodeId);
  if (!node) throw new Error("没有找到这项任务。");
  while (node) {
    if (seen.has(node.id)) throw new Error("任务层级存在循环。");
    seen.add(node.id); result.unshift(node);
    if (node.parent_id === null) break;
    node = byId.get(node.parent_id);
    if (!node) throw new Error("任务的上级不存在。");
  }
  return result;
}

export function engineeringDescendants(doc: EngineeringDocument, nodeId: string): EngineeringNode[] {
  const result: EngineeringNode[] = [];
  const queue = [nodeId];
  const seen = new Set<string>(queue);
  while (queue.length) {
    const id = queue.shift()!;
    for (const node of doc.nodes.filter((item) => item.parent_id === id)) {
      if (seen.has(node.id)) throw new Error("任务层级存在循环。");
      seen.add(node.id); result.push(node); queue.push(node.id);
    }
  }
  return result;
}

/** Older documents retain their existing hard waits; new delivery inputs declare their own waits. */
export function engineeringDirectPrerequisites(node: EngineeringNode): string[] {
  return [...new Set([
    ...node.dependencies,
    ...(node.delivery?.inputs.flatMap(input => input.source_node_id === null ? [] : [input.source_node_id]) ?? []),
    ...(node.prerequisites?.map(item => item.node_id) ?? [])
  ])];
}

export function engineeringEffectivePrerequisites(doc: EngineeringDocument, nodeId: string): string[] {
  return [...new Set(engineeringLineage(doc, nodeId).flatMap(engineeringDirectPrerequisites))];
}

export interface EngineeringCompositionCoverage {
  criterion_id: string; child_ids: string[]; integration: boolean; covered: boolean;
}
/** Coverage is a declared responsibility map. It is not proof of semantic completeness or acceptance. */
export function engineeringCompositionCoverage(doc: EngineeringDocument, nodeId: string): EngineeringCompositionCoverage[] {
  const node = doc.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error("没有找到这项任务。");
  const children = doc.nodes.filter(item => item.parent_id === nodeId && item.status !== "archived");
  return node.criteria.map(criterion => {
    const child_ids = children.filter(child => child.contributes_to.includes(criterion.id)).map(child => child.id);
    const integration = Boolean(node.composition?.integration_criterion_ids.includes(criterion.id));
    return { criterion_id: criterion.id, child_ids, integration, covered: integration || child_ids.length > 0 };
  });
}

/** Missing narrative remains saveable while drafting; check it before execution or acceptance. */
export function engineeringCompositionIssues(doc: EngineeringDocument, nodeId: string): string[] {
  const lineage = engineeringLineage(doc, nodeId), node = lineage.at(-1)!;
  if (node.status === "archived") return [];
  const issues: string[] = [], parent = lineage.at(-2);
  const hasChildren = doc.nodes.some(child => child.parent_id === node.id && child.status !== "archived");
  // Declared delivery contracts require explicit integration on every composite level.
  // Missing optional fields remain readable/saveable; they cannot bypass a new execution or review.
  const compositionRequired = hasChildren && lineage.some(ancestor => ancestor.delivery);
  if (node.composition || compositionRequired) {
    if (!node.composition?.summary.trim()) issues.push(`“${node.title}”需要说明子成果怎样组成整体结果。`);
    if (!node.composition?.scenario.trim()) issues.push(`“${node.title}”需要说明整体验收要跑通的场景。`);
    if (compositionRequired && !node.composition?.integration_criterion_ids.length) issues.push(`“${node.title}”需要至少一项由本层整合负责的完成条件。`);
  }
  if (parent?.composition) {
    if (!node.contributes_to.length) issues.push(`“${node.title}”需要说明承担上级哪项完成条件。`);
    if (!node.contribution?.summary.trim()) issues.push(`“${node.title}”需要写清本项对上级结果的具体贡献。`);
  }
  if (node.contribution && !node.contribution.summary.trim() && !parent?.composition) issues.push(`“${node.title}”的贡献说明尚未填写。`);
  for (const prerequisite of node.prerequisites ?? []) if (!prerequisite.reason.trim()) issues.push(`“${node.title}”需要说明等待“${doc.nodes.find(item => item.id === prerequisite.node_id)?.title ?? prerequisite.node_id}”的开工理由。`);
  for (const interaction of node.interactions ?? []) {
    if (!interaction.purpose.trim()) issues.push(`“${node.title}”需要说明运行配合传递什么、得到什么响应。`);
    if (!interaction.scenario.trim()) issues.push(`“${node.title}”需要说明运行配合所属的使用场景。`);
  }
  return issues;
}

export function engineeringNodeContractRevision(node: EngineeringNode): number {
  return node.contract_revision ?? node.revision;
}

export function engineeringLineageVersions(doc: EngineeringDocument, nodeId: string): Array<{ id: string; revision: number }> {
  return engineeringLineage(doc, nodeId).map(node => ({ id: node.id, revision: engineeringNodeContractRevision(node) }));
}

function canonicalValue(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)])) : item;
  return JSON.stringify(normalize(value));
}

function changeValue(node: EngineeringNode, omit: string[] = []): string {
  const ignored = new Set(["revision", "contract_revision", "updated_at", "created_at", "status", ...omit]);
  return canonicalValue(Object.fromEntries(Object.entries(node).filter(([key]) => !ignored.has(key))));
}

export function engineeringChangeClassification(current: EngineeringNode, proposed: EngineeringNode): EngineeringChangeClassification {
  if (changeValue(current) === changeValue(proposed)) return "none";
  if (changeValue(current, ["title", "order"]) === changeValue(proposed, ["title", "order"])) return "presentation";
  if (changeValue(current, ["title", "order", "owner", "constraints"]) === changeValue(proposed, ["title", "order", "owner", "constraints"])) return "permissions";
  return "contract";
}

/** Service-owned revision advance. Never trust an incoming contract_revision supplied by a client. */
export function prepareEngineeringNodeRevision(current: EngineeringNode, value: EngineeringNode): EngineeringNode {
  const kind = engineeringChangeClassification(current, value), unchanged = kind === "presentation" || kind === "none";
  return EngineeringNodeSchema.parse({ ...value, revision: current.revision + 1,
    contract_revision: engineeringNodeContractRevision(current) + (unchanged ? 0 : 1),
    status: unchanged ? current.status : "draft", created_at: current.created_at });
}

export function engineeringFrozenDeliveryInputs(doc: EngineeringDocument, nodeId: string): EngineeringFrozenDeliveryInput[] {
  return engineeringLineage(doc, nodeId).flatMap(node => (node.delivery?.inputs ?? []).map(input => {
    const source = input.source_node_id === null ? undefined : doc.nodes.find(item => item.id === input.source_node_id);
    const candidate = source ? currentEngineeringRun(doc, source.id) : undefined;
    const accepted = candidate?.status === "accepted" ? candidate : undefined;
    return { consumer_node_id: node.id, input_id: input.id, title: input.title,
      source_node_id: input.source_node_id, source_output_id: input.source_output_id,
      source_run_id: accepted?.id ?? null, source_contract_key: accepted?.snapshot.contract_key ?? null,
      source_contract_revision: source && accepted ? engineeringNodeContractRevision(source) : null,
      external_source: input.external_source };
  }));
}

/** Integrity errors cannot be saved, including while a contract is still a draft. */
function engineeringDeliveryReferenceIssues(doc: EngineeringDocument, node: EngineeringNode): string[] {
  const delivery = node.delivery;
  if (!delivery) return [];
  const issues: string[] = [], label = `“${node.title}”`;
  if (new Set(delivery.outputs.map(output => output.id)).size !== delivery.outputs.length) issues.push(`${label}的交付成果身份重复。`);
  if (new Set(delivery.inputs.map(input => input.id)).size !== delivery.inputs.length) issues.push(`${label}的所需输入身份重复。`);
  for (const output of delivery.outputs) {
    if (new Set(output.criterion_ids).size !== output.criterion_ids.length) issues.push(`${label}的成果“${output.title || output.id}”重复关联验收条件。`);
    if (output.criterion_ids.some(id => !node.criteria.some(criterion => criterion.id === id))) issues.push(`${label}的成果“${output.title || output.id}”关联了不存在的验收条件。`);
  }
  for (const input of delivery.inputs) {
    const name = input.title || input.id;
    if (input.source_node_id !== null) {
      const source = doc.nodes.find(item => item.id === input.source_node_id);
      if (!source) issues.push(`${label}的输入“${name}”来源任务不存在。`);
      else {
        if (node.status !== "archived" && source.status === "archived") issues.push(`${label}的输入“${name}”不能来自已归档任务。`);
        if (input.source_output_id && !source.delivery?.outputs.some(output => output.id === input.source_output_id)) issues.push(`${label}的输入“${name}”引用的来源成果不存在，不能留下悬空关系。`);
      }
      if (input.external_source.trim()) issues.push(`${label}的输入“${name}”只能选择任务成果或外部来源之一。`);
    } else if (input.source_output_id) issues.push(`${label}的输入“${name}”填写来源成果前须先选择来源任务。`);
  }
  return issues;
}

/** Missing content is diagnostic until readiness, never a claim that work is accepted. */
export function engineeringDeliveryIssues(doc: EngineeringDocument, nodeId: string): string[] {
  const lineage = engineeringLineage(doc, nodeId), node = lineage.at(-1)!;
  if (node.status === "archived" || !lineage.some(item => item.delivery !== undefined)) return [];
  const label = `“${node.title}”`, delivery = node.delivery;
  const issues: string[] = [];
  if (node.parent_id !== null) {
    const parent = lineage.at(-2);
    if (!parent?.criteria.length) issues.push(`${label}需要先补充上级“${parent?.title ?? node.parent_id}”的完成条件，再说明本项负责哪一条。`);
    else if (!node.contributes_to.some(id => parent.criteria.some(criterion => criterion.id === id))) issues.push(`${label}需要至少关联一条上级“${parent.title}”的完成条件，说明本项对上级的作用。`);
  }
  if (!delivery) return [...issues, `${label}还没有定义负责范围、交付成果和完成条件。`];
  issues.push(...engineeringDeliveryReferenceIssues(doc, node));
  if (!node.objective.trim()) issues.push(`${label}需要说明完成后要得到什么结果。`);
  if (!node.criteria.length) issues.push(`${label}需要至少一条可核对的完成条件。`);
  if (!delivery.included.some(item => item.trim())) issues.push(`${label}需要写清本项负责的范围。`);
  if (!delivery.excluded.some(item => item.trim()) && delivery.no_extra_exclusions !== true) issues.push(`${label}需要写清本项不承担的范围，或明确没有额外排除项。`);
  if (!delivery.outputs.length) issues.push(`${label}需要至少一项可交付成果。`);
  for (const output of delivery.outputs) {
    if (!output.title.trim()) issues.push(`${label}有一项交付成果尚未填写名称。`);
    if (!output.criterion_ids.length) issues.push(`${label}的成果“${output.title || output.id}”需要关联完成条件。`);
  }
  for (const input of delivery.inputs) {
    if (!input.title.trim()) issues.push(`${label}有一项所需输入尚未填写名称。`);
    if (input.source_node_id !== null && !input.source_output_id) issues.push(`${label}的输入“${input.title || input.id}”需要选择来源任务的具体成果。`);
    if (input.source_node_id === null && !input.external_source.trim()) issues.push(`${label}的输入“${input.title || input.id}”需要说明外部来源或选择任务成果。`);
  }
  return [...new Set(issues)];
}

function engineeringRelationshipReferenceIssues(doc: EngineeringDocument, node: EngineeringNode): string[] {
  const issues: string[] = [], label = `“${node.title}”`;
  if (node.contract_revision !== undefined && node.contract_revision > node.revision) issues.push(`${label}的执行合同版本不能超过内容版本。`);
  const integration = node.composition?.integration_criterion_ids ?? [];
  if (new Set(integration).size !== integration.length) issues.push(`${label}重复声明了本级整合条件。`);
  if (integration.some(id => !node.criteria.some(criterion => criterion.id === id))) issues.push(`${label}的本级整合责任关联了不存在的完成条件。`);
  const prerequisites = node.prerequisites ?? [], interactions = node.interactions ?? [];
  if (new Set(prerequisites.map(item => item.id)).size !== prerequisites.length) issues.push(`${label}的开工前提身份重复。`);
  if (new Set(prerequisites.map(item => item.node_id)).size !== prerequisites.length) issues.push(`${label}对同一任务重复声明了开工前提。`);
  if (new Set(interactions.map(item => item.id)).size !== interactions.length) issues.push(`${label}的运行配合身份重复。`);
  if (new Set(interactions.map(({ id: _id, ...item }) => canonicalValue(item))).size !== interactions.length) issues.push(`${label}重复声明了相同的运行配合。`);
  for (const interaction of interactions) {
    const target = doc.nodes.find(item => item.id === interaction.target_node_id);
    if (!target) issues.push(`${label}的运行配合目标不存在。`);
    else {
      if (target.id === node.id) issues.push(`${label}的运行配合应指向另一项成果。`);
      if (node.status !== "archived" && target.status === "archived") issues.push(`${label}的运行配合不能指向已归档成果。`);
      if (interaction.target_input_id) {
        const input = target.delivery?.inputs.find(item => item.id === interaction.target_input_id);
        if (!input) issues.push(`${label}的运行配合引用了不存在的接收输入。`);
        // A pinned delivery input identifies one source; runtime wiring cannot contradict it.
        // External runtime inputs carry no completion wait and do not prove protocol compatibility.
        else if (input.source_node_id !== null && (input.source_node_id !== node.id || input.source_output_id !== interaction.source_output_id)) {
          issues.push(`${label}的运行配合与接收输入声明的来源任务或成果不一致。`);
        }
      }
    }
    if (interaction.source_output_id && !node.delivery?.outputs.some(output => output.id === interaction.source_output_id)) issues.push(`${label}的运行配合引用了不存在的本项输出。`);
  }
  return issues;
}

function safeRelative(value: string, pattern = false): boolean {
  const path = value.replaceAll("\\", "/");
  return Boolean(path && !path.startsWith("/") && !path.includes(":") && !path.includes("\0")
    && !path.startsWith("!") && !path.split("/").some((part) => !part || part === ".." || part === ".")
    && (pattern || !/[*?\[\]{}]/.test(path)));
}

export function effectiveEngineeringConstraints(doc: EngineeringDocument, nodeId: string): EffectiveEngineeringConstraints {
  const nodes = engineeringLineage(doc, nodeId);
  return {
    allow_layers: nodes.filter((node) => node.constraints.allow.length).map((node) => ({ node_id: node.id, title: node.title, patterns: [...node.constraints.allow] })),
    deny: nodes.flatMap((node) => node.constraints.deny.map((pattern) => ({ node_id: node.id, title: node.title, pattern }))),
    rules: nodes.flatMap((node) => node.constraints.rules.map((text) => ({ node_id: node.id, title: node.title, text }))),
    resources: [...new Set(nodes.flatMap((node) => node.constraints.resources))]
  };
}

export function engineeringPathViolation(effective: EffectiveEngineeringConstraints, rawPath: string): string | null {
  if (!safeRelative(rawPath)) return "产出路径必须是工作区内的相对文件路径，不能包含跳转或通配符。";
  const path = rawPath.replaceAll("\\", "/");
  if (path.split("/").some((part) => [".git", ".project", "node_modules"].includes(part.toLowerCase()))) return "不能通过任务产出修改工程管理记录或依赖目录。";
  const matches = (pattern: string) => safeRelative(pattern, true) && minimatch(path, pattern.replaceAll("\\", "/"), { dot: true, nocase: true, nonegate: true });
  const denied = effective.deny.find((entry) => matches(entry.pattern));
  if (denied) return `被“${denied.title}”的禁止范围 ${denied.pattern} 拦截。`;
  if (!effective.allow_layers.length) return "本任务及上级尚未声明允许的产出范围。";
  for (const layer of effective.allow_layers) if (!layer.patterns.some(matches)) return `超出“${layer.title}”允许的范围：${layer.patterns.join("、")}。`;
  return null;
}

export function validateEngineeringDocument(doc: EngineeringDocument): string[] {
  const errors: string[] = [];
  if (doc.schema_version !== 1 || !Number.isInteger(doc.revision) || doc.revision < 1) errors.push("工程文档版本无效。");
  if (!doc.nodes.length || doc.nodes.length > 2000) errors.push("工程应包含 1—2000 个节点。");
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    if (!EngineeringNodeSchema.safeParse(node).success) errors.push(`任务“${node.title || node.id}”的字段格式无效。`);
    if (ids.has(node.id)) errors.push(`任务身份重复：${node.id}。`);
    ids.add(node.id);
  }
  if (errors.some((error) => error.includes("字段格式"))) return errors;
  const roots = doc.nodes.filter((node) => node.parent_id === null);
  if (roots.length !== 1 || roots[0]?.id !== doc.root_id || roots[0]?.kind !== "project") errors.push("工程必须有一个明确的项目根节点。");
  for (const node of doc.nodes) {
    if (node.parent_id && !ids.has(node.parent_id)) errors.push(`“${node.title}”的上级不存在。`);
    const parent = doc.nodes.find((item) => item.id === node.parent_id);
    if (node.status !== "archived" && parent?.status === "archived") errors.push(`“${node.title}”不能归属已归档任务。`);
    if (new Set(node.criteria.map((item) => item.id)).size !== node.criteria.length) errors.push(`“${node.title}”的验收条件身份重复。`);
    if (new Set(node.actions.map((item) => item.id)).size !== node.actions.length) errors.push(`“${node.title}”的执行动作身份重复。`);
    if (node.contributes_to.some((id) => !parent?.criteria.some((criterion) => criterion.id === id))) errors.push(`“${node.title}”关联了不存在的上级验收条件。`);
    errors.push(...engineeringDeliveryReferenceIssues(doc, node));
    errors.push(...engineeringRelationshipReferenceIssues(doc, node));
    if ([...node.constraints.allow, ...node.constraints.deny].some((pattern) => !safeRelative(pattern, true))) errors.push(`“${node.title}”包含不安全的范围表达。`);
    try {
      const lineage = engineeringLineage(doc, node.id).map((item) => item.id);
      const descendants = engineeringDescendants(doc, node.id).map((item) => item.id);
      for (const dependency of engineeringDirectPrerequisites(node)) {
        if (!ids.has(dependency)) errors.push(`“${node.title}”的依赖不存在：${dependency}。`);
        if (lineage.includes(dependency) || descendants.includes(dependency)) errors.push(`“${node.title}”不能依赖自身、上级或下级，避免相互等待。`);
        if (node.status !== "archived" && doc.nodes.find((item) => item.id === dependency)?.status === "archived") errors.push(`“${node.title}”不能依赖已归档任务。`);
      }
    } catch (error) { errors.push((error as Error).message); }
  }
  // Completion edges include both dependency and child completion; check the combined graph.
  const visiting = new Set<string>(); const visited = new Set<string>(); const stack: string[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) {
      const path = [...stack.slice(stack.indexOf(id)), id].map(key => `“${doc.nodes.find(item => item.id === key)?.title ?? key}”`).join(" → ");
      errors.push(`任务依赖与层级形成循环，无法确定执行顺序：${path}。`); return;
    }
    if (visited.has(id)) return;
    visiting.add(id); stack.push(id);
    const node = doc.nodes.find((item) => item.id === id);
    for (const next of [...(node ? engineeringDirectPrerequisites(node) : []), ...doc.nodes.filter((item) => item.parent_id === id && item.status !== "archived").map((item) => item.id)]) visit(next);
    stack.pop(); visiting.delete(id); visited.add(id);
  };
  for (const node of doc.nodes) visit(node.id);
  return [...new Set(errors)];
}

function lastAccepted(doc: EngineeringDocument, nodeId: string): EngineeringRun | undefined {
  return [...doc.runs].reverse().find((run) => run.node_id === nodeId && run.status === "accepted");
}
function versionDescriptor(doc: EngineeringDocument, nodeId: string) {
  const nodes = [...engineeringLineage(doc, nodeId), ...engineeringDescendants(doc, nodeId).filter((node) => node.status !== "archived")];
  return nodes.map((node) => `${node.id}:${engineeringNodeContractRevision(node)}`).sort();
}
function runtimeRelationDescriptor(doc: EngineeringDocument, nodeId: string): unknown[][] {
  if (!doc.nodes.some(node => node.status !== "archived" && node.interactions?.length)) return [];
  const scope = new Set([...engineeringLineage(doc, nodeId), ...engineeringDescendants(doc, nodeId)].map(node => node.id));
  return doc.nodes.filter(node => node.status !== "archived").flatMap(source => (source.interactions ?? []).filter(relation => scope.has(source.id) || scope.has(relation.target_node_id)).map(relation =>
    [source.id, relation.id, relation.target_node_id, versionDescriptor(doc, source.id), versionDescriptor(doc, relation.target_node_id)]
  )).sort((a, b) => canonicalValue(a.slice(0, 3)).localeCompare(canonicalValue(b.slice(0, 3))));
}
export function engineeringContractKey(doc: EngineeringDocument, nodeId: string): string {
  const node = doc.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("没有找到这项任务。");
  const dependencies = engineeringEffectivePrerequisites(doc, nodeId);
  const runtimeRelations = runtimeRelationDescriptor(doc, nodeId);
  return JSON.stringify({
    lineage: engineeringLineageVersions(doc, nodeId).map((item) => [item.id, item.revision]),
    dependencies: dependencies.sort().map((id) => [id, versionDescriptor(doc, id), lastAccepted(doc, id)?.id ?? null]),
    children: doc.nodes.filter((item) => item.parent_id === nodeId && item.status !== "archived").sort((a, b) => a.id.localeCompare(b.id)).map((child) => [child.id, versionDescriptor(doc, child.id), lastAccepted(doc, child.id)?.id ?? null]),
    ...(runtimeRelations.length ? { runtime_relations: runtimeRelations } : {})
  });
}

export function currentEngineeringRun(doc: EngineeringDocument, nodeId: string): EngineeringRun | undefined {
  return engineeringRunResolver(doc)(nodeId);
}

export function engineeringRunResolver(doc: EngineeringDocument) {
  const memo = new Map<string, EngineeringRun | undefined>();
  const visiting = new Set<string>();
  const matchesQueue = (savedKey: string, key: string) => {
    try {
      const before = JSON.parse(savedKey), after = JSON.parse(key);
      const compatible = (oldItems: unknown[][], newItems: unknown[][]) => oldItems.length === newItems.length && oldItems.every((item, index) =>
        JSON.stringify(item.slice(0, 2)) === JSON.stringify(newItems[index].slice(0, 2)) && (item[2] === null || item[2] === newItems[index][2]));
      return JSON.stringify(before.lineage) === JSON.stringify(after.lineage) && compatible(before.dependencies, after.dependencies) && compatible(before.children, after.children)
        && canonicalValue(before.runtime_relations ?? []) === canonicalValue(after.runtime_relations ?? []);
    } catch { return false; }
  };
  const resolveRun = (nodeId: string): EngineeringRun | undefined => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    if (visiting.has(nodeId)) return undefined;
    visiting.add(nodeId);
    const key = engineeringContractKey(doc, nodeId);
    const result = [...doc.runs].reverse().find((run) => {
      if (run.node_id !== nodeId || run.status === "stale" || (run.snapshot.contract_key !== key && !(run.status === "queued" && matchesQueue(run.snapshot.contract_key, key)))) return false;
      try {
        const frozen = JSON.parse(run.snapshot.contract_key);
        // A version-stable intermediate result can still contain obsolete evidence.
        // Resolve each frozen reference through the whole acceptance chain.
        return [...frozen.dependencies, ...frozen.children].every(([id, _versions, acceptedId]: [string, unknown, string | null]) => {
          if (run.status === "queued" && acceptedId === null) return true;
          const referenced = resolveRun(id);
          return acceptedId !== null && referenced?.status === "accepted" && referenced.id === acceptedId;
        });
      } catch { return false; }
    });
    visiting.delete(nodeId); memo.set(nodeId, result);
    return result;
  };
  return resolveRun;
}

export function previewEngineeringChange(doc: EngineeringDocument, proposed: EngineeringNode): EngineeringChangePreview {
  const current = doc.nodes.find((node) => node.id === proposed.id);
  if (!current) throw new Error("没有找到要修改的任务。");
  const classification = engineeringChangeClassification(current, proposed);
  if (classification === "none" || classification === "presentation") return {
    node_id: current.id, affected_ids: [], running_ids: [], invalidated_run_ids: [], classification,
    reasons: classification === "presentation" ? ["仅更新显示名称或排序；目标、交付、权限及执行合同不变，原验收证据仍按原版本核对。"] : [], warnings: [],
    impact: [{ node_id: current.id, disposition: "unaffected", reason: classification === "presentation" ? "展示调整没有改变已声明的执行约定。" : "没有发生内容变化。", path: [current.id] }]
  };
  const affected = new Set([current.id, ...engineeringDescendants(doc, current.id).map((node) => node.id)]);
  const paths = new Map([...affected].map(id => [id, id === current.id ? [id] : [current.id, id]]));
  const explanations = new Map([...affected].map(id => [id, id === current.id ? "本项约定改变，需要按新版本处理。" : "继承的上级约定改变，需要重新核对。"]));
  const add = (id: string, from: string, reason: string) => {
    if (affected.has(id)) return false;
    affected.add(id); paths.set(id, [...(paths.get(from) ?? [current.id, from]), id]); explanations.set(id, reason); return true;
  };
  if (proposed.parent_id && proposed.parent_id !== current.parent_id) for (const ancestor of engineeringLineage(doc, proposed.parent_id)) affected.add(ancestor.id);
  const interactions = [...doc.nodes, proposed].flatMap(source => (source.interactions ?? []).map(relation => [source.id, relation.target_node_id] as const));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of doc.nodes) if (!affected.has(node.id)) {
      const source = engineeringDirectPrerequisites(node).find(id => affected.has(id));
      if (source) {
        changed = add(node.id, source, "使用的交付成果或开工前提发生变化；尚无独立输出兼容证明，需保守复验。") || changed;
        for (const child of engineeringDescendants(doc, node.id)) changed = add(child.id, node.id, "继承的前提或范围需要重新核对。") || changed;
      }
    }
    for (const [source, target] of interactions) if (affected.has(source) !== affected.has(target)) {
      const from = affected.has(source) ? source : target, to = from === source ? target : source;
      changed = add(to, from, "运行配合的一端约定改变，需要重新验证配合；这不表示必须等待对端开工。") || changed;
      for (const child of engineeringDescendants(doc, to)) changed = add(child.id, to, "所归属成果的运行配合需要重新核对。") || changed;
    }
    // A changed descendant invalidates ancestor acceptance, which can unblock or invalidate downstream tasks.
    for (const id of [...affected]) for (const ancestor of engineeringLineage(doc, id)) changed = add(ancestor.id, id, "子成果或组合关系改变，上级整体验收需要对应新结果。") || changed;
  }
  const affectedRuns = doc.runs.filter((run) => affected.has(run.node_id) && !["stale", "rejected", "blocked"].includes(run.status));
  const warnings: string[] = [];
  if (current.constraints.deny.some((item) => !proposed.constraints.deny.includes(item)) || current.constraints.rules.some((item) => !proposed.constraints.rules.includes(item))) warnings.push("本次修改移除了原有约束，请核对受影响任务是否仍符合工程目标。");
  return {
    node_id: current.id, affected_ids: [...affected], running_ids: affectedRuns.filter((run) => ["running", "queued"].includes(run.status)).map((run) => run.id),
    invalidated_run_ids: affectedRuns.map((run) => run.id),
    reasons: [classification === "permissions" ? "负责人或约束改变，相关执行权限与成果需重新核对。" : "本项及继承其约定的子成果使用新方案。", "沿已声明的交接、开工前提及运行配合保守检查影响；尚未实现独立输出级兼容证明。", "上级整体验收需要对应新的产出；未记录的依赖仍需人工核对。"], warnings,
    classification,
    impact: [...affected].map(id => ({ node_id: id, disposition: id === current.id ? "needs_revision" : "needs_recheck", reason: explanations.get(id) ?? "归属范围改变，需要重新核对组合与交接。", path: paths.get(id) ?? [current.id, id] }))
  };
}

export function engineeringNodesConflict(doc: EngineeringDocument, aId: string, bId: string): boolean {
  if (aId === bId) return true;
  const a = doc.nodes.find((node) => node.id === aId)!;
  const b = doc.nodes.find((node) => node.id === bId)!;
  const ea = effectiveEngineeringConstraints(doc, aId), eb = effectiveEngineeringConstraints(doc, bId);
  if (ea.resources.some((resource) => eb.resources.includes(resource))) return true;
  if (engineeringLineage(doc, aId).some((node) => node.id === bId) || engineeringLineage(doc, bId).some((node) => node.id === aId)) return true;
  const outputs = (node: EngineeringNode) => node.actions.filter((action) => ["write_file", "agent_artifact", "use_capability"].includes(action.type)).map((action) => action.path.replaceAll("\\", "/").toLowerCase());
  const ap = outputs(a), bp = outputs(b);
  if (ap.length && bp.length && ap.every(Boolean) && bp.every(Boolean)) return ap.some((path) => bp.includes(path));
  // Unknown external outputs lock their narrowest declared scope conservatively.
  const prefix = (pattern: string) => pattern.toLowerCase().replaceAll("\\", "/").split(/[*?[{]/)[0];
  const aa = ea.allow_layers.at(-1)?.patterns ?? [], bb = eb.allow_layers.at(-1)?.patterns ?? [];
  return aa.some((left) => bb.some((right) => { const l = prefix(left), r = prefix(right); return l.startsWith(r) || r.startsWith(l); }));
}

export function deriveEngineeringView(doc: EngineeringDocument, maxParallel = 3): EngineeringView {
  const derived: Record<string, EngineeringDerivedNode> = {};
  const activeNodes = doc.nodes.filter((node) => node.status !== "archived");
  const resolveRun = engineeringRunResolver(doc);
  const statusOf = (node: EngineeringNode): EngineeringNode["status"] => {
    if (["archived", "paused"].includes(node.status)) return node.status;
    const run = resolveRun(node.id);
    // A newly checked plan is ready to run again; failed/historical evidence stays historical.
    if (node.status === "ready" && doc.events.some(event => event.node_id === node.id && event.readiness_contract_key === engineeringContractKey(doc, node.id)) && (!run || ["rejected", "blocked", "paused", "stale"].includes(run.status))) return "ready";
    if (run) return ({ queued: "ready", running: "running", review: "review", accepted: "accepted", rejected: "needs_revision", blocked: "blocked", paused: "paused", stale: "needs_revision" } as const)[run.status];
    if (doc.runs.some((item) => item.node_id === node.id)) return "needs_revision";
    return ["accepted", "running", "review"].includes(node.status) ? "draft" : node.status;
  };
  for (const node of doc.nodes) {
    const lineage = engineeringLineage(doc, node.id);
    const children = activeNodes.filter((item) => item.parent_id === node.id).sort((a, b) => a.order - b.order);
    const descendants = engineeringDescendants(doc, node.id).filter((item) => item.status !== "archived");
    const leaves = (descendants.length ? descendants : [node]).filter((item) => !activeNodes.some((child) => child.parent_id === item.id));
    const effective = effectiveEngineeringConstraints(doc, node.id);
    const run = resolveRun(node.id);
    const status = statusOf(node);
    const blockers: string[] = [];
    for (const ancestor of lineage) blockers.push(...engineeringDeliveryIssues(doc, ancestor.id), ...engineeringCompositionIssues(doc, ancestor.id));
    if (!node.objective.trim()) blockers.push("先写清这一步的预期结果。");
    if (!node.criteria.length) blockers.push("至少写一条可核对的验收条件。");
    if (lineage.some((item) => item.status === "paused")) blockers.push("本任务或上级已暂停。");
    if (lineage.some((item) => item.status === "archived")) blockers.push("本任务或上级已归档。");
    const dependencies = engineeringEffectivePrerequisites(doc, node.id);
    for (const id of dependencies) {
      const dependency = doc.nodes.find((item) => item.id === id);
      if (!dependency || statusOf(dependency) !== "accepted") blockers.push(`等待“${dependency?.title ?? id}”当前产出通过验收。`);
    }
    const uncovered = children.length ? engineeringCompositionCoverage(doc, node.id).filter(item => !item.covered).map(item => item.criterion_id) : [];
    for (const id of uncovered) blockers.push(`还没有子任务负责“${node.criteria.find((criterion) => criterion.id === id)?.text}”。`);
    if (children.length && children.some((child) => statusOf(child) !== "accepted")) blockers.push("先完成并验收子任务，再进行本任务的整合检查。");
    if (!children.length && !node.actions.length && !node.source_scope) blockers.push("先写出这一步要执行的具体动作。");
    if (children.length && node.source_scope) blockers.push("源文件合同应分配到实际执行的末级步骤，上级使用整合验收。");
    for (const action of node.actions) {
      if (["write_file", "agent_artifact", "use_capability"].includes(action.type)) {
        const violation = engineeringPathViolation(effective, action.path);
        if (violation) blockers.push(`${action.title}：${violation}`);
      }
      if (action.type === "use_capability" && !node.capabilities.some((capability) => capability.id === action.capability_id)) blockers.push(`“${action.title}”尚未选定可用能力。`);
      if (action.type === "check_file" && !node.criteria.some((criterion) => criterion.id === action.criterion_id && criterion.kind !== "manual")) blockers.push(`“${action.title}”需要关联自动验收条件。`);
    }
    for (const criterion of node.criteria) if (criterion.kind !== "manual") {
      if (!safeRelative(criterion.path)) blockers.push(`验收“${criterion.text}”需要安全的相对文件路径。`);
      if (criterion.kind === "file_contains" && !criterion.expected) blockers.push(`验收“${criterion.text}”还没有填写应包含的内容。`);
    }
    const automaticPassed = node.criteria.filter((criterion) => criterion.kind !== "manual").every((criterion) => run?.evidence.some((evidence) => evidence.criterion_id === criterion.id && evidence.passed === true && evidence.kind === "check"));
    const hasResult = Boolean(run?.evidence.some((evidence) => ["artifact", "check", "capability"].includes(evidence.kind)) || (children.length && children.every((child) => statusOf(child) === "accepted")));
    derived[node.id] = {
      id: node.id, depth: lineage.length - 1, path: lineage.map((item) => item.id), child_ids: children.map((child) => child.id),
      dependent_ids: activeNodes.filter((item) => engineeringDirectPrerequisites(item).includes(node.id)).map((item) => item.id),
      effective, status, blockers: [...new Set(blockers)], can_run: status === "ready" && blockers.length === 0 && !run?.status.match(/^(queued|running|review)$/),
      can_accept: status === "review" && blockers.length === 0 && automaticPassed && hasResult && (!node.source_scope || run?.source_proof?.passed === true),
      latest_run_id: run?.id ?? null, uncovered_criteria: uncovered,
      counts: { total: leaves.length, accepted: leaves.filter((item) => statusOf(item) === "accepted").length, review: leaves.filter((item) => statusOf(item) === "review").length,
        running: leaves.filter((item) => statusOf(item) === "running").length, blocked: leaves.filter((item) => ["blocked", "needs_revision", "paused"].includes(statusOf(item))).length }
    };
  }
  return { document: doc, derived, scheduler: { max_parallel: maxParallel, active: doc.runs.filter((run) => run.status === "running").length, queued: doc.runs.filter((run) => run.status === "queued").length } };
}
