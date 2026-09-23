import type { Claim, Decision, DesignAtom, Evidence, Project, TraceBinding, TraceEdge } from "./schema.ts";

export interface GraphEntity { id: string; title: string; [key: string]: unknown }

export function validateGraph(entities: GraphEntity[], edges: TraceEdge[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entity of entities) {
    if (ids.has(entity.id)) errors.push(`duplicate entity id: ${entity.id}`);
    ids.add(entity.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.from)) errors.push(`missing edge source: ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`missing edge target: ${edge.to}`);
    if (edge.from === edge.to) errors.push(`self edge: ${edge.id}`);
  }
  return errors;
}

export function validateTraceBindings(entities: GraphEntity[], bindings: TraceBinding[]): string[] {
  const errors: string[] = [];
  const ids = new Set(entities.map((entity) => entity.id));
  const bindingIds = new Set<string>();
  const marks = new Set<string>();
  for (const binding of bindings) {
    if (bindingIds.has(binding.id)) errors.push(`duplicate trace binding id: ${binding.id}`);
    if (marks.has(binding.mark)) errors.push(`duplicate trace binding mark: ${binding.mark}`);
    bindingIds.add(binding.id); marks.add(binding.mark);
    if (!ids.has(binding.design_id)) errors.push(`missing binding design: ${binding.design_id}`);
    if (!ids.has(binding.engineering_id)) errors.push(`missing binding engineering: ${binding.engineering_id}`);
  }
  return errors;
}

export function impactFrom(startId: string, edges: TraceEdge[]): { direct: string[]; transitive: string[]; paths: string[][] } {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges.filter((item) => item.status === "formal")) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const direct = [...(adjacency.get(startId) ?? [])];
  const visited = new Set<string>([startId]);
  const queue = direct.map((id) => [startId, id]);
  const paths: string[][] = [];
  while (queue.length) {
    const path = queue.shift()!;
    const current = path.at(-1)!;
    if (visited.has(current)) continue;
    visited.add(current);
    paths.push(path);
    for (const next of adjacency.get(current) ?? []) queue.push([...path, next]);
  }
  return { direct, transitive: [...visited].filter((id) => id !== startId), paths };
}

export function weightedProgress(atoms: DesignAtom[]): number {
  const weights = atoms.map((atom) => atom.weight);
  const total = weights.reduce((sum, item) => sum + item, 0);
  if (!total) return 0;
  const stateScore: Record<DesignAtom["status"], number> = {
    draft: 0, approved: 0.35, verified: 0.8, guarded: 1, blocked: 0.2, failed: 0, superseded: 0
  };
  return Math.round(atoms.reduce((sum, atom) => sum + atom.weight * stateScore[atom.status], 0) / total * 100);
}

export function evidenceCoverage(claims: Claim[], evidence: Evidence[]): number {
  const important = claims.filter((claim) => claim.risk !== "low" && claim.status !== "retired");
  if (!important.length) return 100;
  const accepted = new Set(evidence.filter((item) => item.status === "accepted").flatMap((item) => item.supports));
  return Math.round(important.filter((claim) => accepted.has(claim.id)).length / important.length * 100);
}

export function recomputeClaimConfidence(claim: Claim, evidence: Evidence[]): Claim {
  const accepted = evidence.filter((item) => item.status === "accepted" && item.supports.includes(claim.id));
  const scores = accepted.map((item) => ({ weak: 0.25, medium: 0.55, strong: 0.85 })[item.strength]);
  if (!scores.length) return { ...claim, confidence: 0, status: claim.status === "retired" ? "retired" : "unsupported" };
  const confidence = Math.min(0.98, 1 - scores.reduce((remaining, score) => remaining * (1 - score), 1));
  return {
    ...claim,
    confidence: Math.round(confidence * 100) / 100,
    status: confidence >= 0.75 ? "supported" : confidence >= 0.4 ? "partially_supported" : "unsupported"
  };
}

export function deriveNextBestAction(claims: Claim[], fallback: { title: string; reason: string }) {
  const unresolved = claims
    .filter((claim) => claim.status !== "retired" && (claim.status === "contradicted" || claim.confidence < 0.5))
    .sort((a, b) => ({ high: 3, medium: 2, low: 1 })[b.risk] - ({ high: 3, medium: 2, low: 1 })[a.risk])[0];
  return unresolved ? {
    title: `验证：${unresolved.title}`,
    reason: "这是当前风险最高且证据最薄弱的主张，优先验证能最大幅度降低不确定性。"
  } : fallback;
}

export function deriveDecisionHealth(decision: Decision, claims: Claim[]) {
  const linked = decision.claim_ids.map((id) => claims.find((claim) => claim.id === id)).filter((claim): claim is Claim => Boolean(claim));
  if (decision.status === "superseded" || decision.status === "rejected") return { id: `health-${decision.id}`, title: decision.title, decision_id: decision.id, health: "inactive", confidence: 0, reason: "该决策已不再生效。" };
  if (!decision.claim_ids.length) return { id: `health-${decision.id}`, title: decision.title, decision_id: decision.id, health: "policy", confidence: 1, reason: "这是范围或策略决策，不依赖 Claim 自动计算。" };
  if (linked.length !== decision.claim_ids.length) return { id: `health-${decision.id}`, title: decision.title, decision_id: decision.id, health: "blocked", confidence: 0, reason: "存在缺失的依据主张。" };
  const confidence = Math.round(linked.reduce((sum, claim) => sum + claim.confidence, 0) / linked.length * 100) / 100;
  if (linked.some((claim) => claim.status === "contradicted" || claim.confidence < 0.4)) return { id: `health-${decision.id}`, title: decision.title, decision_id: decision.id, health: "blocked", confidence, reason: "至少一项关键主张被反驳或证据不足，应暂停执行并复核。" };
  if (linked.some((claim) => claim.status !== "supported" || claim.confidence < 0.75)) return { id: `health-${decision.id}`, title: decision.title, decision_id: decision.id, health: "at_risk", confidence, reason: "依据尚未完全支持，需继续补证。" };
  return { id: `health-${decision.id}`, title: decision.title, decision_id: decision.id, health: decision.status === "proposed" ? "ready_for_review" : "supported", confidence, reason: decision.status === "proposed" ? "依据已足够，可进入人工决策。" : "全部关联主张均有充分证据。" };
}

export function baselineMetrics(project: Project, atoms: DesignAtom[]) {
  const baselineIds = new Set(project.baselines.flatMap((baseline) => baseline.atom_ids));
  const baselineAtoms = atoms.filter((atom) => baselineIds.has(atom.id));
  const frontierAtoms = atoms.filter((atom) => !baselineIds.has(atom.id));
  const baselineProgress = weightedProgress(baselineAtoms);
  const frontierProgress = frontierAtoms.length ? weightedProgress(frontierAtoms) : project.frontier.progress;
  return {
    baselineProgress,
    frontierProgress,
    baselineAtRisk: baselineAtoms.some((atom) => ["blocked", "failed"].includes(atom.status))
  };
}
