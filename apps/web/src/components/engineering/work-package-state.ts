import { engineeringContractKey, type EngineeringNode, type EngineeringView } from "@epm/domain";
import type { WorkPackagePreview, WorkPackageRequest } from "../../engineering-api.ts";

export interface WorkPackageOwner { id: string; label: string; available: boolean }
export interface WorkPackageDraft {
  composition: NonNullable<EngineeringNode["composition"]>;
  assignments: Record<string, string>;
  reason: string;
}

export function initialWorkPackageDraft(root: EngineeringNode): WorkPackageDraft {
  return { composition: structuredClone(root.composition ?? { summary: "", scenario: "", integration_criterion_ids: [] }), assignments: {}, reason: "" };
}

export function workPackageCandidates(view: EngineeringView, rootId: string) {
  return view.document.nodes.filter(node => node.parent_id === rootId && node.status !== "archived")
    .sort((a, b) => a.order - b.order).map(node => ({ node, unavailable:
      node.status !== "draft" ? "已进入执行流程" :
      view.document.nodes.some(child => child.parent_id === node.id && child.status !== "archived") ? "请在末级任务分配" :
      view.document.runs.some(run => run.node_id === node.id) ? "已有运行历史" :
      !node.source_scope ? "尚未设置源码范围与检查" : ""
    }));
}

/** This validates the form only. The server rechecks real owners, contracts and readiness. */
export function prepareWorkPackageRequest(view: EngineeringView, rootId: string, draft: WorkPackageDraft, owners: WorkPackageOwner[]): WorkPackageRequest {
  const root = view.document.nodes.find(node => node.id === rootId);
  if (!root || rootId !== view.document.root_id || root.status === "archived") throw new Error("请在当前工程总项确认本轮分工。");
  if (view.document.runs.some(run => run.node_id === rootId)) throw new Error("总项已有运行历史，请通过原有方案变更流程处理。");
  const composition = { summary: draft.composition.summary.trim(), scenario: draft.composition.scenario.trim(), integration_criterion_ids: [...new Set(draft.composition.integration_criterion_ids)] };
  if (!composition.summary || !composition.scenario || !composition.integration_criterion_ids.length) throw new Error("请说明这些成果如何配合、完整使用场景，并选择整体完成条件。");
  if (composition.integration_criterion_ids.some(id => !root.criteria.some(criterion => criterion.id === id))) throw new Error("整体完成条件已变化，请重新选择。");
  const entries = Object.entries(draft.assignments);
  if (!entries.length || entries.length > 20) throw new Error("请选择 1–20 个本轮要开工的任务。");
  const candidates = workPackageCandidates(view, rootId);
  const assignments = entries.map(([node_id, owner]) => {
    const candidate = candidates.find(item => item.node.id === node_id);
    if (!candidate || candidate.unavailable) throw new Error(`任务已不适用于本轮分工${candidate ? `：${candidate.node.title}（${candidate.unavailable}）` : "，请重新选择"}。`);
    if (!owners.some(item => item.id === owner && item.available && item.id.startsWith("codex:"))) throw new Error(`请为「${candidate.node.title}」选择近期已连接的真实负责人。`);
    return { node_id, owner };
  });
  if (!draft.reason.trim()) throw new Error("请简短说明本轮分工的目的。");
  return { root_id: rootId, expected_revision: view.document.revision, composition, assignments, reason: draft.reason.trim() };
}

export function workPackageRequestKey(request: WorkPackageRequest): string {
  return JSON.stringify([request.root_id, request.expected_revision, request.composition.summary,
    request.composition.scenario, [...request.composition.integration_criterion_ids].sort(),
    request.assignments.map(item => [item.node_id, item.owner]).sort(([a], [b]) => a.localeCompare(b)), request.reason]);
}

export function workPackagePreviewCurrent(preview: WorkPackagePreview, request: WorkPackageRequest, preparedWorkspace: string, currentWorkspace: string, now = Date.now()): boolean {
  const expires = Date.parse(preview.expires_at);
  if (!preview.token || !Number.isFinite(expires) || expires <= now || preparedWorkspace !== currentWorkspace ||
    preview.root_id !== request.root_id || preview.expected_revision !== request.expected_revision ||
    workPackageRequestKey(preview.request) !== workPackageRequestKey(request)) return false;
  return preview.nodes.length === request.assignments.length && new Set(preview.nodes.map(node => node.id)).size === preview.nodes.length &&
    request.assignments.every(item => preview.nodes.some(node => node.id === item.node_id && node.owner === item.owner));
}

/** Resolve an uncertain POST using the persisted exact package receipt. This
 * never authorizes a new operation or treats a claimed role as human proof. */
export function workPackageCommitReceipt(view: EngineeringView, preview: WorkPackagePreview): "ready" | "changed" | undefined {
  if (!preview.token || !/^[a-f0-9]{64}$/.test(preview.manifest_digest) || view.document.revision < preview.expected_revision + 1) return;
  const matches = (detail: string | undefined) => {
    if (!detail) return false;
    try {
      const data = JSON.parse(detail);
      return data?.work_package_id === preview.token && data?.manifest_digest === preview.manifest_digest &&
        data?.pre_revision === preview.expected_revision && data?.post_revision === preview.expected_revision + 1;
    } catch { return false; }
  };
  if (!view.document.events.some(event => event.node_id === preview.root_id && event.kind === "plan" && matches(event.detail))) return;
  const root = view.document.nodes.find(node => node.id === preview.root_id);
  const compositionMatches = !!root?.composition && workPackageRequestKey({ ...preview.request, composition: root.composition }) === workPackageRequestKey(preview.request);
  const membersUnchanged = preview.request.assignments.every(assignment => {
    const node = view.document.nodes.find(item => item.id === assignment.node_id);
    return node?.owner === assignment.owner && node.status === "ready" && !view.document.runs.some(run => run.node_id === node.id) &&
      view.document.events.some(event => event.node_id === node.id && event.kind === "plan" && matches(event.detail) && event.readiness_contract_key === engineeringContractKey(view.document, node.id));
  });
  return compositionMatches && membersUnchanged ? "ready" : "changed";
}
