import type { RunPlanProjection } from "../run-plan-api.ts";

export type RunPlanTransportState = "connecting" | "live" | "offline";
export type RunPlanGroupId = "linked" | "unassigned" | "inactive";
export interface RunPlanGroup { id: RunPlanGroupId; title: string; projections: RunPlanProjection[] }

/** Counts describe sessions, while the report list can retain several turns. */
export function latestRunPlanProjections(projections: readonly RunPlanProjection[]): RunPlanProjection[] {
  const latest = new Map<string, RunPlanProjection>();
  for (const report of projections) {
    const previous = latest.get(report.session_id);
    if (!previous || report.updated_at > previous.updated_at || (report.updated_at === previous.updated_at && report.started_at > previous.started_at)) latest.set(report.session_id, report);
  }
  return [...latest.values()];
}

/** Partition the existing read scope only; neither directory proximity nor a report grants node ownership. */
export function groupRunPlanProjections(projections: readonly RunPlanProjection[]): RunPlanGroup[] {
  const groups: RunPlanGroup[] = [
    { id: "linked", title: "已关联节点", projections: [] },
    { id: "unassigned", title: "归属待确认", projections: [] },
    { id: "inactive", title: "已结束 / 已过期", projections: [] }
  ];
  for (const projection of projections) {
    const index = projection.lifecycle !== "active" || projection.connection !== "current" ? 2
      : projection.binding.node_id && ["run", "owner"].includes(projection.binding.state) ? 0 : 1;
    groups[index].projections.push(projection);
  }
  for (const group of groups) group.projections.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return groups.filter(group => group.projections.length > 0);
}

export function runPlanSessionLabel(sessionId: string) {
  return sessionId.length > 16 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId;
}

export function projectionState(projection: RunPlanProjection) {
  if (projection.lifecycle === "turn_ended") return { key: "ended", label: "回合已结束" } as const;
  if (projection.connection === "stale") return { key: "stale", label: "连接已过期" } as const;
  if (projection.steps.length && projection.steps.every(step => step.status === "completed")) {
    return { key: "reported", label: "本轮步骤已报告完成" } as const;
  }
  if (projection.binding.state === "run" && projection.binding.execution_authorized && projection.steps.some(step => step.status === "in_progress")) {
    return { key: "executing", label: "正在执行工程任务" } as const;
  }
  if (projection.binding.state === "run" && !projection.binding.execution_authorized) return { key: "waiting", label: "等待领取工程任务" } as const;
  if (!projection.steps.some(step => step.status === "in_progress")) return { key: "idle", label: "等待步骤更新" } as const;
  return { key: "projecting", label: "正在更新临时计划" } as const;
}

/** A live report can illuminate its reported step; it cannot authorize engineering execution. */
export function runPlanMotion(projection: RunPlanProjection, transport: RunPlanTransportState, visible: boolean, unavailable = false): "reported" | "execution" | "static" {
  if (!visible || unavailable || transport !== "live" || projection.lifecycle !== "active" || projection.connection !== "current"
    || !projection.steps.some(step => step.status === "in_progress")) return "static";
  const state = projectionState(projection).key;
  return state === "executing" ? "execution" : state === "projecting" ? "reported" : "static";
}

/** Keep the current reported step visible even when a long plan has passed its first seven steps. */
export function visibleRunPlanSteps(projection: RunPlanProjection, limit = 7) {
  const index = projection.steps.findIndex(step => step.status === "in_progress");
  const start = Math.max(0, Math.min(index - 2, projection.steps.length - limit));
  return projection.steps.slice(start, start + limit);
}
