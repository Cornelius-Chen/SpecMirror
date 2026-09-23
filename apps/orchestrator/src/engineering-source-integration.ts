import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { currentEngineeringRun, type EngineeringDocument, type EngineeringRun, type FrozenEngineeringSourceScope } from "@epm/domain";
import { EngineeringSourceProofError, freezeEngineeringSourceScope } from "./engineering-source-proof.ts";

export interface EngineeringSourceIntegrationPlan {
  scopes: FrozenEngineeringSourceScope[];
  latest: Array<{ scope: FrozenEngineeringSourceScope; final_manifest_sha256: string; run_id: string; verified_at: string }>;
}
const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function covers(root: string, path: string) { const part = relative(key(root), key(path)); return part === "" || (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part)); }
const overlap = (left: string, right: string) => covers(left, right) || covers(right, left);
function fail(code: string, message: string): never { throw new EngineeringSourceProofError(code, message); }

/** Selects current accepted provenance. The caller must lock all roots and execute these checks. */
export function planEngineeringSourceIntegration(doc: EngineeringDocument, run: EngineeringRun, approvedRoots: readonly string[]): EngineeringSourceIntegrationPlan {
  const accepted: Array<{ run: EngineeringRun; scope: FrozenEngineeringSourceScope; order: number }> = [], seen = new Set<string>(), visiting = new Set<string>();
  const visit = (reference: EngineeringRun["snapshot"]["children"][number]) => {
    const source = doc.runs.find(item => item.id === reference.run_id);
    if (!source || source.node_id !== reference.node_id || source.status !== "accepted" || source.snapshot.contract_key !== reference.contract_key || currentEngineeringRun(doc, reference.node_id)?.id !== source.id) fail("source_integration_reference_stale", "整合引用的子项或依赖验收版本已失效，不能复用旧源文件检查。");
    if (visiting.has(source.id)) fail("source_integration_reference_cycle", "源文件验收引用形成循环，无法确定检查来源。");
    if (seen.has(source.id)) return;
    visiting.add(source.id);
    for (const nested of [...source.snapshot.children, ...source.snapshot.dependencies]) visit(nested);
    if (source.source_scope) {
      const scope = freezeEngineeringSourceScope(source.source_scope, approvedRoots), proof = source.source_proof;
      if (scope.contract_sha256 !== source.source_scope.contract_sha256 || !source.source_baseline || source.source_baseline.scope.contract_sha256 !== scope.contract_sha256 || !proof?.passed || proof.status !== "passed" || proof.contract_sha256 !== scope.contract_sha256 || !proof.final_manifest_sha256 || !/^[a-f0-9]{64}$/.test(proof.final_manifest_sha256) || !Number.isFinite(Date.parse(proof.verified_at))) fail("source_integration_proof_missing", "已验收源文件步骤缺少对应冻结合同的真实通过证据。");
      if (proof.checks.length !== scope.checks.length || scope.checks.some(check => !proof.checks.some(result => result.id === check.id && result.status === "passed" && result.exit_code === 0 && result.command_sha256 === digest({ program: check.program, args: check.args })))) fail("source_integration_proof_missing", "已验收源文件步骤的实际检查与冻结命令不一致。");
      accepted.push({ run: source, scope, order: doc.runs.indexOf(source) });
    }
    visiting.delete(source.id); seen.add(source.id);
  };
  for (const reference of [...run.snapshot.dependencies, ...run.snapshot.children]) visit(reference);
  if (!accepted.length) return { scopes: [], latest: [] };

  const checksByRoot = new Map<string, { root: string; checks: Map<string, FrozenEngineeringSourceScope["checks"][number]> }>();
  for (const source of accepted) {
    const entry = checksByRoot.get(key(source.scope.root)) ?? { root: source.scope.root, checks: new Map() };
    for (const check of source.scope.checks) {
      const identity = digest({ program: check.program, args: check.args }), current = entry.checks.get(identity);
      // A shared command uses the strictest already approved time budget.
      if (!current) entry.checks.set(identity, { ...check, id: "integrated-" + identity.slice(0, 20), title: ("整合复验：" + check.title).slice(0, 200), args: [...check.args] });
      else current.timeout_ms = Math.min(current.timeout_ms ?? 30000, check.timeout_ms ?? 30000);
    }
    if (entry.checks.size > 12) fail("source_integration_check_limit", "同一源目录的最终整合检查超过 12 条，请在计划中提供明确且覆盖子项的统一回归命令。");
    checksByRoot.set(key(source.scope.root), entry);
  }
  const scopes = [...checksByRoot.values()].sort((left, right) => key(left.root).localeCompare(key(right.root))).map(entry => freezeEngineeringSourceScope({ root: entry.root, allow: ["**"], deny: [], checks: [...entry.checks.values()] }, approvedRoots));

  const groups: typeof accepted[] = [];
  for (const source of accepted) {
    const matching = groups.filter(group => group.some(item => overlap(item.scope.root, source.scope.root)));
    if (!matching.length) groups.push([source]);
    else { const target = matching[0]; target.push(source); for (const other of matching.slice(1)) { target.push(...other); groups.splice(groups.indexOf(other), 1); } }
  }
  const latest = groups.map(group => {
    const selected = [...group].sort((left, right) => Date.parse(right.run.source_proof!.verified_at) - Date.parse(left.run.source_proof!.verified_at) || right.order - left.order)[0];
    if (!group.every(item => covers(selected.scope.root, item.scope.root))) fail("source_final_scope_required", "最新验收只覆盖较窄的源目录；请先对覆盖相关子项的完整源目录完成最终检查，再执行上级整合。");
    return { scope: selected.scope, final_manifest_sha256: selected.run.source_proof!.final_manifest_sha256!, run_id: selected.run.id, verified_at: selected.run.source_proof!.verified_at };
  });
  return { scopes, latest: latest.sort((left, right) => key(left.scope.root).localeCompare(key(right.scope.root))) };
}
