import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { readYaml } from "@epm/spec-io";

import type { EngineeringSourceScope, FrozenEngineeringSourceScope, EngineeringSourceFile, EngineeringSourceExclusion, EngineeringSourceBaseline, EngineeringSourceChange, EngineeringSourceCheckResult, EngineeringSourceProof } from "@epm/domain";
export type { EngineeringSourceScope, FrozenEngineeringSourceScope, EngineeringSourceFile, EngineeringSourceExclusion, EngineeringSourceBaseline, EngineeringSourceChange, EngineeringSourceCheckResult, EngineeringSourceProof } from "@epm/domain";

/** Source verification observes a frozen working-tree baseline. It is not an OS write sandbox. */

export const ENGINEERING_SOURCE_LIMITS = Object.freeze({ files: 5000, bytes: 64 * 1024 * 1024, entries: 20000, checks: 12, timeout_ms: 120000, output_bytes: 1024 * 1024 });
const GENERATED = new Set([".git", "node_modules", ".runtime", "dist", "artifacts", "coverage", ".next", ".cache", "test-results", "playwright-report"]);
const EXCLUSION_RULES = [...GENERATED].map(name => "**/" + name + "/**").concat([".project/engineering/**", ".project/task-workspaces/**"]);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hashObject = (value: unknown) => hash(JSON.stringify(value));
const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const cleanNamespace = (path: string) => path.startsWith("\\\\?\\UNC\\") ? "\\\\" + path.slice(8) : path.startsWith("\\\\?\\") ? path.slice(4) : path;
function within(root: string, target: string) { const rel = relative(comparable(root), comparable(target)); return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel)); }
export class EngineeringSourceProofError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "EngineeringSourceProofError"; }
}
function fail(code: string, message: string): never { throw new EngineeringSourceProofError(code, message); }
function checkedRoot(raw: string) {
  if (typeof raw !== "string" || !isAbsolute(raw)) fail("source_root_invalid", "源文件目录必须是绝对路径。");
  const absolute = resolve(cleanNamespace(raw));
  // Reject junctions/symlinks in every ancestor, including the root itself.
  const base = parse(absolute).root;
  let cursor = base;
  for (const component of absolute.slice(base.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) fail("source_symlink", "源文件目录不能经过符号链接或目录联接。");
  }
  if (!lstatSync(absolute).isDirectory()) fail("source_root_invalid", "源文件目录不存在或不是目录。");
  return cleanNamespace(realpathSync.native(absolute));
}
function pattern(raw: string) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 512 || raw.includes("\0")) fail("source_pattern_invalid", "源文件范围必须使用相对路径模式。");
  const value = raw.replaceAll("\\", "/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some(part => part === ".." || part === "." || part === "") || /[\[\]{}!]/.test(value)) fail("source_pattern_invalid", "源文件范围不能越界；模式支持 *、**、?。");
  return value;
}
function matches(glob: string, path: string) {
  let expression = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { expression += "(?:.*/)?"; i++; } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(expression + "$", process.platform === "win32" ? "i" : "").test(path);
}
export function freezeEngineeringSourceScope(input: EngineeringSourceScope, approvedRoots: readonly string[]): FrozenEngineeringSourceScope {
  const root = checkedRoot(input.root);
  if (!approvedRoots.some(candidate => within(checkedRoot(candidate), root))) fail("source_root_unapproved", "源文件目录不属于当前任务明确授权的工程目录。");
  if (!Array.isArray(input.allow) || !input.allow.length || input.allow.length > 100 || !Array.isArray(input.deny) || input.deny.length > 100) fail("source_scope_invalid", "请明确允许修改的源文件范围。");
  if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > ENGINEERING_SOURCE_LIMITS.checks) fail("source_checks_invalid", "源文件交付必须至少有一个可实际执行的检查，最多 12 个。");
  const ids = new Set<string>();
  const checks = input.checks.map(check => {
    if (typeof check.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(check.id) || ids.has(check.id) || typeof check.title !== "string" || !check.title.trim() || check.title.length > 200 || check.program !== "node" || !Array.isArray(check.args) || check.args.length === 0 || check.args.length > 100 || check.args.some(arg => typeof arg !== "string" || arg.length > 16000 || arg.includes("\0"))) fail("source_check_invalid", "检查必须有唯一标识、标题和冻结的 node 参数。");
    ids.add(check.id);
    const timeout = check.timeout_ms ?? 30000;
    if (!Number.isInteger(timeout) || timeout < 20 || timeout > ENGINEERING_SOURCE_LIMITS.timeout_ms) fail("source_check_timeout_invalid", "检查超时必须在 20 至 120000 毫秒之间。");
    return { id: check.id, title: check.title, program: "node" as const, args: [...check.args], timeout_ms: timeout };
  });
  const scope: EngineeringSourceScope = { root, allow: [...new Set(input.allow.map(pattern))].sort(), deny: [...new Set(input.deny.map(pattern))].sort(), checks };
  return { ...scope, contract_sha256: hashObject(scope) };
}
function excluded(path: string) { return path.split("/").some(part => GENERATED.has(part)) || path === ".project/engineering" || path.startsWith(".project/engineering/") || path === ".project/task-workspaces" || path.startsWith(".project/task-workspaces/"); }
function git(root: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024, env: { ...env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } });
}
function hasGitMarker(root: string) {
  let cursor = root;
  while (true) { if (existsSync(join(cursor, ".git"))) return true; const parent = resolve(cursor, ".."); if (parent === cursor) return false; cursor = parent; }
}
function checkedFile(root: string, path: string) {
  if (!path || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".") || isAbsolute(path)) fail("source_path_escape", "源文件清单出现越界路径。");
  const full = resolve(root, path);
  if (!within(root, full)) fail("source_path_escape", "源文件清单出现越界路径。");
  let cursor = root;
  for (const component of path.split("/")) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) fail("source_symlink", "源文件清单包含符号链接或目录联接：" + path);
  }
  if (!within(root, cleanNamespace(realpathSync.native(full)))) fail("source_path_escape", "源文件真实位置超出冻结目录。");
  return full;
}
function registeredExternalReferences(root: string) {
  const references: Array<{ path: string; rule: string }> = [];
  if (!existsSync(join(root, "projects"))) return references;
  checkedFile(root, "projects");
  const projects = readdirSync(join(root, "projects"), { withFileTypes: true });
  if (projects.length > 500) fail("source_project_limit", "外部工程注册项超过 500 个，请缩小源文件目录。");
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const registration = "projects/" + project.name + "/.project/project.yaml", path = "projects/" + project.name + "/source";
    if (!existsSync(join(root, registration)) || !existsSync(join(root, path))) continue;
    const registrationFile = checkedFile(root, registration), stat = lstatSync(registrationFile);
    if (!stat.isFile() || stat.size > 65536) fail("source_registration_invalid", "外部工程注册文件必须是有限大小的常规文件。");
    const config = readYaml<{ id?: string; repository?: { root?: string } }>(registrationFile);
    if (config.id !== "project-" + project.name || config.repository?.root !== "source") continue;
    const source = join(root, path);
    // Only this registered external link is excluded; similarly named ordinary directories remain governed.
    if (!lstatSync(source).isSymbolicLink() || within(root, cleanNamespace(realpathSync.native(source)))) continue;
    const registrationHash = hash(readFileSync(registrationFile));
    references.push({ path, rule: path + "/** (registered by " + registration + "; sha256=" + registrationHash + ")" });
  }
  return references.sort((a, b) => a.path.localeCompare(b.path));
}
export function captureEngineeringSourceBaseline(scope: FrozenEngineeringSourceScope): EngineeringSourceBaseline {
  const validated = freezeEngineeringSourceScope(scope, [scope.root]);
  if (validated.contract_sha256 !== scope.contract_sha256) fail("source_contract_changed", "源文件合同与冻结值不一致。");
  const root = validated.root, references = registeredExternalReferences(root), candidates: string[] = [];
  const exclusions: EngineeringSourceExclusion[] = references.map(reference => ({ path: reference.path + "/", reason: "external_project_reference" }));
  const isReference = (path: string) => references.some(reference => path === reference.path || path.startsWith(reference.path + "/"));
  const pathspec = ["--", ".", ...references.map(reference => ":(exclude)" + reference.path + "/**")];
  let entries = 0;
  const countEntry = () => { if (++entries > ENGINEERING_SOURCE_LIMITS.entries) fail("source_entry_limit", "源文件目录超过 20000 项，请缩小源文件目录。"); };
  const repository = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (repository.error || (repository.status !== 0 && (hasGitMarker(root) || !/not a git repository/i.test(repository.stderr)))) fail("source_git_inventory_failed", "无法判断 Git 仓库状态；未将失败降级为完整源文件清单。");
  const isGit = repository.status === 0 && repository.stdout.trim() === "true";
  if (isGit) {
    const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...pathspec]);
    if (files.status !== 0 || files.error) fail("source_git_inventory_failed", "无法完整读取 Git 工作树文件清单。");
    for (const path of [...new Set(files.stdout.split("\0").filter(Boolean))]) { countEntry(); if (isReference(path)) continue; if (excluded(path)) exclusions.push({ path, reason: "generated_or_runtime" }); else candidates.push(path); }
    const ignored = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", ...pathspec]);
    if (ignored.status !== 0 || ignored.error) fail("source_git_inventory_failed", "无法完整读取 Git 排除项。");
    for (const path of ignored.stdout.split("\0").filter(Boolean)) { countEntry(); if (!isReference(path)) exclusions.push({ path, reason: excluded(path) ? "generated_or_runtime" : "git_ignored" }); }
  } else {
    const walk = (directory: string, prefix: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        countEntry(); const path = prefix + entry.name;
        if (isReference(path)) continue;
        if (excluded(path)) { exclusions.push({ path: path + (entry.isDirectory() ? "/" : ""), reason: "generated_or_runtime" }); continue; }
        if (entry.isSymbolicLink()) fail("source_symlink", "源文件清单包含符号链接或目录联接：" + path);
        if (entry.isDirectory()) { checkedFile(root, path); walk(join(directory, entry.name), path + "/"); }
        else if (entry.isFile()) candidates.push(path);
        else fail("source_file_type", "源文件清单包含无法核验的特殊文件：" + path);
      }
    };
    walk(root, "");
  }
  if (candidates.length > ENGINEERING_SOURCE_LIMITS.files) fail("source_file_limit", "源文件清单超过 5000 个文件，请缩小源文件目录。");
  const manifest: EngineeringSourceFile[] = []; let bytes = 0;
  for (const path of candidates.sort()) {
    // Git lists tracked deletions; their absence is part of the initial working-tree baseline.
    let full: string;
    try { full = checkedFile(root, path); } catch (error) { if (isGit && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) fail("source_file_type", "源文件清单包含无法核验的特殊文件：" + path);
      if (before.nlink > 1) fail("source_hardlink", "源文件存在共享硬链接，不能证明修改仅属于冻结目录：" + path);
      bytes += before.size;
      if (bytes > ENGINEERING_SOURCE_LIMITS.bytes) fail("source_byte_limit", "源文件总大小超过 64 MB，请缩小源文件目录。");
      const content = Buffer.alloc(before.size); let offset = 0;
      while (offset < content.length) { const read = readSync(fd, content, offset, content.length - offset, null); if (!read) break; offset += read; }
      const extra = readSync(fd, Buffer.alloc(1), 0, 1, null), after = fstatSync(fd);
      if (offset !== before.size || extra !== 0 || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !within(root, cleanNamespace(realpathSync.native(full)))) fail("source_changed_while_reading", "读取源文件时发生变化，请重试：" + path);
      manifest.push({ path, sha256: hash(content), bytes: content.length });
    } finally { closeSync(fd); }
  }
  const head = isGit ? git(root, ["rev-parse", "--verify", "HEAD"]) : null;
  const preexisting: Array<{ path: string; status: string }> = [];
  if (isGit) {
    const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec]), prefix = git(root, ["rev-parse", "--show-prefix"]);
    if (status.status !== 0 || status.error || prefix.status !== 0 || prefix.error) fail("source_git_inventory_failed", "无法完整读取已有 Git 修改记录。");
    const rootPrefix = prefix.stdout.trim(), rows = status.stdout.split("\0").filter(Boolean);
    const add = (path: string, state: string) => {
      if (rootPrefix && !path.startsWith(rootPrefix)) return;
      const local = rootPrefix ? path.slice(rootPrefix.length) : path;
      if (local && !excluded(local) && !isReference(local)) preexisting.push({ path: local, status: state });
    };
    for (let index = 0; index < rows.length; index++) {
      countEntry(); const row = rows[index], state = row.slice(0, 2), path = row.slice(3); add(path, state);
      if (/[RC]/.test(state) && rows[index + 1]) add(rows[++index], "rename_or_copy_from");
    }
  }
  return { schema_version: 1, captured_at: new Date().toISOString(), scope: validated, manifest, manifest_sha256: hashObject(manifest), total_bytes: bytes, git: { repository: isGit, head_sha: head?.status === 0 ? head.stdout.trim() : null, preexisting_changes: preexisting.sort((a, b) => a.path.localeCompare(b.path)) }, exclusions: exclusions.sort((a, b) => a.path.localeCompare(b.path)), exclusion_rules: [...EXCLUSION_RULES, ...references.map(reference => reference.rule)] };
}
function redact(value: string) {
  let result = value.replace(/\u001b\[[0-9;]*m/g, "");
  for (const [name, secret] of Object.entries(process.env)) if (/(?:token|secret|password|credential|api[_-]?key)/i.test(name) && secret && secret.length >= 6) result = result.replaceAll(secret, "[已脱敏]");
  return result.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已脱敏]").replace(/((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[已脱敏]").replace(/(Bearer\s+)[^\s,;]+/gi, "$1[已脱敏]");
}
function baseCheck(check: EngineeringSourceScope["checks"][number]): EngineeringSourceCheckResult {
  return { id: check.id, title: redact(check.title), program: "node", args: check.args.map(redact), command_sha256: hashObject({ program: check.program, args: check.args }), status: "not_run", exit_code: null, duration_ms: 0, output_sha256: hash(""), output_bytes: 0, error: null };
}
async function runCheck(root: string, check: EngineeringSourceScope["checks"][number], signal?: AbortSignal): Promise<EngineeringSourceCheckResult> {
  const result = baseCheck(check), started = Date.now(), digest = createHash("sha256");
  if (signal?.aborted) return { ...result, status: "cancelled", error: "源文件检查已取消，未启动命令。" };
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "COMSPEC", "PATHEXT", "LANG"]) if (process.env[name]) env[name] = process.env[name];
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, check.args, { cwd: root, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env });
    let retained = "", killed = false, done = false;
    const stop = () => {
      if (killed || !child.pid) return; killed = true;
      if (process.platform === "win32") {
        const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
        killer.on("close", code => { if (code !== 0) child.kill("SIGKILL"); });
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const collect = (chunk: Buffer) => {
      digest.update(chunk); result.output_bytes += chunk.length;
      if (retained.length < 2000) retained += chunk.toString("utf8").slice(0, 2000 - retained.length);
      if (result.output_bytes > ENGINEERING_SOURCE_LIMITS.output_bytes && !killed) { result.status = "output_limit"; stop(); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { if (!killed) { result.status = "timeout"; stop(); } }, check.timeout_ms ?? 30000);
    const cancel = () => { if (!killed) { result.status = "cancelled"; stop(); } };
    const finish = (code: number | null, spawnError?: Error) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      result.exit_code = code; result.duration_ms = Date.now() - started; result.output_sha256 = digest.digest("hex");
      if (spawnError) result.status = "spawn_error";
      else if (result.status === "not_run") result.status = code === 0 ? "passed" : "failed";
      result.error = result.status === "passed" ? null : redact(spawnError?.message ?? (result.status === "cancelled" ? "源文件检查已取消，命令进程已退出。" : result.status === "timeout" ? "冻结的检查执行超时。" : result.status === "output_limit" ? "检查输出超过 1 MB，已停止。" : retained.trim() || "冻结的检查返回非零退出状态。")).slice(0, 600);
      resolveResult(result);
    };
    child.once("error", error => finish(null, error)); child.once("close", code => finish(code));
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
function changesBetween(before: EngineeringSourceBaseline, after: EngineeringSourceBaseline) {
  const initial = new Map(before.manifest.map(file => [file.path, file])), final = new Map(after.manifest.map(file => [file.path, file]));
  return [...new Set([...initial.keys(), ...final.keys()])].sort().flatMap(path => {
    const left = initial.get(path), right = final.get(path);
    if (left?.sha256 === right?.sha256) return [];
    const reason = before.scope.deny.some(glob => matches(glob, path)) ? "denied" : before.scope.allow.some(glob => matches(glob, path)) ? "allowed" : "outside_allow";
    return [{ path, kind: !left ? "added" : !right ? "deleted" : "modified", before_sha256: left?.sha256 ?? null, after_sha256: right?.sha256 ?? null, allowed: reason === "allowed", reason } satisfies EngineeringSourceChange];
  });
}
export async function verifyEngineeringSourceProof(baseline: EngineeringSourceBaseline, approvedRoots: readonly string[], options: { signal?: AbortSignal; assertCheckContext?: () => void } = {}): Promise<EngineeringSourceProof> {
  const proof: EngineeringSourceProof = { schema_version: 1, verification_mode: "post_execution", verified_at: new Date().toISOString(), status: "blocked", passed: false, root: baseline.scope.root, contract_sha256: baseline.scope.contract_sha256, baseline_manifest_sha256: baseline.manifest_sha256, final_manifest_sha256: null, changes: [], checks: baseline.scope.checks.map(baseCheck), preexisting_changes: baseline.git.preexisting_changes.map(change => ({ ...change })), exclusions: [], exclusion_rules: [...EXCLUSION_RULES], source_changed_during_checks: false, error: null };
  try {
    const scope = freezeEngineeringSourceScope(baseline.scope, approvedRoots);
    if (scope.contract_sha256 !== baseline.scope.contract_sha256 || hashObject(baseline.manifest) !== baseline.manifest_sha256) fail("source_baseline_changed", "源文件起点或冻结合同与原始记录不一致。");
    const beforeChecks = captureEngineeringSourceBaseline(scope);
    if (hashObject(beforeChecks.exclusion_rules) !== hashObject(baseline.exclusion_rules)) fail("source_exclusions_changed", "外部工程引用或排除规则在执行后发生变化，必须重新冻结源文件起点。");
    proof.final_manifest_sha256 = beforeChecks.manifest_sha256;
    proof.changes = changesBetween(baseline, beforeChecks); proof.exclusions = beforeChecks.exclusions; proof.exclusion_rules = beforeChecks.exclusion_rules;
    if (proof.changes.some(change => !change.allowed)) { proof.status = "failed"; proof.error = "源文件变更超出冻结范围，检查未执行。"; return proof; }
    for (let index = 0; index < scope.checks.length; index++) {
      options.assertCheckContext?.();
      const result = await runCheck(scope.root, scope.checks[index], options.signal);
      // A recheck may depend on a separately confirmed configuration outside
      // the writable source scope. Do not publish this check's result if that
      // context changed while its process was running.
      options.assertCheckContext?.();
      proof.checks[index] = result;
    }
    const afterChecks = captureEngineeringSourceBaseline(scope);
    if (hashObject(afterChecks.exclusion_rules) !== hashObject(baseline.exclusion_rules)) fail("source_exclusions_changed", "实际检查期间外部工程引用或排除规则发生变化。");
    proof.source_changed_during_checks = beforeChecks.manifest_sha256 !== afterChecks.manifest_sha256;
    proof.final_manifest_sha256 = afterChecks.manifest_sha256; proof.changes = changesBetween(baseline, afterChecks); proof.exclusions = afterChecks.exclusions;
    proof.passed = !proof.source_changed_during_checks && proof.changes.every(change => change.allowed) && proof.checks.every(check => check.status === "passed");
    proof.status = proof.passed ? "passed" : "failed";
    proof.error = proof.source_changed_during_checks ? "实际检查期间源文件发生变化，不能将该检查视为最终文件的通过证据。" : proof.passed ? null : proof.checks.some(check => check.status === "cancelled") ? "源文件检查已取消，实际命令已停止或未启动。" : "至少一个冻结的实际检查未通过。";
  } catch (error) { proof.error = redact(error instanceof EngineeringSourceProofError ? error.message : "无法完整核验源文件：" + ((error as NodeJS.ErrnoException).code ?? "unknown")).slice(0, 600); }
  return proof;
}
