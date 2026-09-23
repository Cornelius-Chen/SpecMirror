import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { currentEngineeringRun, effectiveEngineeringAgentOwner, engineeringContractKey, type EngineeringDocument } from "@epm/domain";
import type { RuntimeStore } from "@epm/spec-io";
import { readCompanionStatus, receiveCompanionHook, type CompanionHookPayload, type CompanionSession, type CompanionStatus } from "./codex-companion.ts";
import { EngineeringServiceError } from "./engineering-service.ts";
import type { EventBus } from "./events.ts";
import type { TaskWorkspaceRecord, TaskWorkspaces } from "./task-workspaces.ts";
import { redactSecrets } from "./stdio-jsonrpc.ts";
import { isRecentAgentSession } from "./agent-session-presence.ts";
import { adaptCodexPlanEvent } from "./codex-plan-event-adapter.ts";
import {
  normalizeRunPlan, RunPlanProjectionStore, type RunPlanProjection, type RunPlanProjectionBinding,
  type StoredRunPlanProjection
} from "./run-plan-projection.ts";

const OBSERVATIONS = "workspace-companion:hook-observations:v1";
const HOOKS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]);
const PLAN_TOOLS = new Set(["update_plan", "create_goal", "get_goal", "update_goal"]);
const fail = (code: string, message: string, status = 403): never => { throw new EngineeringServiceError(code, message, status); };
const text = (value: unknown, max = 2000) => typeof value === "string" && value.trim().length <= max ? value.trim() : "";
const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) ? value : "";

type RunPlanHookResult = {
  accepted: boolean;
  reason?: string;
  changed?: boolean;
  projection_id?: string | null;
  workspace_id?: string | null;
  binding?: RunPlanProjectionBinding;
};
type ObservedCompanionSession = CompanionSession & { authenticated_at_ms?: number };
/** Internal result of a trusted, read-only Codex current-turn lookup; never request-body authority. */
export type AuthoritativeCodexTurn = Readonly<{ sessionId: string; cwd: string; turnId: string }>;
const metadata = (value: unknown) => { const candidate = redactSecrets(text(value, 160)); return /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(candidate) ? candidate : ""; };
function canonical(value: string) {
  let ancestor = resolve(value); const suffix: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return resolve(existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor, ...suffix);
}
const samePath = (a: string, b: string) => isAbsolute(a) && isAbsolute(b) && relative(canonical(a), canonical(b)) === "";
function inside(root: string, cwd: string) {
  if (!isAbsolute(cwd)) return false;
  const rel = relative(canonical(root), canonical(cwd));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}
type WorkspaceStatus = CompanionStatus & {
  workspace?: TaskWorkspaceRecord | null;
  workspace_selection_required?: boolean;
  workspace_candidates?: Array<Pick<TaskWorkspaceRecord, "id" | "title" | "thread_id" | "source_cwd">>;
};
export type CompanionRunPlanProjectionInput = {
  session_id?: unknown;
  cwd?: unknown;
  workspace_id?: unknown;
  plan?: unknown;
};

function latestRunPlanProjections(projections: StoredRunPlanProjection[], observations: CompanionSession[]) {
  const currentTurn = new Map(observations.map(item => [item.session_id, item.turn_id]));
  const latest = new Map<string, StoredRunPlanProjection>();
  for (const projection of projections.sort((a, b) => {
    const priority = (item: StoredRunPlanProjection) => item.lifecycle !== "active" ? 0
      : item.source !== "goal" && item.turn_id === currentTurn.get(item.session_id) ? 3 : item.source === "goal" ? 2 : 1;
    return priority(b) - priority(a) || b.updated_at.localeCompare(a.updated_at);
  })) {
    if (!latest.has(projection.session_id)) latest.set(projection.session_id, projection);
  }
  return [...latest.values()];
}

/** Hook observations establish identity presence, never workspace or execution authority. */
export class WorkspaceCompanion {
  readonly runPlans: RunPlanProjectionStore;
  private readonly observedThisProcess = new Set<string>();
  constructor(readonly root: string, readonly runtime: RuntimeStore, readonly events: EventBus, readonly options: { readonlyLegacy?: boolean } = {}) {
    this.runPlans = new RunPlanProjectionStore(runtime);
  }

  private observations(): ObservedCompanionSession[] {
    try {
      const value = JSON.parse(this.runtime.getState(OBSERVATIONS) ?? "[]");
      return Array.isArray(value) ? value.filter(item => item && identifier(item.session_id) && typeof item.cwd === "string" && isAbsolute(item.cwd)
        && typeof item.last_seen_at === "string" && (item.authenticated_at_ms === undefined || Number.isSafeInteger(item.authenticated_at_ms))).slice(0, 500) : [];
    } catch { return []; }
  }

  /** UI may list matching real candidates before assigning their owner fields. */
  sessions(record: TaskWorkspaceRecord): CompanionSession[] {
    const all = [...this.observations(), ...readCompanionStatus(this.root, this.runtime).sessions];
    const seen = new Set<string>();
    return all.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
      .filter(session => !seen.has(session.session_id) && Boolean(seen.add(session.session_id)))
      .filter(session => record.kind === "existing" && !record.thread_id ? inside(record.source_cwd, session.cwd) : samePath(session.cwd, record.source_cwd));
  }

  /** Only actual lifecycle receipts establish freshness; legacy plan/progress sync does not. */
  lifecycleObservations(record: TaskWorkspaceRecord): CompanionSession[] {
    return this.observations()
      .filter(session => this.observedThisProcess.has(this.observationKey(session.session_id, session.cwd)))
      .filter(session => record.kind === "existing" && !record.thread_id ? inside(record.source_cwd, session.cwd) : samePath(session.cwd, record.source_cwd));
  }

  /** Recent signed connection records are discovery hints, never fresh execution presence or approval. */
  taskConnectionCandidates() {
    return this.observations()
      .filter(session => typeof session.authenticated_at_ms === "number" && session.authenticated_at_ms > 0 && isRecentAgentSession(session.last_seen_at))
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at)).slice(0, 20)
      .map(session => ({ thread_id: session.session_id, cwd: session.cwd, source: "hook" as const, observed_at: session.last_seen_at }));
  }

  /** Only a signed new tool event needs a current-turn lookup; reads never refresh presence. */
  needsCurrentTurnVerification(input: CompanionHookPayload, authenticatedAtMs?: number): boolean {
    const sessionId = identifier(input?.session_id), cwd = text(input?.cwd), turnId = identifier(input?.turn_id);
    if (!sessionId || !cwd || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd) || !turnId || input.hook_event_name !== "PostToolUse") return false;
    const previous = this.observations().find(item => item.session_id === sessionId);
    return Boolean(previous?.turn_id && turnId !== previous.turn_id && samePath(previous.cwd, cwd)
      && typeof authenticatedAtMs === "number" && Number.isSafeInteger(authenticatedAtMs) && authenticatedAtMs > 0
      && previous.authenticated_at_ms !== undefined && authenticatedAtMs > previous.authenticated_at_ms
      && !this.runPlans.isTurnEnded(sessionId, turnId));
  }

  receiveHook(input: CompanionHookPayload, workspaces?: Pick<TaskWorkspaces, "contextForAgent" | "records" | "resolve">,
    authenticatedAtMs?: number, authoritativeTurn?: AuthoritativeCodexTurn) {
    const sessionId = identifier(input?.session_id), cwd = text(input?.cwd), eventName = text(input?.hook_event_name, 80);
    if (!sessionId || !cwd || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd) || !HOOKS.has(eventName)) fail("invalid_codex_hook_payload", "需要真实生命周期 Hook 的会话、工作目录与有效事件。", 400);
    const observations = this.observations(), previous = observations.find(item => item.session_id === sessionId), at = new Date().toISOString();
    if (authenticatedAtMs !== undefined && previous?.authenticated_at_ms !== undefined && authenticatedAtMs < previous.authenticated_at_ms) return {
      accepted: false, ignored: "old_signed_event", identity_observed: false, execution_authorized: false, session: previous,
      imported_task_ids: [], run_plan_projection: { accepted: false, reason: "old_signed_event" } as RunPlanHookResult,
      hook_response: eventName === "Stop" ? { continue: true } : null
    };
    const incomingTurnId = identifier(input.turn_id);
    // App-to-app delegation can start a turn without UserPromptSubmit. Its first
    // tool event must match the independently read current Codex turn, in addition
    // to the signed Hook. The same rule applies after a restart: an undelivered
    // older event is not proof of the current turn. Recheck after the route's
    // lookup so an intervening Stop or newer receipt cannot be overwritten.
    const canObserveVerifiedTurn = Boolean(authoritativeTurn && this.needsCurrentTurnVerification(input, authenticatedAtMs)
      && identifier(authoritativeTurn.sessionId) === sessionId
      && identifier(authoritativeTurn.turnId) === incomingTurnId && typeof authoritativeTurn.cwd === "string"
      && samePath(authoritativeTurn.cwd, cwd));
    const oldTurnEvent = Boolean(incomingTurnId && previous?.turn_id && incomingTurnId !== previous.turn_id
      && !["SessionStart", "UserPromptSubmit"].includes(eventName) && !canObserveVerifiedTurn);
    const turnId = eventName === "UserPromptSubmit" ? incomingTurnId || null : oldTurnEvent ? previous?.turn_id ?? null : incomingTurnId || previous?.turn_id || null;
    // Some lifecycle Hook variants omit turn_id. They still belong to the last
    // observed turn, so its Stop tombstone must prevent a late event from
    // reviving presence or a RunPlan. Outside the signed and independently
    // verified current-turn event above, only
    // SessionStart and UserPromptSubmit establish fresh lifecycle context.
    const endedTurnEvent = Boolean(turnId && !["SessionStart", "UserPromptSubmit"].includes(eventName) && this.runPlans.isTurnEnded(sessionId, turnId));
    if (oldTurnEvent || endedTurnEvent) return {
      accepted: false, ignored: oldTurnEvent ? "old_turn_event" : "turn_already_ended", identity_observed: false,
      execution_authorized: false, session: previous ?? null, imported_task_ids: [],
      run_plan_projection: { accepted: false, reason: oldTurnEvent ? "old_turn_event" : "turn_already_ended" } as RunPlanHookResult,
      hook_response: eventName === "Stop" ? { continue: true } : null
    };
    const preserveTurn = oldTurnEvent || endedTurnEvent;
    const stage = preserveTurn ? previous?.stage ?? "connected" : eventName === "Stop" ? "idle" : eventName === "SubagentStop" ? previous?.stage ?? "connected" : eventName === "SubagentStart" ? "implementing" : eventName === "PostToolUse" && PLAN_TOOLS.has(text(input.tool_name, 80)) ? "planning" : "connected";
    const session: ObservedCompanionSession = {
      session_id: sessionId, cwd: oldTurnEvent ? previous?.cwd ?? cwd : cwd, model: metadata(input.model) || metadata(previous?.model) || null,
      permission_mode: metadata(input.permission_mode) || metadata(previous?.permission_mode) || null,
      turn_id: turnId, stage, last_event: preserveTurn ? previous?.last_event ?? eventName : eventName, last_seen_at: at, started_at: previous?.started_at ?? at,
      // No Plan import, task status change, tool input or conversation text is stored here.
      plan_version: null, synced_task_ids: [], plan_steps: [], plan_explanation: null,
      current_task_id: null, task_progress: [], output_preview: null,
      ...(authenticatedAtMs !== undefined ? { authenticated_at_ms: authenticatedAtMs } : previous?.authenticated_at_ms !== undefined ? { authenticated_at_ms: previous.authenticated_at_ms } : {})
    };
    this.runtime.setState(OBSERVATIONS, JSON.stringify([session, ...observations.filter(item => item.session_id !== sessionId)].slice(0, 500)));
    this.observedThisProcess.add(this.observationKey(sessionId, session.cwd));
    const projection = this.projectHook(input, session, previous, oldTurnEvent, at, workspaces);
    if (inside(this.root, cwd) && !this.options.readonlyLegacy) return { ...receiveCompanionHook(this.root, this.runtime, this.events, input), run_plan_projection: projection };
    this.events.emit({ type: "system", message: "已观察到来源任务的真实 Hook；工作区关联和节点分配仍分别校验。", data: { kind: "workspace-companion", sessionId, stage } });
    return { accepted: true, identity_observed: true, execution_authorized: false, session, imported_task_ids: [], run_plan_projection: projection, hook_response: eventName === "Stop" ? { continue: true } : null };
  }

  private projectHook(input: CompanionHookPayload, session: CompanionSession, previous: CompanionSession | undefined, oldTurnEvent: boolean, at: string,
    workspaces?: Pick<TaskWorkspaces, "contextForAgent" | "records" | "resolve">): RunPlanHookResult {
    const eventName = text(input.hook_event_name, 80), toolName = text(input.tool_name, 80);
    if (!workspaces) return { accepted: false, reason: "workspace_resolver_unavailable" };
    if (oldTurnEvent) return { accepted: false, reason: "old_turn_event" };
    if (eventName === "PostToolUse" && PLAN_TOOLS.has(toolName)) {
      if (!session.turn_id) return { accepted: false, reason: "turn_id_unverified" };
      if (previous?.last_event === "Stop" && previous.turn_id === session.turn_id) return { accepted: false, reason: "turn_already_ended" };
      const adapted = adaptCodexPlanEvent(input);
      if (!adapted.accepted) return adapted;
      const target = this.projectionTarget(session.session_id, session.cwd, workspaces);
      const saved = adapted.source === "update_plan"
        ? this.runPlans.upsert({ workspace_id: target.workspace_id, session_id: session.session_id, source_cwd: session.cwd,
          turn_id: session.turn_id, plan: adapted.plan, binding: target.binding, at })
        : (() => {
          const toolUseId = identifier(input.tool_use_id);
          if (!toolUseId) return null;
          return this.runPlans.upsertGoal({ workspace_id: target.workspace_id, session_id: session.session_id, source_cwd: session.cwd,
            turn_id: session.turn_id, tool_use_id: toolUseId, operation: adapted.operation, goal_status: adapted.goal_status,
            plan: adapted.plan, binding: target.binding, at });
        })();
      if (!saved) return { accepted: false, reason: "tool_use_id_unverified" };
      if (saved.rejected === "goal_event_stale") return { accepted: false, changed: false, projection_id: saved.projection?.id ?? null,
        workspace_id: saved.projection?.workspace_id ?? target.workspace_id, binding: saved.projection?.binding ?? target.binding, reason: "goal_event_stale" };
      if (saved.rejected === "goal_already_active") return { accepted: false, changed: false, projection_id: saved.projection?.id ?? null,
        workspace_id: saved.projection?.workspace_id ?? target.workspace_id, binding: saved.projection?.binding ?? target.binding, reason: "goal_already_active" };
      if (saved.rejected === "turn_ended") return { accepted: false, changed: false, projection_id: saved.projection?.id ?? null,
        workspace_id: saved.projection?.workspace_id ?? target.workspace_id, binding: saved.projection?.binding ?? target.binding, reason: "turn_already_ended" };
      if (saved.changed && saved.projection) this.events.emit({
        type: "plan", message: adapted.source === "goal" ? "已更新 Codex 长期目标的临时投影；不会改动工程结构或验收状态。" : "已更新 Codex 当前回合的临时计划；不会改动工程结构或验收状态。",
        data: { kind: "run-plan-projection", projectionId: saved.projection.id, workspaceId: saved.projection.workspace_id,
          sessionId: saved.projection.session_id, lifecycle: saved.projection.lifecycle, bindingState: saved.projection.binding.state, planHash: saved.projection.plan_hash }
      });
      return { accepted: true, changed: saved.changed, projection_id: saved.projection?.id ?? null,
        workspace_id: saved.projection?.workspace_id ?? target.workspace_id, binding: saved.projection?.binding ?? target.binding };
    }
    if (eventName === "Stop") {
      if (!session.turn_id) return { accepted: false, reason: "turn_id_unverified" };
      const ended = this.runPlans.endTurn(session.session_id, session.turn_id, at);
      if (ended.changed && ended.projection) this.events.emit({
        type: "execution", message: "Codex 当前回合已结束；计划状态仍不代表工程验收。",
        data: { kind: "run-plan-projection", projectionId: ended.projection.id, workspaceId: ended.projection.workspace_id,
          sessionId: ended.projection.session_id, lifecycle: ended.projection.lifecycle, bindingState: ended.projection.binding.state, planHash: ended.projection.plan_hash }
      });
      return { accepted: Boolean(ended.projection), changed: ended.changed, projection_id: ended.projection?.id ?? null,
        reason: ended.projection ? undefined : "projection_not_found" };
    }
    return { accepted: false, reason: "lifecycle_only" };
  }

  /** Writes only the current Agent turn's runtime projection. It never imports
   * tasks or changes the engineering document, node state, or acceptance. */
  syncRunPlanProjection(input: CompanionRunPlanProjectionInput,
    workspaces: Pick<TaskWorkspaces, "contextForAgent" | "records" | "resolve">) {
    const sessionId = identifier(input?.session_id), cwd = text(input?.cwd), requestedWorkspaceId = input.workspace_id === undefined ? "" : identifier(input.workspace_id);
    if (!sessionId || !cwd || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) fail("invalid_codex_run_plan_payload", "请提供真实 Hook 已发现的会话与绝对工作目录。", 400);
    if (input.workspace_id !== undefined && !requestedWorkspaceId) fail("task_workspace_scope_invalid", "明确工作区标识无效。", 400);
    const plan = normalizeRunPlan(input.plan) ?? fail("plan_contract_invalid", "计划只接受 1 至 100 个 step/status 白名单条目。", 400);
    const observed = this.observations().filter(item => item.session_id === sessionId && samePath(item.cwd, cwd))
      .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0];
    if (!observed || !this.observedThisProcess.has(this.observationKey(sessionId, cwd)) || !isRecentAgentSession(observed.last_seen_at)) {
      fail("codex_session_not_current", "当前会话与目录尚未被本次服务进程的真实 Hook 确认。", 403);
    }
    const turnId = identifier(observed.turn_id);
    if (!turnId) fail("turn_id_unverified", "真实 Hook 尚未提供当前回合标识。", 409);
    if (this.runPlans.isTurnEnded(sessionId, turnId)) fail("turn_already_ended", "当前回合已经结束，不能补写计划投影。", 409);
    const target = this.projectionTarget(sessionId, cwd, workspaces, requestedWorkspaceId || undefined);
    if (requestedWorkspaceId && target.workspace_id !== requestedWorkspaceId) fail("task_workspace_not_authorized", "当前真实会话不属于指定工作区。", 403);
    const at = new Date().toISOString();
    const saved = this.runPlans.upsert({ workspace_id: target.workspace_id, session_id: sessionId, source_cwd: cwd,
      turn_id: turnId, plan, binding: target.binding, at });
    if (saved.rejected === "turn_ended") fail("turn_already_ended", "当前回合已经结束，不能补写计划投影。", 409);
    if (saved.changed && saved.projection) this.events.emit({
      type: "plan", message: "已更新 Codex 当前回合的临时计划；不会改动工程结构或验收状态。",
      data: { kind: "run-plan-projection", projectionId: saved.projection.id, workspaceId: saved.projection.workspace_id,
        sessionId: saved.projection.session_id, lifecycle: saved.projection.lifecycle, bindingState: saved.projection.binding.state, planHash: saved.projection.plan_hash }
    });
    return { accepted: true, changed: saved.changed, projection_id: saved.projection?.id ?? null,
      workspace_id: saved.projection?.workspace_id ?? target.workspace_id, binding: saved.projection?.binding ?? target.binding };
  }

  private projectionTarget(sessionId: string, cwd: string, workspaces: Pick<TaskWorkspaces, "contextForAgent" | "records" | "resolve">,
    requestedWorkspaceId?: string): { workspace_id: string | null; binding: RunPlanProjectionBinding } {
    let authorized: ReturnType<TaskWorkspaces["contextForAgent"]>;
    try { authorized = workspaces.contextForAgent(sessionId, cwd, requestedWorkspaceId); } catch { authorized = undefined; }
    const records = requestedWorkspaceId ? [workspaces.resolve(requestedWorkspaceId).record] : workspaces.records(), exact = records.filter(record => samePath(record.source_cwd, cwd));
    // An exact task source is more specific than the host's broad descendant match.
    const candidates = exact.length ? exact : records.filter(record => record.kind === "existing" && !record.thread_id && inside(record.source_cwd, cwd));
    const context = requestedWorkspaceId ? authorized : exact.length === 1 && authorized?.record.id !== exact[0]!.id ? workspaces.resolve(exact[0]!.id)
      : authorized ?? (candidates.length === 1 ? workspaces.resolve(candidates[0]!.id) : undefined);
    if (!context) return { workspace_id: null, binding: this.unassigned(candidates.length > 1 ? "来源目录对应多个工作区，未自动猜测。" : "当前会话尚未归属任何工作区。") };
    const workspaceId = context.record.id, doc = context.service.view().document, actor = "codex:" + sessionId;
    const owned = doc.nodes.filter(node => node.status !== "archived" && effectiveEngineeringAgentOwner(doc, node.id) === actor);
    const runs = owned.flatMap(node => {
      const run = currentEngineeringRun(doc, node.id);
      if (!run || run.mode !== "external" || !["queued", "running"].includes(run.status) || run.actor !== actor || run.handoff?.owner !== actor) return [];
      if (!samePath(run.handoff.source_cwd, cwd) || run.handoff.contract_key !== run.snapshot.contract_key) return [];
      try { if (run.snapshot.contract_key !== engineeringContractKey(doc, node.id)) return []; } catch { return []; }
      return [{ node, run }];
    });
    if (runs.length === 1) {
      const { node, run } = runs[0]!;
      const executionAuthorized = run.status === "running" && run.handoff?.state === "claimed";
      return { workspace_id: workspaceId, binding: { state: "run", node_id: node.id, run_id: run.id, owner: actor,
        contract_key: run.snapshot.contract_key, execution_authorized: executionAuthorized,
        ...(!executionAuthorized ? { reason: run.handoff?.state !== "claimed" ? "冻结运行尚未由负责人领取。" : "冻结运行仍在等待执行条件。" } : {}) } };
    }
    if (runs.length > 1) return { workspace_id: workspaceId, binding: { state: "ambiguous", node_id: null, run_id: null, owner: actor, contract_key: null,
      execution_authorized: false, reason: "当前会话同时对应多个有效运行，未自动选择。" } };
    if (owned.length === 1) {
      const node = owned[0]!;
      let contractKey: string | null = null;
      try { contractKey = engineeringContractKey(doc, node.id); } catch { /* invalid contracts remain unattached */ }
      return { workspace_id: workspaceId, binding: { state: "owner", node_id: node.id, run_id: null, owner: actor, contract_key: contractKey,
        execution_authorized: false, reason: "会话拥有此节点，但尚无唯一的当前冻结运行。" } };
    }
    if (owned.length > 1) return { workspace_id: workspaceId, binding: { state: "ambiguous", node_id: null, run_id: null, owner: actor, contract_key: null,
      execution_authorized: false, reason: "当前会话对应多个负责节点，未自动选择。" } };
    if (context.record.thread_id === sessionId && samePath(context.record.source_cwd, cwd)) return { workspace_id: workspaceId,
      binding: { state: "workspace", node_id: doc.root_id, run_id: null, owner: null, contract_key: null, execution_authorized: false,
        reason: "计划仅观察性显示在任务工作区，尚未分配工程节点。" } };
    return { workspace_id: workspaceId, binding: this.unassigned("来源目录已识别，但会话尚未分配工程节点。") };
  }

  private unassigned(reason: string): RunPlanProjectionBinding {
    return { state: "unassigned", node_id: null, run_id: null, owner: null, contract_key: null, execution_authorized: false, reason };
  }

  readRunPlanProjections(workspaceId: string, workspaces: Pick<TaskWorkspaces, "resolve">) {
    const context = workspaces.resolve(workspaceId);
    const observations = this.lifecycleObservations(context.record);
    const latest = latestRunPlanProjections(this.runPlans.list().filter(item => item.workspace_id === context.record.id), observations);
    const projections: RunPlanProjection[] = latest.map(projection => {
      const observation = observations.find(item => item.session_id === projection.session_id && samePath(item.cwd, projection.source_cwd));
      return { ...projection, binding: this.revalidateProjectionBinding(projection, context.service.view().document),
        connection: observation && isRecentAgentSession(observation.last_seen_at) ? "current" : "stale" };
    });
    return { schema_version: 1 as const, workspace_id: context.record.id, projections };
  }

  /** Task-level observation is available before workspace association. Reads
   * never establish identity, refresh activity, or disclose engineering bindings. */
  readTaskRunPlanProjections(input: { session_id?: unknown; cwd?: unknown }) {
    const sessionId = identifier(input.session_id), cwd = text(input.cwd);
    if (!sessionId || !cwd || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) {
      fail("invalid_codex_run_plan_scope", "请提供真实任务会话与实际绝对工作目录。", 400);
    }
    const observation = this.observations()
      .filter(item => item.session_id === sessionId && samePath(item.cwd, cwd))
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))[0];
    if (!observation) fail("task_run_plan_source_unobserved", "当前 session_id 与 cwd 尚未被真实 Hook 一起发现。");
    const observations = this.observedThisProcess.has(this.observationKey(sessionId, observation.cwd)) ? [observation] : [];
    const latest = latestRunPlanProjections(this.runPlans.list()
      .filter(item => item.session_id === sessionId && samePath(item.source_cwd, observation.cwd)), observations);
    const projections: RunPlanProjection[] = latest.map(projection => ({
      ...projection, workspace_id: null,
      binding: this.unassigned("仅观察当前任务计划；工程归属与执行授权需在工程工作区单独核对。"),
      connection: observations.length && isRecentAgentSession(observation.last_seen_at) ? "current" : "stale"
    }));
    return { schema_version: 1 as const, session_id: sessionId, source_cwd: observation.cwd, workspace_id: null, projections };
  }

  private revalidateProjectionBinding(projection: StoredRunPlanProjection, doc: EngineeringDocument): RunPlanProjectionBinding {
    const binding = projection.binding, actor = "codex:" + projection.session_id;
    if (binding.state === "run" && binding.node_id && binding.run_id && binding.contract_key) {
      const node = doc.nodes.find(item => item.id === binding.node_id && item.status !== "archived"), run = doc.runs.find(item => item.id === binding.run_id);
      let currentKey: string | null = null;
      try { if (node) currentKey = engineeringContractKey(doc, node.id); } catch { /* stale */ }
      const current = node ? currentEngineeringRun(doc, node.id) : undefined;
      if (!node || !run || current?.id !== run.id || currentKey !== binding.contract_key || run.snapshot.contract_key !== binding.contract_key
        || run.handoff?.contract_key !== binding.contract_key || run.actor !== actor || run.handoff?.owner !== actor || !samePath(run.handoff.source_cwd, projection.source_cwd)
        || !["queued", "running"].includes(run.status)) return this.unassigned("原冻结运行或合同已变化；旧计划未附着到新运行。 ".trim());
      const executionAuthorized = run.status === "running" && run.handoff.state === "claimed";
      return { ...binding, execution_authorized: executionAuthorized,
        ...(executionAuthorized ? { reason: undefined } : { reason: run.handoff.state !== "claimed" ? "冻结运行尚未由负责人领取。" : "冻结运行仍在等待执行条件。" }) };
    }
    if (binding.state === "owner" && binding.node_id) {
      const node = doc.nodes.find(item => item.id === binding.node_id && item.status !== "archived");
      let currentKey: string | null = null;
      try { if (node) currentKey = engineeringContractKey(doc, node.id); } catch { /* stale */ }
      if (!node || effectiveEngineeringAgentOwner(doc, node.id) !== actor || currentKey !== binding.contract_key) return this.unassigned("节点负责人或合同已变化；旧计划保持未归属。 ".trim());
    }
    if (binding.state === "workspace" && doc.root_id !== binding.node_id) return this.unassigned("工作区根节点已变化；旧计划保持未归属。 ".trim());
    return { ...binding, execution_authorized: false };
  }

  private observationKey(sessionId: string, cwd: string) {
    return `${sessionId}\u0000${canonical(cwd)}`;
  }

  readStatus(input: { cwd?: unknown; session_id?: unknown; workspace_id?: unknown } = {}, workspaces?: Pick<TaskWorkspaces, "contextForAgent" | "records" | "resolve">): WorkspaceStatus {
    const base = readCompanionStatus(this.root, this.runtime);
    const cwd = text(input.cwd), sessionId = identifier(input.session_id), workspaceId = text(input.workspace_id, 160);
    if (input.cwd === undefined && input.session_id === undefined && input.workspace_id === undefined) return base;
    if (!cwd || !isAbsolute(cwd)) fail("cwd_required", "请提供当前任务的真实绝对 cwd。", 400);
    if (input.workspace_id !== undefined && !workspaceId) fail("task_workspace_scope_invalid", "明确工作区标识不能为空。", 400);
    if (input.session_id !== undefined && !sessionId) fail("codex_session_not_found", "请提供有效的真实 Hook session_id。");
    if (!sessionId) {
      if (inside(this.root, cwd) && !workspaceId) return base;
      return fail("task_workspace_session_required", "跨目录工作区解析需要当前真实 Hook session_id。", 400);
    }
    const observed = [...this.observations(), ...base.sessions].filter(item => item.session_id === sessionId).sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))[0];
    if (!observed || !samePath(observed.cwd, cwd)) fail("codex_session_not_found", "当前 session_id 与 cwd 尚未被真实 Hook 一起发现。");
    const context = workspaces?.contextForAgent(sessionId, cwd, workspaceId || undefined);
    if (context) {
      const recent = isRecentAgentSession(observed.last_seen_at);
      return { ...base, connected: recent, sessions: [observed], latest_session: observed, selected_session_id: null,
        selection_required: false, feedback: [], workspace: context.record, workspace_selection_required: false };
    }
    if (workspaceId) {
      // Resolve distinguishes an unknown scope from a known scope without assignment.
      workspaces?.resolve(workspaceId);
      return fail("task_workspace_not_authorized", "当前真实会话未关联或未分配到指定工作区。");
    }
    const candidates = (workspaces?.records() ?? []).filter(record => workspaces?.contextForAgent(sessionId, cwd, record.id))
      .map(({ id, title, thread_id, source_cwd }) => ({ id, title, thread_id, source_cwd }));
    if (candidates.length > 1) return { ...base, sessions: [observed], latest_session: null, connected: false, selected_session_id: null,
      selection_required: false, feedback: [], workspace: null, workspace_selection_required: true, workspace_candidates: candidates };
    if (inside(this.root, cwd) && !workspaces?.records().find(record => record.id === "host")?.thread_id) return base;
    return fail("task_workspace_not_bound", "真实 Hook 已发现，但当前任务尚未关联工作区，也没有明确分配的工程节点。请在统一任务工作区完成关联或分配。");
  }
}
