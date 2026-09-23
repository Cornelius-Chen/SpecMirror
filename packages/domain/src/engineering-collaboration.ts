import { minimatch } from "minimatch";
import {
  currentEngineeringRun,
  deriveEngineeringView,
  effectiveEngineeringConstraints,
  engineeringDescendants,
  engineeringLineage,
  engineeringNodeContractRevision,
  type EngineeringDocument,
  type EngineeringNode
} from "./engineering.ts";

export type EngineeringZoneOwnerState = "unassigned" | "single" | "mixed";
export type EngineeringCollaborationHandoffKind = "delivery" | "prerequisite" | "interaction";
export type EngineeringCollaborationConflictKind = "hard_dependency" | "shared_resource" | "write_path_overlap";

export interface EngineeringAgentAssignment {
  node_id: string;
  declared_owner: string | null;
  effective_agent_owner: string | null;
  owner_source_node_id: string | null;
  inherited: boolean;
}

export interface EngineeringZoneWriteScope {
  id: string;
  node_id: string;
  kind: "source" | "artifact";
  root: string;
  pattern: string;
}

export interface EngineeringCollaborationHandoff {
  id: string;
  from_zone_id: string;
  to_zone_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: EngineeringCollaborationHandoffKind;
  requires_acceptance: boolean;
  active_wait: boolean;
  blocking: boolean;
  label: string;
  reason: string;
  source_output_id?: string;
  target_input_id?: string;
}

export interface EngineeringCollaborationConflict {
  id: string;
  left_zone_id: string;
  right_zone_id: string;
  kind: EngineeringCollaborationConflictKind;
  effect: "wait" | "serialize";
  blocking: true;
  reason: string;
  waiting_zone_id?: string;
  required_zone_id?: string;
  resource?: string;
  write_scopes?: [EngineeringZoneWriteScope, EngineeringZoneWriteScope];
}

export interface EngineeringCollaborationCovenants {
  rules: Array<{ node_id: string; title: string; text: string }>;
  resources: string[];
}

export interface EngineeringCollaborationZone {
  id: string;
  root_node_id: string;
  title: string;
  node_ids: string[];
  leaf_ids: string[];
  available_leaf_ids: string[];
  runnable_leaf_ids: string[];
  authorized_leaf_ids: string[];
  claimable_leaf_ids: string[];
  claimable_run_ids: string[];
  owner_state: EngineeringZoneOwnerState;
  effective_agent_owner: string | null;
  agent_owners: string[];
  covenants: EngineeringCollaborationCovenants;
  write_scopes: EngineeringZoneWriteScope[];
  contract_key: string;
}

export interface EngineeringCollaborationPlan {
  scope_root_id: string;
  zones: EngineeringCollaborationZone[];
  node_assignments: Record<string, EngineeringAgentAssignment>;
  handoffs: EngineeringCollaborationHandoff[];
  conflicts: EngineeringCollaborationConflict[];
  available_leaf_ids: string[];
  runnable_leaf_ids: string[];
  authorized_leaf_ids: string[];
  claimable_leaf_ids: string[];
  claimable_run_ids: string[];
}

interface ZoneDraft extends Omit<EngineeringCollaborationZone, "contract_key"> {
  contract_key?: string;
}

const unassignedOwners = new Set(["", "未分配", "unassigned"]);
const writingActionTypes = new Set(["write_file", "agent_artifact", "use_capability"]);

function canonicalValue(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]))
      : item;
  return JSON.stringify(normalize(value));
}

function normalizedOwner(owner: string): string | null {
  const value = owner.trim();
  return unassignedOwners.has(value.toLowerCase()) || value === "未分配" ? null : value;
}

function isAgentOwner(owner: string): boolean {
  return /^codex:[^\s:][^\s]*$/i.test(owner);
}

/**
 * Resolve the nearest declared owner. Only an authenticated Codex identity is an
 * Agent owner; a nearer human/role owner deliberately stops Agent inheritance.
 */
export function engineeringAgentAssignment(doc: EngineeringDocument, nodeId: string): EngineeringAgentAssignment {
  const lineage = engineeringLineage(doc, nodeId);
  const node = lineage.at(-1)!;
  for (let index = lineage.length - 1; index >= 0; index--) {
    const candidate = lineage[index]!;
    const owner = normalizedOwner(candidate.owner);
    if (!owner) continue;
    return {
      node_id: node.id,
      declared_owner: normalizedOwner(node.owner),
      effective_agent_owner: isAgentOwner(owner) ? owner : null,
      owner_source_node_id: isAgentOwner(owner) ? candidate.id : null,
      inherited: isAgentOwner(owner) && candidate.id !== node.id
    };
  }
  return { node_id: node.id, declared_owner: null, effective_agent_owner: null, owner_source_node_id: null, inherited: false };
}

export function effectiveEngineeringAgentOwner(doc: EngineeringDocument, nodeId: string): string | null {
  return engineeringAgentAssignment(doc, nodeId).effective_agent_owner;
}

function activeSubtree(doc: EngineeringDocument, rootNode: EngineeringNode): EngineeringNode[] {
  return [rootNode, ...engineeringDescendants(doc, rootNode.id)
    .filter(node => node.status !== "archived")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))];
}

function leafNodes(doc: EngineeringDocument, nodes: EngineeringNode[]): EngineeringNode[] {
  const activeIds = new Set(nodes.map(node => node.id));
  return nodes.filter(node => !doc.nodes.some(child => child.status !== "archived" && child.parent_id === node.id && activeIds.has(child.id)));
}

function normalizePath(value: string): string {
  let result = value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
  if (result.length > 1) result = result.replace(/\/$/, "");
  return result || ".";
}

function absolutePattern(scope: EngineeringZoneWriteScope): string {
  const root = normalizePath(scope.root);
  const pattern = normalizePath(scope.pattern).replace(/^\.\//, "");
  return scope.kind === "artifact" ? `artifact:${pattern}` : `source:${root}/${pattern}`;
}

function hasMagic(value: string): boolean {
  return /[*?\[\]{}()!+@]/.test(value);
}

function subtreeRoot(value: string): string | null {
  const normalized = value.replace(/\/$/, "");
  if (normalized.endsWith("/**")) return normalized.slice(0, -3).replace(/\/$/, "");
  return null;
}

/** Only proven intersections are returned; ambiguous broad globs do not serialize sibling zones. */
function writeScopesOverlap(left: EngineeringZoneWriteScope, right: EngineeringZoneWriteScope): boolean {
  if (left.kind !== right.kind) return false;
  const a = absolutePattern(left), b = absolutePattern(right);
  if (a === b) return true;
  const aMagic = hasMagic(a), bMagic = hasMagic(b);
  if (!aMagic && !bMagic) return false;
  if (!aMagic) return minimatch(a, b, { dot: true, nocase: true, nonegate: true });
  if (!bMagic) return minimatch(b, a, { dot: true, nocase: true, nonegate: true });
  const aRoot = subtreeRoot(a), bRoot = subtreeRoot(b);
  if (aRoot && bRoot) return aRoot === bRoot || aRoot.startsWith(`${bRoot}/`) || bRoot.startsWith(`${aRoot}/`);
  if (aRoot && !hasMagic(b.replace(`${aRoot}/`, "")) && b.startsWith(`${aRoot}/`)) return true;
  if (bRoot && !hasMagic(a.replace(`${bRoot}/`, "")) && a.startsWith(`${bRoot}/`)) return true;
  return false;
}

function zoneWriteScopes(nodes: EngineeringNode[]): EngineeringZoneWriteScope[] {
  const scopes: EngineeringZoneWriteScope[] = [];
  for (const node of nodes) {
    for (const [index, pattern] of (node.source_scope?.allow ?? []).entries()) scopes.push({
      id: `${node.id}:source:${index}`, node_id: node.id, kind: "source", root: node.source_scope!.root, pattern
    });
    for (const action of node.actions) if (writingActionTypes.has(action.type) && action.path.trim()) scopes.push({
      id: `${node.id}:artifact:${action.id}`, node_id: node.id, kind: "artifact", root: ".", pattern: action.path
    });
  }
  return scopes.sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueRules(doc: EngineeringDocument, nodes: EngineeringNode[]): EngineeringCollaborationCovenants {
  const rules = new Map<string, { node_id: string; title: string; text: string }>();
  const resources = new Set<string>();
  for (const node of nodes) {
    const effective = effectiveEngineeringConstraints(doc, node.id);
    for (const rule of effective.rules) rules.set(`${rule.node_id}\u0000${rule.text}`, rule);
    for (const resource of effective.resources) resources.add(resource);
  }
  return {
    rules: [...rules.values()].sort((a, b) => a.node_id.localeCompare(b.node_id) || a.text.localeCompare(b.text)),
    resources: [...resources].sort()
  };
}

function addHandoff(target: Map<string, EngineeringCollaborationHandoff>, value: EngineeringCollaborationHandoff) {
  const semanticKey = canonicalValue([
    value.kind, value.from_zone_id, value.to_zone_id, value.source_node_id, value.target_node_id,
    value.source_output_id ?? "", value.target_input_id ?? ""
  ]);
  if (!target.has(semanticKey)) target.set(semanticKey, value);
}

function crossZoneHandoffs(doc: EngineeringDocument, nodeToZone: Map<string, string>, statuses: Record<string, EngineeringNode["status"]>): EngineeringCollaborationHandoff[] {
  const handoffs = new Map<string, EngineeringCollaborationHandoff>();
  for (const target of doc.nodes.filter(node => node.status !== "archived" && nodeToZone.has(node.id))) {
    const targetZone = nodeToZone.get(target.id)!;
    const deliveredSources = new Set<string>();
    for (const input of target.delivery?.inputs ?? []) {
      if (!input.source_node_id) continue;
      const sourceZone = nodeToZone.get(input.source_node_id);
      if (!sourceZone || sourceZone === targetZone) continue;
      deliveredSources.add(input.source_node_id);
      const source = doc.nodes.find(node => node.id === input.source_node_id);
      const output = source?.delivery?.outputs.find(item => item.id === input.source_output_id);
      addHandoff(handoffs, {
        id: `handoff:delivery:${input.source_node_id}:${target.id}:${input.id}`,
        from_zone_id: sourceZone, to_zone_id: targetZone, source_node_id: input.source_node_id, target_node_id: target.id,
        kind: "delivery", requires_acceptance: true, active_wait: statuses[input.source_node_id] !== "accepted", blocking: statuses[input.source_node_id] !== "accepted",
        label: output?.title || input.title || "成果交接",
        reason: `“${target.title}”需要“${source?.title ?? input.source_node_id}”通过验收后的成果。`,
        source_output_id: input.source_output_id, target_input_id: input.id
      });
    }
    for (const prerequisite of target.prerequisites ?? []) {
      if (deliveredSources.has(prerequisite.node_id)) continue;
      const sourceZone = nodeToZone.get(prerequisite.node_id);
      if (!sourceZone || sourceZone === targetZone) continue;
      const source = doc.nodes.find(node => node.id === prerequisite.node_id);
      addHandoff(handoffs, {
        id: `handoff:prerequisite:${prerequisite.node_id}:${target.id}:${prerequisite.id}`,
        from_zone_id: sourceZone, to_zone_id: targetZone, source_node_id: prerequisite.node_id, target_node_id: target.id,
        kind: "prerequisite", requires_acceptance: true, active_wait: statuses[prerequisite.node_id] !== "accepted", blocking: statuses[prerequisite.node_id] !== "accepted", label: "开工前提",
        reason: prerequisite.reason.trim() || `“${target.title}”等待“${source?.title ?? prerequisite.node_id}”完成。`
      });
    }
    const represented = new Set([...(target.delivery?.inputs.flatMap(input => input.source_node_id ? [input.source_node_id] : []) ?? []), ...(target.prerequisites?.map(item => item.node_id) ?? [])]);
    for (const dependencyId of target.dependencies) {
      if (represented.has(dependencyId)) continue;
      const sourceZone = nodeToZone.get(dependencyId);
      if (!sourceZone || sourceZone === targetZone) continue;
      const source = doc.nodes.find(node => node.id === dependencyId);
      addHandoff(handoffs, {
        id: `handoff:prerequisite:${dependencyId}:${target.id}:legacy`,
        from_zone_id: sourceZone, to_zone_id: targetZone, source_node_id: dependencyId, target_node_id: target.id,
        kind: "prerequisite", requires_acceptance: true, active_wait: statuses[dependencyId] !== "accepted", blocking: statuses[dependencyId] !== "accepted", label: "完成后开始",
        reason: `“${target.title}”需要等待“${source?.title ?? dependencyId}”完成。`
      });
    }
  }
  for (const source of doc.nodes.filter(node => node.status !== "archived" && nodeToZone.has(node.id))) {
    const sourceZone = nodeToZone.get(source.id)!;
    for (const interaction of source.interactions ?? []) {
      const targetZone = nodeToZone.get(interaction.target_node_id);
      if (!targetZone || targetZone === sourceZone) continue;
      const target = doc.nodes.find(node => node.id === interaction.target_node_id);
      addHandoff(handoffs, {
        id: `handoff:interaction:${source.id}:${interaction.target_node_id}:${interaction.id}`,
        from_zone_id: sourceZone, to_zone_id: targetZone, source_node_id: source.id, target_node_id: interaction.target_node_id,
        kind: "interaction", requires_acceptance: false, active_wait: false, blocking: false, label: interaction.purpose.trim() || "运行配合",
        reason: interaction.scenario.trim() || `“${source.title}”与“${target?.title ?? interaction.target_node_id}”需要运行配合。`,
        ...(interaction.source_output_id ? { source_output_id: interaction.source_output_id } : {}),
        ...(interaction.target_input_id ? { target_input_id: interaction.target_input_id } : {})
      });
    }
  }
  return [...handoffs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function zoneConflicts(zones: ZoneDraft[], handoffs: EngineeringCollaborationHandoff[]): EngineeringCollaborationConflict[] {
  const conflicts: EngineeringCollaborationConflict[] = [];
  for (const handoff of handoffs.filter(item => item.active_wait)) conflicts.push({
    id: `conflict:wait:${handoff.id}`,
    left_zone_id: handoff.from_zone_id,
    right_zone_id: handoff.to_zone_id,
    kind: "hard_dependency",
    effect: "wait",
    blocking: true,
    reason: handoff.reason,
    waiting_zone_id: handoff.to_zone_id,
    required_zone_id: handoff.from_zone_id
  });
  for (let leftIndex = 0; leftIndex < zones.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < zones.length; rightIndex++) {
      const left = zones[leftIndex]!, right = zones[rightIndex]!;
      for (const resource of left.covenants.resources.filter(item => right.covenants.resources.includes(item))) conflicts.push({
        id: `conflict:resource:${left.id}:${right.id}:${resource}`,
        left_zone_id: left.id, right_zone_id: right.id, kind: "shared_resource", effect: "serialize", blocking: true,
        reason: `“${left.title}”与“${right.title}”同时需要独占资源“${resource}”。`, resource
      });
      for (const leftScope of left.write_scopes) for (const rightScope of right.write_scopes) {
        if (!writeScopesOverlap(leftScope, rightScope)) continue;
        conflicts.push({
          id: `conflict:write:${leftScope.id}:${rightScope.id}`,
          left_zone_id: left.id, right_zone_id: right.id, kind: "write_path_overlap", effect: "serialize", blocking: true,
          reason: `“${left.title}”与“${right.title}”声明写入同一范围：${leftScope.pattern} / ${rightScope.pattern}。`,
          write_scopes: [leftScope, rightScope]
        });
      }
    }
  }
  return conflicts.sort((a, b) => a.id.localeCompare(b.id));
}

function zoneContractKey(
  doc: EngineeringDocument,
  scopeRootId: string,
  zone: ZoneDraft,
  assignments: Record<string, EngineeringAgentAssignment>,
  handoffs: EngineeringCollaborationHandoff[]
): string {
  const memberIds = new Set(zone.node_ids);
  const interfaces = handoffs.filter(handoff => handoff.from_zone_id === zone.id || handoff.to_zone_id === zone.id).map(handoff => {
    const source = doc.nodes.find(node => node.id === handoff.source_node_id)!;
    const target = doc.nodes.find(node => node.id === handoff.target_node_id)!;
    return {
      kind: handoff.kind, from_zone_id: handoff.from_zone_id, to_zone_id: handoff.to_zone_id,
      source_node_id: source.id, source_contract_revision: engineeringNodeContractRevision(source),
      target_node_id: target.id, target_contract_revision: engineeringNodeContractRevision(target),
      source_output_id: handoff.source_output_id ?? "", target_input_id: handoff.target_input_id ?? "", requires_acceptance: handoff.requires_acceptance
    };
  });
  return canonicalValue({
    schema_version: 1,
    scope_root_id: scopeRootId,
    zone_id: zone.id,
    members: doc.nodes.filter(node => memberIds.has(node.id)).map(node => [node.id, engineeringNodeContractRevision(node)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    assignments: zone.node_ids.map(nodeId => {
      const assignment = assignments[nodeId]!;
      return [nodeId, assignment.effective_agent_owner, assignment.owner_source_node_id];
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    covenants: {
      rules: zone.covenants.rules.map(rule => [rule.node_id, rule.text]),
      resources: zone.covenants.resources
    },
    write_scopes: zone.write_scopes.map(scope => [scope.node_id, scope.kind, scope.root, scope.pattern]),
    interfaces: interfaces.sort((a, b) => canonicalValue(a).localeCompare(canonicalValue(b)))
  });
}

/**
 * Project one hierarchy level into independent Agent work zones. Sibling zones
 * stay parallel unless a declared hard wait, exclusive resource, or provably
 * overlapping direct write scope says otherwise.
 */
export function deriveEngineeringCollaborationPlan(doc: EngineeringDocument, scopeRootId = doc.root_id): EngineeringCollaborationPlan {
  const scopeRoot = doc.nodes.find(node => node.id === scopeRootId && node.status !== "archived");
  if (!scopeRoot) throw new Error("没有找到协作分区的范围节点。");
  const directChildren = doc.nodes.filter(node => node.parent_id === scopeRootId && node.status !== "archived").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const zoneRoots = directChildren.length ? directChildren : [scopeRoot];
  const view = deriveEngineeringView(doc);
  const nodeAssignments: Record<string, EngineeringAgentAssignment> = {};
  nodeAssignments[scopeRoot.id] = engineeringAgentAssignment(doc, scopeRoot.id);
  const nodeToZone = new Map<string, string>();
  const zones: ZoneDraft[] = zoneRoots.map(rootNode => {
    const nodes = activeSubtree(doc, rootNode);
    const leaves = leafNodes(doc, nodes);
    for (const node of nodes) {
      nodeAssignments[node.id] = engineeringAgentAssignment(doc, node.id);
      nodeToZone.set(node.id, `zone:${rootNode.id}`);
    }
    // A zone is singly owned only when every active member resolves to the same
    // Agent. Looking at leaves alone can hide an internal human or second-Agent
    // boundary and would make the zone packet broader than its real authority.
    const ownerSignatures = [...new Set(nodes.map(node => nodeAssignments[node.id]!.effective_agent_owner ?? "unassigned"))];
    const owners = ownerSignatures.filter(owner => owner !== "unassigned").sort();
    const availableLeafIds = leaves.filter(leaf => {
      if (nodeAssignments[leaf.id]!.effective_agent_owner) return false;
      const status = view.derived[leaf.id]?.status;
      const run = currentEngineeringRun(doc, leaf.id);
      return !["accepted", "running", "review", "archived"].includes(status ?? "archived")
        && !run?.status.match(/^(queued|running|review)$/);
    }).map(leaf => leaf.id);
    const runnableLeafIds = leaves.filter(leaf => view.derived[leaf.id]?.can_run).map(leaf => leaf.id);
    const authorizedLeafIds = leaves.filter(leaf => Boolean(nodeAssignments[leaf.id]!.effective_agent_owner)).map(leaf => leaf.id);
    const claimable = leaves.flatMap(leaf => {
      const owner = nodeAssignments[leaf.id]!.effective_agent_owner;
      const run = currentEngineeringRun(doc, leaf.id);
      if (!owner || !run || run.mode !== "external" || !["queued", "running"].includes(run.status)
        || run.handoff?.state !== "awaiting_claim" || run.handoff.owner !== owner
        || run.handoff.contract_key !== run.snapshot.contract_key) return [];
      return [{ leaf_id: leaf.id, run_id: run.id }];
    });
    return {
      id: `zone:${rootNode.id}`,
      root_node_id: rootNode.id,
      title: rootNode.title,
      node_ids: nodes.map(node => node.id),
      leaf_ids: leaves.map(node => node.id),
      available_leaf_ids: availableLeafIds,
      runnable_leaf_ids: runnableLeafIds,
      authorized_leaf_ids: authorizedLeafIds,
      claimable_leaf_ids: claimable.map(item => item.leaf_id),
      claimable_run_ids: claimable.map(item => item.run_id),
      owner_state: ownerSignatures.length === 1 && ownerSignatures[0] === "unassigned" ? "unassigned" : ownerSignatures.length === 1 ? "single" : "mixed",
      effective_agent_owner: ownerSignatures.length === 1 && ownerSignatures[0] !== "unassigned" ? ownerSignatures[0]! : null,
      agent_owners: owners,
      covenants: uniqueRules(doc, nodes),
      write_scopes: zoneWriteScopes(nodes)
    };
  });
  const statuses = Object.fromEntries(Object.entries(view.derived).map(([nodeId, derived]) => [nodeId, derived.status]));
  const handoffs = crossZoneHandoffs(doc, nodeToZone, statuses);
  for (const zone of zones) zone.contract_key = zoneContractKey(doc, scopeRootId, zone, nodeAssignments, handoffs);
  const finalizedZones = zones as EngineeringCollaborationZone[];
  return {
    scope_root_id: scopeRootId,
    zones: finalizedZones,
    node_assignments: nodeAssignments,
    handoffs,
    conflicts: zoneConflicts(zones, handoffs),
    available_leaf_ids: finalizedZones.flatMap(zone => zone.available_leaf_ids),
    runnable_leaf_ids: finalizedZones.flatMap(zone => zone.runnable_leaf_ids),
    authorized_leaf_ids: finalizedZones.flatMap(zone => zone.authorized_leaf_ids),
    claimable_leaf_ids: finalizedZones.flatMap(zone => zone.claimable_leaf_ids),
    claimable_run_ids: finalizedZones.flatMap(zone => zone.claimable_run_ids)
  };
}

export function engineeringZoneContractKey(doc: EngineeringDocument, zoneRootId: string, scopeRootId = doc.root_id): string {
  const zoneId = `zone:${zoneRootId}`;
  const zone = deriveEngineeringCollaborationPlan(doc, scopeRootId).zones.find(item => item.id === zoneId);
  if (!zone) throw new Error("没有找到这项协作分区。");
  return zone.contract_key;
}
