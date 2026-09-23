import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SupervisionDocumentSchema, SupervisionTaskSchema } from "@epm/domain";
import type { RuntimeStore } from "@epm/spec-io";
import { loadSupervision, writeSupervision } from "@epm/spec-io";
import type { EventBus } from "./events.ts";
import { redactSecrets } from "./stdio-jsonrpc.ts";
import { isRecentAgentSession } from "./agent-session-presence.ts";

const SESSION_STATE_KEY = "codex-companion:sessions";
const SELECTION_STATE_KEY = "codex-companion:selected-session";
const FEEDBACK_STATE_KEY = "codex-companion:feedback";
const STOP_STATE_KEY = "codex-companion:processed-stops";
const PROMPT_CYCLE_STATE_KEY = "codex-companion:prompt-cycles";
const MAX_SESSIONS = 20;
const STAGES = ["connected", "planning", "implementing", "testing", "reviewing", "blocked", "completed", "idle"] as const;

export type CompanionStage = typeof STAGES[number];
export type CompanionPlanStepStatus = "pending" | "in_progress" | "completed";
export interface CompanionPlanStep { step: string; status: CompanionPlanStepStatus; task_id: string }
export interface CompanionTaskProgress { task_id: string; stage: CompanionStage; summary: string; updated_at: string; source: "agent" }

export interface CompanionSession {
  session_id: string;
  cwd: string;
  model: string | null;
  permission_mode: string | null;
  turn_id: string | null;
  stage: CompanionStage;
  last_event: string;
  last_seen_at: string;
  started_at: string;
  plan_version: string | null;
  synced_task_ids: string[];
  plan_steps: CompanionPlanStep[];
  plan_explanation: string | null;
  current_task_id: string | null;
  task_progress: CompanionTaskProgress[];
  output_preview: string | null;
}

export interface CompanionFeedback {
  id: string;
  session_id: string;
  task_id: string;
  task_title: string;
  text: string;
  status: "pending" | "delivered";
  created_at: string;
  delivered_at: string | null;
}

export interface CompanionStatus {
  mode: "plugin-hooks-mcp";
  connected: boolean;
  project_root: string;
  selected_session_id: string | null;
  selection_required: boolean;
  latest_session: CompanionSession | null;
  sessions: CompanionSession[];
  feedback: CompanionFeedback[];
  manual_import_fallback: true;
}

export interface CompanionHookPayload {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  model?: unknown;
  permission_mode?: unknown;
  turn_id?: unknown;
  event_id?: unknown;
  stop_hook_active?: unknown;
  source?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  last_assistant_message?: unknown;
}

export interface CompanionPlanInput {
  cwd?: string;
  session_id?: string;
  explanation?: string;
  plan: Array<{ step: string; status?: string }>;
}

export function readCompanionStatus(root: string, runtime: RuntimeStore): CompanionStatus {
  const sessions = readSessions(runtime).filter((item) => isProjectPath(root, item.cwd))
    .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at));
  const selectedId = runtime.getState(SELECTION_STATE_KEY);
  const latest = selectedId ? sessions.find((item) => item.session_id === selectedId) ?? null : sessions.length === 1 ? sessions[0] : null;
  const feedback = readJsonState<CompanionFeedback[]>(runtime, FEEDBACK_STATE_KEY, [])
    .filter((item) => sessions.some((session) => session.session_id === item.session_id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const recent = latest ? isRecentAgentSession(latest.last_seen_at) : false;
  return {
    mode: "plugin-hooks-mcp", connected: recent, project_root: root,
    selected_session_id: latest?.session_id ?? null, selection_required: sessions.length > 0 && !latest,
    latest_session: latest, sessions, feedback, manual_import_fallback: true
  };
}

export function bindCompanionSession(root: string, runtime: RuntimeStore, events: EventBus, input: { session_id?: string; cwd?: string }) {
  if (input.cwd !== undefined) requireProjectPath(root, input.cwd);
  const session = readCompanionStatus(root, runtime).sessions.find((item) => item.session_id === text(input.session_id));
  if (!session) throw new Error("codex_session_not_found");
  runtime.setState(SELECTION_STATE_KEY, session.session_id);
  events.emit({ type: "system", message: "已选定 Codex 伴随任务；后续同步与监督反馈将绑定此任务。", data: { kind: "codex-companion-binding", sessionId: session.session_id } });
  return readCompanionStatus(root, runtime);
}

export function receiveCompanionHook(root: string, runtime: RuntimeStore, events: EventBus, input: CompanionHookPayload) {
  const sessionId = text(input.session_id);
  const cwd = text(input.cwd);
  const eventName = text(input.hook_event_name);
  if (!sessionId || !cwd || !eventName) throw new Error("invalid_codex_hook_payload");
  if (!isProjectPath(root, cwd)) return { accepted: false, ignored: "different_project", hook_response: stopResponse(eventName) };

  const now = new Date().toISOString();
  const sessions = readSessions(runtime);
  const previous = sessions.find((item) => item.session_id === sessionId);
  let next: CompanionSession = {
    session_id: sessionId, cwd,
    model: text(input.model) || previous?.model || null,
    permission_mode: text(input.permission_mode) || previous?.permission_mode || null,
    turn_id: text(input.turn_id) || (eventName === "UserPromptSubmit" ? null : previous?.turn_id) || null,
    stage: stageForHook(eventName, text(input.tool_name), previous?.stage),
    last_event: eventName, last_seen_at: now, started_at: previous?.started_at ?? now,
    plan_version: previous?.plan_version ?? null,
    synced_task_ids: previous?.synced_task_ids ?? [],
    plan_steps: previous?.plan_steps ?? [], plan_explanation: previous?.plan_explanation ?? null,
    current_task_id: previous?.current_task_id ?? null, task_progress: previous?.task_progress ?? [],
    output_preview: previous?.output_preview ?? null
  };
  if (eventName === "Stop") {
    next.output_preview = compact(redactSecrets(text(input.last_assistant_message)), 360) || null;
    const taskId = next.current_task_id;
    if (taskId) {
      const previousProgress = next.task_progress.find((item) => item.task_id === taskId);
      const completed = next.plan_steps.some((item) => item.task_id === taskId && item.status === "completed") || previousProgress?.stage === "completed";
      const active = previousProgress && ["connected", "planning", "implementing", "testing", "reviewing"].includes(previousProgress.stage);
      if (completed || active || !previousProgress) {
        const progress: CompanionTaskProgress = {
          task_id: taskId, stage: completed ? "completed" : "idle", source: "agent", updated_at: now,
          summary: completed ? (previousProgress?.stage === "completed" ? previousProgress.summary : "Agent Plan 报告步骤已完成。") : "Codex 当前回合已结束，等待下一步。"
        };
        next.task_progress = [progress, ...next.task_progress.filter((item) => item.task_id !== taskId)];
      }
    }
  }
  saveSessions(runtime, [next, ...sessions.filter((item) => item.session_id !== sessionId)]);
  if (eventName === "UserPromptSubmit") {
    const cycles = readJsonState<Record<string, number>>(runtime, PROMPT_CYCLE_STATE_KEY, {});
    runtime.setState(PROMPT_CYCLE_STATE_KEY, JSON.stringify({ ...cycles, [sessionId]: (cycles[sessionId] ?? 0) + 1 }));
  }
  // Register candidates, but never guess which candidate owns Plan writes.
  const status = readCompanionStatus(root, runtime);
  const selected = status.selected_session_id === sessionId;
  let importedTaskIds: string[] = [];
  if (selected && eventName === "PostToolUse" && text(input.tool_name) === "update_plan") {
    const plan = extractPlan(input.tool_input);
    if (plan.length) {
      const explanation = input.tool_input && typeof input.tool_input === "object" ? text((input.tool_input as { explanation?: unknown }).explanation) : "";
      const result = syncCompanionPlan(root, runtime, events, { session_id: sessionId, cwd, plan, explanation });
      importedTaskIds = result.imported_task_ids;
      next = readCompanionStatus(root, runtime).latest_session!;
    }
  }
  events.emit({ type: "system", message: companionEventMessage(eventName, next, importedTaskIds), data: { kind: "codex-companion", sessionId, turnId: next.turn_id, stage: next.stage, importedTaskIds } });

  if (eventName === "Stop") {
    const cycle = readJsonState<Record<string, number>>(runtime, PROMPT_CYCLE_STATE_KEY, {})[sessionId] ?? 0;
    const identity = text(input.event_id) || text(input.turn_id) || next.turn_id || [cycle, text(input.last_assistant_message)];
    const stopId = createHash("sha256").update(JSON.stringify([sessionId, identity])).digest("hex");
    const stops = readJsonState<string[]>(runtime, STOP_STATE_KEY, []);
    const duplicate = stops.includes(stopId);
    if (!duplicate) runtime.setState(STOP_STATE_KEY, JSON.stringify([stopId, ...stops].slice(0, 500)));
    const ownedTaskIds = exclusiveTaskIds(root, runtime, next);
    const pending = readJsonState<CompanionFeedback[]>(runtime, FEEDBACK_STATE_KEY, []).reverse().find((item) => item.session_id === sessionId && item.status === "pending" && ownedTaskIds.has(item.task_id));
    if (selected && !duplicate && input.stop_hook_active !== true && pending && loadSupervision(root).tasks.some((item) => item.id === pending.task_id)) {
      const feedback = readJsonState<CompanionFeedback[]>(runtime, FEEDBACK_STATE_KEY, []).map((item) => item.id === pending.id ? { ...item, status: "delivered" as const, delivered_at: now } : item);
      runtime.setState(FEEDBACK_STATE_KEY, JSON.stringify(feedback));
      events.emit({ type: "approval", message: "已在 Codex 安全回合边界送达“" + pending.task_title + "”的监督反馈。", data: { kind: "codex-companion-feedback", feedbackId: pending.id, sessionId, taskId: pending.task_id } });
      return { accepted: true, session: next, imported_task_ids: importedTaskIds, hook_response: { decision: "block", reason: "映构监督反馈（" + pending.task_title + "）：" + pending.text } };
    }
  }
  return { accepted: true, session: next, imported_task_ids: importedTaskIds, hook_response: stopResponse(eventName) };
}

export function syncCompanionPlan(root: string, runtime: RuntimeStore, events: EventBus, input: CompanionPlanInput) {
  const session = selectedSession(root, runtime, input);
  const plan = normalizePlan(input.plan);
  const result = syncPlan(root, runtime, events, session, plan);
  const steps = plan.map((item, index) => ({ ...item, task_id: result.imported_task_ids[index] }));
  const inProgress = steps.find((item) => item.status === "in_progress");
  const explanation = compact(redactSecrets(text(input.explanation)), 2000) || null;
  const stepsChanged = JSON.stringify(session.plan_steps) !== JSON.stringify(steps);
  const stage: CompanionStage = stepsChanged ? (steps.every((item) => item.status === "completed") ? "completed" : "planning") : session.stage;
  const stateChanged = stepsChanged || session.plan_explanation !== explanation;
  const now = new Date().toISOString();
  const taskProgress = steps.map((step): CompanionTaskProgress => {
    const previousStep = session.plan_steps.find((item) => item.task_id === step.task_id);
    const previousProgress = session.task_progress.find((item) => item.task_id === step.task_id);
    // A repeated in_progress Plan must not erase a more precise testing/reviewing report.
    if (previousStep?.status === step.status && previousProgress) return previousProgress;
    return {
      task_id: step.task_id, stage: step.status === "completed" ? "completed" : step.status === "in_progress" ? "implementing" : "idle",
      source: "agent", updated_at: now,
      summary: step.status === "completed" ? "Agent Plan 报告步骤已完成。" : step.status === "in_progress" ? "Agent Plan 将此步骤设为进行中。" : "Agent Plan 将此步骤设为待处理。"
    };
  });
  saveSessions(runtime, readSessions(runtime).map((item) => item.session_id === session.session_id ? {
    ...item, stage, last_event: "mcp/plan-sync", last_seen_at: now,
    plan_version: result.document.plan.version, synced_task_ids: [...new Set(result.imported_task_ids)],
    plan_steps: steps, plan_explanation: explanation,
    current_task_id: inProgress?.task_id ?? (item.current_task_id && result.imported_task_ids.includes(item.current_task_id) ? item.current_task_id : null),
    task_progress: taskProgress
  } : item));
  if (result.unchanged && stateChanged) {
    events.emit({ type: "plan", message: "Codex Plan 的步骤状态已更新；设计版本保持不变。", data: { kind: "codex-companion-plan-status", sessionId: session.session_id, planVersion: result.document.plan.version, taskIds: result.imported_task_ids } });
  }
  return result;
}

export function reportCompanionProgress(root: string, runtime: RuntimeStore, events: EventBus, input: { cwd?: string; session_id?: string; task_id?: string; task?: string; stage?: string; summary?: string }) {
  const session = selectedSession(root, runtime, input);
  const stage = companionStage(input.stage);
  const taskValue = text(input.task_id) || text(input.task);
  if (!taskValue) throw new Error("codex_progress_task_required");
  const ownedTaskIds = exclusiveTaskIds(root, runtime, session);
  const matches = loadSupervision(root).tasks.filter((item) => ownedTaskIds.has(item.id) && (item.id === taskValue || (!input.task_id && item.title === taskValue)));
  if (matches.length !== 1) throw new Error("codex_task_not_owned_by_session");
  const task = matches[0];
  const now = new Date().toISOString();
  const summary = compact(redactSecrets(text(input.summary)), 500);
  const progress: CompanionTaskProgress = { task_id: task.id, stage, summary, updated_at: now, source: "agent" };
  saveSessions(runtime, readSessions(runtime).map((item) => item.session_id === session.session_id ? {
    ...item, stage, current_task_id: task.id, last_event: "mcp/progress", last_seen_at: now,
    output_preview: summary || item.output_preview,
    task_progress: [progress, ...item.task_progress.filter((entry) => entry.task_id !== task.id)]
  } : item));
  events.emit({ type: stage === "testing" || stage === "reviewing" ? "test" : "execution", message: "Codex：" + task.title + " · " + stageLabel(stage) + (summary ? " · " + summary : ""), data: { kind: "codex-companion", sessionId: session.session_id, stage, task: task.title, taskId: task.id, source: "agent" } });
  return readCompanionStatus(root, runtime);
}

export function queueCompanionFeedback(root: string, runtime: RuntimeStore, events: EventBus, input: { session_id?: string; task_id?: string; text?: string }) {
  const value = text(input.text);
  if (!value) throw new Error("feedback_text_required");
  const session = selectedSession(root, runtime, input);
  const task = loadSupervision(root).tasks.find((item) => item.id === input.task_id);
  if (!task) throw new Error("supervision_task_not_found");
  if (!exclusiveTaskIds(root, runtime, session).has(task.id)) throw new Error("codex_task_not_owned_by_session");
  const feedback: CompanionFeedback = { id: "feedback-" + randomUUID(), session_id: session.session_id, task_id: task.id, task_title: task.title, text: compact(redactSecrets(value), 2000), status: "pending", created_at: new Date().toISOString(), delivered_at: null };
  runtime.setState(FEEDBACK_STATE_KEY, JSON.stringify([feedback, ...readJsonState<CompanionFeedback[]>(runtime, FEEDBACK_STATE_KEY, [])].slice(0, 100)));
  events.emit({ type: "approval", message: "“" + task.title + "”的监督反馈已排队，将在 Codex 下一个安全回合边界送达。", data: { kind: "codex-companion-feedback", feedbackId: feedback.id, sessionId: session.session_id, taskId: task.id } });
  return { feedback, status: readCompanionStatus(root, runtime) };
}

function syncPlan(root: string, runtime: RuntimeStore, events: EventBus, session: CompanionSession, plan: Array<{ step: string; status: CompanionPlanStepStatus }>) {
  const document = loadSupervision(root);
  const tasks = [...document.tasks];
  const details = [...document.details];
  const importedTaskIds: string[] = [];
  const ownedTaskIds = exclusiveTaskIds(root, runtime, session);
  for (const { step } of plan) {
    const reusable = (taskId: string) => ownedTaskIds.has(taskId) && !importedTaskIds.includes(taskId);
    const previous = session.plan_steps.find((item) => item.step === step && reusable(item.task_id));
    // Titles alone never establish ownership of another session's or a human's design/evidence.
    const existing = tasks.find((item) => item.id === previous?.task_id) ?? tasks.find((item) => reusable(item.id) && item.title.toLocaleLowerCase() === step.toLocaleLowerCase());
    if (existing) { importedTaskIds.push(existing.id); continue; }
    const task = SupervisionTaskSchema.parse({ id: "task-" + randomUUID(), title: step, objective: step, status: "draft", version: "t1", order: tasks.length, dependencies: [] });
    tasks.push(task);
    importedTaskIds.push(task.id);
    details.push(SupervisionDocumentSchema.shape.details.element.parse({
      id: "detail-function-" + randomUUID(), task_id: task.id, title: "功能结果", category: "function", intent: step,
      status: "draft", version: "v1", acceptance: ["请补充一条可以直接判断通过或不通过的验收条件"],
      prompt: { version: "p1", base: "遵循已批准的 Plan、设计线和受保护基线。", local: "只处理 Plan 任务“" + step + "”；新增工作必须提出变更建议。", resources: [], allowed_changes: ["仅修改当前 Plan 任务明确授权的内容"], forbidden_changes: ["不得修改其他 Plan 任务、共享契约或受保护基线"] }
    }));
  }
  // Runtime statuses and explanation are not design changes or extra tasks.
  const sourceText = plan.map((item, index) => (index + 1) + ". " + item.step).join("\n");
  const sameSteps = JSON.stringify(session.plan_steps.map((item) => item.step)) === JSON.stringify(plan.map((item) => item.step));
  const unchanged = tasks.length === document.tasks.length && (sameSteps || document.plan.source_text === sourceText);
  if (unchanged) return { document, imported_task_ids: importedTaskIds, unchanged: true };
  const frozen = tasks.filter((item) => item.status === "frozen").length;
  const next = writeSupervision(root, {
    ...document, tasks, details,
    plan: { ...document.plan, version: "plan-v" + (Number(document.plan.version.match(/\d+$/)?.[0] ?? 0) + 1), status: frozen === tasks.length ? "frozen" : frozen ? "partially_frozen" : "draft", source: "codex-plan", source_text: sourceText, imported_at: new Date().toISOString(), frozen_at: null }
  });
  events.emit({ type: "plan", message: "Codex Plan 已同步；新增 " + (tasks.length - document.tasks.length) + " 个可编辑任务，不会自动冻结或派发。", data: { kind: "codex-companion-plan", sessionId: session.session_id, planVersion: next.plan.version, taskIds: importedTaskIds } });
  return { document: next, imported_task_ids: importedTaskIds, unchanged: false };
}

function exclusiveTaskIds(root: string, runtime: RuntimeStore, session: CompanionSession) {
  const otherOwners = new Set(readCompanionStatus(root, runtime).sessions.filter((item) => item.session_id !== session.session_id).flatMap((item) => item.synced_task_ids));
  return new Set(session.synced_task_ids.filter((taskId) => !otherOwners.has(taskId)));
}

function selectedSession(root: string, runtime: RuntimeStore, input: { cwd?: string; session_id?: string }) {
  if (input.cwd !== undefined) requireProjectPath(root, input.cwd);
  const status = readCompanionStatus(root, runtime);
  const requested = input.session_id !== undefined ? status.sessions.find((item) => item.session_id === text(input.session_id)) : null;
  if (input.session_id !== undefined && !requested) throw new Error("codex_session_not_found");
  if (status.selection_required) throw new Error("codex_session_selection_required");
  if (!status.latest_session) throw new Error("codex_session_not_bound");
  if (requested && requested.session_id !== status.selected_session_id) throw new Error("codex_session_not_selected");
  requireProjectPath(root, input.cwd ?? status.latest_session.cwd);
  return status.latest_session;
}

function normalizePlan(value: CompanionPlanInput["plan"]) {
  if (!Array.isArray(value) || !value.length) throw new Error("codex_plan_steps_required");
  return value.map((item) => {
    if (!item || !text(item.step)) throw new Error("codex_plan_steps_required");
    const status = item.status ?? "pending";
    if (!["pending", "in_progress", "completed"].includes(status)) throw new Error("codex_plan_status_invalid");
    return { step: redactSecrets(text(item.step)), status: status as CompanionPlanStepStatus };
  });
}

function extractPlan(value: unknown): Array<{ step: string; status?: string }> {
  if (!value || typeof value !== "object") return [];
  const plan = (value as { plan?: unknown }).plan;
  return Array.isArray(plan) ? plan as CompanionPlanInput["plan"] : [];
}

function readJsonState<T>(runtime: RuntimeStore, key: string, fallback: T): T {
  const raw = runtime.getState(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function readSessions(runtime: RuntimeStore): CompanionSession[] {
  return readJsonState<CompanionSession[]>(runtime, SESSION_STATE_KEY, []).map((item) => ({
    ...item, plan_steps: item.plan_steps ?? [], plan_explanation: item.plan_explanation ?? null,
    current_task_id: item.current_task_id ?? null, task_progress: item.task_progress ?? []
  }));
}

function saveSessions(runtime: RuntimeStore, sessions: CompanionSession[]) {
  const selectedId = runtime.getState(SELECTION_STATE_KEY);
  const sorted = [...sessions].sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at));
  const selected = sorted.find((item) => item.session_id === selectedId);
  const kept = sorted.slice(0, MAX_SESSIONS);
  if (selected && !kept.includes(selected)) kept[kept.length - 1] = selected;
  runtime.setState(SESSION_STATE_KEY, JSON.stringify(kept));
}

function requireProjectPath(root: string, cwd: string) {
  if (!isProjectPath(root, cwd)) throw new Error("codex_cwd_outside_project");
}

function isProjectPath(root: string, cwd: string) {
  if (!text(cwd) || !isAbsolute(cwd)) return false;
  const project = canonicalPath(root);
  const candidate = canonicalPath(cwd);
  const rel = relative(project, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function canonicalPath(value: string) {
  let ancestor = resolve(value);
  const suffix: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return resolve(existsSync(ancestor) ? realpathSync(ancestor) : ancestor, ...suffix);
}

function stageForHook(event: string, tool: string, previous: CompanionStage = "connected"): CompanionStage {
  if (event === "SessionStart" || event === "UserPromptSubmit") return "connected";
  if (event === "SubagentStart") return "implementing";
  if (event === "SubagentStop" || event === "Stop") return "idle";
  if (event === "PostToolUse" && tool === "update_plan") return "planning";
  return previous;
}

function companionStage(value?: string): CompanionStage {
  if (!STAGES.includes(value as CompanionStage)) throw new Error("codex_progress_stage_invalid");
  return value as CompanionStage;
}

function stageLabel(stage: CompanionStage) {
  return ({ connected: "已连接", planning: "规划中", implementing: "执行中", testing: "测试中", reviewing: "审查中", blocked: "已阻塞", completed: "Agent 报告完成", idle: "等待中" } as const)[stage];
}

function companionEventMessage(event: string, session: CompanionSession, importedTaskIds: string[]) {
  if (importedTaskIds.length) return "已同步 Codex 当前任务的 " + importedTaskIds.length + " 个 Plan 步骤。";
  if (event === "SessionStart") return "已发现 Codex 伴随候选任务。";
  if (event === "Stop") return "Codex 当前回合已结束，产出摘要已回到映构运行态。";
  return "Codex 伴随状态：" + stageLabel(session.stage) + "。";
}

function stopResponse(event: string) { return event === "Stop" ? { continue: true } : null; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function compact(value: string, limit: number) { return value.replace(/\s+/g, " ").trim().slice(0, limit); }
