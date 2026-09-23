import type { Capability, CodexCompanionStatus, CodexReadiness, PermissionContract, ProjectMap, RuntimeStatus, SupervisionDetail, SupervisionDocument, SupervisionGoalResult, SupervisionProgress, SupervisionRun, SupervisionTask } from "./types.ts";
import { fetchWithHumanApproval } from "./human-approval-client.ts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => undefined) as T | { error?: string } | undefined;
  if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && payload.error ? payload.error : `${response.status} ${response.statusText}`);
  return payload as T;
}

async function humanApprovedRequest<T>(url: string, init: RequestInit, workspace = "host"): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  headers.set("x-mirror-workspace-id", workspace);
  headers.set("x-mirror-surface", "current-task");
  const requestTarget = { method, url, workspace, body: null };
  const response = await fetchWithHumanApproval(url, { ...init, headers }, requestTarget);
  const payload = await response.json().catch(() => undefined) as T | { error?: string } | undefined;
  if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && payload.error ? payload.error : `${response.status} ${response.statusText}`);
  return payload as T;
}

export const api = {
  health: () => request<{ ok: boolean; gateway: string; credential: string; runtime: string; enabled: boolean }>("/api/health"),
  map: () => request<ProjectMap>("/api/project/map"),
  status: () => request<RuntimeStatus>("/api/status"),
  codexReadiness: (signal?: AbortSignal) => request<CodexReadiness>("/api/codex/readiness", signal ? { signal } : undefined),
  codexCompanionStatus: () => request<CodexCompanionStatus>("/api/codex-companion/status"),
  bindCodexCompanionSession: (sessionId: string) => request<CodexCompanionStatus>("/api/codex-companion/bind", { method: "POST", body: JSON.stringify({ session_id: sessionId }) }),
  sendCodexCompanionFeedback: (taskId: string, text: string, sessionId: string) => request<{ status: CodexCompanionStatus }>("/api/codex-companion/feedback", { method: "POST", body: JSON.stringify({ task_id: taskId, text, session_id: sessionId }) }),
  startCodexSmoke: (signal?: AbortSignal, workspace?: string) => humanApprovedRequest<CodexReadiness["smoke"]>("/api/codex/smoke", { method: "POST", ...(signal ? { signal } : {}) }, workspace),
  stopCodexSmoke: (signal?: AbortSignal, workspace?: string) => humanApprovedRequest<CodexReadiness["smoke"]>("/api/codex/smoke/stop", { method: "POST", ...(signal ? { signal } : {}) }, workspace),
  capture: (title: string) => request("/api/inbox/capture", { method: "POST", body: JSON.stringify({ title }) }),
  impact: (id: string) => request<{ direct: string[]; transitive: string[] }>("/api/impact", { method: "POST", body: JSON.stringify({ id }) }),
  compile: (id: string) => request(`/api/changesets/${id}/compile`, { method: "POST" }),
  dispatch: (id: string) => request(`/api/changesets/${id}/dispatch`, { method: "POST" }),
  supervision: () => request<SupervisionDocument>("/api/supervision"),
  supervisionHistory: () => request<SupervisionDocument[]>("/api/supervision/history"),
  supervisionRuns: () => request<SupervisionRun[]>("/api/supervision/runs"),
  supervisionProgress: () => request<SupervisionProgress>("/api/supervision/progress"),
  importSupervisionPlan: (text: string) => request<{ document: SupervisionDocument; imported_task_ids: string[] }>("/api/supervision/plan/import", { method: "POST", body: JSON.stringify({ text }) }),
  createSupervisionTask: (title?: string) => request<{ document: SupervisionDocument; task: SupervisionTask; detail: SupervisionDetail }>("/api/supervision/tasks", { method: "POST", body: JSON.stringify({ title }) }),
  saveSupervisionTask: (task: SupervisionTask) => request<SupervisionDocument>(`/api/supervision/tasks/${task.id}`, { method: "PUT", body: JSON.stringify(task) }),
  freezeSupervisionTask: (id: string) => request<SupervisionDocument>(`/api/supervision/tasks/${id}/freeze`, { method: "POST" }),
  createSupervisionDetail: (category: SupervisionDetail["category"], taskId: string) => request<{ document: SupervisionDocument; detail: SupervisionDetail }>("/api/supervision/details", { method: "POST", body: JSON.stringify({ category, task_id: taskId }) }),
  dispatchSupervisionDetail: (id: string, mode: "mock" | "codex" = "mock") => request<{ document: SupervisionDocument; run: SupervisionRun; progress: SupervisionProgress }>(`/api/supervision/details/${id}/dispatch`, { method: "POST", body: JSON.stringify({ mode }) }),
  compileSupervisionGoal: (id: string) => request<SupervisionGoalResult>(`/api/supervision/details/${id}/compile-goal`, { method: "POST" }),
  dispatchSupervisionGoal: (id: string) => request<SupervisionGoalResult>(`/api/supervision/details/${id}/dispatch-goal`, { method: "POST" }),
  stopSupervisionRun: (id: string) => request<SupervisionRun>(`/api/supervision/runs/${id}/stop`, { method: "POST" }),
  resumeSupervisionRun: (id: string) => request<SupervisionRun>(`/api/supervision/runs/${id}/resume`, { method: "POST" }),
  stopRun: (id: string) => request(`/api/runs/${id}/stop`, { method: "POST" }),
  resumeRun: (id: string) => request(`/api/runs/${id}/resume`, { method: "POST" }),
  saveSupervisionDetail: (detail: SupervisionDetail) => request<SupervisionDocument>(`/api/supervision/details/${detail.id}`, { method: "PUT", body: JSON.stringify(detail) }),
  reviewSupervisionDetail: (id: string, verdict: "accepted" | "needs_revision", note: string) => request<SupervisionDocument>(`/api/supervision/details/${id}/review`, { method: "POST", body: JSON.stringify({ verdict, note }) }),
  capabilities: () => request<{ capabilities: Capability[]; contracts: PermissionContract[] }>("/api/capabilities"),
  createPermissionContract: (capabilityId: string, detailId: string) => request<PermissionContract>("/api/permission-contracts", { method: "POST", body: JSON.stringify({ capability_id: capabilityId, detail_id: detailId }) }),
  reviewPermissionContract: (id: string, verdict: "approved" | "revoked") => request<PermissionContract>(`/api/permission-contracts/${id}/review`, { method: "POST", body: JSON.stringify({ verdict }) })
};
