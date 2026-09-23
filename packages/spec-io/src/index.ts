import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "yaml";
export * from "./engineering.ts";
import {
  ProjectSchema, TraceSchema, assertTransition, baselineMetrics, deriveDecisionHealth, deriveNextBestAction, entitySchemas, evidenceCoverage, globsOverlap, impactFrom, recomputeClaimConfidence, validateGraph, validateTraceBindings,
  type AgentRun, type ChangeSet, type Claim, type Constraint, type Decision, type DesignAtom,
  type EngineeringUnit, type Evidence, type GoalContract, type Idea, type Project, type TraceEdge,
  type ChangeProposal, type ReviewRecord, type TraceBinding, SupervisionDocumentSchema, SupervisionRunSchema, SupervisionTaskSchema,
  type SupervisionDetail, type SupervisionDocument, type SupervisionDocumentInput, type SupervisionRun, type SupervisionTask,
  type Capability, type PermissionContract, CapabilitySchema, PermissionContractSchema, ExternalAgentReceiptSchema,
  CompletionAuditSchema, type CompletionAudit
} from "@epm/domain";

export interface ProjectModel {
  project: Project;
  ideas: Idea[];
  claims: Claim[];
  decisions: Decision[];
  evidence: Evidence[];
  design: DesignAtom[];
  constraints: Constraint[];
  engineering: EngineeringUnit[];
  changes: ChangeSet[];
  goals: GoalContract[];
  runs: AgentRun[];
  proposals: ChangeProposal[];
  reviews: ReviewRecord[];
  capabilities: Capability[];
  permissionContracts: PermissionContract[];
  edges: TraceEdge[];
  bindings: TraceBinding[];
}

const folders = ["inbox", "claims", "decisions", "evidence", "design", "constraints", "engineering", "changes", "goals", "runs", "proposals", "reviews", "capabilities", "permission-contracts"] as const;

export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".project", "project.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No .project/project.yaml found from ${start}`);
    current = parent;
  }
}

export function readYaml<T = unknown>(path: string): T {
  return parse(readFileSync(path, "utf8")) as T;
}

export function readVersionedYaml<T = unknown>(path: string): T {
  return migrateDocument(readYaml(path)) as T;
}

export function atomicWriteYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const operationId = `${process.pid}.${randomUUID()}`;
  const temporary = `${path}.${operationId}.tmp`;
  const backup = `${path}.${operationId}.bak`;
  writeFileSync(temporary, stringify(value, { lineWidth: 110 }), { encoding: "utf8", flag: "wx" });
  const handle = openSync(temporary, "r+");
  try { fsyncSync(handle); } finally { closeSync(handle); }
  let movedOld = false;
  try {
    if (existsSync(path)) { renameSync(path, backup); movedOld = true; }
    renameSync(temporary, path);
    if (movedOld) rmSync(backup, { force: true });
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    if (movedOld && existsSync(backup) && !existsSync(path)) renameSync(backup, path);
    throw error;
  }
}

function loadFolder(root: string, folder: typeof folders[number]): unknown[] {
  const path = join(root, ".project", folder);
  if (!existsSync(path)) return [];
  const schema = entitySchemas[folder];
  return readdirSync(path, { withFileTypes: true })
    .filter((item) => item.isFile() && /\.ya?ml$/i.test(item.name))
    .map((item) => schema.parse(readVersionedYaml(join(path, item.name))));
}

export function loadProject(root = findRepoRoot()): ProjectModel {
  const projectRoot = resolve(root);
  const project = ProjectSchema.parse(readVersionedYaml(join(projectRoot, ".project", "project.yaml")));
  const trace = TraceSchema.parse(readVersionedYaml(join(projectRoot, ".project", "trace.yaml")));
  const model: ProjectModel = {
    project,
    ideas: loadFolder(projectRoot, "inbox") as Idea[], claims: loadFolder(projectRoot, "claims") as Claim[],
    decisions: loadFolder(projectRoot, "decisions") as Decision[], evidence: loadFolder(projectRoot, "evidence") as Evidence[],
    design: loadFolder(projectRoot, "design") as DesignAtom[], constraints: loadFolder(projectRoot, "constraints") as Constraint[],
    engineering: loadFolder(projectRoot, "engineering") as EngineeringUnit[], changes: loadFolder(projectRoot, "changes") as ChangeSet[],
    goals: loadFolder(projectRoot, "goals") as GoalContract[], runs: loadFolder(projectRoot, "runs") as AgentRun[],
    proposals: loadFolder(projectRoot, "proposals") as ChangeProposal[], reviews: loadFolder(projectRoot, "reviews") as ReviewRecord[], edges: trace.edges,
    capabilities: loadFolder(projectRoot, "capabilities") as Capability[], permissionContracts: loadFolder(projectRoot, "permission-contracts") as PermissionContract[],
    bindings: trace.bindings
  };
  const errors = [
    ...validateGraph(allGraphEntities(model), model.edges),
    ...validateTraceBindings(allGraphEntities(model), model.bindings),
    ...validateProjectReferences(model),
    ...validateSupervisionReferences(projectRoot, model)
  ];
  if (errors.length) throw new Error(`Graph validation failed:\n${errors.join("\n")}`);
  return model;
}

export function loadCompletionAudit(root = findRepoRoot()): CompletionAudit {
  const projectRoot = resolve(root);
  return CompletionAuditSchema.parse(readVersionedYaml(join(projectRoot, ".project", "audits", "completion.yaml")));
}

export function validateCompletionEvidence(root: string, audit: CompletionAudit): string[] {
  const projectRoot = resolve(root);
  const findings: string[] = [];
  const supervisionDetailIds = new Set(loadSupervision(projectRoot).details.map((detail) => detail.id));
  const project = loadProject(projectRoot).project;
  const baselineIds = new Set([...project.baselines.map((baseline) => baseline.id), project.frontier.id]);
  const safeArtifact = (taskId: string, reference: string) => {
    const [kind, rawTarget] = reference.split(":", 2);
    if (!rawTarget || !["file", "test"].includes(kind)) {
      findings.push(`unsupported completion evidence: ${taskId} -> ${reference}`);
      return;
    }
    const [relativePath, marker] = rawTarget.split("#", 2);
    const absolute = resolve(projectRoot, relativePath);
    const escaped = relative(projectRoot, absolute);
    if (isAbsolute(relativePath) || escaped.startsWith("..") || isAbsolute(escaped)) {
      findings.push(`unsafe completion evidence path: ${taskId} -> ${reference}`);
      return;
    }
    if (!existsSync(absolute)) {
      findings.push(`missing completion evidence: ${taskId} -> ${reference}`);
      return;
    }
    if (kind === "test" && marker) {
      const content = readFileSync(absolute, "utf8").toLocaleLowerCase();
      if (!content.includes(marker.toLocaleLowerCase())) findings.push(`missing completion evidence marker: ${taskId} -> ${reference}`);
    }
  };
  for (const workstream of audit.workstreams) for (const task of workstream.tasks) {
    for (const reference of task.evidence) safeArtifact(task.id, reference);
    if (task.condition?.kind === "supervision_detail_accepted" && !supervisionDetailIds.has(task.condition.detail_id)) {
      findings.push(`missing completion condition detail: ${task.id} -> ${task.condition.detail_id}`);
    }
    if (task.condition?.kind === "baseline_guarded" && !baselineIds.has(task.condition.baseline_id)) {
      findings.push(`missing completion condition baseline: ${task.id} -> ${task.condition.baseline_id}`);
    }
  }
  return findings;
}

export function allGraphEntities(model: ProjectModel) {
  return [...model.ideas, ...model.claims, ...model.decisions, ...model.evidence, ...model.design, ...model.constraints, ...model.engineering, ...model.changes, ...model.goals, ...model.runs, ...model.proposals, ...model.reviews, ...model.capabilities, ...model.permissionContracts] as Array<{ id: string; title: string; [key: string]: unknown }>;
}

export function validateProjectReferences(model: ProjectModel): string[] {
  const findings: string[] = [];
  const graphEntityIds = new Set(allGraphEntities(model).map((item) => item.id));
  const entityIds = new Set([model.project.id, ...graphEntityIds]);
  const designIds = new Set(model.design.map((item) => item.id));
  const evidenceIds = new Set(model.evidence.map((item) => item.id));
  const claimIds = new Set(model.claims.map((item) => item.id));
  const decisionIds = new Set(model.decisions.map((item) => item.id));
  const constraintIds = new Set(model.constraints.map((item) => item.id));
  const engineeringIds = new Set(model.engineering.map((item) => item.id));
  const changeIds = new Set(model.changes.map((item) => item.id));
  const goalIds = new Set(model.goals.map((item) => item.id));
  const runIds = new Set(model.runs.map((item) => item.id));
  const capabilityIds = new Set(model.capabilities.map((item) => item.id));
  const baselineIds = new Set(model.project.baselines.map((item) => item.id));
  const requireRef = (owner: string, field: string, id: string, allowed: Set<string>) => {
    if (!allowed.has(id)) findings.push(`missing reference: ${owner}.${field} -> ${id}`);
  };

  if (graphEntityIds.has(model.project.id)) findings.push(`duplicate project/entity id: ${model.project.id}`);
  const baselineAtoms = new Set<string>();
  for (const baseline of model.project.baselines) for (const id of baseline.atom_ids) {
    requireRef(baseline.id, "atom_ids", id, designIds);
    if (baselineAtoms.has(id)) findings.push(`design atom appears in multiple baselines: ${id}`);
    baselineAtoms.add(id);
  }
  for (const claim of model.claims) for (const evidenceId of claim.evidence_ids) {
    requireRef(claim.id, "evidence_ids", evidenceId, evidenceIds);
    const evidence = model.evidence.find((item) => item.id === evidenceId);
    if (evidence && !evidence.supports.includes(claim.id)) findings.push(`non-reciprocal claim evidence: ${claim.id} <-> ${evidenceId}`);
  }
  for (const evidence of model.evidence) for (const target of evidence.supports) {
    requireRef(evidence.id, "supports", target, entityIds);
    const claim = model.claims.find((item) => item.id === target);
    if (claim && !claim.evidence_ids.includes(evidence.id)) findings.push(`non-reciprocal evidence claim: ${evidence.id} <-> ${claim.id}`);
  }
  for (const decision of model.decisions) {
    for (const id of decision.claim_ids) requireRef(decision.id, "claim_ids", id, claimIds);
    for (const id of decision.supersedes) requireRef(decision.id, "supersedes", id, decisionIds);
  }
  for (const constraint of model.constraints) for (const id of constraint.applies_to) requireRef(constraint.id, "applies_to", id, entityIds);
  for (const engineering of model.engineering) for (const id of engineering.design_ids) requireRef(engineering.id, "design_ids", id, designIds);
  for (const goal of model.goals) {
    requireRef(goal.id, "change_set_id", goal.change_set_id, changeIds);
    for (const id of goal.dependencies) requireRef(goal.id, "dependencies", id, goalIds);
    const change = model.changes.find((item) => item.id === goal.change_set_id);
    if (change && !change.goal_ids.includes(goal.id)) findings.push(`goal absent from owning change set: ${goal.id} -> ${change.id}`);
    const advancesUnguardedDesign = change?.design_ids.some((id) => model.design.some((design) => design.id === id && design.status !== "guarded"));
    if (advancesUnguardedDesign && goal.required_gateway !== "codex-app-server") findings.push(`formal frontier goal must require codex-app-server: ${goal.id}`);
  }
  for (const change of model.changes) {
    for (const id of change.goal_ids) requireRef(change.id, "goal_ids", id, goalIds);
    for (const id of change.design_ids) requireRef(change.id, "design_ids", id, designIds);
    for (const id of change.constraint_ids) requireRef(change.id, "constraint_ids", id, constraintIds);
    for (const id of change.protected_baselines) requireRef(change.id, "protected_baselines", id, baselineIds);
    for (const [id, dependencies] of Object.entries(change.dependency_dag)) {
      if (!change.goal_ids.includes(id)) findings.push(`extra change DAG node: ${change.id}.${id}`);
      for (const dependency of dependencies) if (!change.goal_ids.includes(dependency)) findings.push(`missing change DAG dependency: ${change.id}.${id} -> ${dependency}`);
    }
    for (const id of change.goal_ids) if (!(id in change.dependency_dag)) findings.push(`missing change DAG node: ${change.id}.${id}`);
    for (const [contract, owner] of Object.entries(change.shared_contract_owners)) if (!change.goal_ids.includes(owner)) findings.push(`invalid shared contract owner: ${change.id}.${contract} -> ${owner}`);
  }
  for (const run of model.runs) requireRef(run.id, "goal_id", run.goal_id, goalIds);
  for (const proposal of model.proposals) requireRef(proposal.id, "goal_id", proposal.goal_id, goalIds);
  for (const review of model.reviews) {
    requireRef(review.id, "change_set_id", review.change_set_id, changeIds);
    for (const id of review.run_ids) requireRef(review.id, "run_ids", id, runIds);
  }
  for (const contract of model.permissionContracts) requireRef(contract.id, "capability_id", contract.capability_id, capabilityIds);
  for (const binding of model.bindings) {
    requireRef(binding.id, "design_id", binding.design_id, designIds);
    requireRef(binding.id, "engineering_id", binding.engineering_id, engineeringIds);
  }
  return [...new Set(findings)];
}

export function validateRepositoryArtifacts(root: string, model: ProjectModel): string[] {
  const findings: string[] = [];
  const safePath = (owner: string, value: string) => {
    const absolute = resolve(root, value);
    const fromRoot = relative(resolve(root), absolute);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      findings.push(`artifact path escapes repository: ${owner} -> ${value}`);
      return undefined;
    }
    return absolute;
  };
  const requirePath = (owner: string, value: string) => {
    const absolute = safePath(owner, value);
    if (absolute && !existsSync(absolute)) findings.push(`missing repository artifact: ${owner} -> ${value}`);
    return absolute && existsSync(absolute) ? absolute : undefined;
  };

  for (const engineering of model.engineering.filter((item) => ["verified", "guarded"].includes(item.status))) {
    requirePath(`${engineering.id}.path`, engineering.path);
    for (const testPath of engineering.test_paths) requirePath(`${engineering.id}.test_paths`, testPath);
  }
  for (const binding of model.bindings.filter((item) => item.status === "formal")) {
    const design = model.design.find((item) => item.id === binding.design_id);
    if (design && readObjectPath(design, binding.field_path) === undefined) findings.push(`missing design field: ${binding.id} -> ${binding.field_path}`);
    const file = requirePath(`${binding.id}.file_path`, binding.file_path);
    if (file && statSync(file).isFile() && !sourceContainsSymbol(readFileSync(file, "utf8"), binding.symbol)) findings.push(`missing code symbol: ${binding.id} -> ${binding.symbol}`);
    for (const testPath of binding.test_paths) requirePath(`${binding.id}.test_paths`, testPath);
  }
  return [...new Set(findings)];
}

export function validateSupervisionReferences(root: string, model: ProjectModel): string[] {
  if (!existsSync(supervisionFile(root))) return [];
  const findings: string[] = [];
  const document = loadSupervision(root);
  const documentVersions = [...loadSupervisionHistory(root), document]
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
  const runs = loadSupervisionRuns(root);
  const details = new Map<string, SupervisionDetail>();
  const goalIds = new Set(model.goals.map((item) => item.id));
  const agentRuns = new Map(model.runs.map((item) => [item.id, item]));
  const permissionContracts = new Map(model.permissionContracts.map((item) => [item.id, item]));
  const taskIds = new Set<string>();
  if (!model.design.some((item) => item.id === document.design_id)) findings.push(`missing supervision design: ${document.id}.design_id -> ${document.design_id}`);
  for (const task of document.tasks) {
    if (taskIds.has(task.id)) findings.push(`duplicate supervision task id: ${task.id}`);
    taskIds.add(task.id);
  }
  for (const task of document.tasks) for (const dependency of task.dependencies) {
    if (!taskIds.has(dependency) || dependency === task.id) findings.push(`invalid supervision task dependency: ${task.id} -> ${dependency}`);
  }
  for (const detail of document.details) {
    if (details.has(detail.id)) findings.push(`duplicate supervision detail id: ${detail.id}`);
    if (!taskIds.has(detail.task_id)) findings.push(`missing supervision detail task: ${detail.id}.task_id -> ${detail.task_id}`);
    details.set(detail.id, detail);
  }
  for (const contract of model.permissionContracts) if (!details.has(contract.detail_id)) findings.push(`missing permission detail: ${contract.id}.detail_id -> ${contract.detail_id}`);
  const runIds = new Set(runs.map((item) => item.id));
  for (const run of runs) {
    const detail = details.get(run.detail_id);
    if (!detail) findings.push(`missing supervision run detail: ${run.id}.detail_id -> ${run.detail_id}`);
    else {
      const snapshotDetail = [...documentVersions].reverse()
        .filter((version) => version.updated_at <= run.requested_at)
        .map((version) => version.details.find((item) => item.id === run.detail_id))
        .find((item) => item && JSON.stringify(item.prompt) === JSON.stringify(run.prompt_snapshot))
        ?? [...documentVersions].reverse()
          .map((version) => version.details.find((item) => item.id === run.detail_id))
          .find((item) => item && JSON.stringify(item.prompt) === JSON.stringify(run.prompt_snapshot))
        ?? detail;
      if (run.category !== snapshotDetail.category) findings.push(`supervision run category mismatch: ${run.id} -> ${run.category}/${snapshotDetail.category}`);
      validateOutputChecks(`${run.id}.output`, snapshotDetail, run.output, findings);
    }
    if (run.goal_id && !goalIds.has(run.goal_id)) findings.push(`missing supervision run goal: ${run.id}.goal_id -> ${run.goal_id}`);
    if (run.agent_run_id) {
      const agentRun = agentRuns.get(run.agent_run_id);
      if (!agentRun) findings.push(`missing supervision AgentRun: ${run.id}.agent_run_id -> ${run.agent_run_id}`);
      else if (run.goal_id && agentRun.goal_id !== run.goal_id) findings.push(`supervision AgentRun goal mismatch: ${run.id} -> ${agentRun.goal_id}/${run.goal_id}`);
    }
    if (run.supersedes_run_id) {
      if (!runIds.has(run.supersedes_run_id)) findings.push(`missing superseded supervision run: ${run.id}.supersedes_run_id -> ${run.supersedes_run_id}`);
      else {
        const previous = runs.find((item) => item.id === run.supersedes_run_id)!;
        if (previous.detail_id !== run.detail_id || previous.attempt >= run.attempt) findings.push(`invalid supervision run succession: ${run.id} -> ${previous.id}`);
      }
    }
    for (const id of run.capability_contract_ids) {
      const contract = permissionContracts.get(id);
      if (!contract) findings.push(`missing supervision capability contract: ${run.id}.capability_contract_ids -> ${id}`);
      else if (contract.detail_id !== run.detail_id) findings.push(`supervision capability scope mismatch: ${run.id} -> ${id}`);
    }
    if (["reviewing", "accepted", "needs_revision"].includes(run.status) && !run.output) findings.push(`supervision run output required: ${run.id} (${run.status})`);
    if (run.output && run.mode !== run.output.source) findings.push(`supervision run source mismatch: ${run.id} -> ${run.mode}/${run.output.source}`);
  }

  const receipts = join(root, ".project", "external-receipts");
  if (existsSync(receipts)) for (const item of readdirSync(receipts, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))) {
    const detailId = item.name.replace(/\.ya?ml$/i, "");
    const detail = details.get(detailId);
    if (!detail) { findings.push(`external receipt has no supervision detail: ${item.name}`); continue; }
    try {
      const receipt = ExternalAgentReceiptSchema.parse(readYaml(join(receipts, item.name)));
      validateOutputChecks(`external-receipts/${item.name}`, detail, receipt, findings);
      if (receipt.artifact_kind !== artifactKindForCategory(detail.category)) findings.push(`external receipt artifact kind mismatch: ${detailId} -> ${receipt.artifact_kind}`);
    } catch (error) { findings.push(`invalid external receipt: ${item.name} -> ${error instanceof Error ? error.message : String(error)}`); }
  }
  return [...new Set(findings)];
}

function artifactKindForCategory(category: SupervisionDetail["category"]) {
  return ({ function: "behavior", visual: "screenshot", interaction: "workflow", copy: "copy", asset: "asset" } as const)[category];
}

function validateOutputChecks(owner: string, detail: SupervisionDetail, output: { checks: Array<{ criterion: string; note: string }>; artifact_kind: string } | undefined, findings: string[]) {
  if (!output) return;
  if (output.artifact_kind !== artifactKindForCategory(detail.category)) findings.push(`supervision artifact kind mismatch: ${owner} -> ${output.artifact_kind}`);
  if (output.checks.length !== detail.acceptance.length) findings.push(`supervision acceptance coverage mismatch: ${owner}`);
  for (const criterion of detail.acceptance) if (output.checks.filter((check) => check.criterion === criterion && check.note.trim()).length !== 1) findings.push(`supervision acceptance mapping mismatch: ${owner} -> ${criterion}`);
}

function readObjectPath(value: unknown, path: string): unknown {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function sourceContainsSymbol(source: string, symbol: string) {
  if (source.includes(symbol)) return true;
  return symbol.split(".").filter(Boolean).every((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source));
}

export function projectMap(model: ProjectModel) {
  const derivedClaims = model.claims.map((claim) => recomputeClaimConfidence(claim, model.evidence));
  const decisionHealth = model.decisions.map((decision) => deriveDecisionHealth(decision, derivedClaims));
  const metrics = baselineMetrics(model.project, model.design);
  const activeRuns = model.runs.filter((run) => ["planning", "implementing", "reviewing", "integrating"].includes(run.status));
  return {
    project: model.project,
    metrics: {
      ...metrics,
      evidenceCoverage: evidenceCoverage(derivedClaims, model.evidence),
      agentLoad: activeRuns.length,
      maxWorkers: model.project.runtime.max_workers,
      blockedGoals: model.goals.filter((goal) => goal.status === "blocked").length
    },
    nodes: allGraphEntities({ ...model, claims: derivedClaims }),
    edges: model.edges,
    bindings: model.bindings,
    collections: {
      ideas: model.ideas, claims: derivedClaims, decisions: model.decisions, evidence: model.evidence,
      design: model.design, constraints: model.constraints, engineering: model.engineering,
      changes: model.changes, goals: model.goals, runs: model.runs, proposals: model.proposals, reviews: model.reviews,
      capabilities: model.capabilities, permissionContracts: model.permissionContracts, decisionHealth
    },
    nextBestAction: deriveNextBestAction(derivedClaims, model.project.next_best_action)
  };
}

export function impactReport(model: ProjectModel, id: string) {
  const impact = impactFrom(id, model.edges);
  const impacted = new Set(impact.transitive);
  return {
    ...impact,
    guardedAtRisk: model.design.filter((atom) => atom.status === "guarded" && impacted.has(atom.id)).map((atom) => atom.id),
    affectedTests: model.engineering.filter((unit) => impacted.has(unit.id)).flatMap((unit) => unit.test_paths),
    evidenceToRevalidate: model.evidence.filter((item) => item.status === "accepted" && (item.supports.includes(id) || item.supports.some((target) => impacted.has(target)))).map((item) => item.id)
  };
}

export function captureIdea(root: string, title: string, body = title): Idea {
  const now = new Date().toISOString();
  const idea = entitySchemas.inbox.parse({
    schema_version: 1, id: `idea-${randomUUID()}`, title, body,
    status: "captured", suggested_links: [], created_at: now, updated_at: now
  });
  atomicWriteYaml(join(root, ".project", "inbox", `${idea.id}.yaml`), idea);
  return idea;
}

export function writeRun(root: string, run: AgentRun): void {
  const parsed = entitySchemas.runs.parse(run);
  const path = join(root, ".project", "runs", `${parsed.id}.yaml`);
  if (existsSync(path)) {
    const current = entitySchemas.runs.parse(readVersionedYaml(path));
    if (current.status !== parsed.status) assertTransition("goal", current.status, parsed.status);
  }
  atomicWriteYaml(path, parsed);
}

export function writeGoal(root: string, goal: GoalContract): void {
  const parsed = entitySchemas.goals.parse(goal);
  const path = join(root, ".project", "goals", `${parsed.id}.yaml`);
  if (existsSync(path)) {
    const current = entitySchemas.goals.parse(readVersionedYaml(path));
    if (current.status !== parsed.status) assertTransition("goal", current.status, parsed.status);
  }
  atomicWriteYaml(path, parsed);
}

export function writeChangeSet(root: string, change: ChangeSet): void {
  const parsed = entitySchemas.changes.parse(change);
  const path = join(root, ".project", "changes", `${parsed.id}.yaml`);
  if (existsSync(path)) {
    const current = entitySchemas.changes.parse(readVersionedYaml(path));
    if (current.status !== parsed.status) assertTransition("change", current.status, parsed.status);
  }
  atomicWriteYaml(path, parsed);
}

export function writeChangeProposal(root: string, proposal: ChangeProposal): void {
  const parsed = entitySchemas.proposals.parse(proposal);
  atomicWriteYaml(join(root, ".project", "proposals", `${parsed.id}.yaml`), parsed);
}

export function writeReview(root: string, review: ReviewRecord): void {
  const parsed = entitySchemas.reviews.parse(review);
  atomicWriteYaml(join(root, ".project", "reviews", `${parsed.id}.yaml`), parsed);
}

const supervisionFile = (root: string) => join(root, ".project", "supervision", "specmirror-m1.yaml");

const bumpVersionTag = (value: string, prefix: string) => `${prefix}${Number(value.match(/\d+$/)?.[0] ?? 0) + 1}`;

function supervisionPlanStatus(tasks: SupervisionTask[]): SupervisionDocument["plan"]["status"] {
  const frozen = tasks.filter((task) => task.status === "frozen").length;
  return frozen === tasks.length ? "frozen" : frozen ? "partially_frozen" : "draft";
}

function validateSupervisionTaskReferences(document: SupervisionDocument) {
  const ids = new Set(document.tasks.map((task) => task.id));
  if (ids.size !== document.tasks.length) throw new Error("duplicate_supervision_task_id");
  for (const task of document.tasks) for (const dependency of task.dependencies) {
    if (!ids.has(dependency) || dependency === task.id) throw new Error(`invalid_supervision_task_dependency: ${task.id} -> ${dependency}`);
  }
  for (const detail of document.details) if (!ids.has(detail.task_id)) throw new Error(`unknown_supervision_task: ${detail.id} -> ${detail.task_id}`);
  return document;
}

function touchSupervisionTask(document: SupervisionDocument, taskId: string) {
  const tasks = document.tasks.map((task) => task.id === taskId ? {
    ...task,
    status: "ready" as const,
    version: bumpVersionTag(task.version, "t")
  } : task);
  const status = supervisionPlanStatus(tasks);
  return {
    ...document,
    plan: {
      ...document.plan,
      version: bumpVersionTag(document.plan.version, "plan-v"),
      status,
      frozen_at: status === "frozen" ? document.plan.frozen_at : null
    },
    tasks
  };
}

export function loadSupervision(root = findRepoRoot()): SupervisionDocument {
  return validateSupervisionTaskReferences(SupervisionDocumentSchema.parse(readVersionedYaml(supervisionFile(root))));
}

export function writeSupervision(root: string, document: SupervisionDocumentInput): SupervisionDocument {
  const path = supervisionFile(root);
  let version = document.version;
  if (existsSync(path)) {
    const current = SupervisionDocumentSchema.parse(readVersionedYaml(path));
    const historyPath = join(root, ".project", "supervision-history", `${current.id}-${current.version}.yaml`);
    if (!existsSync(historyPath)) atomicWriteYaml(historyPath, current);
    const number = Number(current.version.match(/\d+$/)?.[0] ?? 0);
    version = `v${number + 1}`;
  }
  const next = validateSupervisionTaskReferences(SupervisionDocumentSchema.parse({ ...document, version, updated_at: new Date().toISOString() }));
  atomicWriteYaml(supervisionFile(root), next);
  return next;
}

export function loadSupervisionHistory(root = findRepoRoot()): SupervisionDocument[] {
  const folder = join(root, ".project", "supervision-history");
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((item) => item.isFile() && /\.ya?ml$/i.test(item.name))
    .map((item) => SupervisionDocumentSchema.parse(readVersionedYaml(join(folder, item.name))))
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
}

export function writeSupervisionDetail(root: string, detail: SupervisionDetail): SupervisionDocument {
  const document = loadSupervision(root);
  const parsed = SupervisionDocumentSchema.shape.details.element.parse(detail);
  const current = document.details.find((item) => item.id === parsed.id);
  if (!current) throw new Error(`Unknown supervision detail: ${parsed.id}`);
  if (current.task_id !== parsed.task_id) throw new Error("supervision_detail_task_immutable");
  if (current.status !== parsed.status) assertTransition("supervision", current.status, parsed.status);
  const definition = (item: SupervisionDetail) => ({ title: item.title, intent: item.intent, acceptance: item.acceptance, prompt: item.prompt, execution: item.execution });
  const changed = JSON.stringify(definition(current)) !== JSON.stringify(definition(parsed));
  const base = changed ? touchSupervisionTask(document, parsed.task_id) : document;
  return writeSupervision(root, { ...base, details: base.details.map((item) => item.id === parsed.id ? parsed : item) });
}

export function appendSupervisionDetail(root: string, category: SupervisionDetail["category"], title?: string, taskId?: string): SupervisionDocument {
  const document = loadSupervision(root);
  const targetTask = document.tasks.find((task) => task.id === taskId) ?? document.tasks[0];
  if (!targetTask) throw new Error("supervision_task_required");
  const labels = { function: "功能", visual: "视觉", interaction: "交互", copy: "文案", asset: "素材" } as const;
  const detail = SupervisionDocumentSchema.shape.details.element.parse({
    id: `detail-${category}-${randomUUID()}`,
    task_id: targetTask.id,
    title: title?.trim() || `新的${labels[category]}要求`,
    category,
    intent: "请说明这条设计为什么要做，以及人最终应看到或感受到什么。",
    status: "draft",
    version: "v1",
    acceptance: ["请改写为一条可以直接判断通过或不通过的验收条件"],
    prompt: {
      version: "p1",
      base: "遵循本项目已批准的设计线与受保护基线。",
      local: `只处理当前${labels[category]}条目；请先按人类可检查的方式说明产出。`,
      resources: [],
      allowed_changes: [`仅修改当前${labels[category]}条目明确允许的内容`],
      forbidden_changes: ["不得修改其他设计类别、正式工程关系或受保护基线"]
    }
  });
  const touched = touchSupervisionTask(document, targetTask.id);
  return writeSupervision(root, { ...touched, details: [...touched.details, detail] });
}

export function appendSupervisionTask(root: string, title = "新的 Plan 任务"): { document: SupervisionDocument; task: SupervisionTask; detail: SupervisionDetail } {
  const document = loadSupervision(root);
  const task = SupervisionTaskSchema.parse({
    id: `task-${randomUUID()}`,
    title: title.trim() || "新的 Plan 任务",
    objective: "请说明这项任务要交付的主要结果。",
    status: "draft",
    version: "t1",
    order: document.tasks.length,
    dependencies: []
  });
  const detail = SupervisionDocumentSchema.shape.details.element.parse({
    id: `detail-function-${randomUUID()}`,
    task_id: task.id,
    title: "功能结果",
    category: "function",
    intent: "请说明本任务在功能上必须实现什么结果。",
    status: "draft",
    version: "v1",
    acceptance: ["请改写为一条可以直接判断通过或不通过的验收条件"],
    prompt: {
      version: "p1",
      base: "遵循已批准设计与受保护基线。",
      local: "只处理当前 Plan 任务，不得扩展其他任务。",
      resources: [],
      allowed_changes: ["仅修改当前任务明确允许的内容"],
      forbidden_changes: ["不得修改其他 Plan 任务或受保护基线"]
    }
  });
  const tasks = [...document.tasks, task];
  const plan = { ...document.plan, version: bumpVersionTag(document.plan.version, "plan-v"), status: supervisionPlanStatus(tasks), frozen_at: null };
  const next = writeSupervision(root, { ...document, plan, tasks, details: [...document.details, detail] });
  return { document: next, task, detail };
}

export function writeSupervisionTask(root: string, task: SupervisionTask): SupervisionDocument {
  const document = loadSupervision(root);
  const parsed = SupervisionTaskSchema.parse(task);
  const current = document.tasks.find((item) => item.id === parsed.id);
  if (!current) throw new Error(`supervision_task_not_found: ${parsed.id}`);
  if (parsed.status === "frozen") throw new Error("use_freeze_supervision_task");
  const expectedVersion = bumpVersionTag(current.version, "t");
  if (parsed.version !== expectedVersion) throw new Error(`supervision_task_version_conflict: expected ${expectedVersion}`);
  const tasks = document.tasks.map((item) => item.id === parsed.id ? { ...parsed, status: "ready" as const } : item);
  const plan = { ...document.plan, version: bumpVersionTag(document.plan.version, "plan-v"), status: supervisionPlanStatus(tasks), frozen_at: null };
  return writeSupervision(root, { ...document, plan, tasks });
}

export function freezeSupervisionTask(root: string, taskId: string): SupervisionDocument {
  const document = loadSupervision(root);
  const task = document.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`supervision_task_not_found: ${taskId}`);
  const details = document.details.filter((detail) => detail.task_id === taskId);
  if (!details.length || details.some((detail) => detail.status === "draft")) throw new Error("supervision_task_not_ready: 请先完善并保存任务内所有设计条目。");
  const unresolvedDependency = task.dependencies.find((id) => document.tasks.find((item) => item.id === id)?.status !== "frozen");
  if (unresolvedDependency) throw new Error(`supervision_task_dependency_not_frozen: ${unresolvedDependency}`);
  const tasks = document.tasks.map((item) => item.id === taskId ? { ...item, status: "frozen" as const } : item);
  const status = supervisionPlanStatus(tasks);
  return writeSupervision(root, { ...document, plan: { ...document.plan, status, frozen_at: status === "frozen" ? new Date().toISOString() : null }, tasks });
}

function parsePlanTaskTitles(text: string) {
  const titles = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "```" && !/^#{1,6}\s*(plan|计划|任务分解)\s*$/i.test(line))
    .map((line) => line.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*|\[[ xX]\]\s*)/, "").trim())
    .filter((line) => line.length >= 2)
    .map((line) => line.slice(0, 160));
  return [...new Set(titles)];
}

export function importSupervisionPlan(root: string, text: string): { document: SupervisionDocument; imported_task_ids: string[] } {
  const sourceText = text.trim();
  if (!sourceText) throw new Error("plan_text_required");
  const titles = parsePlanTaskTitles(sourceText);
  if (!titles.length) throw new Error("plan_tasks_required");
  const document = loadSupervision(root);
  const tasks = [...document.tasks];
  const details = [...document.details];
  const importedTaskIds: string[] = [];
  for (const title of titles) {
    const existing = tasks.find((task) => task.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase());
    if (existing) { importedTaskIds.push(existing.id); continue; }
    const task = SupervisionTaskSchema.parse({
      id: `task-${randomUUID()}`,
      title,
      objective: title,
      status: "draft",
      version: "t1",
      order: tasks.length,
      dependencies: []
    });
    tasks.push(task);
    importedTaskIds.push(task.id);
    details.push(SupervisionDocumentSchema.shape.details.element.parse({
      id: `detail-function-${randomUUID()}`,
      task_id: task.id,
      title: "功能结果",
      category: "function",
      intent: title,
      status: "draft",
      version: "v1",
      acceptance: ["请补充一条可以直接判断通过或不通过的验收条件"],
      prompt: {
        version: "p1",
        base: "遵循已批准的 Plan、设计线和受保护基线。",
        local: `只处理 Plan 任务“${title}”；新增工作必须提出变更建议。`,
        resources: [],
        allowed_changes: ["仅修改当前 Plan 任务明确授权的内容"],
        forbidden_changes: ["不得修改其他 Plan 任务、共享契约或受保护基线"]
      }
    }));
  }
  const now = new Date().toISOString();
  const plan = {
    version: bumpVersionTag(document.plan.version, "plan-v"),
    status: supervisionPlanStatus(tasks),
    source: "codex-plan" as const,
    source_text: sourceText,
    imported_at: now,
    frozen_at: null
  };
  return { document: writeSupervision(root, { ...document, plan, tasks, details }), imported_task_ids: importedTaskIds };
}

export function loadSupervisionRuns(root = findRepoRoot()): SupervisionRun[] {
  const folder = join(root, ".project", "supervision-runs");
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((item) => item.isFile() && /\.ya?ml$/i.test(item.name))
    .map((item) => SupervisionRunSchema.parse(readVersionedYaml(join(folder, item.name))))
    .sort((left, right) => left.requested_at.localeCompare(right.requested_at));
}

export function writeSupervisionRun(root: string, run: SupervisionRun): SupervisionRun {
  const parsed = SupervisionRunSchema.parse(run);
  const path = join(root, ".project", "supervision-runs", `${parsed.id}.yaml`);
  if (existsSync(path)) {
    const current = SupervisionRunSchema.parse(readVersionedYaml(path));
    if (current.status !== parsed.status) assertTransition("supervisionRun", current.status, parsed.status);
  }
  const detail = loadSupervision(root).details.find((item) => item.id === parsed.detail_id);
  if (!detail) throw new Error(`Unknown supervision detail: ${parsed.detail_id}`);
  if (detail.category !== parsed.category) throw new Error(`Supervision category mismatch: ${parsed.id}`);
  if (parsed.supersedes_run_id && !loadSupervisionRuns(root).some((item) => item.id === parsed.supersedes_run_id && item.detail_id === parsed.detail_id && item.attempt < parsed.attempt)) throw new Error(`Invalid superseded supervision run: ${parsed.supersedes_run_id}`);
  atomicWriteYaml(path, parsed);
  return parsed;
}

export function loadCapabilities(root = findRepoRoot()): Capability[] {
  return loadFolder(resolve(root), "capabilities") as Capability[];
}

export function loadPermissionContracts(root = findRepoRoot()): PermissionContract[] {
  return loadFolder(resolve(root), "permission-contracts") as PermissionContract[];
}

export function writePermissionContract(root: string, contract: PermissionContract): PermissionContract {
  const parsed = PermissionContractSchema.parse(contract);
  const capabilityExists = loadCapabilities(root).some((item) => item.id === parsed.capability_id);
  const detailExists = loadSupervision(root).details.some((item) => item.id === parsed.detail_id);
  if (!capabilityExists) throw new Error(`Unknown capability: ${parsed.capability_id}`);
  if (!detailExists) throw new Error(`Unknown supervision detail: ${parsed.detail_id}`);
  const current = loadPermissionContracts(root).find((item) => item.id === parsed.id);
  if (current && current.status !== parsed.status) assertTransition("permission", current.status, parsed.status);
  atomicWriteYaml(join(root, ".project", "permission-contracts", `${parsed.id}.yaml`), parsed);
  return parsed;
}

export function rebuildIndex(root = findRepoRoot()): { path: string; entities: number; edges: number; bindings: number } {
  const model = loadProject(root);
  const runtime = join(root, ".project", ".runtime");
  mkdirSync(runtime, { recursive: true });
  const path = join(runtime, "control-plane.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trace_edges (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trace_bindings (id TEXT PRIMARY KEY, mark TEXT NOT NULL UNIQUE, design_id TEXT NOT NULL, engineering_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM entities; DELETE FROM trace_edges; DELETE FROM trace_bindings;");
    const insertEntity = db.prepare("INSERT INTO entities (id, kind, title, payload, indexed_at) VALUES (?, ?, ?, ?, ?)");
    const now = new Date().toISOString();
    const groups: Array<[string, Array<{ id: string; title: string }>]> = [
      ["project", [model.project]],
      ["idea", model.ideas], ["claim", model.claims], ["decision", model.decisions], ["evidence", model.evidence],
      ["design", model.design], ["constraint", model.constraints], ["engineering", model.engineering], ["change", model.changes],
      ["goal", model.goals], ["run", model.runs.map((run) => ({ ...run, title: run.id }))],
      ["proposal", model.proposals], ["review", model.reviews], ["capability", model.capabilities], ["permission-contract", model.permissionContracts]
    ];
    for (const [kind, values] of groups) for (const value of values) insertEntity.run(value.id, kind, value.title, JSON.stringify(value), now);
    const insertEdge = db.prepare("INSERT INTO trace_edges (id, source, target, relation, payload) VALUES (?, ?, ?, ?, ?)");
    for (const edge of model.edges) insertEdge.run(edge.id, edge.from, edge.to, edge.relation, JSON.stringify(edge));
    const insertBinding = db.prepare("INSERT INTO trace_bindings (id, mark, design_id, engineering_id, payload) VALUES (?, ?, ?, ?, ?)");
    for (const binding of model.bindings) insertBinding.run(binding.id, binding.mark, binding.design_id, binding.engineering_id, JSON.stringify(binding));
    db.exec("COMMIT");
    return { path, entities: groups.reduce((sum, [, values]) => sum + values.length, 0), edges: model.edges.length, bindings: model.bindings.length };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
    throw error;
  } finally { db.close(); }
}

export interface RuntimeEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class RuntimeStore {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(root = findRepoRoot()) {
    const runtime = join(root, ".project", ".runtime");
    mkdirSync(runtime, { recursive: true });
    this.path = join(runtime, "control-plane.sqlite");
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
  }

  recordEvent(type: string, payload: Record<string, unknown>, createdAt = new Date().toISOString()): number {
    const result = this.db.prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify(payload), createdAt);
    return Number(result.lastInsertRowid);
  }

  eventsSince(seq = 0): RuntimeEventRecord[] {
    const rows = this.db.prepare("SELECT seq, type, payload, created_at FROM events WHERE seq > ? ORDER BY seq ASC LIMIT 500").all(seq) as Array<{ seq: number; type: string; payload: string; created_at: string }>;
    return rows.map((row) => ({ seq: row.seq, type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.created_at }));
  }

  acquireLocks(resources: string[], owner: string): boolean {
    const unique = [...new Set(resources)].sort();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const insert = this.db.prepare("INSERT INTO locks (resource, owner, acquired_at) VALUES (?, ?, ?)");
      const now = new Date().toISOString();
      for (const resource of unique) insert.run(resource, owner, now);
      this.db.exec("COMMIT");
      return true;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
      return false;
    }
  }

  acquireGoalLocks(writeGlobs: string[], contracts: string[], owner: string): boolean {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const existing = this.listLocks();
      const writeConflict = existing.filter((lock) => lock.resource.startsWith("write:")).some((lock) => writeGlobs.some((glob) => globsOverlap(lock.resource.slice(6), glob)));
      const normalizedContracts = contracts.map((contract) => contract.replaceAll("\\", "/"));
      const contractConflict = existing.filter((lock) => lock.resource.startsWith("contract:")).some((lock) => normalizedContracts.includes(lock.resource.slice(9).replaceAll("\\", "/")));
      if (writeConflict || contractConflict) { this.db.exec("ROLLBACK"); return false; }
      const insert = this.db.prepare("INSERT INTO locks (resource, owner, acquired_at) VALUES (?, ?, ?)");
      const now = new Date().toISOString();
      for (const glob of [...new Set(writeGlobs)]) insert.run(`write:${glob.replaceAll("\\", "/")}`, owner, now);
      for (const contract of [...new Set(normalizedContracts)]) insert.run(`contract:${contract}`, owner, now);
      this.db.exec("COMMIT"); return true;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      return false;
    }
  }

  releaseLocks(owner: string): void { this.db.prepare("DELETE FROM locks WHERE owner = ?").run(owner); }
  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, value, new Date().toISOString());
  }
  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  clearState(key: string): void { this.db.prepare("DELETE FROM runtime_state WHERE key = ?").run(key); }
  releaseStaleLocks(validOwners: Set<string>): Array<{ resource: string; owner: string; acquiredAt: string }> {
    const stale = this.listLocks().filter((lock) => !validOwners.has(lock.owner));
    const remove = this.db.prepare("DELETE FROM locks WHERE owner = ?");
    for (const lock of stale) remove.run(lock.owner);
    return stale;
  }
  listLocks(): Array<{ resource: string; owner: string; acquiredAt: string }> {
    return (this.db.prepare("SELECT resource, owner, acquired_at FROM locks ORDER BY resource").all() as Array<{ resource: string; owner: string; acquired_at: string }>).map((row) => ({ resource: row.resource, owner: row.owner, acquiredAt: row.acquired_at }));
  }
  close(): void { this.db.close(); }
}

export function readRuntimeSnapshot(root = findRepoRoot()): { locks: Array<{ resource: string; owner: string; acquiredAt: string }>; haltedReason: string | null } {
  const path = join(root, ".project", ".runtime", "control-plane.sqlite");
  if (!existsSync(path)) return { locks: [], haltedReason: null };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const locks = (db.prepare("SELECT resource, owner, acquired_at FROM locks ORDER BY resource").all() as Array<{ resource: string; owner: string; acquired_at: string }>).map((row) => ({ resource: row.resource, owner: row.owner, acquiredAt: row.acquired_at }));
    const state = db.prepare("SELECT value FROM runtime_state WHERE key = 'halted_reason'").get() as { value: string } | undefined;
    return { locks, haltedReason: state?.value ?? null };
  } catch { return { locks: [], haltedReason: null }; }
  finally { db.close(); }
}

export function readIndexEntityIds(root = findRepoRoot()): string[] {
  const path = join(root, ".project", ".runtime", "control-plane.sqlite");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM entities ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
  } catch { return []; }
  finally { db.close(); }
}

export function migrateDocument(value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error("Cannot migrate a non-object document.");
  const document = value as Record<string, unknown>;
  const version = Number(document.schema_version ?? 1);
  if (version > 1) throw new Error(`Unsupported future schema_version: ${version}`);
  return { ...document, schema_version: 1 };
}

export function validateProject(root = findRepoRoot()) {
  const model = loadProject(root);
  const completionPath = join(resolve(root), ".project", "audits", "completion.yaml");
  const completion = existsSync(completionPath) ? loadCompletionAudit(root) : undefined;
  const completionFindings = completion ? validateCompletionEvidence(root, completion) : [];
  const findings = [...validateRepositoryArtifacts(root, model), ...completionFindings];
  return {
    valid: findings.length === 0,
    entities: allGraphEntities(model).length + 1,
    edges: model.edges.length,
    bindings: model.bindings.length,
    completionTasks: completion?.workstreams.flatMap((item) => item.tasks).length ?? 0,
    findings
  };
}
