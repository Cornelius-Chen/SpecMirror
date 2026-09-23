import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentEngineeringRun, engineeringContractKey, engineeringPathViolation, EngineeringRunMetricsSchema,
  type EngineeringDocument, type EngineeringRun, type EngineeringSourceBaseline, type EngineeringSourceProof,
  type FrozenEngineeringSourceScope } from "@epm/domain";
import { ENGINEERING_SOURCE_LIMITS, freezeEngineeringSourceScope } from "./engineering-source-proof.ts";

export type MaterialStatus = "verified" | "missing" | "changed" | "unrecorded" | "unreadable";
export interface RunResultArtifact {
  evidence_id: string; path: string | null; recorded_sha256: string | null; actual_sha256: string | null; status: MaterialStatus;
}
export interface RunResultIssue { code: string; message: string; evidence_id?: string; check_id?: string; path?: string }
export interface RunResultSourceCheck {
  id: string; title: string; status: "passed" | "failed" | "timeout" | "output_limit" | "spawn_error" | "not_run" | "cancelled";
  exit_code: number | null; scope_index: number; verified_at: string | null; command_sha256: string | null;
  baseline_manifest_sha256: string | null; final_manifest_sha256: string | null; actual_manifest_sha256: string | null;
  material_status: MaterialStatus;
}
export interface EngineeringRunResult {
  schema_version: 1; kind: "engineering-run-result"; workspace_id: string; node_id: string; run_id: string; observed_at: string;
  contract_key: string; node_revision: number; run_status: EngineeringRun["status"]; started_at: string; finished_at: string | null;
  current_contract: boolean; review: { reviewed_at: string; review_note: string } | null;
  artifacts: RunResultArtifact[]; source_checks: RunResultSourceCheck[]; metrics: EngineeringRun["metrics"] | null; issues: RunResultIssue[];
}

export class EngineeringRunResultError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value : null;
const cleanNamespace = (path: string) => path.startsWith("\\\\?\\UNC\\") ? "\\\\" + path.slice(8) : path.startsWith("\\\\?\\") ? path.slice(4) : path;
const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const within = (root: string, target: string) => {
  const path = relative(comparable(root), comparable(target));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
};
function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !/[:\x00-\x1f]/.test(path)
    && !path.replaceAll("\\", "/").split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.startsWith(".private") || /^\.env(?:\.|$)/i.test(part));
}
function redactSecrets(value: string): string {
  let text = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:token|secret|password|credential|api[_-]?key)/i.test(name) && secret && secret.length >= 6) text = text.replaceAll(secret, "[已脱敏]");
  }
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已脱敏]")
    .replace(/((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[已脱敏]")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[已脱敏]");
}
// Free text has no path boundary grammar (a path may contain spaces or touch Chinese text).
const publicText = (value: string) => /(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value) ? "[包含路径的文本已隐藏]" : redactSecrets(value);
const publicPath = (path: unknown) => safePath(path) && redactSecrets(path) === path ? path.replaceAll("\\", "/") : null;
function failure(status: MaterialStatus): never { throw { materialStatus: status }; }
function errorStatus(error: unknown): MaterialStatus {
  if (error && typeof error === "object") {
    if ("materialStatus" in error) return (error as { materialStatus: MaterialStatus }).materialStatus;
    if ("code" in error && error.code === "ENOENT") return "missing";
  }
  return "unreadable";
}
/** Adapted from engineering-service path constraints, without ensureOutputDirectory/mkdir. */
function checkedPath(root: string, path: string): string {
  if (!safePath(path) || !isAbsolute(root)) failure("unreadable");
  const base = cleanNamespace(realpathSync.native(root));
  let target = root;
  for (const part of path.replaceAll("\\", "/").split("/")) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink()) failure("unreadable");
    if (!within(base, cleanNamespace(realpathSync.native(target)))) failure("unreadable");
  }
  return target;
}
type Budget = { bytes: number; files: number; entries: number };
const budget = (): Budget => ({ bytes: 0, files: 0, entries: 0 });
/** Bounded reads reuse source-proof's single-handle and before/after identity checks. No commands run. */
function fileHash(root: string, path: string, limits: Budget): { sha256: string; bytes: number } {
  const full = checkedPath(root, path), initial = lstatSync(full);
  if (!initial.isFile() || initial.nlink !== 1 || ++limits.files > ENGINEERING_SOURCE_LIMITS.files) failure("unreadable");
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.ino !== initial.ino || before.dev !== initial.dev) failure("unreadable");
    limits.bytes += before.size;
    if (limits.bytes > ENGINEERING_SOURCE_LIMITS.bytes) failure("unreadable");
    const content = Buffer.alloc(Math.min(65536, Math.max(1, before.size))), sha = createHash("sha256");
    let count = 0;
    while (count < before.size) {
      const size = readSync(fd, content, 0, Math.min(content.length, before.size - count), null);
      if (size === 0) break;
      count += size; sha.update(content.subarray(0, size));
    }
    const extra = readSync(fd, content, 0, 1, null), after = fstatSync(fd), final = lstatSync(checkedPath(root, path));
    if (count !== before.size || extra || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || final.ino !== before.ino || final.dev !== before.dev || final.size !== before.size || final.mtimeMs !== before.mtimeMs || final.ctimeMs !== before.ctimeMs) failure("changed");
    return { sha256: sha.digest("hex"), bytes: count };
  } finally { closeSync(fd); }
}
function artifactRoot(root: string, run: EngineeringRun): string {
  if (!/^engineering-run-[a-f0-9-]+$/.test(run.id)) failure("unreadable");
  const expected = resolve(root, ".project", "engineering", "recursive", "outputs", run.id);
  if (comparable(resolve(run.output_dir)) !== comparable(expected)) failure("unreadable");
  // Check every component from the trusted workspace, including a missing run directory.
  return checkedPath(root, relative(root, expected));
}

const MATERIAL_MESSAGES: Record<MaterialStatus, string> = {
  verified: "材料与记录摘要一致。", missing: "记录中的材料已缺失。", changed: "材料已变化，与原记录不一致。",
  unrecorded: "没有可核对的原始摘要或版本依据。", unreadable: "材料无法安全读取或超过读取上限。"
};
function sourceMaterials(scope: FrozenEngineeringSourceScope | undefined, baseline: EngineeringSourceBaseline | undefined,
  proof: EngineeringSourceProof | undefined, issues: RunResultIssue[], limits: Budget, approvedRoots: readonly string[], checksMatch: boolean): { status: MaterialStatus; actual: string | null } {
  if (!scope || !baseline || !proof || !digest(proof.final_manifest_sha256)) return { status: "unrecorded", actual: null };
  try {
    // The stored scope is evidence, not authority. Reject an unrelated root before even statting it.
    if (!isAbsolute(scope.root) || !approvedRoots.some(root => isAbsolute(root)
      && within(resolve(cleanNamespace(root)), resolve(cleanNamespace(scope.root))))) failure("unreadable");
    const validated = freezeEngineeringSourceScope(scope, approvedRoots);
    if (!checksMatch) failure("unrecorded");
    if (scope.contract_sha256 !== baseline.scope.contract_sha256 || scope.contract_sha256 !== proof.contract_sha256
      || validated.contract_sha256 !== scope.contract_sha256
      || comparable(resolve(scope.root)) !== comparable(resolve(baseline.scope.root))
      || baseline.manifest_sha256 !== proof.baseline_manifest_sha256 || hash(JSON.stringify(baseline.manifest)) !== baseline.manifest_sha256
      || comparable(resolve(scope.root)) !== comparable(resolve(proof.root))) failure("unrecorded");
    const expected = new Map(baseline.manifest.map(item => [item.path, item.sha256]));
    for (const change of proof.changes) {
      if (!safePath(change.path) || (expected.get(change.path) ?? null) !== change.before_sha256) failure("unrecorded");
      if (change.after_sha256 === null) expected.delete(change.path); else expected.set(change.path, change.after_sha256);
    }
    // Frozen exclusions preserve the original inventory policy; no git or acceptance commands are executed.
    const generated = new Set([".git", "node_modules", ".runtime", "dist", "artifacts", "coverage", ".next", ".cache", "test-results", "playwright-report"]);
    const exclusions = proof.exclusions.map(item => item.path.replaceAll("\\", "/"));
    const excluded = (path: string) => path.split("/").some(part => generated.has(part))
      || path === ".project/engineering" || path.startsWith(".project/engineering/") || path === ".project/task-workspaces" || path.startsWith(".project/task-workspaces/")
      || exclusions.some(item => item.endsWith("/") ? path === item.slice(0, -1) || path.startsWith(item) : path === item);
    if (baseline.manifest.some(item => !safePath(item.path)) || [...expected.keys()].some(excluded)) failure("unrecorded");
    if (lstatSync(scope.root).isSymbolicLink()) failure("unreadable");
    const actual: Array<{path: string; sha256: string; bytes: number}> = [];
    const walk = (prefix: string) => {
      const directory = prefix ? checkedPath(scope.root, prefix) : scope.root;
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (++limits.entries > ENGINEERING_SOURCE_LIMITS.entries) failure("unreadable");
        const path = prefix ? prefix + "/" + item.name : item.name;
        if (excluded(path)) continue;
        if (item.isDirectory()) walk(path);
        else actual.push({ path, ...fileHash(scope.root, path, limits) });
      }
    };
    walk(""); actual.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const actualHash = hash(JSON.stringify(actual));
    const actualFiles = new Map(actual.map(item => [item.path, item.sha256]));
    let missing = false;
    for (const [path, saved] of expected) if (actualFiles.get(path) !== saved) {
      const status = actualFiles.has(path) ? "changed" : "missing"; missing ||= status === "missing";
      issues.push({ code: "source_" + status, message: MATERIAL_MESSAGES[status], ...(publicPath(path) ? { path: publicPath(path)! } : {}) });
    }
    const unknown = [...actualFiles.keys()].filter(path => !expected.has(path));
    for (const path of unknown) issues.push({ code: "source_inventory_unrecorded", message: "发现原清单之外的文件；未重新执行清单命令，无法确认它是否属于排除项。", ...(publicPath(path) ? {path: publicPath(path)!} : {}) });
    const recordedChanged = [...expected].some(([path, saved]) => actualFiles.has(path) && actualFiles.get(path) !== saved);
    const status = actualHash === proof.final_manifest_sha256 && actual.length === expected.size
      && actual.every(item => expected.get(item.path) === item.sha256) ? "verified" : missing ? "missing" : recordedChanged ? "changed" : unknown.length ? "unrecorded" : "changed";
    return { status, actual: actualHash };
  } catch (error) { return { status: errorStatus(error), actual: null }; }
}

export function buildEngineeringRunResult(input: { root: string; workspace_id: string; document: EngineeringDocument; run_id: string; approved_source_roots: readonly string[] }): EngineeringRunResult {
  const { document: doc } = input, run = doc.runs.find(item => item.id === input.run_id);
  if (!run || !doc.nodes.some(node => node.id === run.node_id)) throw new EngineeringRunResultError("engineering_run_not_found", 404, "没有找到该工作区的运行记录。");
  const issues: RunResultIssue[] = [], limits = budget();
  const current = currentEngineeringRun(doc, run.node_id)?.id === run.id && engineeringContractKey(doc, run.node_id) === run.snapshot.contract_key;
  if (!current) issues.push({ code: "historical_run", message: "这是历史运行，不能表示当前版本已经完成。" });
  const artifacts: RunResultArtifact[] = run.evidence.filter(item => item.kind === "artifact" || item.kind === "capability").map(evidence => {
    const path = publicPath(evidence.path), recorded = digest(evidence.sha256);
    let actual: string | null = null, status: MaterialStatus = "unreadable";
    try {
      if (!path || engineeringPathViolation(run.snapshot.effective, evidence.path!)) failure("unreadable");
      actual = fileHash(artifactRoot(input.root, run), path, limits).sha256;
      status = !recorded ? "unrecorded" : actual.toLowerCase() === recorded.toLowerCase() ? "verified" : "changed";
    } catch (error) { status = errorStatus(error); }
    if (!recorded && status !== "unrecorded") issues.push({ code: "artifact_unrecorded", message: MATERIAL_MESSAGES.unrecorded,
      evidence_id: publicText(evidence.id), ...(path ? {path} : {}) });
    if (status !== "verified") issues.push({ code: "artifact_" + status, message: MATERIAL_MESSAGES[status], evidence_id: publicText(evidence.id), ...(path ? {path} : {}) });
    return { evidence_id: publicText(evidence.id), path, recorded_sha256: recorded, actual_sha256: actual, status };
  });
  if (["review", "accepted", "rejected", "blocked", "stale"].includes(run.status)) {
    const promisedPaths = new Set([
      ...run.snapshot.node.actions.filter(action => action.type === "write_file" || action.type === "agent_artifact").map(action => action.path),
      ...run.snapshot.node.criteria.filter(criterion => criterion.kind !== "manual" && criterion.path).map(criterion => criterion.path)
    ]);
    for (const path of promisedPaths) if (!artifacts.some(artifact => artifact.path === publicPath(path))) {
      issues.push({ code: "artifacts_not_recorded", message: "本次运行声明应交付的材料缺少产物记录。", ...(publicPath(path) ? {path: publicPath(path)!} : {}) });
    }
    if (!artifacts.length && !promisedPaths.size && run.snapshot.node.actions.some(action => action.type === "use_capability")) {
      issues.push({ code: "artifacts_not_recorded", message: "本次运行声明的能力产出缺少材料记录。" });
    }
  }
  for (const evidence of run.evidence.filter(item => item.kind === "check" && item.passed !== true)) {
    issues.push({ code: "check_not_passed", message: "原运行中的材料检查尚未通过。", evidence_id: publicText(evidence.id) });
  }
  const groups: Array<{scope?: FrozenEngineeringSourceScope; baseline?: EngineeringSourceBaseline; proof?: EngineeringSourceProof}> = [];
  if (run.source_scope || run.source_baseline || run.source_proof) groups.push({scope: run.source_scope, baseline: run.source_baseline, proof: run.source_proof});
  const groupCount = Math.max(run.source_integration_scopes?.length ?? 0, run.source_integration_baselines?.length ?? 0, run.source_integration_proofs?.length ?? 0);
  for (let i = 0; i < groupCount; i++) groups.push({scope: run.source_integration_scopes?.[i], baseline: run.source_integration_baselines?.[i], proof: run.source_integration_proofs?.[i]});
  const source_checks: RunResultSourceCheck[] = groups.flatMap(({scope, baseline, proof}, scope_index) => {
    const frozenChecks = Array.isArray(scope?.checks) ? scope.checks : [];
    const savedChecks = Array.isArray(proof?.checks) ? proof.checks : [];
    const checkStatuses = ["passed", "failed", "timeout", "output_limit", "spawn_error", "not_run", "cancelled"];
    const matches = (saved: typeof savedChecks[number], check: typeof frozenChecks[number]) => saved.id === check.id && saved.program === check.program
      && digest(saved.command_sha256) === hash(JSON.stringify({ program: check.program, args: check.args }))
      && checkStatuses.includes(saved.status) && (saved.exit_code === null || Number.isInteger(saved.exit_code));
    const checksMatch = Boolean(proof && scope && baseline && proof.schema_version === 1 && proof.verification_mode === "post_execution"
      && !proof.source_changed_during_checks && savedChecks.length === frozenChecks.length && frozenChecks.length > 0
      && frozenChecks.every(check => savedChecks.filter(saved => saved?.id === check.id).length === 1 && savedChecks.some(saved => saved && matches(saved, check)))
      && proof.contract_sha256 === scope.contract_sha256 && proof.baseline_manifest_sha256 === baseline.manifest_sha256);
    if (proof && !checksMatch) issues.push({ code: "source_check_records_unrecorded", message: "保存的检查记录与冻结检查清单或版本依据不一致。" });
    const material = sourceMaterials(scope, baseline, proof, issues, limits, input.approved_source_roots, checksMatch);
    if (material.status !== "verified") issues.push({code: "source_" + material.status, message: "源码核对：" + MATERIAL_MESSAGES[material.status]});
    if (proof && !proof.passed) issues.push({ code: "source_proof_not_passed", message: "原运行的源码验证未通过。" });
    return frozenChecks.map(check => {
      const candidates = savedChecks.filter(saved => saved?.id === check.id);
      const recorded = checksMatch && candidates.length === 1 && matches(candidates[0], check) ? candidates[0] : undefined;
      if (proof && !recorded) issues.push({ code: "source_check_record_unrecorded", message: "这项冻结检查没有唯一且匹配的原始记录。", check_id: publicText(check.id) });
      if (!recorded || recorded.status !== "passed") issues.push({ code: "source_check_not_passed", message: "原运行的源文件检查尚未通过。", check_id: publicText(check.id) });
      return { id: publicText(check.id), title: publicText(recorded?.title ?? check.title), status: recorded?.status ?? "not_run", exit_code: recorded?.exit_code ?? null, scope_index,
        verified_at: proof?.verified_at ?? null, command_sha256: digest(recorded?.command_sha256), baseline_manifest_sha256: digest(proof?.baseline_manifest_sha256 ?? baseline?.manifest_sha256),
        final_manifest_sha256: digest(proof?.final_manifest_sha256), actual_manifest_sha256: material.actual, material_status: material.status };
    });
  });
  const metrics = run.metrics ? EngineeringRunMetricsSchema.safeParse(run.metrics) : null;
  if (metrics && !metrics.success) issues.push({code: "metrics_invalid", message: "保存的用量记录无法核对。"});
  if (run.status === "accepted" && !run.reviewed_at) issues.push({ code: "review_not_recorded", message: "该运行缺少已保存的人工查收记录。" });
  return { schema_version: 1, kind: "engineering-run-result", workspace_id: input.workspace_id, node_id: run.node_id, run_id: run.id,
    observed_at: new Date().toISOString(), contract_key: run.snapshot.contract_key, node_revision: run.snapshot.node.revision,
    run_status: run.status, started_at: run.started_at, finished_at: run.finished_at, current_contract: current,
    review: run.reviewed_at ? { reviewed_at: run.reviewed_at, review_note: publicText(run.review_note) } : null,
    artifacts, source_checks, metrics: metrics?.success ? metrics.data : null, issues };
}
