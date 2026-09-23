export type RunPlanStepStatus = "pending" | "in_progress" | "completed";
export type RunPlanBindingState = "run" | "owner" | "workspace" | "ambiguous" | "unassigned";

export interface RunPlanProjection {
  id: string;
  workspace_id: string | null;
  session_id: string;
  source_cwd: string;
  turn_id: string;
  plan_hash: string;
  lifecycle: "active" | "turn_ended";
  connection: "current" | "stale";
  binding: {
    state: RunPlanBindingState;
    node_id: string | null;
    run_id: string | null;
    owner: string | null;
    contract_key: string | null;
    execution_authorized: boolean;
    reason?: string;
  };
  steps: Array<{ id: string; order: number; title: string; status: RunPlanStepStatus }>;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  acceptance: "not_evaluated";
  notice: string;
}

export interface RunPlanProjectionView {
  schema_version: 1;
  workspace_id: string;
  projections: RunPlanProjection[];
}

export async function loadRunPlanProjections(workspaceId: string, signal?: AbortSignal): Promise<RunPlanProjectionView> {
  const response = await fetch(`/api/task-workspaces/${encodeURIComponent(workspaceId)}/run-plan-projections`, { signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Codex 本轮计划暂时无法读取。");
  return payload as RunPlanProjectionView;
}

export interface TaskRunPlanProjectionView {
  schema_version: 1;
  workspace_id: null;
  session_id: string;
  source_cwd: string;
  projections: RunPlanProjection[];
}

const canonicalCwd = (value: string) => {
  const path = value.trim().replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
};

/** A task's activity can be observed before it owns an engineering workspace. */
export async function loadTaskRunPlanProjections(sessionId: string, cwd: string, signal?: AbortSignal): Promise<TaskRunPlanProjectionView> {
  const response = await fetch(`/api/task-run-plans/${encodeURIComponent(sessionId)}?${new URLSearchParams({ cwd })}`, { signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.code === "task_run_plan_source_unobserved"
    ? "尚未收到此任务的真实活动。Codex 更新计划后，这里会自动显示。"
    : "本轮计划暂时无法读取，请稍后重试。");
  if (payload.workspace_id !== null || payload.session_id !== sessionId || typeof payload.source_cwd !== "string"
    || canonicalCwd(payload.source_cwd) !== canonicalCwd(cwd) || !Array.isArray(payload.projections)
    || payload.projections.some((item: RunPlanProjection) => item.session_id !== sessionId || typeof item.source_cwd !== "string"
      || canonicalCwd(item.source_cwd) !== canonicalCwd(cwd) || item.workspace_id !== null
      || item.binding?.state !== "unassigned" || item.binding.execution_authorized !== false
      || item.binding.node_id !== null || item.binding.run_id !== null || item.binding.owner !== null || item.binding.contract_key !== null)) {
    throw new Error("本轮计划与当前任务不一致，已拒绝显示。");
  }
  return payload as TaskRunPlanProjectionView;
}
