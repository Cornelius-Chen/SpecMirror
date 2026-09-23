import { createHash, randomUUID } from "node:crypto";
import {
  assertTransition,
  deriveSupervisionProgress,
  ExternalAgentReceiptSchema,
  type AgentOutput,
  type AgentRun,
  type ChangeSet,
  type ExternalAgentReceipt,
  type GoalContract,
  type SupervisionCategory,
  type SupervisionRun
} from "@epm/domain";
import {
  loadPermissionContracts,
  loadProject,
  loadSupervision,
  loadSupervisionRuns,
  writeChangeSet,
  writeGoal,
  writeSupervisionDetail,
  writeSupervisionRun
} from "@epm/spec-io";
import type { EventBus } from "./events.ts";
import { GitController } from "./git.ts";
import type { GoalOrchestrator } from "./orchestrator.ts";

const artifactKinds: Record<SupervisionCategory, AgentOutput["artifact_kind"]> = {
  function: "behavior",
  visual: "screenshot",
  interaction: "workflow",
  copy: "copy",
  asset: "asset"
};

function runEvent(type: string, message: string) {
  return { type, message, at: new Date().toISOString() };
}

function activeCapabilityContractIds(root: string, detailId: string, at = new Date().toISOString()) {
  return loadPermissionContracts(root)
    .filter((contract) => contract.detail_id === detailId && contract.status === "approved" && (!contract.expires_at || contract.expires_at > at))
    .map((contract) => contract.id)
    .sort();
}

function executionRevision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 10);
}

function finishMockRun(root: string, events: EventBus, run: SupervisionRun) {
  const document = loadSupervision(root);
  const detail = document.details.find((item) => item.id === run.detail_id);
  if (!detail) throw new Error(`Unknown supervision detail: ${run.detail_id}`);
  const persisted = loadSupervisionRuns(root).find((item) => item.id === run.id);
  const activeRun = persisted?.status === "queued" ? writeSupervisionRun(root, { ...run, status: "running" }) : run;
  const producedAt = new Date().toISOString();
  const output: AgentOutput = {
    source: "mock",
    agent_label: `确定性 ${detail.category} Mock Worker`,
    summary: `已按“${detail.title}”的 ${run.prompt_snapshot.version} Prompt 生成结构化演示回执。它证明分类派发、权限快照和产出回挂链路，不代表设计已被真实实现。`,
    artifact_kind: artifactKinds[detail.category],
    produced_at: producedAt,
    checks: detail.acceptance.map((criterion) => ({ criterion, result: "pending", note: "确定性 Mock 未生成真实产品证据，等待真实 Agent 产出或人工材料。" })),
    reviewer_status: "pending",
    reviewer_note: ""
  };
  const finished = writeSupervisionRun(root, {
    ...activeRun,
    status: "reviewing",
    output,
    finished_at: producedAt,
    events: [...activeRun.events, runEvent("output", "Mock Worker 已生成结构化产出并等待人工检查。")]
  });
  const nextDocument = writeSupervisionDetail(root, { ...detail, status: "reviewing", output });
  events.emit({ type: "execution", message: `“${detail.title}”的 ${detail.category} Mock 产出已回挂，等待逐项检查。`, data: { kind: "supervision", runId: run.id, detailId: detail.id, category: detail.category } });
  return { document: nextDocument, run: finished, progress: deriveSupervisionProgress(nextDocument, loadSupervisionRuns(root)) };
}

function safeArtifactRef(value: string | undefined) {
  if (!value) return true;
  if (/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** Attach a structured receipt produced by a Codex/Agent outside the managed App Server.
 *  It becomes human-reviewable evidence, but never a formal Goal, Reviewer, or integration verdict.
 */
export function attachExternalSupervisionOutput(root: string, events: EventBus, detailId: string, receipt: ExternalAgentReceipt) {
  const document = loadSupervision(root);
  const detail = document.details.find((item) => item.id === detailId);
  if (!detail) throw new Error(`detail_not_found: ${detailId}`);
  const parsed = ExternalAgentReceiptSchema.parse(receipt);
  if (!safeArtifactRef(parsed.artifact_ref)) throw new Error("external_receipt_artifact_ref_unsafe");
  if (parsed.artifact_kind !== artifactKinds[detail.category]) throw new Error(`external_receipt_artifact_kind_mismatch: expected ${artifactKinds[detail.category]}`);
  if (parsed.checks.length !== detail.acceptance.length) throw new Error("external_receipt_check_mismatch: 必须逐条覆盖当前设计验收条件。");
  for (const criterion of detail.acceptance) {
    const matches = parsed.checks.filter((check) => check.criterion === criterion && check.note.trim());
    if (matches.length !== 1) throw new Error(`external_receipt_check_mismatch: ${criterion}`);
  }

  const previous = loadSupervisionRuns(root).filter((run) => run.detail_id === detailId);
  if (previous.some((run) => ["queued", "running"].includes(run.status))) throw new Error("external_receipt_active_run");
  // Validate every transition before persisting a receipt so rejection leaves no orphan run.
  const requiresAssignment = detail.status === "ready" || detail.status === "needs_revision";
  if (requiresAssignment) assertTransition("supervision", detail.status, "assigned");
  if (detail.status !== "reviewing") assertTransition("supervision", requiresAssignment ? "assigned" : detail.status, "reviewing");
  const producedAt = new Date().toISOString();
  const output: AgentOutput = {
    source: "external",
    ...parsed,
    produced_at: producedAt,
    reviewer_status: "pending",
    reviewer_note: ""
  };
  const run: SupervisionRun = {
    schema_version: 1,
    id: `supervision-run-${randomUUID()}`,
    detail_id: detail.id,
    category: detail.category,
    mode: "external",
    status: "reviewing",
    attempt: Math.max(0, ...previous.map((item) => item.attempt)) + 1,
    thread_id: null,
    prompt_snapshot: structuredClone(detail.prompt),
    permission_snapshot: {
      category_only: true,
      resource_refs: [...detail.prompt.resources],
      allowed_changes: [...detail.prompt.allowed_changes],
      forbidden_changes: [...detail.prompt.forbidden_changes]
    },
    output,
    supersedes_run_id: previous.at(-1)?.id ?? null,
    requested_at: producedAt,
    started_at: producedAt,
    finished_at: producedAt,
    capability_contract_ids: activeCapabilityContractIds(root, detail.id, producedAt),
    events: [runEvent("attached", "外部 Agent 的结构化回执已逐项回挂；等待监督者检查，不计正式 Goal 完成。")]
  };
  const savedRun = writeSupervisionRun(root, run);
  if (requiresAssignment) writeSupervisionDetail(root, { ...detail, status: "assigned" });
  const nextDocument = writeSupervisionDetail(root, { ...detail, status: "reviewing", output });
  events.emit({ type: "execution", message: `“${detail.title}”已收到外部 Agent 的逐项实现回执，等待人工检查。`, data: { kind: "supervision", runId: run.id, detailId: detail.id, category: detail.category, source: "external" } });
  return { document: nextDocument, run: savedRun, progress: deriveSupervisionProgress(nextDocument, loadSupervisionRuns(root)) };
}

/** Compile one human-readable supervision detail into an immutable, bounded engineering contract. */
export function compileSupervisionDetail(root: string, detailId: string) {
  const model = loadProject(root);
  const document = loadSupervision(root);
  const detail = document.details.find((item) => item.id === detailId);
  if (!detail) throw new Error(`detail_not_found: ${detailId}`);
  const task = document.tasks.find((item) => item.id === detail.task_id);
  if (!task) throw new Error(`supervision_task_not_found: ${detail.task_id}`);
  if (task.status !== "frozen") throw new Error("supervision_task_not_frozen: 请先检查并冻结当前 Plan 任务。");
  if (detail.status === "draft") throw new Error("detail_not_ready: 请先完成并保存设计细节。");
  if (!detail.execution) throw new Error("execution_scope_required: 请先填写所有权、写入范围和验收命令。");

  const capabilityContractIds = activeCapabilityContractIds(root, detail.id);
  const revision = executionRevision({
    version: detail.version,
    taskId: task.id,
    taskVersion: task.version,
    planVersion: document.plan.version,
    category: detail.category,
    intent: detail.intent,
    acceptance: detail.acceptance,
    prompt: detail.prompt,
    execution: detail.execution,
    capabilityContractIds
  });
  const goalId = `goal-${detail.id}-${revision}`;
  const changeId = `change-${detail.id}-${revision}`;
  const existingGoal = model.goals.find((item) => item.id === goalId);
  const existingChange = model.changes.find((item) => item.id === changeId);
  if (existingGoal && existingChange) return { goal: existingGoal, change: existingChange, existing: true };

  const git = new GitController(root);
  const startSha = git.head(model.project.repository.main_branch);
  const goal: GoalContract = {
    schema_version: 1,
    id: goalId,
    change_set_id: changeId,
    title: `${detail.title} · ${detail.category} 分类执行`,
    outcome: detail.intent,
    status: "compiled",
    required_gateway: "codex-app-server",
    ownership_modules: [...detail.execution.ownership_modules],
    write_globs: [...detail.execution.write_globs],
    shared_contracts: [...detail.execution.shared_contracts],
    dependencies: [],
    acceptance_commands: [...detail.execution.acceptance_commands],
    unresolved_design_questions: [],
    max_minutes: Math.min(60, model.project.runtime.goal_timeout_minutes),
    max_turns: Math.min(8, model.project.runtime.max_execution_turns),
    supervision_context: {
      detail_id: detail.id,
      task_id: task.id,
      task_version: task.version,
      plan_version: document.plan.version,
      category: detail.category,
      detail_version: `${detail.version}@${document.version}`,
      prompt_snapshot: structuredClone(detail.prompt),
      acceptance: [...detail.acceptance],
      capability_contract_ids: capabilityContractIds
    }
  };
  const change: ChangeSet = {
    schema_version: 1,
    id: changeId,
    title: `${detail.title} · 受控执行变更`,
    status: "compiled",
    start_sha: startSha,
    goal_ids: [goal.id],
    dependency_dag: { [goal.id]: [] },
    design_ids: [document.design_id],
    constraint_ids: ["constraint-local-only", "constraint-no-secret"].filter((id) => model.constraints.some((item) => item.id === id)),
    shared_contract_owners: Object.fromEntries(goal.shared_contracts.map((contract) => [contract, goal.id])),
    protected_baselines: model.project.baselines.filter((baseline) => ["verified", "guarded"].includes(baseline.status)).map((baseline) => baseline.id),
    acceptance_commands: [...detail.execution.acceptance_commands]
  };
  writeGoal(root, goal);
  writeChangeSet(root, change);
  return { goal, change, existing: false };
}

function finishGoalRun(root: string, events: EventBus, supervisionRun: SupervisionRun, agentRun: AgentRun) {
  const document = loadSupervision(root);
  const detail = document.details.find((item) => item.id === supervisionRun.detail_id);
  if (!detail) throw new Error(`Unknown supervision detail: ${supervisionRun.detail_id}`);
  const persisted = loadSupervisionRuns(root).find((item) => item.id === supervisionRun.id);
  if (persisted?.status === "stopped") return { document, run: persisted, progress: deriveSupervisionProgress(document, loadSupervisionRuns(root)) };
  const activeRun = persisted?.status === "queued" ? writeSupervisionRun(root, { ...supervisionRun, status: "running" }) : supervisionRun;
  const producedAt = new Date().toISOString();
  const successful = agentRun.status === "verified";
  const stopped = agentRun.status === "stopped";
  const output: AgentOutput = {
    source: agentRun.gateway === "mock" ? "mock" : "codex",
    agent_label: agentRun.gateway === "mock" ? `正式编排 · 确定性 ${detail.category} Mock Worker` : `Codex · ${detail.category} Worker`,
    summary: agentRun.agent_summary ?? (successful
      ? `Agent 已完成“${detail.title}”的受控执行；请按右侧验收项核对产出后再决定是否通过。`
      : `“${detail.title}”的执行结束于 ${agentRun.status}，请查看检查项并局部修订后重试。`),
    artifact_kind: artifactKinds[detail.category],
    artifact_ref: agentRun.artifact_ref,
    produced_at: producedAt,
    checks: agentRun.agent_checks.length ? agentRun.agent_checks : detail.acceptance.map((criterion) => ({
      criterion,
      result: "pending" as const,
      note: successful ? "工程门禁已结束，但 Agent 未提供面向本设计条件的直接证据，仍需人工核对。" : `运行状态：${agentRun.status}。`
    })),
    reviewer_status: "pending",
    reviewer_note: ""
  };
  const status: SupervisionRun["status"] = successful ? "reviewing" : stopped ? "stopped" : "failed";
  const finished = writeSupervisionRun(root, {
    ...activeRun,
    status,
    thread_id: agentRun.thread_id,
    agent_run_id: agentRun.id,
    output,
    finished_at: producedAt,
    events: [...activeRun.events, runEvent("agent-finished", `正式 Goal 已结束：${agentRun.status}。`), runEvent("output", "Agent 产出已回挂到原设计条目。")]
  });
  const nextDocument = writeSupervisionDetail(root, { ...detail, status: successful ? "reviewing" : "needs_revision", output });
  events.emit({
    type: successful ? "execution" : "system",
    goalId: supervisionRun.goal_id ?? undefined,
    message: successful ? `“${detail.title}”的正式产出已回挂，等待监督者逐项检查。` : `“${detail.title}”未通过工程门禁，只阻塞本条及其下游。`,
    data: { kind: "supervision", runId: supervisionRun.id, agentRunId: agentRun.id, detailId: detail.id, category: detail.category }
  });
  return { document: nextDocument, run: finished, progress: deriveSupervisionProgress(nextDocument, loadSupervisionRuns(root)) };
}

/** Dispatch through the same scheduler, worktree, Reviewer and Integrator used by engineering Goals. */
export function dispatchSupervisionGoal(root: string, orchestrator: GoalOrchestrator, detailId: string) {
  const compiled = compileSupervisionDetail(root, detailId);
  if (["verified", "blocked", "failed", "stopped", "superseded"].includes(compiled.goal.status)) {
    throw new Error(`goal_not_dispatchable: ${compiled.goal.status}`);
  }
  if (!orchestrator.canDispatchGoal(compiled.goal)) throw new Error(`gateway_required:${compiled.goal.required_gateway ?? "ready"}`);
  const lint = orchestrator.compile(compiled.change.id);
  if (!lint.valid) throw new Error(`goal_contract_invalid: ${lint.findings.filter((item) => item.severity === "error").map((item) => item.code).join(",")}`);

  const document = loadSupervision(root);
  const detail = document.details.find((item) => item.id === detailId)!;
  const previous = loadSupervisionRuns(root).filter((run) => run.detail_id === detailId);
  const requestedAt = new Date().toISOString();
  const run: SupervisionRun = {
    schema_version: 1,
    id: `supervision-run-${randomUUID()}`,
    detail_id: detail.id,
    category: detail.category,
    mode: orchestrator.gateway.kind === "mock" ? "mock" : "codex",
    status: "queued",
    attempt: Math.max(0, ...previous.map((item) => item.attempt)) + 1,
    thread_id: null,
    goal_id: compiled.goal.id,
    agent_run_id: null,
    prompt_snapshot: structuredClone(detail.prompt),
    permission_snapshot: { category_only: true, resource_refs: [...detail.prompt.resources], allowed_changes: [...detail.prompt.allowed_changes], forbidden_changes: [...detail.prompt.forbidden_changes] },
    supersedes_run_id: previous.at(-1)?.id ?? null,
    requested_at: requestedAt,
    started_at: requestedAt,
    finished_at: null,
    capability_contract_ids: [...(compiled.goal.supervision_context?.capability_contract_ids ?? [])],
    events: [runEvent("compiled", `已编译为 ${compiled.goal.id}。`), runEvent("queued", "等待受控调度器分配独立 worktree。")]
  };
  writeSupervisionRun(root, run);
  writeSupervisionDetail(root, { ...detail, status: "assigned" });

  const dispatched = orchestrator.dispatch(compiled.change.id);
  const active = orchestrator.active.get(compiled.goal.id);
  if (!active) {
    const failed = writeSupervisionRun(root, { ...run, status: "failed", finished_at: new Date().toISOString(), events: [...run.events, runEvent("dispatch-failed", `未进入 Worker：${orchestrator.haltedReason ?? "scheduler_not_started"}`)] });
    throw new Error(`dispatch_not_started: ${orchestrator.haltedReason ?? "scheduler_not_started"}; run=${failed.id}`);
  }
  const running = writeSupervisionRun(root, { ...run, status: "running", events: [...run.events, runEvent("running", "已进入 Goal 调度、Reviewer 与 Integrator 链路。") ] });
  orchestrator.events.emit({ type: "execution", goalId: compiled.goal.id, message: `“${detail.title}”已作为正式 Goal 派发。`, data: { kind: "supervision", runId: running.id, detailId: detail.id, category: detail.category } });
  void active.then((agentRun) => finishGoalRun(root, orchestrator.events, running, agentRun)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeSupervisionRun(root, { ...running, status: "failed", finished_at: new Date().toISOString(), events: [...running.events, runEvent("link-failed", message)] });
  });
  return { document: loadSupervision(root), run: running, goal: compiled.goal, change: compiled.change, dispatch: dispatched, progress: deriveSupervisionProgress(loadSupervision(root), loadSupervisionRuns(root)) };
}

export async function stopSupervisionGoalRun(root: string, orchestrator: GoalOrchestrator, supervisionRunId: string) {
  const run = loadSupervisionRuns(root).find((item) => item.id === supervisionRunId);
  if (!run) throw new Error(`supervision_run_not_found: ${supervisionRunId}`);
  if (!run.agent_run_id || !run.goal_id) throw new Error("formal_agent_run_required: 快速 Mock 演练请直接重新派发本类。");
  if (!['queued', 'running'].includes(run.status)) throw new Error(`supervision_run_not_stoppable: ${run.status}`);
  await orchestrator.stop(run.agent_run_id);
  const stopped = writeSupervisionRun(root, {
    ...run,
    status: "stopped",
    finished_at: new Date().toISOString(),
    events: [...run.events, runEvent("stopped", "监督者已停止正式运行，现场保留供恢复。")]
  });
  const detail = loadSupervision(root).details.find((item) => item.id === run.detail_id);
  if (detail) writeSupervisionDetail(root, { ...detail, status: "needs_revision" });
  return stopped;
}

export function resumeSupervisionGoalRun(root: string, orchestrator: GoalOrchestrator, supervisionRunId: string) {
  const run = loadSupervisionRuns(root).find((item) => item.id === supervisionRunId);
  if (!run) throw new Error(`supervision_run_not_found: ${supervisionRunId}`);
  if (!run.agent_run_id || !run.goal_id) throw new Error("formal_agent_run_required: 快速 Mock 演练请直接重新派发本类。");
  if (!['failed', 'stopped', 'needs_revision'].includes(run.status)) throw new Error(`supervision_run_not_resumable: ${run.status}`);
  orchestrator.resume(run.agent_run_id);
  const active = orchestrator.active.get(run.goal_id);
  if (!active) throw new Error("resume_not_started");
  const resumed = writeSupervisionRun(root, {
    ...run,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    events: [...run.events, runEvent("resumed", "从保留的 worktree 与 AgentRun 恢复正式运行。")]
  });
  const detail = loadSupervision(root).details.find((item) => item.id === run.detail_id);
  if (detail) writeSupervisionDetail(root, { ...detail, status: "assigned" });
  void active.then((agentRun) => finishGoalRun(root, orchestrator.events, resumed, agentRun)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeSupervisionRun(root, { ...resumed, status: "failed", finished_at: new Date().toISOString(), events: [...resumed.events, runEvent("resume-link-failed", message)] });
  });
  return resumed;
}

/** Fast deterministic demo path. It never enters a worktree and is never completion evidence. */
export function dispatchSupervisionDetail(root: string, events: EventBus, detailId: string, mode: "mock" | "codex" = "mock") {
  if (mode === "codex") throw new Error("credential_required: 真实 Codex 设计执行尚未启用。");
  const document = loadSupervision(root);
  const detail = document.details.find((item) => item.id === detailId);
  if (!detail) throw new Error(`Unknown supervision detail: ${detailId}`);
  const previous = loadSupervisionRuns(root).filter((run) => run.detail_id === detailId);
  const requestedAt = new Date().toISOString();
  const capabilityContractIds = activeCapabilityContractIds(root, detail.id, requestedAt);
  const run: SupervisionRun = {
    schema_version: 1,
    id: `supervision-run-${randomUUID()}`,
    detail_id: detail.id,
    category: detail.category,
    mode,
    status: "running",
    attempt: Math.max(0, ...previous.map((item) => item.attempt)) + 1,
    thread_id: null,
    prompt_snapshot: structuredClone(detail.prompt),
    permission_snapshot: { category_only: true, resource_refs: [...detail.prompt.resources], allowed_changes: [...detail.prompt.allowed_changes], forbidden_changes: [...detail.prompt.forbidden_changes] },
    supersedes_run_id: previous.at(-1)?.id ?? null,
    requested_at: requestedAt,
    started_at: requestedAt,
    finished_at: null,
    capability_contract_ids: capabilityContractIds,
    events: [runEvent("queued", "设计条目已进入分类执行队列。"), runEvent("running", `只授权 ${detail.category} 类别范围。`)]
  };
  writeSupervisionRun(root, run);
  writeSupervisionDetail(root, { ...detail, status: "assigned" });
  events.emit({ type: "execution", message: `已派发“${detail.title}”，仅授权 ${detail.category} 类别。`, data: { kind: "supervision", runId: run.id, detailId: detail.id, category: detail.category } });
  return finishMockRun(root, events, run);
}

export function reconcileSupervisionRuns(root: string, events: EventBus) {
  const recovered: Array<ReturnType<typeof finishMockRun>> = [];
  for (const run of loadSupervisionRuns(root).filter((item) => !item.goal_id && item.mode === "mock" && ["queued", "running"].includes(item.status))) {
    recovered.push(finishMockRun(root, events, { ...run, status: "running", started_at: run.started_at ?? new Date().toISOString(), events: [...run.events, runEvent("recovered", "服务重启后恢复确定性 Mock 运行。") ] }));
  }
  const agentRuns = loadProject(root).runs;
  for (const run of loadSupervisionRuns(root).filter((item) => item.goal_id && ["queued", "running"].includes(item.status))) {
    const agentRun = agentRuns.filter((item) => item.goal_id === run.goal_id).at(-1);
    if (agentRun && ["verified", "blocked", "failed", "stopped", "superseded"].includes(agentRun.status)) {
      finishGoalRun(root, events, { ...run, events: [...run.events, runEvent("recovered", "服务重启后从正式 AgentRun 恢复回挂。") ] }, agentRun);
    }
  }
  return recovered;
}
