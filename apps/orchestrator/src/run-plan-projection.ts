import { createHash } from "node:crypto";
import type { RuntimeStore } from "@epm/spec-io";
import { redactSecrets } from "./stdio-jsonrpc.ts";
import type { CodexGoalStatus, CodexPlanSource } from "./codex-plan-event-adapter.ts";

const STATE_KEY = "workspace-companion:run-plan-projections:v1";
const MAX_PROJECTIONS = 500;
const MAX_DEDUPE_KEYS = 1_000;
const MAX_ENDED_TURN_KEYS = 1_000;
export const RUN_PLAN_PROJECTION_NOTICE = "计划完成只表示 Agent 报告，不代表工程验收。";

export type RunPlanProjectionStepStatus = "pending" | "in_progress" | "completed";
export type RunPlanProjectionLifecycle = "active" | "turn_ended";
export type RunPlanProjectionBindingState = "run" | "owner" | "workspace" | "ambiguous" | "unassigned";

export interface RunPlanProjectionBinding {
  state: RunPlanProjectionBindingState;
  node_id: string | null;
  run_id: string | null;
  owner: string | null;
  contract_key: string | null;
  execution_authorized: boolean;
  reason?: string;
}

export interface RunPlanProjectionStep {
  id: string;
  order: number;
  title: string;
  status: RunPlanProjectionStepStatus;
}

export interface StoredRunPlanProjection {
  id: string;
  workspace_id: string | null;
  session_id: string;
  source_cwd: string;
  turn_id: string;
  plan_hash: string;
  lifecycle: RunPlanProjectionLifecycle;
  binding: RunPlanProjectionBinding;
  steps: RunPlanProjectionStep[];
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  acceptance: "not_evaluated";
  notice: typeof RUN_PLAN_PROJECTION_NOTICE;
  source?: CodexPlanSource;
  goal_status?: CodexGoalStatus;
  goal_created_tool_use_id?: string;
  goal_event_ids?: string[];
  last_tool_use_id?: string;
}

export interface RunPlanProjection extends StoredRunPlanProjection {
  connection: "current" | "stale";
}

type StoredState = {
  schema_version: 1;
  projections: StoredRunPlanProjection[];
  dedupe_keys: string[];
  ended_turn_keys: string[];
};

export type NormalizedRunPlan = { steps: RunPlanProjectionStep[]; hash: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const turnKey = (sessionId: string, turnId: string) => sha256(JSON.stringify([sessionId, turnId]));
const safeId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);

function sanitizeStep(value: string) {
  return redactSecrets(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|password|secret)[A-Za-z0-9_]*)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** Only the bounded, documented update_plan surface is admitted. */
export function normalizeRunPlan(value: unknown): NormalizedRunPlan | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  const steps: RunPlanProjectionStep[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || typeof (item as { step?: unknown }).step !== "string") return null;
    const title = sanitizeStep((item as { step: string }).step);
    if (!title) return null;
    const rawStatus = (item as { status?: unknown }).status ?? "pending";
    if (!new Set(["pending", "in_progress", "completed"]).has(rawStatus as string)) return null;
    const status = rawStatus as RunPlanProjectionStepStatus;
    steps.push({ id: "plan-step-" + sha256(JSON.stringify([index, title])).slice(0, 20), order: index, title, status });
  }
  return { steps, hash: sha256(JSON.stringify(steps.map(({ title, status }) => ({ title, status })))) };
}

function validBinding(value: unknown): value is RunPlanProjectionBinding {
  if (!value || typeof value !== "object") return false;
  const item = value as RunPlanProjectionBinding;
  return new Set(["run", "owner", "workspace", "ambiguous", "unassigned"]).has(item.state)
    && (item.node_id === null || safeId(item.node_id)) && (item.run_id === null || safeId(item.run_id))
    && (item.owner === null || typeof item.owner === "string") && (item.contract_key === null || typeof item.contract_key === "string")
    && typeof item.execution_authorized === "boolean" && (item.reason === undefined || typeof item.reason === "string");
}

function validProjection(value: unknown): value is StoredRunPlanProjection {
  if (!value || typeof value !== "object") return false;
  const item = value as StoredRunPlanProjection;
  return safeId(item.id) && (item.workspace_id === null || safeId(item.workspace_id)) && safeId(item.session_id) && safeId(item.turn_id)
    && typeof item.source_cwd === "string" && typeof item.plan_hash === "string" && /^[a-f0-9]{64}$/.test(item.plan_hash)
    && new Set(["active", "turn_ended"]).has(item.lifecycle) && validBinding(item.binding)
    && Array.isArray(item.steps) && item.steps.length > 0 && item.steps.length <= 100
    && item.steps.every((step, index) => safeId(step.id) && step.order === index && typeof step.title === "string" && step.title.length > 0 && step.title.length <= 500 && new Set(["pending", "in_progress", "completed"]).has(step.status))
    && typeof item.started_at === "string" && typeof item.updated_at === "string" && (item.ended_at === null || typeof item.ended_at === "string")
    && item.acceptance === "not_evaluated" && item.notice === RUN_PLAN_PROJECTION_NOTICE
    && (item.source === undefined || new Set(["update_plan", "goal"]).has(item.source))
    && (item.goal_status === undefined || new Set(["active", "complete", "blocked"]).has(item.goal_status))
    && (item.goal_created_tool_use_id === undefined || safeId(item.goal_created_tool_use_id))
    && (item.goal_event_ids === undefined || Array.isArray(item.goal_event_ids) && item.goal_event_ids.length <= 100 && item.goal_event_ids.every(safeId))
    && (item.last_tool_use_id === undefined || safeId(item.last_tool_use_id));
}

export class RunPlanProjectionStore {
  constructor(readonly runtime: RuntimeStore) {}

  private readState(): StoredState {
    const raw = this.runtime.getState(STATE_KEY);
    if (!raw) return { schema_version: 1, projections: [], dedupe_keys: [], ended_turn_keys: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<StoredState>;
      if (parsed.schema_version !== 1 || !Array.isArray(parsed.projections) || !Array.isArray(parsed.dedupe_keys)) return { schema_version: 1, projections: [], dedupe_keys: [], ended_turn_keys: [] };
      return {
        schema_version: 1,
        projections: parsed.projections.filter(validProjection).slice(0, MAX_PROJECTIONS),
        dedupe_keys: parsed.dedupe_keys.filter((item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)).slice(0, MAX_DEDUPE_KEYS),
        ended_turn_keys: (Array.isArray(parsed.ended_turn_keys) ? parsed.ended_turn_keys : [])
          .filter((item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)).slice(0, MAX_ENDED_TURN_KEYS)
      };
    } catch {
      return { schema_version: 1, projections: [], dedupe_keys: [], ended_turn_keys: [] };
    }
  }

  private save(state: StoredState) {
    this.runtime.setState(STATE_KEY, JSON.stringify({
      schema_version: 1,
      projections: [...state.projections].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, MAX_PROJECTIONS),
      dedupe_keys: state.dedupe_keys.slice(0, MAX_DEDUPE_KEYS),
      ended_turn_keys: state.ended_turn_keys.slice(0, MAX_ENDED_TURN_KEYS)
    } satisfies StoredState));
  }

  list() { return this.readState().projections.map(item => structuredClone(item)); }

  isTurnEnded(sessionId: string, turnId: string) {
    return this.readState().ended_turn_keys.includes(turnKey(sessionId, turnId));
  }

  upsert(input: {
    workspace_id: string | null;
    session_id: string;
    source_cwd: string;
    turn_id: string;
    plan: NormalizedRunPlan;
    binding: RunPlanProjectionBinding;
    at: string;
  }) {
    const state = this.readState();
    const dedupeKey = sha256(JSON.stringify([input.session_id, input.turn_id, input.plan.hash]));
    const existing = state.projections.find(item => item.session_id === input.session_id && item.turn_id === input.turn_id);
    if (state.ended_turn_keys.includes(turnKey(input.session_id, input.turn_id))) {
      return { changed: false, projection: existing ? structuredClone(existing) : null, rejected: "turn_ended" as const };
    }
    // Idempotency applies to the currently visible projection. A real A → B → A
    // edit in the same turn must be able to restore A even though that hash was
    // seen earlier; otherwise the UI would keep showing B.
    if (existing?.lifecycle === "active" && existing.workspace_id === input.workspace_id && existing.plan_hash === input.plan.hash
      && JSON.stringify(existing.binding) === JSON.stringify(input.binding)) return { changed: false, projection: structuredClone(existing) };
    const id = "run-plan-" + sha256(JSON.stringify([input.session_id, input.turn_id])).slice(0, 24);
    const projection: StoredRunPlanProjection = {
      id,
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      source_cwd: input.source_cwd,
      turn_id: input.turn_id,
      plan_hash: input.plan.hash,
      lifecycle: "active",
      binding: structuredClone(input.binding),
      steps: structuredClone(input.plan.steps),
      started_at: existing?.started_at ?? input.at,
      updated_at: input.at,
      ended_at: null,
      acceptance: "not_evaluated",
      notice: RUN_PLAN_PROJECTION_NOTICE,
      source: "update_plan"
    };
    this.save({ schema_version: 1, projections: [projection, ...state.projections.filter(item => item.id !== id)], dedupe_keys: [dedupeKey, ...state.dedupe_keys.filter(item => item !== dedupeKey)], ended_turn_keys: state.ended_turn_keys });
    return { changed: true, projection: structuredClone(projection) };
  }

  upsertGoal(input: {
    workspace_id: string | null;
    session_id: string;
    source_cwd: string;
    turn_id: string;
    tool_use_id: string;
    operation: "create" | "refresh" | "finish";
    goal_status: CodexGoalStatus;
    plan: NormalizedRunPlan;
    binding: RunPlanProjectionBinding;
    at: string;
  }) {
    const state = this.readState();
    const active = state.projections.find(item => item.session_id === input.session_id && item.source === "goal" && item.lifecycle === "active");
    const seen = state.projections.find(item => item.session_id === input.session_id && item.source === "goal"
      && (item.goal_event_ids?.includes(input.tool_use_id) || item.goal_created_tool_use_id === input.tool_use_id || item.last_tool_use_id === input.tool_use_id));
    const existing = seen ?? active;
    const terminal = input.goal_status !== "active";
    if (seen) {
      if (seen.plan_hash === input.plan.hash && seen.goal_status === input.goal_status
        && seen.workspace_id === input.workspace_id && JSON.stringify(seen.binding) === JSON.stringify(input.binding)) {
        return { changed: false, projection: structuredClone(seen) };
      }
      return { changed: false, projection: structuredClone(seen), rejected: "goal_event_stale" as const };
    }
    if (input.operation === "create" && active) return { changed: false, projection: structuredClone(active), rejected: "goal_already_active" as const };
    const id = existing?.id ?? "run-goal-" + sha256(JSON.stringify([input.session_id, input.tool_use_id])).slice(0, 24);
    const projection: StoredRunPlanProjection = {
      id,
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      source_cwd: input.source_cwd,
      turn_id: existing?.turn_id ?? input.turn_id,
      plan_hash: input.plan.hash,
      lifecycle: terminal ? "turn_ended" : "active",
      binding: structuredClone(input.binding),
      steps: structuredClone(input.plan.steps),
      started_at: existing?.started_at ?? input.at,
      updated_at: input.at,
      ended_at: terminal ? input.at : null,
      acceptance: "not_evaluated",
      notice: RUN_PLAN_PROJECTION_NOTICE,
      source: "goal",
      goal_status: input.goal_status,
      goal_created_tool_use_id: existing?.goal_created_tool_use_id ?? input.tool_use_id,
      goal_event_ids: [input.tool_use_id, ...(existing?.goal_event_ids ?? [existing?.last_tool_use_id].filter((value): value is string => Boolean(value)))].slice(0, 100),
      last_tool_use_id: input.tool_use_id
    };
    this.save({ ...state, projections: [projection, ...state.projections.filter(item => item.id !== id)] });
    return { changed: true, projection: structuredClone(projection) };
  }

  endTurn(sessionId: string, turnId: string, at: string) {
    const state = this.readState();
    const current = state.projections.find(item => item.session_id === sessionId && item.turn_id === turnId && item.source !== "goal");
    const key = turnKey(sessionId, turnId), alreadyEnded = state.ended_turn_keys.includes(key);
    const projection = current && current.lifecycle !== "turn_ended" ? { ...current, lifecycle: "turn_ended" as const, ended_at: at, updated_at: at } : current;
    if (!alreadyEnded || projection !== current) this.save({ ...state,
      projections: projection ? [projection, ...state.projections.filter(item => item.id !== projection.id)] : state.projections,
      ended_turn_keys: [key, ...state.ended_turn_keys.filter(item => item !== key)] });
    return { changed: !alreadyEnded || projection !== current, projection: projection ? structuredClone(projection) : null };
  }
}
