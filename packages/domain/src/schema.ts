import { z } from "zod";

export const Id = z.string().min(2).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const Timestamp = z.string().datetime({ offset: true });

export const ProjectSchema = z.object({
  schema_version: z.number().int().positive(),
  id: Id,
  title: z.string().min(1),
  description: z.string(),
  repository: z.object({ main_branch: z.string().min(1), root: z.string() }),
  runtime: z.object({
    max_workers: z.number().int().min(1).max(3),
    goal_timeout_minutes: z.number().int().positive(),
    max_fix_retries: z.number().int().min(0).max(2),
    max_execution_turns: z.number().int().min(1).max(8),
    gateway: z.enum(["mock", "codex-app-server"])
  }),
  baselines: z.array(z.object({
    id: Id,
    title: z.string(),
    status: z.enum(["draft", "approved", "verified", "guarded", "at_risk"]),
    progress: z.number().min(0).max(100),
    atom_ids: z.array(Id)
  })),
  frontier: z.object({
    id: Id,
    title: z.string(),
    status: z.enum(["draft", "active", "blocked", "deferred", "verified"]),
    progress: z.number().min(0).max(100),
    reason: z.string().optional()
  }),
  next_best_action: z.object({ title: z.string(), reason: z.string() })
});

export const IdeaSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(), body: z.string(),
  status: z.enum(["captured", "triaged", "promoted", "later", "rejected"]),
  suggested_links: z.array(Id).default([]), created_at: Timestamp, updated_at: Timestamp
});

export const ClaimSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(),
  kind: z.enum(["value", "feasibility", "delivery", "business"]),
  status: z.enum(["unknown", "unsupported", "partially_supported", "supported", "contradicted", "retired"]),
  confidence: z.number().min(0).max(1), risk: z.enum(["low", "medium", "high"]),
  evidence_ids: z.array(Id), updated_at: Timestamp
});

export const DecisionSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(),
  status: z.enum(["proposed", "accepted", "superseded", "rejected"]), rationale: z.string(),
  claim_ids: z.array(Id), supersedes: z.array(Id), revisit_when: z.string(), updated_at: Timestamp
});

export const EvidenceSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(),
  kind: z.enum(["test", "interview", "metric", "artifact", "review"]),
  status: z.enum(["candidate", "accepted", "rejected", "stale"]),
  strength: z.enum(["weak", "medium", "strong"]), supports: z.array(Id), source: z.string(),
  summary: z.string(), recorded_at: Timestamp
});

export const DesignAtomSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, version: z.string(), title: z.string(),
  status: z.enum(["draft", "approved", "verified", "guarded", "blocked", "failed", "superseded"]),
  module: z.string(), weight: z.number().min(0), acceptance: z.array(z.string()),
  protected_by: z.array(z.string()), blocked_reason: z.string().optional(), updated_at: Timestamp
});

export const SupervisionCategorySchema = z.enum(["function", "visual", "interaction", "copy", "asset"]);
export const SupervisionDetailStatusSchema = z.enum(["draft", "ready", "assigned", "reviewing", "accepted", "needs_revision"]);
export const SupervisionTaskStatusSchema = z.enum(["draft", "ready", "frozen"]);
export const SupervisionPlanStatusSchema = z.enum(["draft", "partially_frozen", "frozen"]);

export const SupervisionTaskSchema = z.object({
  id: Id,
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  status: SupervisionTaskStatusSchema,
  version: z.string().min(1),
  order: z.number().int().min(0),
  dependencies: z.array(Id).default([])
});

export const SupervisionPlanSchema = z.object({
  version: z.string().min(1),
  status: SupervisionPlanStatusSchema,
  source: z.enum(["codex-plan", "manual", "legacy"]),
  source_text: z.string().default(""),
  imported_at: Timestamp,
  frozen_at: Timestamp.nullable().default(null)
});

export const PromptFragmentSchema = z.object({
  version: z.string().min(1),
  base: z.string(),
  local: z.string(),
  resources: z.array(z.string().min(1)).default([]),
  allowed_changes: z.array(z.string()),
  forbidden_changes: z.array(z.string())
});

export const ExecutionScopeSchema = z.object({
  ownership_modules: z.array(z.string().min(1)).min(1).max(2),
  write_globs: z.array(z.string().min(1)).min(1),
  shared_contracts: z.array(z.string().min(1)).default([]),
  acceptance_commands: z.array(z.string().min(1)).min(1)
});

export const AgentOutputCheckSchema = z.object({
  criterion: z.string().min(1),
  result: z.enum(["pass", "partial", "fail", "pending"]),
  note: z.string()
});

export const AgentOutputSchema = z.object({
  source: z.enum(["mock", "codex", "external"]),
  agent_label: z.string().min(1),
  summary: z.string().min(1),
  artifact_kind: z.enum(["behavior", "screenshot", "copy", "workflow", "asset"]),
  artifact_ref: z.string().optional(),
  produced_at: Timestamp,
  checks: z.array(AgentOutputCheckSchema),
  reviewer_status: z.enum(["pending", "accepted", "needs_revision"]),
  reviewer_note: z.string()
});

export const ExternalAgentReceiptSchema = z.object({
  agent_label: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(4000),
  artifact_kind: z.enum(["behavior", "screenshot", "copy", "workflow", "asset"]),
  artifact_ref: z.string().trim().min(1).max(1000).optional(),
  checks: z.array(AgentOutputCheckSchema).min(1)
});

export const SupervisionDetailSchema = z.object({
  id: Id,
  task_id: Id.default("task-legacy-supervision"),
  title: z.string().min(1),
  category: SupervisionCategorySchema,
  intent: z.string().min(1),
  status: SupervisionDetailStatusSchema,
  version: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  prompt: PromptFragmentSchema,
  execution: ExecutionScopeSchema.optional(),
  output: AgentOutputSchema.optional()
});

export const SupervisionDocumentSchema = z.object({
  schema_version: z.number().int().positive(),
  id: Id,
  title: z.string().min(1),
  design_id: Id,
  version: z.string().min(1),
  updated_at: Timestamp,
  plan: SupervisionPlanSchema.default({
    version: "plan-v1",
    status: "frozen",
    source: "legacy",
    source_text: "历史设计监督文档",
    imported_at: "2026-01-01T00:00:00.000Z",
    frozen_at: "2026-01-01T00:00:00.000Z"
  }),
  tasks: z.array(SupervisionTaskSchema).min(1).default([{
    id: "task-legacy-supervision",
    title: "历史设计监督任务",
    objective: "承载升级前创建的设计监督条目",
    status: "frozen",
    version: "t1",
    order: 0,
    dependencies: []
  }]),
  details: z.array(SupervisionDetailSchema).min(1)
});

export const SupervisionRunSchema = z.object({
  schema_version: z.number().int().positive(),
  id: Id,
  detail_id: Id,
  category: SupervisionCategorySchema,
  mode: z.enum(["mock", "codex", "external"]),
  status: z.enum(["queued", "running", "reviewing", "accepted", "needs_revision", "failed", "stopped"]),
  attempt: z.number().int().positive(),
  thread_id: z.string().nullable(),
  prompt_snapshot: PromptFragmentSchema,
  permission_snapshot: z.object({
    category_only: z.literal(true),
    resource_refs: z.array(z.string()).default([]),
    allowed_changes: z.array(z.string()),
    forbidden_changes: z.array(z.string())
  }),
  output: AgentOutputSchema.optional(),
  supersedes_run_id: Id.nullable().optional(),
  requested_at: Timestamp,
  started_at: Timestamp.nullable(),
  finished_at: Timestamp.nullable(),
  events: z.array(z.object({ type: z.string(), message: z.string(), at: Timestamp })),
  capability_contract_ids: z.array(Id).default([]),
  goal_id: Id.nullable().optional(),
  agent_run_id: Id.nullable().optional()
});

export const CapabilityKindSchema = z.enum(["agent", "skill", "api", "mcp", "asset"]);
export const CapabilitySchema = z.object({
  schema_version: z.number().int().positive(),
  id: Id,
  title: z.string().min(1),
  kind: CapabilityKindSchema,
  status: z.enum(["available", "disabled"]),
  description: z.string().min(1),
  provider: z.string().min(1),
  requires_credential: z.boolean(),
  actions: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)),
  source_ref: z.string().optional(),
  tags: z.array(z.string()).default([])
});

export const PermissionContractSchema = z.object({
  schema_version: z.number().int().positive(),
  id: Id,
  title: z.string().min(1),
  capability_id: Id,
  detail_id: Id,
  status: z.enum(["proposed", "approved", "revoked", "expired"]),
  purpose: z.string().min(1),
  allowed_actions: z.array(z.string().min(1)).min(1),
  forbidden_actions: z.array(z.string().min(1)),
  credential_mode: z.enum(["none", "server_only"]),
  expires_at: Timestamp.nullable(),
  created_at: Timestamp,
  reviewed_at: Timestamp.nullable()
});

export const ConstraintSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(), kind: z.string(),
  status: z.enum(["active", "superseded"]), rule: z.string(), applies_to: z.array(Id)
});

export const EngineeringUnitSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(), kind: z.enum(["package", "application", "service", "test"]),
  path: z.string(), status: z.enum(["planned", "implementing", "verified", "guarded", "blocked", "failed"]),
  owner: z.string(), design_ids: z.array(Id), test_paths: z.array(z.string())
});

export const GoalStatus = z.enum(["compiled", "planning", "implementing", "reviewing", "integrating", "verified", "blocked", "failed", "superseded", "stopped"]);
export const GoalContractSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, change_set_id: Id, title: z.string(), outcome: z.string().min(1),
  status: GoalStatus, ownership_modules: z.array(z.string()), write_globs: z.array(z.string()),
  required_gateway: z.enum(["mock", "codex-app-server"]).optional(),
  shared_contracts: z.array(z.string()), dependencies: z.array(Id), acceptance_commands: z.array(z.string()).min(1),
  unresolved_design_questions: z.array(z.string()), max_minutes: z.number().int().positive().max(60),
  max_turns: z.number().int().positive().max(8),
  supervision_context: z.object({
    detail_id: Id,
    task_id: Id.optional(),
    task_version: z.string().min(1).optional(),
    plan_version: z.string().min(1).optional(),
    category: SupervisionCategorySchema,
    detail_version: z.string().min(1),
    prompt_snapshot: PromptFragmentSchema,
    acceptance: z.array(z.string().min(1)).min(1),
    capability_contract_ids: z.array(Id).default([])
  }).optional()
});

export const ChangeSetSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(),
  status: z.enum(["draft", "compiled", "running", "reviewing", "integrating", "verified", "blocked", "failed"]),
  start_sha: z.string(), goal_ids: z.array(Id).min(1), dependency_dag: z.record(Id, z.array(Id)),
  design_ids: z.array(Id).default([]), constraint_ids: z.array(Id).default([]),
  shared_contract_owners: z.record(z.string(), Id).default({}),
  protected_baselines: z.array(Id), acceptance_commands: z.array(z.string()).min(1)
});

export const AgentRunSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, goal_id: Id, gateway: z.string(), status: GoalStatus,
  thread_id: z.string().nullable(), attempt: z.number().int().positive(), started_at: Timestamp,
  finished_at: Timestamp.nullable().optional(), events: z.array(z.string()),
  worktree_path: z.string().optional(), branch: z.string().optional(), candidate_sha: z.string().optional(),
  capability_contract_ids: z.array(Id).default([]),
  agent_summary: z.string().optional(), agent_evidence: z.array(z.string()).default([]), artifact_ref: z.string().optional(),
  agent_checks: z.array(AgentOutputCheckSchema).default([])
});

export const ChangeProposalSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, goal_id: Id, title: z.string(), reason: z.string(),
  requested_globs: z.array(z.string()), status: z.enum(["proposed", "accepted", "rejected", "superseded"]), created_at: Timestamp
});

export const ReviewRecordSchema = z.object({
  schema_version: z.number().int().positive(), id: Id, title: z.string(), change_set_id: Id,
  run_ids: z.array(Id), start_sha: z.string(), candidate_sha: z.string(),
  status: z.enum(["pending", "approved", "changes_requested", "rejected", "stale"]), reviewer: z.string(),
  requirements_diff_tests: z.enum(["complete", "incomplete"]), scope_drift: z.string(), orphan_code: z.string(),
    baseline_regression: z.string(), evidence_complete: z.boolean(),
    acceptance_results: z.array(z.object({
      command: z.string(), exit_code: z.number().int(), started_at: Timestamp, finished_at: Timestamp,
      duration_ms: z.number().int().nonnegative(), environment: z.object({ node: z.string(), platform: z.string() })
    })).default([]),
    recorded_at: Timestamp
});

export const TraceEdgeSchema = z.object({
  id: Id, from: Id, to: Id,
  relation: z.enum(["supports", "contradicts", "informs", "constrains", "implemented_by", "verified_by", "depends_on", "supersedes", "impacts"]),
  status: z.enum(["suggested", "formal", "superseded"])
});

export const TraceBindingSchema = z.object({
  id: Id,
  mark: z.string().min(1),
  design_id: Id,
  field_path: z.string().min(1),
  field_label: z.string().min(1),
  engineering_id: Id,
  file_path: z.string().min(1),
  symbol: z.string().min(1),
  test_paths: z.array(z.string()).default([]),
  status: z.enum(["suggested", "formal", "superseded"])
});

export const TraceSchema = z.object({
  schema_version: z.number().int().positive(),
  edges: z.array(TraceEdgeSchema),
  bindings: z.array(TraceBindingSchema).default([])
});

export type Project = z.infer<typeof ProjectSchema>;
export type Idea = z.infer<typeof IdeaSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type DesignAtom = z.infer<typeof DesignAtomSchema>;
export type SupervisionCategory = z.infer<typeof SupervisionCategorySchema>;
export type SupervisionTask = z.infer<typeof SupervisionTaskSchema>;
export type SupervisionPlan = z.infer<typeof SupervisionPlanSchema>;
export type SupervisionDetail = z.infer<typeof SupervisionDetailSchema>;
export type SupervisionDocument = z.infer<typeof SupervisionDocumentSchema>;
export type SupervisionDocumentInput = z.input<typeof SupervisionDocumentSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type SupervisionRun = z.infer<typeof SupervisionRunSchema>;
export type ExternalAgentReceipt = z.infer<typeof ExternalAgentReceiptSchema>;
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type PermissionContract = z.infer<typeof PermissionContractSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type EngineeringUnit = z.infer<typeof EngineeringUnitSchema>;
export type GoalContract = z.infer<typeof GoalContractSchema>;
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type ChangeProposal = z.infer<typeof ChangeProposalSchema>;
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type TraceEdge = z.infer<typeof TraceEdgeSchema>;
export type TraceBinding = z.infer<typeof TraceBindingSchema>;

export const entitySchemas = {
  inbox: IdeaSchema,
  claims: ClaimSchema,
  decisions: DecisionSchema,
  evidence: EvidenceSchema,
  design: DesignAtomSchema,
  constraints: ConstraintSchema,
  engineering: EngineeringUnitSchema,
  changes: ChangeSetSchema,
  goals: GoalContractSchema,
  runs: AgentRunSchema,
  proposals: ChangeProposalSchema,
  reviews: ReviewRecordSchema,
  capabilities: CapabilitySchema,
  "permission-contracts": PermissionContractSchema
} as const;
