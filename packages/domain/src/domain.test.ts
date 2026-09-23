import { describe, expect, it } from "vitest";
import { baselineMetrics, canTransition, deriveCompletionProgress, deriveDecisionHealth, deriveNextBestAction, deriveSupervisionProgress, globsOverlap, impactFrom, lintGoal, lintGoalPlan, parsePlanCandidates, recomputeClaimConfidence, scheduleGoals, scopeViolations, validateGoalDag, validateTraceBindings, type Claim, type CompletionAudit, type DesignAtom, type GoalContract, type SupervisionDocument } from "./index.ts";

const goal = (id: string, globs: string[], dependencies: string[] = []): GoalContract => ({
  schema_version: 1, id, change_set_id: "change-test", title: id, outcome: `完成 ${id}`, status: "compiled",
  ownership_modules: [id], write_globs: globs, shared_contracts: [], dependencies,
  acceptance_commands: ["pnpm test"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8
});

describe("domain state and progress", () => {
  it("enforces guarded state and valid goal flow", () => {
    expect(canTransition("design", "verified", "guarded")).toBe(true);
    expect(canTransition("design", "guarded", "draft")).toBe(false);
    expect(canTransition("goal", "reviewing", "integrating")).toBe(true);
    expect(canTransition("goal", "stopped", "integrating")).toBe(true);
    expect(canTransition("change", "blocked", "integrating")).toBe(true);
    expect(canTransition("supervisionRun", "queued", "running")).toBe(true);
    expect(canTransition("supervisionRun", "reviewing", "accepted")).toBe(true);
    expect(canTransition("supervisionRun", "accepted", "running")).toBe(false);
    expect(canTransition("supervision", "accepted", "ready")).toBe(true);
    expect(canTransition("decision", "accepted", "superseded")).toBe(true);
    expect(canTransition("evidence", "accepted", "candidate")).toBe(false);
    expect(canTransition("change", "integrating", "verified")).toBe(true);
    expect(canTransition("permission", "approved", "revoked")).toBe(true);
  });

  it("keeps guarded baseline complete when frontier is added", () => {
    const atoms: DesignAtom[] = [
      { schema_version: 1, id: "x1", version: "v1", title: "X1", status: "guarded", module: "base", weight: 100, acceptance: [], protected_by: [], updated_at: new Date().toISOString() },
      { schema_version: 1, id: "y1", version: "v1", title: "Y1", status: "draft", module: "next", weight: 100, acceptance: [], protected_by: [], updated_at: new Date().toISOString() }
    ];
    const metrics = baselineMetrics({ schema_version: 1, id: "project", title: "P", description: "", repository: { main_branch: "main", root: "." }, runtime: { max_workers: 3, goal_timeout_minutes: 60, max_fix_retries: 2, max_execution_turns: 8, gateway: "mock" }, baselines: [{ id: "X0", title: "X0", status: "guarded", progress: 100, atom_ids: ["x1"] }], frontier: { id: "Y1", title: "Y1", status: "active", progress: 0 }, next_best_action: { title: "T", reason: "R" } }, atoms);
    expect(metrics).toEqual({ baselineProgress: 100, frontierProgress: 0, baselineAtRisk: false });
  });

  it("parses the same review-only Plan candidates for API and CLI consumers", () => {
    expect(parsePlanCandidates("1. 设计监督入口；验证受保护基线\n- 必须只监听本机\n验证受保护基线")).toEqual([
      expect.objectContaining({ id: "candidate-1", title: "设计监督入口", kind: "design", proposed_status: "draft", formal: false }),
      expect.objectContaining({ id: "candidate-2", title: "验证受保护基线", kind: "evidence", proposed_status: "candidate", formal: false }),
      expect.objectContaining({ id: "candidate-3", title: "必须只监听本机", kind: "constraint", formal: false })
    ]);
  });

  it("recomputes claim confidence and next action from accepted evidence", () => {
    const claim: Claim = { schema_version: 1, id: "claim-a", title: "核心路径可行", kind: "feasibility", status: "unknown", confidence: 0.9, risk: "high", evidence_ids: [], updated_at: new Date().toISOString() };
    const unsupported = recomputeClaimConfidence(claim, []);
    expect(unsupported).toMatchObject({ confidence: 0, status: "unsupported" });
    expect(deriveNextBestAction([unsupported], { title: "fallback", reason: "fallback" }).title).toContain("核心路径可行");
    const supported = recomputeClaimConfidence(claim, [{ schema_version: 1, id: "evidence-a", title: "回归", kind: "test", status: "accepted", strength: "strong", supports: ["claim-a"], source: "test", summary: "pass", recorded_at: new Date().toISOString() }]);
    expect(supported).toMatchObject({ confidence: 0.85, status: "supported" });
    expect(deriveDecisionHealth({ schema_version: 1, id: "decision-a", title: "采用核心路径", status: "accepted", rationale: "证据支持", claim_ids: ["claim-a"], supersedes: [], revisit_when: "证据失效", updated_at: new Date().toISOString() }, [supported])).toMatchObject({ health: "supported", confidence: 0.85 });
    expect(deriveDecisionHealth({ schema_version: 1, id: "decision-a", title: "采用核心路径", status: "accepted", rationale: "证据支持", claim_ids: ["claim-a"], supersedes: [], revisit_when: "证据失效", updated_at: new Date().toISOString() }, [unsupported])).toMatchObject({ health: "blocked", confidence: 0 });
  });

  it("derives supervision progress from design state and check evidence", () => {
    const now = new Date().toISOString();
    const document: SupervisionDocument = {
      schema_version: 1, id: "supervision-a", title: "监督", design_id: "design-a", version: "v1", updated_at: now,
      plan: { version: "plan-v1", status: "frozen", source: "legacy", source_text: "测试", imported_at: now, frozen_at: now },
      tasks: [{ id: "task-legacy-supervision", title: "测试任务", objective: "测试监督进度", status: "frozen", version: "t1", order: 0, dependencies: [] }],
      details: [
        { id: "detail-a", task_id: "task-legacy-supervision", title: "功能", category: "function", intent: "可核对", status: "accepted", version: "v1", acceptance: ["完成"], prompt: { version: "p1", base: "", local: "", resources: [], allowed_changes: [], forbidden_changes: [] }, output: { source: "mock", agent_label: "Mock", summary: "结果", artifact_kind: "behavior", produced_at: now, checks: [{ criterion: "完成", result: "pass", note: "有证据" }], reviewer_status: "accepted", reviewer_note: "" } },
        { id: "detail-b", task_id: "task-legacy-supervision", title: "视觉", category: "visual", intent: "可检查", status: "needs_revision", version: "v1", acceptance: ["完成"], prompt: { version: "p1", base: "", local: "", resources: [], allowed_changes: [], forbidden_changes: [] } }
      ]
    };
    const progress = deriveSupervisionProgress(document, []);
    expect(progress).toMatchObject({ designProgress: 75, outputCoverage: 50, evidenceCoverage: 0, acceptanceCoverage: 50, revisionNeeded: 1 });
    expect(progress.nextBestAction).toMatchObject({ detailId: "detail-b", title: "局部重做：视觉" });
  });

  it("counts only evidenced atomic tasks as total-product completion", () => {
    const audit: CompletionAudit = {
      schema_version: 1, id: "audit-a", title: "完成度", updated_at: new Date().toISOString(), counting_rule: "atomic_tasks_equal_weight_done_only",
      workstreams: [
        { id: "stream-a", title: "设计", description: "设计任务", tasks: [
          { id: "task-a", title: "已验证", status: "done", evidence: ["file:a"] },
          { id: "task-b", title: "待人工判断", status: "waiting_user", evidence: [], action: "给出判断" }
        ] },
        { id: "stream-b", title: "工程", description: "工程任务", tasks: [
          { id: "task-c", title: "正在实现", status: "in_progress", evidence: [] }
        ] }
      ]
    };
    expect(deriveCompletionProgress(audit)).toMatchObject({ done: 1, total: 3, progress: 33, waitingUser: 1, inProgress: 1, nextAction: { taskId: "task-c" } });
  });

  it("resolves human, runtime, and baseline completion gates from their real state", () => {
    const audit: CompletionAudit = {
      schema_version: 1, id: "audit-conditions", title: "自动门禁", updated_at: new Date().toISOString(), counting_rule: "atomic_tasks_equal_weight_done_only",
      workstreams: [{ id: "stream-gates", title: "门禁", description: "真实状态", tasks: [
        { id: "gate-human", title: "人工通过", status: "waiting_user", evidence: [], action: "检查", condition: { kind: "supervision_detail_accepted", detail_id: "detail-a" } },
        { id: "gate-smoke", title: "烟测通过", status: "waiting_user", evidence: [], action: "烟测", condition: { kind: "codex_smoke_passed" } },
        { id: "gate-baseline", title: "基线守护", status: "waiting_user", evidence: [], action: "提升", condition: { kind: "baseline_guarded", baseline_id: "Y1" } },
        { id: "gate-still-waiting", title: "仍需人工", status: "waiting_user", evidence: [], action: "等待", condition: { kind: "supervision_detail_accepted", detail_id: "detail-b" } }
      ] }]
    };
    const progress = deriveCompletionProgress(audit, { acceptedSupervisionDetailIds: ["detail-a"], codexSmokePassed: true, guardedBaselineIds: ["Y1"] });
    expect(progress).toMatchObject({ done: 3, total: 4, progress: 75, waitingUser: 1, nextAction: { taskId: "gate-still-waiting" } });
    expect(progress.workstreams[0]?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gate-human", status: "done", declaredStatus: "waiting_user", resolved: true, resolution: expect.stringContaining("detail-a") }),
      expect.objectContaining({ id: "gate-still-waiting", status: "waiting_user", resolved: false })
    ]));
  });
});

describe("graph and orchestration", () => {
  it("propagates impact over formal edges", () => {
    const result = impactFrom("a", [
      { id: "e1", from: "a", to: "b", relation: "constrains", status: "formal" },
      { id: "e2", from: "b", to: "c", relation: "implemented_by", status: "formal" }
    ]);
    expect(result.direct).toEqual(["b"]);
    expect(result.transitive).toEqual(["b", "c"]);
  });

  it("validates field-to-code bindings against stable entity ids", () => {
    const binding = { id: "binding-a", mark: "F01", design_id: "design-a", field_path: "acceptance[0]", field_label: "字段可追踪", engineering_id: "engineering-a", file_path: "apps/web/a.tsx", symbol: "TraceLens", test_paths: [], status: "formal" as const };
    expect(validateTraceBindings([{ id: "design-a", title: "设计" }, { id: "engineering-a", title: "工程" }], [binding])).toEqual([]);
    expect(validateTraceBindings([{ id: "design-a", title: "设计" }], [binding])).toEqual(["missing binding engineering: engineering-a"]);
  });

  it("runs three independent goals but serializes overlapping writes", () => {
    const goals = [goal("g1", ["apps/a/**"]), goal("g2", ["apps/b/**"]), goal("g3", ["apps/c/**"]), goal("g4", ["apps/a/src/**"])];
    const result = scheduleGoals(goals);
    expect(result.runnable.map((item) => item.id)).toEqual(["g1", "g2", "g3"]);
    expect(globsOverlap("apps/a/**", "apps/a/src/**")).toBe(true);
  });

  it("blocks only failed goal downstream and detects scope drift", () => {
    const goals = [goal("g1", ["a/**"]), goal("g2", ["b/**"], ["g1"]), goal("g3", ["c/**"])];
    const result = scheduleGoals(goals, new Set(), new Set(["g1"]));
    expect(result.blocked).toEqual(["g2"]);
    expect(result.runnable.map((item) => item.id)).toEqual(["g3"]);
    expect(scopeViolations(["a/x.ts", "b/x.ts"], goals[0])).toEqual(["b/x.ts"]);
  });

  it("lints unresolved design and ownership size", () => {
    const invalid = { ...goal("g1", ["a/**"]), ownership_modules: ["a", "b", "c"], unresolved_design_questions: ["Which API?"] };
    expect(lintGoal(invalid).map((item) => item.code)).toEqual(["too_many_modules", "unresolved_design"]);
    expect(lintGoal({ ...goal("g2", ["b/**"]), ownership_modules: [] }).map((item) => item.code)).toContain("missing_ownership");
  });

  it("normalizes Windows and POSIX shared-contract paths before scheduling", () => {
    const left = { ...goal("g1", ["a/**"]), shared_contracts: ["packages/domain/src/schema.ts"] };
    const right = { ...goal("g2", ["b/**"]), shared_contracts: ["packages\\domain\\src\\schema.ts"] };
    const result = scheduleGoals([left, right]);
    expect(result.runnable.map((item) => item.id)).toEqual(["g1"]);
    expect(result.waiting.map((item) => item.id)).toEqual(["g2"]);
  });

  it("rechecks the Worker Plan against outcome, ownership, write scope, and unresolved design", () => {
    const contract = { ...goal("g1", ["apps/feature/**"]), ownership_modules: ["feature"] };
    const valid = {
      outcome: contract.outcome, primaryOutcomes: [contract.outcome], ownershipModules: ["feature"],
      plannedWriteGlobs: ["apps/feature/src/**"], sharedContracts: [], unresolvedQuestions: [],
      steps: [{ title: "实现", acceptance: "测试通过" }], risks: []
    };
    expect(lintGoalPlan(contract, valid)).toEqual([]);
    expect(lintGoalPlan(contract, {
      ...valid, primaryOutcomes: [contract.outcome, "顺便重构"], ownershipModules: ["feature", "auth"],
      plannedWriteGlobs: ["apps/**"], sharedContracts: ["schema/global.yaml"], unresolvedQuestions: ["是否更换架构"]
    }).map((item) => item.code)).toEqual([
      "plan_outcome_drift", "plan_ownership_drift", "plan_write_scope_drift", "plan_shared_contract_drift", "plan_unresolved_design"
    ]);
  });

  it("rejects missing and cyclic goal dependencies", () => {
    expect(validateGoalDag([{ ...goal("g1", ["a/**"]), dependencies: ["missing"] }])).toEqual(["missing_dependency:g1:missing"]);
    expect(validateGoalDag([{ ...goal("g1", ["a/**"]), dependencies: ["g2"] }, { ...goal("g2", ["b/**"]), dependencies: ["g1"] }])[0]).toContain("dependency_cycle");
  });
});
