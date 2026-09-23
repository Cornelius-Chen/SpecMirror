import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { globsOverlap, lintGoal, lintGoalPlan, scheduleGoals, scopeViolations, validateGoalDag, type AgentRun, type GoalContract } from "@epm/domain";
import { atomicWriteYaml, findRepoRoot, loadProject, RuntimeStore, writeChangeProposal, writeChangeSet, writeGoal, writeReview, writeRun } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import type { AgentGateway, GoalExecutionContext } from "./gateway.ts";
import { normalizeReviewFeedback } from "./gateway.ts";
import { GitController } from "./git.ts";

const ACTIVE_STATUSES = new Set(["planning", "implementing", "reviewing", "integrating"]);
const FAILED_STATUSES = new Set(["failed", "blocked", "stopped", "superseded"]);
const INFRASTRUCTURE_FAILURE_LIMIT = 3;

export class GoalOrchestrator {
  readonly events: EventBus;
  readonly runtime?: RuntimeStore;
  readonly active = new Map<string, Promise<AgentRun>>();
  readonly controllers = new Map<string, AbortController>();
  haltedReason?: string;
  instanceToken?: string;

  constructor(readonly root: string, readonly gateway: AgentGateway, persistRuntime = true, readonly timeoutOverrideMs?: number, recoverInterrupted = false) {
    this.runtime = persistRuntime ? new RuntimeStore(root) : undefined;
    this.events = new EventBus(this.runtime);
    this.gateway.attachEvents?.(this.events);
    if (this.runtime) {
      if (recoverInterrupted) {
        this.#claimInstanceLease();
        const model = loadProject(root);
        const interruptedRuns = model.runs.filter((run) => ACTIVE_STATUSES.has(run.status));
        for (const run of interruptedRuns) {
          const phase = run.status;
          const stopped = { ...run, status: "stopped" as const, finished_at: new Date().toISOString(), events: [...run.events, `service_restart_interrupted:${phase}`] };
          writeRun(this.root, stopped);
          const goal = model.goals.find((item) => item.id === run.goal_id);
          if (goal) writeGoal(this.root, { ...goal, status: "stopped" });
          this.runtime.releaseLocks(run.id);
          this.events.emit({ type: "system", goalId: run.goal_id, message: `服务重启检测到 ${phase} 阶段已失去本地执行进程；已保留 thread 与 worktree，等待恢复。`, data: { runId: run.id, phase, recoverable: true } });
        }
        this.runtime.releaseStaleLocks(new Set());
      }
      this.haltedReason = this.runtime.getState("halted_reason") || undefined;
    }
  }

  close() {
    if (this.runtime && this.instanceToken && this.runtime.getState("orchestrator_owner") === this.instanceToken) this.runtime.clearState("orchestrator_owner");
    this.runtime?.close();
  }

  async reconcileThreadGoalStatuses() {
    if (this.gateway.kind !== "codex-app-server" || this.gateway.ready === false || !this.gateway.setGoalStatus) return { attempted: 0, synced: 0, failed: 0 };
    const runs = loadProject(this.root).runs
      .filter((run) => run.thread_id && ["verified", "blocked", "failed", "stopped", "superseded"].includes(run.status))
      .sort((left, right) => left.started_at.localeCompare(right.started_at));
    const latestByGoal = new Map(runs.map((run) => [run.goal_id, run]));
    let synced = 0;
    let failed = 0;
    for (const run of latestByGoal.values()) {
      const threadStatus = run.status === "verified"
        ? "complete"
        : this.haltedReason?.includes("usage_limit")
          ? "usageLimited"
          : run.status === "stopped"
            ? "paused"
            : "blocked";
      try {
        await this.gateway.setGoalStatus(run.thread_id!, threadStatus);
        synced++;
      } catch (error) {
        failed++;
        this.events.emit({ type: "system", goalId: run.goal_id, message: "重启后 Codex 线程 Goal 状态重同步失败；YAML 仍为权威，下次启动会再次尝试。", data: { threadStatus, error: error instanceof Error ? error.message : String(error) } });
      }
    }
    return { attempted: latestByGoal.size, synced, failed };
  }

  #claimInstanceLease() {
    if (!this.runtime) throw new Error("runtime_required_for_dispatch");
    const previousOwner = this.runtime.getState("orchestrator_owner");
    if (this.instanceToken && previousOwner === this.instanceToken) return;
    const previousPid = Number(previousOwner?.split(":", 1)[0]);
    if (previousOwner && processAlive(previousPid)) throw new Error(`orchestrator_already_running:${previousPid}`);
    this.instanceToken = `${process.pid}:${randomUUID()}`;
    this.runtime.setState("orchestrator_owner", this.instanceToken);
  }

  compile(changeSetId: string) {
    const model = loadProject(this.root);
    const change = model.changes.find((item) => item.id === changeSetId);
    if (!change) throw new Error(`Unknown Change Set: ${changeSetId}`);
    const goals = model.goals.filter((goal) => change.goal_ids.includes(goal.id));
    const findings: Array<{ goalId?: string; code: string; message: string; severity: "error" | "warning" }> = goals.flatMap((goal) => lintGoal(goal).map((finding) => ({ goalId: goal.id, ...finding })));
    const expectedIds = new Set(change.goal_ids);
    const normalizedContractOwners = new Map(Object.entries(change.shared_contract_owners).map(([contract, owner]) => [contract.replaceAll("\\", "/"), owner]));
    for (const id of change.goal_ids) if (!model.goals.some((goal) => goal.id === id)) findings.push({ code: "missing_goal", message: `Change Set 引用了不存在的 Goal：${id}`, severity: "error" });
    for (const goal of goals) {
      if (goal.change_set_id !== change.id) findings.push({ goalId: goal.id, code: "change_set_mismatch", message: "Goal 的 change_set_id 不一致。", severity: "error" });
      const dag = change.dependency_dag[goal.id] ?? [];
      if (JSON.stringify([...dag].sort()) !== JSON.stringify([...goal.dependencies].sort())) findings.push({ goalId: goal.id, code: "dag_mismatch", message: "Change Set DAG 与 Goal dependencies 不一致。", severity: "error" });
      for (const contract of goal.shared_contracts) if (!normalizedContractOwners.has(contract.replaceAll("\\", "/"))) findings.push({ goalId: goal.id, code: "shared_contract_unowned", message: `共享契约未声明所有者：${contract}`, severity: "error" });
    }
    for (const error of validateGoalDag(goals)) findings.push({ code: error.split(":", 1)[0], message: error, severity: "error" });
    for (const id of change.design_ids) {
      const atom = model.design.find((item) => item.id === id);
      if (!atom) findings.push({ code: "missing_design", message: `缺少设计规格：${id}`, severity: "error" });
      else if (!["approved", "verified", "guarded"].includes(atom.status)) findings.push({ code: "design_not_ready", message: `设计规格尚未关闭开放问题：${id} (${atom.status})`, severity: "error" });
    }
    for (const id of change.constraint_ids) {
      const constraint = model.constraints.find((item) => item.id === id);
      if (!constraint) findings.push({ code: "missing_constraint", message: `缺少约束：${id}`, severity: "error" });
      else if (constraint.status !== "active") findings.push({ code: "constraint_inactive", message: `约束未生效：${id}`, severity: "error" });
    }
    for (const dagId of Object.keys(change.dependency_dag)) if (!expectedIds.has(dagId)) findings.push({ code: "extra_dag_node", message: `DAG 含有不属于 Change Set 的节点：${dagId}`, severity: "error" });
    for (const goalId of change.goal_ids) if (!(goalId in change.dependency_dag)) findings.push({ code: "missing_dag_node", message: `DAG 缺少 Goal 节点：${goalId}`, severity: "error" });
    for (const baselineId of change.protected_baselines) if (!model.project.baselines.some((baseline) => baseline.id === baselineId)) findings.push({ code: "missing_baseline", message: `受保护基线不存在：${baselineId}`, severity: "error" });
    for (const [contract, owner] of Object.entries(change.shared_contract_owners)) if (!expectedIds.has(owner)) findings.push({ code: "invalid_contract_owner", message: `共享契约 ${contract} 的所有者不在 Change Set：${owner}`, severity: "error" });
    if (change.start_sha === "UNBORN" && change.status !== "verified") findings.push({ code: "invalid_start_sha", message: "只有历史自举 Change Set 可以使用 UNBORN。", severity: "error" });
    if (change.start_sha !== "UNBORN") try { new GitController(this.root).head(change.start_sha); } catch { findings.push({ code: "invalid_start_sha", message: `起始 SHA 不存在：${change.start_sha}`, severity: "error" }); }
    const completed = new Set(goals.filter((goal) => goal.status === "verified").map((goal) => goal.id));
    const failed = new Set(goals.filter((goal) => FAILED_STATUSES.has(goal.status)).map((goal) => goal.id));
    const running = goals.filter((goal) => ACTIVE_STATUSES.has(goal.status));
    const schedule = scheduleGoals(goals, completed, failed, model.project.runtime.max_workers, running);
    const gatewayWaiting = schedule.runnable.filter((goal) => !this.canDispatchGoal(goal));
    const dependencyWaiting = goals.filter((goal) => !completed.has(goal.id) && !failed.has(goal.id) && !running.includes(goal) && !schedule.runnable.includes(goal) && !schedule.waiting.includes(goal) && !schedule.blocked.includes(goal.id)).map((goal) => goal.id);
    return { change, goals, findings, schedule: { runnable: schedule.runnable.filter((goal) => this.canDispatchGoal(goal)).map((goal) => goal.id), serial: schedule.waiting.map((goal) => goal.id), gatewayWaiting: gatewayWaiting.map((goal) => goal.id), dependencyWaiting, blocked: [...new Set([...failed, ...schedule.blocked])] }, valid: !findings.some((item) => item.severity === "error") };
  }

  dispatch(changeSetId: string) {
    if (this.haltedReason) return { gateway: this.gateway.kind, halted: this.haltedReason, schedule: { runnable: [], waiting: [], blocked: [] }, active: [...this.active.keys()] };
    if (!loadProject(this.root).changes.some((change) => change.id === changeSetId)) throw new Error(`Unknown Change Set: ${changeSetId}`);
    this.#claimInstanceLease();
    const compiled = this.compile(changeSetId);
    if (!compiled.valid) throw new Error("Goal Size Linter rejected the Change Set.");
    const completed = new Set(compiled.goals.filter((goal) => goal.status === "verified").map((goal) => goal.id));
    const failed = new Set(compiled.goals.filter((goal) => FAILED_STATUSES.has(goal.status)).map((goal) => goal.id));
    const running = compiled.goals.filter((goal) => this.active.has(goal.id) || ACTIVE_STATUSES.has(goal.status));
    const rawSchedule = scheduleGoals(compiled.goals, completed, failed, loadProject(this.root).project.runtime.max_workers, running);
    const gatewayWaiting = rawSchedule.runnable.filter((goal) => !this.canDispatchGoal(goal));
    const schedule = { ...rawSchedule, runnable: rawSchedule.runnable.filter((goal) => this.canDispatchGoal(goal)), waiting: [...rawSchedule.waiting, ...gatewayWaiting], gatewayWaiting };
    if (schedule.runnable.length) writeChangeSet(this.root, { ...compiled.change, status: "running" });
    for (const goal of schedule.runnable) this.#launch(goal, changeSetId);
    return { gateway: this.gateway.kind, schedule, active: [...this.active.keys()] };
  }

  canDispatchGoal(goal: GoalContract) {
    return (!goal.required_gateway || goal.required_gateway === this.gateway.kind) && this.gateway.ready !== false;
  }

  #launch(goal: GoalContract, changeSetId: string, resumeFrom?: AgentRun) {
    const promise = this.#execute(goal, resumeFrom).then(async (run) => {
      this.active.delete(goal.id);
      const status = this.#refreshChangeSet(changeSetId);
      const project = loadProject(this.root);
      const refreshedRun = project.runs.find((item) => item.id === run.id) ?? run;
      if (this.gateway.setGoalStatus) {
        const changeGoalIds = new Set(project.changes.find((item) => item.id === changeSetId)?.goal_ids ?? [goal.id]);
        const syncRuns = status === "verified"
          ? project.runs.filter((item) => changeGoalIds.has(item.goal_id) && item.status === "verified" && item.thread_id)
          : [refreshedRun];
        for (const syncRun of syncRuns) {
          if (!syncRun.thread_id) continue;
          const threadStatus = syncRun.status === "verified"
            ? "complete"
            : this.haltedReason?.includes("usage_limit")
              ? "usageLimited"
              : syncRun.status === "blocked" || syncRun.status === "failed"
                ? "blocked"
                : "paused";
          try { await this.gateway.setGoalStatus(syncRun.thread_id, threadStatus); }
          catch (error) {
            this.events.emit({
              type: "system",
              goalId: syncRun.goal_id,
              message: "Codex 线程 Goal 状态同步失败；YAML 运行态仍为权威，可在恢复时重试。",
              data: { threadStatus, error: error instanceof Error ? error.message : String(error) }
            });
          }
        }
      }
      if (status === "running" && !this.haltedReason) queueMicrotask(() => this.dispatch(changeSetId));
      return refreshedRun;
    }, (error) => {
      this.active.delete(goal.id);
      throw error;
    });
    this.active.set(goal.id, promise);
  }

  async #execute(goal: GoalContract, resumeFrom?: AgentRun): Promise<AgentRun> {
    const goalTimeoutMs = this.timeoutOverrideMs ?? goal.max_minutes * 60_000;
    const now = new Date().toISOString();
    const run: AgentRun = resumeFrom ? { ...resumeFrom, status: "planning", finished_at: null, events: [...resumeFrom.events, "resumed"] } : {
      schema_version: 1, id: `run-${goal.id}-${randomUUID().slice(0, 8)}`, goal_id: goal.id,
      gateway: this.gateway.kind, status: "planning", thread_id: null, attempt: 1, started_at: now, events: [],
      capability_contract_ids: [], agent_evidence: [], agent_checks: []
    };
    const deadlineAt = Date.parse(run.started_at) + goalTimeoutMs;
    const remainingTime = () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("goal_timeout");
      return remaining;
    };
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    if (!this.runtime!.acquireGoalLocks(goal.write_globs, goal.shared_contracts, run.id)) {
      run.status = "blocked";
      run.events.push("scheduler_lock_conflict");
      writeGoal(this.root, { ...goal, status: "blocked" });
      this.events.emit({ type: "system", goalId: goal.id, message: "调度锁冲突，Goal 已保留为可恢复状态。" });
    } else try {
      const change = loadProject(this.root).changes.find((item) => item.id === goal.change_set_id);
      if (!change || change.start_sha === "UNBORN") throw new Error("change_set_not_dispatchable");
      const mainGit = new GitController(this.root);
      const worktree = mainGit.createGoalWorktree(goal.id, change.start_sha);
      const worktreeGit = new GitController(worktree.path);
      if (!resumeFrom) worktreeGit.mergeDependencies(goal.dependencies.map((id) => `codex/goal/${id}`));
      const executionBaseSha = worktreeGit.head();
      const context: GoalExecutionContext = { cwd: worktree.path, branch: worktree.branch, signal: controller.signal };
      const reviewPrefix = `review-${run.id}-attempt-`;
      const previousReview = resumeFrom ? loadProject(this.root).reviews
        .filter((review) => {
          const attempt = Number(review.id.slice(reviewPrefix.length));
          return review.id === reviewPrefix + attempt && Number.isInteger(attempt) && attempt > 0 && attempt <= resumeFrom.attempt
            && review.run_ids.includes(run.id) && review.change_set_id === goal.change_set_id && review.start_sha === change.start_sha
            && ["changes_requested", "rejected"].includes(review.status);
        })
        .sort((left, right) => Number(right.id.slice(reviewPrefix.length)) - Number(left.id.slice(reviewPrefix.length)))[0] : undefined;
      let reviewFeedback = normalizeReviewFeedback(previousReview && previousReview.orphan_code !== "none" ? previousReview.orphan_code.split("; ") : []);
      run.worktree_path = worktree.path;
      run.branch = worktree.branch;
      run.events.push(`worktree:${worktree.branch}`);
      writeRun(this.root, run);

      writeGoal(this.root, { ...goal, status: "planning" });
      const started = await withTimeout(this.gateway.start(goal, run.thread_id, context), remainingTime(), "goal_timeout", controller.signal);
      run.thread_id = started.threadId;
      writeRun(this.root, run);
      this.events.emit({ type: "plan", goalId: goal.id, message: "正在隔离 worktree 中生成结构化计划。" });
      let turnsUsed = run.events.filter((event) => event.startsWith("turn_budget:")).length;
      const consumeTurn = (phase: "plan" | "implementation" | "review") => {
        if (turnsUsed >= goal.max_turns) throw new Error("execution_turn_limit");
        turnsUsed += 1;
        run.events.push(`turn_budget:${turnsUsed}/${goal.max_turns}:${phase}`);
      };
      let planFeedback: string[] = [];
      let planAccepted = false;
      for (let revision = 0; revision <= 2; revision++) {
        consumeTurn("plan");
        const plan = await withTimeout(this.gateway.plan(goal, context, planFeedback), remainingTime(), "goal_timeout", controller.signal);
        const planFindings = lintGoalPlan(goal, plan);
        run.events.push(`plan:${plan.steps.length}:revision-${revision}`, ...planFindings.map((finding) => `plan_finding:${finding.code}`));
        writeRun(this.root, run);
        if (!planFindings.length) { planAccepted = true; break; }
        planFeedback = planFindings.map((finding) => finding.message);
        if (revision < 2) {
          this.events.emit({ type: "plan", goalId: goal.id, message: `Worker Plan 越过 Goal Contract，正在进行第 ${revision + 1} 轮自动收敛。`, data: { findings: planFindings.map((finding) => finding.code) } });
          continue;
        }
        const requestedGlobs = scopeViolations(plan.plannedWriteGlobs, goal);
        const proposal = {
          schema_version: 1 as const,
          id: `proposal-plan-${goal.id}-${randomUUID().slice(0, 8)}`,
          goal_id: goal.id,
          title: `${goal.title} · Worker Plan 边界调整建议`,
          reason: planFeedback.join("；"),
          requested_globs: requestedGlobs.length ? requestedGlobs : [...plan.plannedWriteGlobs],
          status: "proposed" as const,
          created_at: new Date().toISOString()
        };
        writeChangeProposal(this.root, proposal);
        run.events.push(`change_proposal:${proposal.id}`);
        this.events.emit({ type: "approval", goalId: goal.id, message: "Worker Plan 两轮收敛后仍越界；已生成 ChangeProposal，只阻塞当前 Goal 及其下游。", data: { proposalId: proposal.id } });
      }
      if (!planAccepted) throw new Error("goal_plan_rejected");

      const maxAttempts = loadProject(this.root).project.runtime.max_fix_retries + 1;
      const startAttempt = resumeFrom ? resumeFrom.attempt + 1 : 1;
      if (startAttempt > maxAttempts) {
        run.status = "blocked";
        run.events.push("retry_limit_exhausted");
        writeGoal(this.root, { ...goal, status: "blocked" });
      }
      for (let attempt = startAttempt; attempt <= maxAttempts; attempt++) {
        if (turnsUsed + 2 > goal.max_turns) throw new Error("execution_turn_limit");
        run.attempt = attempt;
        run.status = "implementing";
        writeRun(this.root, run);
        writeGoal(this.root, { ...goal, status: "implementing" });
        consumeTurn("implementation");
        const implementation = await withTimeout(this.gateway.implement(goal, this.events, { ...context, ...(reviewFeedback.length ? { reviewFeedback: [...reviewFeedback] } : {}) }), remainingTime(), "goal_timeout", controller.signal);
        run.agent_summary = implementation.summary;
        run.agent_evidence = implementation.evidence;
        run.agent_checks = implementation.checks ?? [];
        run.artifact_ref = implementation.artifactRef;
        const implementationChecksComplete = supervisionChecksComplete(goal, run.agent_checks);
        writeRun(this.root, run);
        const changedFiles = worktreeGit.allChangedFiles(executionBaseSha);
        const changeSetContext = loadProject(this.root).changes.find((item) => item.id === goal.change_set_id)!;
        const sharedContractGlobs = Object.keys(changeSetContext.shared_contract_owners);
        const changedSharedContracts = changedFiles.filter((path) => sharedContractGlobs.some((contract) => globsOverlap(path, contract)));
        const unownedContractChanges = changedSharedContracts.filter((path) => sharedContractGlobs.some((contract) => globsOverlap(path, contract) && changeSetContext.shared_contract_owners[contract] !== goal.id));
        const violations = [...new Set([...scopeViolations(changedFiles, goal), ...unownedContractChanges])];
        if (violations.length) {
          run.status = "blocked";
          run.events.push(`scope_violation:${violations.join(",")}`);
          writeRun(this.root, run);
          writeGoal(this.root, { ...goal, status: "blocked" });
          this.events.emit({ type: "approval", goalId: goal.id, message: "检测到越界 Diff，已阻挡当前 Goal。", data: { violations } });
          break;
        }
        if (changedSharedContracts.length) {
          const proposal = {
            schema_version: 1 as const, id: `proposal-contract-${goal.id}-${randomUUID().slice(0, 8)}`, goal_id: goal.id,
            title: `${goal.title} · 共享契约变更确认`, reason: "共享契约发生 Diff；按保护规则禁止自动合并，需要人工审查并重新编译边界。",
            requested_globs: [...new Set(changedSharedContracts)], status: "proposed" as const, created_at: new Date().toISOString()
          };
          writeChangeProposal(this.root, proposal);
          run.status = "blocked";
          run.events.push(`shared_contract_changed:${changedSharedContracts.join(",")}`, `change_proposal:${proposal.id}`);
          writeRun(this.root, run);
          writeGoal(this.root, { ...goal, status: "blocked" });
          this.events.emit({ type: "approval", goalId: goal.id, message: "共享契约发生变化，已禁止自动合并并生成 ChangeProposal。", data: { changedSharedContracts, proposalId: proposal.id } });
          break;
        }

        run.status = "reviewing";
        writeRun(this.root, run);
        writeGoal(this.root, { ...goal, status: "reviewing" });
        this.events.emit({ type: "test", goalId: goal.id, message: "Reviewer 正在检查需求—Diff—测试映射。" });
        consumeTurn("review");
        const review = await withTimeout(this.gateway.review(goal, changedFiles, context), remainingTime(), "goal_timeout", controller.signal);
        const mappingComplete = reviewMappingComplete(goal, review);
        if (review.approved && mappingComplete && review.findings.length === 0 && implementationChecksComplete) {
          const acceptance = runAcceptanceCommands(worktree.path, goal.acceptance_commands, remainingTime());
          let mainGateFailure: string | undefined;
          try { mainGit.assertMainUnchanged(change.start_sha, loadProject(this.root).project.repository.main_branch); }
          catch (error) { mainGateFailure = error instanceof Error ? error.message : String(error); }
          const candidateSha = acceptance.passed && !mainGateFailure ? worktreeGit.commitAll(`codex(${goal.id}): ${goal.title}`) : worktreeGit.head();
          run.candidate_sha = candidateSha;
          const integrationReady = acceptance.passed && !mainGateFailure;
          writeReview(this.root, {
            schema_version: 1, id: `review-${run.id}-attempt-${attempt}`, title: `${goal.title} · 第 ${attempt} 次独立审查`,
            change_set_id: goal.change_set_id, run_ids: [run.id], start_sha: change.start_sha, candidate_sha: candidateSha,
            status: integrationReady ? "approved" : mainGateFailure ? "stale" : "changes_requested", reviewer: `${this.gateway.kind}-reviewer`,
            requirements_diff_tests: "complete",
            scope_drift: "none", orphan_code: review.findings.join("; ") || "none",
            baseline_regression: acceptance.passed ? "none" : "failed", evidence_complete: integrationReady,
            acceptance_results: acceptance.results.map((result) => ({
              command: result.command, exit_code: result.exitCode, started_at: result.startedAt, finished_at: result.finishedAt,
              duration_ms: result.durationMs, environment: result.environment
            })),
            recorded_at: new Date().toISOString()
          });
          run.events.push(...acceptance.results.map((result) => `acceptance:${result.command}:${result.exitCode}`));
          if (!integrationReady) {
            run.status = "blocked";
            writeRun(this.root, run);
            writeGoal(this.root, { ...goal, status: "blocked" });
            this.events.emit({ type: mainGateFailure ? "integration" : "test", goalId: goal.id, message: mainGateFailure ? "主分支已移动，禁止进入集成。" : "验收命令失败，禁止进入集成。", data: { results: acceptance.results, mainGateFailure } });
            break;
          }
          run.status = "integrating";
          this.runtime!.clearState("infrastructure_failure_count");
          writeRun(this.root, run);
          writeGoal(this.root, { ...goal, status: "integrating" });
          this.events.emit({ type: "integration", goalId: goal.id, message: "候选分支已通过独立审查，等待 Change Set 完整回归。" });
          break;
        }

        if (!mappingComplete) review.findings.push("需求—Diff—测试映射缺失、重复或证据为空。");
        if (!implementationChecksComplete) review.findings.push("Agent 未逐条返回全部设计验收项的通过证据。");
        reviewFeedback = normalizeReviewFeedback(review.findings);
        run.events.push(`review_rejected:attempt-${attempt}`);
        writeReview(this.root, {
          schema_version: 1, id: `review-${run.id}-attempt-${attempt}`, title: `${goal.title} · 第 ${attempt} 次独立审查`,
          change_set_id: goal.change_set_id, run_ids: [run.id], start_sha: change.start_sha, candidate_sha: worktreeGit.head(),
          status: "changes_requested", reviewer: `${this.gateway.kind}-reviewer`, requirements_diff_tests: mappingComplete ? "complete" : "incomplete",
          scope_drift: "none", orphan_code: reviewFeedback.join("; ") || "none", baseline_regression: "not_run", evidence_complete: false,
          acceptance_results: [], recorded_at: new Date().toISOString()
        });
        if (attempt === maxAttempts) {
          run.status = "blocked";
          writeGoal(this.root, { ...goal, status: "blocked" });
        } else this.events.emit({ type: "execution", goalId: goal.id, message: `Reviewer 要求修复，开始第 ${attempt + 1} 次尝试。` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "goal_timeout") {
        controller.abort();
        if (run.thread_id) await this.gateway.interrupt?.(run.thread_id).catch(() => undefined);
      }
      const persisted = loadProject(this.root);
      const persistedRun = persisted.runs.find((item) => item.id === run.id);
      const persistedGoal = persisted.goals.find((item) => item.id === goal.id);
      const explicitlyStopped = message !== "goal_timeout" && (controller.signal.aborted || message === "run_stopped" || persistedRun?.status === "stopped" || persistedGoal?.status === "stopped");
      run.status = explicitlyStopped ? "stopped" : /credential_required|usage_limit|authentication|goal_plan_rejected|execution_turn_limit/i.test(message) ? "blocked" : "failed";
      writeGoal(this.root, { ...goal, status: run.status });
      run.events.push(message);
      if (/credential_required|usage_limit|authentication/i.test(message)) {
        this.haltedReason = message;
        this.runtime!.setState("halted_reason", message);
      } else if (isInfrastructureFailure(message)) {
        const failures = Number(this.runtime!.getState("infrastructure_failure_count") ?? 0) + 1;
        this.runtime!.setState("infrastructure_failure_count", String(failures));
        run.events.push(`infrastructure_failure_count:${failures}`);
        if (failures >= INFRASTRUCTURE_FAILURE_LIMIT) {
          this.haltedReason = `infrastructure_failures:${failures}`;
          this.runtime!.setState("halted_reason", this.haltedReason);
          this.events.emit({ type: "system", goalId: goal.id, message: `连续 ${failures} 次基础设施失败，已停止派发新依赖项并保留恢复状态。` });
        }
      } else {
        this.runtime!.clearState("infrastructure_failure_count");
      }
      this.events.emit({ type: "system", goalId: goal.id, message: `运行失败：${message}` });
    } finally {
      this.runtime!.releaseLocks(run.id);
      this.controllers.delete(run.id);
    }
    run.finished_at = new Date().toISOString();
    writeRun(this.root, run);
    this.events.emit({ type: "system", goalId: goal.id, message: `Goal 已结束：${run.status}`, data: { runId: run.id, status: run.status } });
    return run;
  }

  async stop(runId: string) {
    this.#claimInstanceLease();
    const model = loadProject(this.root);
    const run = model.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!ACTIVE_STATUSES.has(run.status)) throw new Error(`run_not_stoppable: ${run.status}`);
    this.controllers.get(runId)?.abort();
    if (run.thread_id && this.gateway.interrupt) {
      try { await this.gateway.interrupt(run.thread_id); } catch { /* local stopped state remains authoritative */ }
    }
    if (run.thread_id && this.gateway.setGoalStatus) {
      try { await this.gateway.setGoalStatus(run.thread_id, "paused"); }
      catch { /* local stopped state remains authoritative and the resume path re-pauses the Goal */ }
    }
    const stopped = { ...run, status: "stopped" as const, finished_at: new Date().toISOString(), events: [...run.events, "user_stopped"] };
    writeRun(this.root, stopped);
    const goal = model.goals.find((item) => item.id === run.goal_id);
    if (goal) writeGoal(this.root, { ...goal, status: "stopped" });
    this.events.emit({ type: "system", goalId: run.goal_id, message: "运行已停止并保留可恢复状态。" });
    return stopped;
  }

  resume(runId: string) {
    this.#claimInstanceLease();
    const model = loadProject(this.root);
    const run = model.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const goal = model.goals.find((item) => item.id === run.goal_id);
    if (!goal) throw new Error(`Unknown goal: ${run.goal_id}`);
    if (!this.canDispatchGoal(goal)) throw new Error(`gateway_required:${goal.required_gateway ?? "ready"}`);
    if (!["stopped", "failed", "blocked"].includes(run.status)) throw new Error(`run_not_resumable: ${run.status}`);
    const interruptedPhase = [...run.events].reverse().find((event) => event.startsWith("service_restart_interrupted:"))?.split(":")[1];
    if (interruptedPhase === "integrating" && run.candidate_sha) {
      writeRun(this.root, { ...run, status: "integrating", finished_at: null, events: [...run.events, "resumed:integration"] });
      writeGoal(this.root, { ...goal, status: "integrating" });
      const status = this.#refreshChangeSet(goal.change_set_id);
      return { resumed: true, goalId: goal.id, phase: "integration", status };
    }
    this.#launch(goal, goal.change_set_id, run);
    return { resumed: true, goalId: goal.id, phase: interruptedPhase ?? "execution" };
  }

  status() {
    const model = loadProject(this.root);
    const completed = new Set(model.goals.filter((goal) => goal.status === "verified").map((goal) => goal.id));
    const failed = new Set(model.goals.filter((goal) => FAILED_STATUSES.has(goal.status)).map((goal) => goal.id));
    const running = model.goals.filter((goal) => this.active.has(goal.id) || ACTIVE_STATUSES.has(goal.status));
    const schedule = scheduleGoals(model.goals, completed, failed, model.project.runtime.max_workers, running);
    const gatewayWaiting = schedule.runnable.filter((goal) => !this.canDispatchGoal(goal));
    const runnable = schedule.runnable.filter((goal) => this.canDispatchGoal(goal));
    const dependencyWaiting = model.goals.filter((goal) => !completed.has(goal.id) && !failed.has(goal.id) && !running.includes(goal) && !schedule.runnable.includes(goal) && !schedule.waiting.includes(goal) && !schedule.blocked.includes(goal.id)).map((goal) => goal.id);
    return {
      active: [...this.active.keys()], runnable: runnable.map((goal) => goal.id), waiting: [...new Set([...schedule.waiting.map((goal) => goal.id), ...gatewayWaiting.map((goal) => goal.id), ...dependencyWaiting])], gatewayWaiting: gatewayWaiting.map((goal) => goal.id), blocked: [...new Set([...failed, ...schedule.blocked])],
      stoppedRuns: model.runs.filter((run) => run.status === "stopped").map((run) => run.id), locks: this.runtime?.listLocks() ?? [], haltedReason: this.haltedReason ?? null
    };
  }

  #refreshChangeSet(changeSetId: string) {
    const model = loadProject(this.root);
    const change = model.changes.find((item) => item.id === changeSetId);
    if (!change) return "blocked" as const;
    if (change.status === "verified") return "verified" as const;
    const goals = model.goals.filter((goal) => change.goal_ids.includes(goal.id));
    if (goals.some((goal) => ["blocked", "failed"].includes(goal.status))) {
      writeChangeSet(this.root, { ...change, status: "blocked" });
      return "blocked" as const;
    }
    if (!goals.every((goal) => ["integrating", "verified"].includes(goal.status))) {
      writeChangeSet(this.root, { ...change, status: "running" });
      return "running" as const;
    }

    writeChangeSet(this.root, { ...change, status: "integrating" });
    const runs = model.runs.filter((run) => goals.some((goal) => goal.id === run.goal_id));
    const integrationDeadline = Math.min(...goals.map((goal) => {
      const run = [...runs].reverse().find((item) => item.goal_id === goal.id && item.candidate_sha);
      return run ? Date.parse(run.started_at) + (this.timeoutOverrideMs ?? goal.max_minutes * 60_000) : Date.now();
    }));
    const remainingIntegrationTime = () => {
      const remaining = integrationDeadline - Date.now();
      if (remaining <= 0) throw new Error("goal_timeout");
      return remaining;
    };
    const rootGit = new GitController(this.root);
    let regression = { passed: false, results: [] as ReturnType<typeof runAcceptanceCommands>["results"] };
    try {
      remainingIntegrationTime();
      const result = rootGit.integrateBranches({
        changeSetId: change.id,
        mainBranch: model.project.repository.main_branch,
        expectedStartSha: change.start_sha,
        goalBranches: goals.map((goal) => `codex/goal/${goal.id}`),
        runRegression: (path) => {
          regression = runAcceptanceCommands(path, change.acceptance_commands, remainingIntegrationTime());
          return regression.passed;
        }
      });
      writeReview(this.root, {
        schema_version: 1, id: `review-integrator-${change.id}`, title: `${change.title} · Integrator 完整回归`, change_set_id: change.id,
        run_ids: runs.map((run) => run.id), start_sha: change.start_sha, candidate_sha: result.mergedSha, status: "approved", reviewer: "integrator",
        requirements_diff_tests: "complete", scope_drift: "none", orphan_code: "none", baseline_regression: "none", evidence_complete: true,
        acceptance_results: regression.results.map((item) => ({ command: item.command, exit_code: item.exitCode, started_at: item.startedAt, finished_at: item.finishedAt, duration_ms: item.durationMs, environment: item.environment })),
        recorded_at: new Date().toISOString()
      });
      writeChangeSet(this.root, { ...change, status: "verified" });
      for (const goal of goals) {
        writeGoal(this.root, { ...goal, status: "verified" });
        const goalRuns = runs.filter((run) => run.goal_id === goal.id && run.status === "integrating");
        for (const run of goalRuns) writeRun(this.root, { ...run, status: "verified", finished_at: new Date().toISOString(), events: [...run.events, "integrated"] });
        const path = rootGit.goalWorktreePath(goal.id);
        try { rootGit.removeGoalWorktree(path); } catch { /* successful merge is durable; cleanup can be reconciled later */ }
      }
      this.events.emit({ type: "integration", message: `Change Set ${change.title} 已完整回归并进入主分支。`, data: { checkpoint: result.checkpoint, mergedSha: result.mergedSha } });
      return "verified" as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeReview(this.root, {
        schema_version: 1, id: `review-integrator-${change.id}`, title: `${change.title} · Integrator 完整回归`, change_set_id: change.id,
        run_ids: runs.map((run) => run.id), start_sha: change.start_sha, candidate_sha: "INTEGRATION_BLOCKED",
        status: message.includes("main_sha_changed") ? "stale" : "changes_requested", reviewer: "integrator", requirements_diff_tests: "complete",
        scope_drift: "none", orphan_code: "none", baseline_regression: regression.passed ? "none" : "failed", evidence_complete: false,
        acceptance_results: regression.results.map((item) => ({ command: item.command, exit_code: item.exitCode, started_at: item.startedAt, finished_at: item.finishedAt, duration_ms: item.durationMs, environment: item.environment })),
        recorded_at: new Date().toISOString()
      });
      writeChangeSet(this.root, { ...change, status: "blocked" });
      for (const goal of goals.filter((item) => item.status === "integrating")) writeGoal(this.root, { ...goal, status: "blocked" });
      for (const run of runs.filter((item) => item.status === "integrating")) writeRun(this.root, { ...run, status: "blocked", finished_at: new Date().toISOString(), events: [...run.events, `integration_blocked:${message}`] });
      this.events.emit({ type: "integration", message: `完整回归或主分支门禁失败，候选 worktree 已保留：${message}` });
      return "blocked" as const;
    }
  }
}

export function createOrchestrator(gateway: AgentGateway, root = findRepoRoot(), persistRuntime = true, recoverInterrupted = false) { return new GoalOrchestrator(root, gateway, persistRuntime, undefined, recoverInterrupted); }

export function writeCompiledGoal(root: string, goal: GoalContract) {
  atomicWriteYaml(join(root, ".project", "goals", `${goal.id}.yaml`), goal);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, code: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const stopped = new Promise<T>((_, reject) => {
      abort = () => reject(new Error("run_stopped"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); }), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function runAcceptanceCommands(root: string, commands: string[], timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  const results = commands.map((command) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("goal_timeout");
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { cwd: root, encoding: "utf8", windowsHide: true, timeout: remaining });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error("goal_timeout");
    const finishedAt = new Date().toISOString();
    return { command, exitCode: result.status ?? 1, startedAt, finishedAt, durationMs: Date.now() - started, environment: { node: process.version, platform: process.platform } };
  });
  return { passed: results.every((result) => result.exitCode === 0), results };
}

function isInfrastructureFailure(message: string) {
  return /goal_timeout|codex_rpc|codex_turn_failed|transport|stdio|spawn|econn|epipe|process.*exit/i.test(message);
}

function reviewMappingComplete(goal: GoalContract, review: Awaited<ReturnType<AgentGateway["review"]>>) {
  const expected = goal.supervision_context?.acceptance.length ? goal.supervision_context.acceptance : [goal.outcome];
  if (review.requirementDiffTestMap.length !== expected.length) return false;
  return expected.every((requirement) => review.requirementDiffTestMap.filter((item) => item.requirement === requirement && item.evidence.trim()).length === 1);
}

function supervisionChecksComplete(goal: GoalContract, checks: AgentRun["agent_checks"]) {
  const expected = goal.supervision_context?.acceptance;
  if (!expected?.length) return true;
  if (checks.length !== expected.length) return false;
  return expected.every((criterion) => checks.filter((check) => check.criterion === criterion && check.result === "pass" && check.note.trim()).length === 1);
}

function processAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
