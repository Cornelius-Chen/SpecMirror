export interface Entity {
  id: string;
  title?: string;
  status?: string;
  kind?: string;
  version?: string;
  path?: string;
  summary?: string;
  rationale?: string;
  outcome?: string;
  acceptance?: string[];
  acceptance_commands?: string[];
  test_paths?: string[];
  evidence_ids?: string[];
  [key: string]: unknown;
}

export interface TraceEdge { id: string; from: string; to: string; relation: string; status: string }
export interface TraceBinding {
  id: string; mark: string; design_id: string; field_path: string; field_label: string;
  engineering_id: string; file_path: string; symbol: string; test_paths: string[]; status: string;
}

export interface ProjectMap {
  project: {
    id: string; title: string; description: string;
    baselines: Array<{ id: string; title: string; status: string; progress: number; atom_ids: string[] }>;
    frontier: { id: string; title: string; status: string; progress: number; reason?: string };
    next_best_action: { title: string; reason: string };
  };
  metrics: { baselineProgress: number; frontierProgress: number; baselineAtRisk: boolean; evidenceCoverage: number; agentLoad: number; maxWorkers: number; blockedGoals: number };
  nextBestAction: { title: string; reason: string };
  nodes: Entity[];
  edges: TraceEdge[];
  bindings?: TraceBinding[];
  collections: Record<string, Entity[]>;
}

export type SupervisionCategory = "function" | "visual" | "interaction" | "copy" | "asset";
export type SupervisionDetailStatus = "draft" | "ready" | "assigned" | "reviewing" | "accepted" | "needs_revision";

export interface SupervisionDetail {
  id: string;
  task_id: string;
  title: string;
  category: SupervisionCategory;
  intent: string;
  status: SupervisionDetailStatus;
  version: string;
  acceptance: string[];
  prompt: { version: string; base: string; local: string; resources: string[]; allowed_changes: string[]; forbidden_changes: string[] };
  execution?: {
    ownership_modules: string[];
    write_globs: string[];
    shared_contracts: string[];
    acceptance_commands: string[];
  };
  output?: {
    source: "mock" | "codex" | "external";
    agent_label: string;
    summary: string;
    artifact_kind: "behavior" | "screenshot" | "copy" | "workflow" | "asset";
    artifact_ref?: string;
    produced_at: string;
    checks: Array<{ criterion: string; result: "pass" | "partial" | "fail" | "pending"; note: string }>;
    reviewer_status: "pending" | "accepted" | "needs_revision";
    reviewer_note: string;
  };
}

export interface SupervisionTask {
  id: string;
  title: string;
  objective: string;
  status: "draft" | "ready" | "frozen";
  version: string;
  order: number;
  dependencies: string[];
}

export interface SupervisionDocument {
  schema_version: number;
  id: string;
  title: string;
  design_id: string;
  version: string;
  updated_at: string;
  plan: {
    version: string;
    status: "draft" | "partially_frozen" | "frozen";
    source: "codex-plan" | "manual" | "legacy";
    source_text: string;
    imported_at: string;
    frozen_at: string | null;
  };
  tasks: SupervisionTask[];
  details: SupervisionDetail[];
}

export interface SupervisionRun {
  schema_version: number;
  id: string;
  detail_id: string;
  category: SupervisionCategory;
  mode: "mock" | "codex" | "external";
  status: "queued" | "running" | "reviewing" | "accepted" | "needs_revision" | "failed" | "stopped";
  attempt: number;
  thread_id: string | null;
  prompt_snapshot: SupervisionDetail["prompt"];
  permission_snapshot: { category_only: true; resource_refs: string[]; allowed_changes: string[]; forbidden_changes: string[] };
  output?: SupervisionDetail["output"];
  supersedes_run_id?: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  events: Array<{ type: string; message: string; at: string }>;
  capability_contract_ids?: string[];
  goal_id?: string | null;
  agent_run_id?: string | null;
}

export interface SupervisionGoalResult {
  document?: SupervisionDocument;
  run?: SupervisionRun;
  goal: Entity;
  change: Entity;
  existing?: boolean;
  validation?: { valid: boolean; findings: Array<{ code: string; message: string; severity: string }> };
  progress?: SupervisionProgress;
}

export interface SupervisionProgress {
  designProgress: number;
  outputCoverage: number;
  evidenceCoverage: number;
  acceptanceCoverage: number;
  activeRuns: number;
  revisionNeeded: number;
  totalDetails: number;
  totalRuns: number;
  byTask: Record<string, { total: number; accepted: number; progress: number; outputCoverage: number }>;
  byCategory: Record<SupervisionCategory, { total: number; accepted: number; progress: number }>;
  nextBestAction: { detailId: string | null; title: string; reason: string };
}

export type CodexCompanionStage = "connected" | "planning" | "implementing" | "testing" | "reviewing" | "blocked" | "completed" | "idle";

export interface CodexCompanionSession {
  session_id: string;
  cwd: string;
  model: string | null;
  permission_mode: string | null;
  turn_id: string | null;
  stage: CodexCompanionStage;
  last_event: string;
  last_seen_at: string;
  started_at: string;
  plan_version: string | null;
  synced_task_ids: string[];
  output_preview: string | null;
  plan_steps: Array<{ step: string; status: "pending" | "in_progress" | "completed"; task_id: string }>;
  plan_explanation: string | null;
  current_task_id: string | null;
  task_progress: Array<{ task_id: string; stage: CodexCompanionStage; summary: string; updated_at: string; source: "agent" }>;
}

export interface CodexCompanionStatus {
  mode: "plugin-hooks-mcp";
  connected: boolean;
  project_root: string;
  selected_session_id: string | null;
  selection_required: boolean;
  latest_session: CodexCompanionSession | null;
  sessions: CodexCompanionSession[];
  feedback: Array<{
    id: string;
    session_id: string;
    task_id: string;
    task_title: string;
    text: string;
    status: "pending" | "delivered";
    created_at: string;
    delivered_at: string | null;
  }>;
  manual_import_fallback: true;
}

export interface RuntimeStatus {
  active: string[];
  runnable: string[];
  waiting: string[];
  blocked: string[];
  stoppedRuns: string[];
  locks: Array<{ resource: string; owner: string; acquiredAt: string }>;
  haltedReason: string | null;
  agentLoad: number;
  maxWorkers: number;
  gateway: string;
}

export interface CodexReadiness {
  ready_to_run: boolean;
  credential: "configured" | "required" | "rejected";
  credential_source: "none" | "stored" | "api-key" | "provider";
  credential_location: "server-only";
  runtime: "ready" | "required";
  enabled: boolean;
  gateway_selected: boolean;
  locked_codex_version: string;
  selected_model: string | null;
  checks: Array<{ id: string; title: string; status: "ready" | "waiting" | "idle" | "running" | "passed" | "failed" | "stopped"; note: string }>;
  smoke: { id: string | null; status: "idle" | "running" | "passed" | "failed" | "stopped"; started_at: string | null; finished_at: string | null; message: string; evidence_status: "verified" | "unavailable" | "invalid"; receipt?: { ref: string; sha256: string } };
}

export type CapabilityKind = "agent" | "skill" | "api" | "mcp" | "asset";
export interface Capability {
  schema_version: number;
  id: string;
  title: string;
  kind: CapabilityKind;
  status: "available" | "disabled";
  description: string;
  provider: string;
  requires_credential: boolean;
  actions: string[];
  constraints: string[];
  source_ref?: string;
  tags: string[];
}

export interface PermissionContract {
  schema_version: number;
  id: string;
  title: string;
  capability_id: string;
  detail_id: string;
  status: "proposed" | "approved" | "revoked" | "expired";
  purpose: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  credential_mode: "none" | "server_only";
  expires_at: string | null;
  created_at: string;
  reviewed_at: string | null;
}
