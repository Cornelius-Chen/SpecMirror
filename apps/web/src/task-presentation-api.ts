import { fetchWithHumanApproval } from "./human-approval-client.ts";

/** Reading organization is separate from the frozen engineering contract. */
export interface TaskPresentationView {
  schema_version: 1;
  revision: number;
  collections: Array<{ id: string; title: string }>;
  task_collection_ids: Record<string, string[]>;
  workspace_id: string | null;
  workspace: { current_phase_id: string | null; node_labels: Record<string, string[]>; node_names?: Record<string, string> };
}

export type TaskPresentationOperation =
  | { type: "create_collection"; title: string }
  | { type: "rename_collection"; id: string; title: string }
  | { type: "delete_collection"; id: string }
  | { type: "set_task_collections"; task_id: string; collection_ids: string[] }
  | { type: "set_current_phase"; phase_id: string | null }
  | { type: "set_node_labels"; node_id: string; labels: string[] }
  | { type: "set_node_names"; names: Record<string, string | null> };

export class TaskPresentationApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = "TaskPresentationApiError"; }
}

const listeners = new Set<(view: TaskPresentationView) => void>();
/** Keep classification and step labels in the same tab aware of one another's revision. */
export function subscribeTaskPresentation(listener: (view: TaskPresentationView) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function createTaskPresentationApi(workspaceId?: string) {
  const url = `/api/task-presentation${workspaceId ? `?${new URLSearchParams({ workspace: workspaceId })}` : ""}`;
  async function request(body?: { expected_revision: number; operation: TaskPresentationOperation }): Promise<TaskPresentationView> {
    const init: RequestInit = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    const response = body
      ? await fetchWithHumanApproval(url, init, { method: "POST", url, workspace: "host", body })
      : await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new TaskPresentationApiError(payload.error || "分类信息暂时无法读取，请稍后重试。", response.status, payload.code);
    const view = payload as TaskPresentationView;
    if (body) for (const listener of listeners) listener(view);
    return view;
  }
  return { load: () => request(), mutate: (expected_revision: number, operation: TaskPresentationOperation) => request({ expected_revision, operation }) };
}
