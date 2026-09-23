import { currentEngineeringRun, effectiveEngineeringAgentOwner, type EngineeringView } from "@epm/domain";
import type { RecheckWorkPackagePreview, RecheckWorkPackageRequest } from "../../engineering-api.ts";

export interface RecheckWorkPackageDraft {
  selected: string[];
  configPaths: Record<string, Record<string, string>>;
  reason: string;
}

/** Only the value after a single --config can be edited. All other arguments stay frozen. */
export function recheckConfigIndex(args: string[]): number {
  const flag = args.indexOf("--config");
  return flag >= 0 && args.lastIndexOf("--config") === flag && flag + 1 < args.length && !args[flag + 1].startsWith("-") ? flag + 1 : -1;
}

export function recheckWorkPackageCandidates(view: EngineeringView) {
  return view.document.nodes.filter(node => node.status !== "archived").flatMap(node => {
    const run = currentEngineeringRun(view.document, node.id);
    if (!run || !["paused", "blocked"].includes(run.status)) return [];
    const owner = effectiveEngineeringAgentOwner(view.document, node.id);
    const unavailable = view.document.nodes.some(child => child.parent_id === node.id && child.status !== "archived") ? "请在末级任务复验" :
      run.mode !== "external" ? "只支持原负责人执行的任务" :
      !owner || owner !== run.handoff?.owner ? "原运行与当前负责人不一致" :
      !node.source_scope?.checks.some(check => recheckConfigIndex(check.args) >= 0) ? "没有可修改的检查配置路径" : "";
    return [{ node, run, unavailable }];
  }).sort((a, b) => a.node.order - b.node.order);
}

export function initialRecheckWorkPackageDraft(view: EngineeringView): RecheckWorkPackageDraft {
  return { selected: [], reason: "", configPaths: Object.fromEntries(recheckWorkPackageCandidates(view).map(({ node }) => [node.id,
    Object.fromEntries((node.source_scope?.checks ?? []).flatMap(check => {
      const index = recheckConfigIndex(check.args);
      return index < 0 ? [] : [[check.id, check.args[index]]];
    }))])) };
}

export function prepareRecheckWorkPackageRequest(view: EngineeringView, draft: RecheckWorkPackageDraft): RecheckWorkPackageRequest {
  if (!draft.selected.length || draft.selected.length > 20 || new Set(draft.selected).size !== draft.selected.length) throw new Error("请选择 1–20 个要复验的任务。");
  if (!draft.reason.trim()) throw new Error("请简短说明为什么修正检查配置。");
  const candidates = recheckWorkPackageCandidates(view);
  const items = draft.selected.map(node_id => {
    const candidate = candidates.find(item => item.node.id === node_id);
    if (!candidate || candidate.unavailable) throw new Error(candidate?.unavailable || "任务或原运行已变化，请重新选择。");
    let changed = false;
    const checks = candidate.node.source_scope!.checks.map(check => {
      const args = [...check.args], index = recheckConfigIndex(args);
      if (index >= 0) {
        const path = draft.configPaths[node_id]?.[check.id];
        if (typeof path !== "string" || !path.trim() || path.length > 16_000 || /[\x00-\x1f]/.test(path) || path.trim().startsWith("-")) throw new Error(`请填写「${check.title}」的配置文件路径。`);
        // A friendly lexical check only; the server resolves the real path and
        // enforces the fixed test root, regular file and reviewed content hash.
        if (path.trim().split(/[\\/]/).at(-1) !== check.args[index].split(/[\\/]/).at(-1)) throw new Error(`「${check.title}」只能修正同名配置文件的路径，不能更换配置文件名。`);
        args[index] = path.trim(); changed ||= args[index] !== check.args[index];
      }
      return { id: check.id, args };
    });
    if (!changed) throw new Error(`「${candidate.node.title}」的配置路径尚未修改。`);
    return { node_id, prior_run_id: candidate.run.id, checks };
  });
  return { expected_revision: view.document.revision, reason: draft.reason.trim(), items };
}

export function recheckWorkPackageRequestKey(request: RecheckWorkPackageRequest): string {
  return JSON.stringify([request.expected_revision, request.reason, request.items.map(item => [item.node_id, item.prior_run_id,
    item.checks.map(check => [check.id, check.args])])]);
}

export function recheckWorkPackageContext(view: EngineeringView, workspace: string): string {
  return JSON.stringify([workspace, view.document.id, view.document.revision,
    recheckWorkPackageCandidates(view).map(({ node, run, unavailable }) => [node.id, node.revision, node.owner, node.status,
      node.source_scope, run.id, run.status, run.snapshot.contract_key, run.handoff?.owner, unavailable])]);
}

/** Display binding only. The server still authenticates the human and rechecks its full manifest. */
export function recheckWorkPackagePreviewCurrent(preview: RecheckWorkPackagePreview, request: RecheckWorkPackageRequest,
  view: EngineeringView, preparedWorkspace: string, currentWorkspace: string, now = Date.now()): boolean {
  try {
    const expires = Date.parse(preview.expires_at);
    if (!preview.token || !/^[a-f0-9]{64}$/.test(preview.manifest_digest) || preview.creates_runs !== false ||
      !Number.isFinite(expires) || expires <= now || preparedWorkspace !== currentWorkspace ||
      preview.workspace_id !== currentWorkspace || preview.root_id !== view.document.root_id ||
      preview.expected_revision !== request.expected_revision || view.document.revision !== request.expected_revision ||
      recheckWorkPackageRequestKey(preview.request) !== recheckWorkPackageRequestKey(request) ||
      preview.nodes.length !== request.items.length || new Set(preview.nodes.map(node => node.id)).size !== preview.nodes.length ||
      preview.ready_node_ids.length !== request.items.length || new Set(preview.ready_node_ids).size !== request.items.length ||
      !request.items.every(item => preview.ready_node_ids.includes(item.node_id))) return false;
    const candidates = recheckWorkPackageCandidates(view);
    return request.items.every(item => {
      const candidate = candidates.find(entry => entry.node.id === item.node_id), node = preview.nodes.find(entry => entry.id === item.node_id);
      if (!candidate || candidate.unavailable || !node || node.prior_run_id !== item.prior_run_id || candidate.run.id !== item.prior_run_id ||
        node.title !== candidate.node.title || node.owner !== candidate.run.handoff?.owner || !preview.affected_ids.includes(node.id) ||
        node.checks.length !== item.checks.length || new Set(node.checks.map(check => check.id)).size !== node.checks.length) return false;
      return item.checks.every(check => {
        const shown = node.checks.find(entry => entry.id === check.id), original = candidate.node.source_scope?.checks.find(entry => entry.id === check.id);
        if (!shown || !original) return false;
        if (JSON.stringify(check.args) !== JSON.stringify(original.args)) {
          const config = shown.configuration;
          if (!config || typeof config.test_root !== "string" || !config.test_root.trim() || typeof config.path !== "string" || !config.path.trim()
            || typeof config.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(config.sha256)) return false;
        }
        return shown.title === original.title && JSON.stringify(shown.args) === JSON.stringify(check.args) &&
          JSON.stringify(shown.before_args) === JSON.stringify(original.args) && (shown.timeout_ms ?? 30_000) === (original.timeout_ms ?? 30_000);
      });
    });
  } catch { return false; }
}
