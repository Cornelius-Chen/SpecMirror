import type { CodexCompanionStatus } from "./types.ts";
import type { EngineeringCapabilityCatalog, EngineeringChangePreview, EngineeringHandoffPacket, EngineeringNode, EngineeringView } from "@epm/domain";
import type { EngineeringFeedbackCreate, EngineeringFeedbackUpdate } from "../../../packages/domain/src/engineering-feedback.ts";
import { humanApprovalHeaders } from "./human-approval-client.ts";
import { parseEngineeringRunResult } from "./components/project-map/node-result-state.ts";

export class EngineeringApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = "EngineeringApiError"; }
}

export interface PlanImportPreview { token: string; parent_id: string; expected_revision: number; nodes: EngineeringNode[]; warnings: string[]; source: { title: string; reference: string }; invalidated_run_ids?: string[] }
export interface WorkPackageRequest {
  root_id: string; expected_revision: number;
  composition: NonNullable<EngineeringNode["composition"]>;
  assignments: Array<{ node_id: string; owner: string }>;
  reason: string;
}
export interface WorkPackagePreview {
  token: string; expected_revision: number; root_id: string; request: WorkPackageRequest;
  manifest_digest: string;
  nodes: Array<{ id: string; title: string; owner: string; source_scope: EngineeringNode["source_scope"] }>;
  affected_ids: string[]; expires_at: string;
}
export interface RecheckWorkPackageRequest {
  expected_revision: number; reason: string;
  items: Array<{ node_id: string; prior_run_id: string; checks: Array<{ id: string; args: string[] }> }>;
}
export interface RecheckWorkPackagePreview {
  token: string; request: RecheckWorkPackageRequest; workspace_id: string;
  root_id: string; expected_revision: number; manifest_digest: string; expires_at: string;
  nodes: Array<{ id: string; title: string; owner: string; prior_run_id: string;
    checks: Array<{ id: string; title: string; before_args: string[]; args: string[]; timeout_ms: number;
      configuration?: { test_root: string; path: string; sha256: string } }> }>;
  affected_ids: string[]; ready_node_ids: string[]; creates_runs: false;
}
export interface StructureProposalSummary {
  available: boolean; approval_configured: boolean; proposal_id?: string; title?: string; reason?: string; created_at?: string;
  expected_revision?: number; current_revision?: number; current?: boolean; node_count?: number;
}
export interface StructureProposalPreview {
  proposal_id: string; approval_configured: boolean; token: string; title: string; reason: string; created_at?: string;
  expected_revision: number; affected_ids: string[]; invalidated_run_ids: string[]; view: EngineeringView; node_count: number;
}

const errorLabels: Record<string, string> = {
  engineering_parent_running: "上级任务正在运行，请先暂停后再拆分。", engineering_node_running: "当前任务已有执行，请先查看或暂停该次运行。",
  engineering_run_already_active: "该任务已在执行或验收队列中，请查看已有运行。", engineering_archive_has_children: "请先处理活动子任务，再归档当前任务。",
  engineering_archive_has_dependents: "其他任务仍依赖此任务，请先调整依赖。", engineering_archive_running: "运行中的任务需要先暂停，才能归档。",
  engineering_no_changes: "方案内容没有实际变化，无需重复保存。", engineering_action_order: "请按冻结方案的顺序执行动作。",
  engineering_check_criterion_invalid: "请为核对动作选择有效的自动验收条件。", engineering_duplicate_output_path: "多个动作使用了同一交付路径，请为每项产出设置不同路径。",
  engineering_capability_not_bound: "请先在能力选用中选择对应能力，并说明用途。", engineering_review_note_required: "请填写本次验收的核对依据。",
  engineering_capability_use_required: "本次运行尚未实际应用该能力，暂时不能反馈。", engineering_feedback_note_required: "请填写能力应用的帮助或不足。",
  engineering_actions_incomplete: "还有计划中的动作尚未完成，请等待实际产出。", engineering_output_exists: "本次运行中已经存在同名产出，不能覆盖。"
};

export function createEngineeringApi(workspaceId?: string) {
const scopeHeaders: Record<string, string> = workspaceId ? { "x-mirror-workspace-id": workspaceId } : {};
const resultUrl = (runId: string) => `/api/engineering/runs/${encodeURIComponent(runId)}/result?${new URLSearchParams({ workspace: workspaceId ?? "host" })}`;
async function request<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const url = `/api/engineering${path}`;
  const requestMethod = body === undefined ? "GET" : method;
  const send = (approval: Record<string, string> = {}) => fetch(url, {
    headers: { ...scopeHeaders, ...approval, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) })
  });
  let response = await send();
  let payload = await response.json().catch(() => ({}));
  if (response.status === 403 && payload.code === "human_approval_required") {
    const approval = await humanApprovalHeaders({ method: requestMethod, url, workspace: workspaceId ?? "host", body: body ?? null });
    response = await send(approval);
    payload = await response.json().catch(() => ({}));
  }
  if (!response.ok) throw new EngineeringApiError(errorLabels[payload.error] || (payload.error === payload.code ? errorLabels[payload.code] : undefined) || payload.error || `请求未完成（${response.status}）`, response.status, payload.code);
  return payload as T;
}

return {
  workspaceId,
  resultUrl,
  result: async (runId: string, signal?: AbortSignal) => {
    const response = await fetch(resultUrl(runId), { method: "GET", cache: "no-store", signal, headers: { ...scopeHeaders, Accept: "application/json" } });
    if (!response.ok) throw new EngineeringApiError(response.status === 404 ? "这次运行记录不存在或不属于当前工作区。" : `暂时无法读取结果记录（${response.status}）。`, response.status);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new EngineeringApiError("结果记录不是有效的 JSON，请刷新后重试。", response.status); }
    const result = parseEngineeringRunResult(payload);
    if (result.workspace_id !== (workspaceId ?? "host") || result.run_id !== runId) throw new EngineeringApiError("结果记录与当前工作区或运行不匹配。", 409);
    return result;
  },
  view: () => request<EngineeringView>(""),
  structureProposal: () => request<StructureProposalSummary>("/structure-proposal"),
  previewStructure: (proposalId: string) => request<StructureProposalPreview>("/structure-proposal/preview", { proposal_id: proposalId }),
  commitStructure: (proposalId: string, token: string, revision: number) => request<EngineeringView>("/structure-proposal/commit", { proposal_id: proposalId, token, expected_revision: revision }),
  sessions: async () => { const response = await fetch(workspaceId ? `/api/task-workspaces/${encodeURIComponent(workspaceId)}/sessions` : "/api/codex-companion/status"); const payload = await response.json(); if (!response.ok) throw new EngineeringApiError(payload.error || "无法读取协作会话", response.status); return (payload as Pick<CodexCompanionStatus, "sessions">).sessions; },
  capabilities: () => request<EngineeringCapabilityCatalog>("/capabilities"),
  create: (parentId: string, title: string, kind: EngineeringNode["kind"], revision: number) => request<EngineeringView>("/nodes", { parent_id: parentId, title, kind, expected_revision: revision }),
  preview: (node: EngineeringNode, revision: number) => request<EngineeringChangePreview>(`/nodes/${encodeURIComponent(node.id)}/preview`, { node, expected_revision: revision }),
  save: (node: EngineeringNode, revision: number, reason: string) => request<EngineeringView>(`/nodes/${encodeURIComponent(node.id)}`, { node, expected_revision: revision, reason }, "PUT"),
  archive: (id: string, revision: number, reason: string) => request<EngineeringView>(`/nodes/${encodeURIComponent(id)}/archive`, { expected_revision: revision, reason }),
  ready: (id: string, revision: number) => request<EngineeringView>(`/nodes/${encodeURIComponent(id)}/ready`, { expected_revision: revision }),
  previewWorkPackage: (input: WorkPackageRequest) => request<WorkPackagePreview>("/work-package/preview", input),
  commitWorkPackage: (token: string, input: WorkPackageRequest) => request<EngineeringView>("/work-package/commit", { token, request: input }),
  previewRecheckWorkPackage: (input: RecheckWorkPackageRequest) => request<RecheckWorkPackagePreview>("/work-package/recheck/preview", input),
  commitRecheckWorkPackage: (token: string, input: RecheckWorkPackageRequest) => request<EngineeringView>("/work-package/recheck/commit", { token, request: input }),
  dispatch: (nodeIds: string[], mode: "controlled" | "external", revision: number) => request<EngineeringView>("/dispatch", { node_ids: nodeIds, mode, expected_revision: revision }),
  pause: (id: string, reason: string) => request<EngineeringView>(`/nodes/${encodeURIComponent(id)}/pause`, { reason }),
  handoff: (runId: string) => request<EngineeringHandoffPacket>(`/runs/${encodeURIComponent(runId)}/handoff`),
  previewImport: (parentId: string, revision: number, plan: unknown) => request<PlanImportPreview>("/plan-import/preview", { parent_id: parentId, expected_revision: revision, plan }),
  commitImport: (token: string, revision: number, reason: string) => request<EngineeringView>("/plan-import/commit", { token, expected_revision: revision, reason }),
  action: (runId: string, actionId: string) => request<EngineeringView>(`/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}`, {}),
  finish: (runId: string) => request<EngineeringView>(`/runs/${encodeURIComponent(runId)}/finish`, {}),
  review: (runId: string, verdict: "accepted" | "needs_revision", note: string, checks: Array<{ criterion_id: string; passed: boolean; note: string }>) => request<EngineeringView>(`/runs/${encodeURIComponent(runId)}/review`, { verdict, note, checks }),
  feedback: (runId: string, capabilityUseId: string, note: string) => request<EngineeringView>(`/runs/${encodeURIComponent(runId)}/feedback`, { capability_use_id: capabilityUseId, note }),
  createFeedback: (input: EngineeringFeedbackCreate) => request<EngineeringView>("/feedback-items", input),
  updateFeedback: (id: string, input: EngineeringFeedbackUpdate) => request<EngineeringView>(`/feedback-items/${encodeURIComponent(id)}/update`, input),
  artifact: (runId: string, path: string) => `/api/engineering/runs/${encodeURIComponent(runId)}/artifact?${new URLSearchParams({ path, ...(workspaceId ? { workspace: workspaceId } : {}) })}`
};
}

export type EngineeringApi = ReturnType<typeof createEngineeringApi>;
// The compatibility client is immutable and refers only to the original host.
export const engineeringApi = createEngineeringApi();
