import type { EngineeringRun, EngineeringView } from "@epm/domain";

export type ResultMaterialStatus = "verified" | "missing" | "changed" | "unrecorded" | "unreadable";
export interface EngineeringRunResult {
  schema_version: 1; kind: "engineering-run-result";
  workspace_id: string; node_id: string; run_id: string; observed_at: string;
  contract_key: string; node_revision: number; run_status: EngineeringRun["status"];
  started_at: string; finished_at: string | null; current_contract: boolean;
  review: { reviewed_at: string | null; review_note: string } | null;
  artifacts: Array<{ evidence_id: string; path: string | null; recorded_sha256: string | null; actual_sha256: string | null; status: ResultMaterialStatus }>;
  source_checks: Array<{ id: string; title: string; status: string; exit_code: number | null; material_status?: string }>;
  metrics: EngineeringRun["metrics"] | null;
  issues: Array<{ code: string; message: string; evidence_id?: string; check_id?: string; path?: string }>;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
export const materialLabels: Record<ResultMaterialStatus, string> = {
  verified: "与记录一致", missing: "文件缺失", changed: "内容已变化", unrecorded: "缺少记录校验值", unreadable: "无法读取"
};

/** Validate only the v1 fields consumed here; additional backend fields remain compatible. */
export function parseEngineeringRunResult(value: unknown): EngineeringRunResult {
  if (!object(value) || value.schema_version !== 1 || value.kind !== "engineering-run-result"
    || !["workspace_id", "node_id", "run_id", "observed_at", "contract_key", "started_at"].every(key => typeof value[key] === "string")
    || !Number.isInteger(value.node_revision) || typeof value.current_contract !== "boolean" || !nullableText(value.finished_at)
    || !["queued", "running", "review", "accepted", "blocked", "paused", "rejected", "stale"].includes(String(value.run_status))
    || !(value.review === null || object(value.review) && nullableText(value.review.reviewed_at) && typeof value.review.review_note === "string")
    || !Array.isArray(value.artifacts) || !value.artifacts.every(item => object(item) && typeof item.evidence_id === "string"
      && nullableText(item.path) && nullableText(item.recorded_sha256) && nullableText(item.actual_sha256) && Object.hasOwn(materialLabels, String(item.status)))
    || !Array.isArray(value.source_checks) || !value.source_checks.every(item => object(item) && typeof item.id === "string" && typeof item.title === "string"
      && typeof item.status === "string" && (item.exit_code === null || Number.isInteger(item.exit_code)) && (item.material_status === undefined || typeof item.material_status === "string"))
    || !(value.metrics === null || object(value.metrics) && object(value.metrics.token_usage) && typeof value.metrics.token_usage.total_tokens === "number")
    || !Array.isArray(value.issues) || !value.issues.every(item => object(item) && typeof item.code === "string" && typeof item.message === "string"
      && ["evidence_id", "check_id", "path"].every(key => item[key] === undefined || typeof item[key] === "string"))) {
    throw new Error("结果记录格式不符合接口约定，请刷新后核对。");
  }
  return value as unknown as EngineeringRunResult;
}

/** Display helpers only. The EngineeringRun remains the authoritative record. */
export function nodeResultRuns(view: EngineeringView, nodeId: string) {
  const runs = view.document.runs.filter(run => run.node_id === nodeId);
  const current = runs.find(run => run.id === view.derived[nodeId]?.latest_run_id && run.status !== "stale");
  return { current, history: runs.filter(run => run.id !== current?.id).slice().reverse() };
}

export function hasRecordedReview(run?: Pick<EngineeringRun, "reviewed_at">): boolean {
  return !!run?.reviewed_at && Number.isFinite(Date.parse(run.reviewed_at));
}

/** Include the document version: a response for the previous contract cannot flash after a render. */
export function nodeResultSelectionKey(workspaceId: string, nodeId: string, runId: string, revision: number, refresh: number) {
  return JSON.stringify([workspaceId, nodeId, runId, revision, refresh]);
}

export function isResultArtifactPath(path: unknown): path is string {
  return typeof path === "string" && !!path && !/^[\\/]|[\u0000-\u001f:\\]/.test(path)
    && !path.split("/").some(part => part === ".." || part === "." || part === "");
}

export function nodeResultSummary(result: EngineeringRunResult, selectedCurrent: boolean) {
  const current = selectedCurrent && result.current_contract;
  const reviewed = result.run_status === "accepted" && hasRecordedReview(result.review ?? undefined);
  const inProgress = ["queued", "running"].includes(result.run_status);
  const pendingIssue = (issue: EngineeringRunResult["issues"][number]) => inProgress && (
    issue.code === "artifacts_not_recorded" && !result.artifacts.length
    || issue.code === "source_unrecorded" && result.source_checks.every(check => check.status === "not_run")
    || issue.code === "source_check_not_passed" && result.source_checks.some(check => check.id === issue.check_id && check.status === "not_run" && check.exit_code === null)
      && !result.source_checks.some(check => check.id === issue.check_id && check.status !== "not_run"));
  const describeIssue = (issue: EngineeringRunResult["issues"][number]) => [issue.path || issue.check_id || issue.evidence_id, issue.message].filter(Boolean).join("：");
  const notices = result.issues.filter(pendingIssue).map(describeIssue);
  const issues = result.issues.filter(issue => issue.code !== "historical_run" && !pendingIssue(issue)).map(describeIssue);
  for (const item of result.artifacts) {
    if (item.status !== "verified") issues.push(`${item.path || item.evidence_id}：${materialLabels[item.status]}`);
    else if (!item.recorded_sha256 || !item.actual_sha256 || item.recorded_sha256.toLowerCase() !== item.actual_sha256.toLowerCase()) issues.push(`${item.path || item.evidence_id}：校验依据不完整或不一致`);
    if (item.path !== null && !isResultArtifactPath(item.path)) issues.push(`${item.evidence_id}：成果路径不可用`);
  }
  for (const check of result.source_checks) {
    if (inProgress && check.status === "not_run" && check.exit_code === null && (!check.material_status || check.material_status === "unrecorded")) { notices.push(`${check.title || check.id}：尚未执行检查`); continue; }
    if (check.status !== "passed" || check.exit_code !== 0) issues.push(`${check.title || check.id}：原检查未通过（退出码 ${check.exit_code ?? "缺测"}）`);
    if (check.material_status !== "verified") issues.push(`${check.title || check.id}：当前材料${materialLabels[check.material_status as ResultMaterialStatus] || "尚未核实"}`);
  }
  if (result.run_status === "accepted" && !reviewed) issues.push("缺少有效的人工复核时间，验收记录待核对。");
  const needsAttention = issues.length > 0 || ["blocked", "paused", "rejected"].includes(result.run_status);
  const label = needsAttention ? "需要处理" : reviewed ? "已验收" : result.run_status === "review" ? "待查收"
    : result.run_status === "running" ? "进行中" : result.run_status === "queued" ? "等待执行" : "历史记录";
  const output = result.artifacts.length ? `${result.artifacts.length} 份成果记录` : result.source_checks.length ? `${result.source_checks.length} 项源码检查记录` : "本次运行记录";
  const summary = needsAttention ? reviewed ? "原人工验收记录已保留，当前材料需要处理。" : "本次结果有待处理的问题，请核对下列记录。"
    : reviewed ? `已人工验收，${output}可查阅。` : result.run_status === "review" ? `已提交${output}，等待人工查收。`
      : result.run_status === "running" ? `正在执行，已记录${output}。` : result.run_status === "queued" ? "运行已登记，正在等待领取或执行条件。" : "该次历史运行保留供查阅。";
  return { current, reviewed, label, summary, issues: [...new Set(issues)], notices: [...new Set(notices)], tone: needsAttention ? "attention" : reviewed ? "accepted" : result.run_status };
}
