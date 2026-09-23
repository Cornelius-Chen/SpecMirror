import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CODEX_SMOKE_RUN_MARKER = ".specmirror-codex-smoke-run.json";

const MANAGED_RUNS_PARTS = [".project", ".runtime", "codex-smoke-runs"] as const;
const RUN_PREFIX = "run-";
const MARKER_KIND = "specmirror-codex-smoke-run";
const MARKER_SCHEMA_VERSION = 1;
const MAX_MARKER_BYTES = 16 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TOP_LEVEL = new Set([CODEX_SMOKE_RUN_MARKER, "repo", "repo-worktrees"]);

export interface ManagedCodexSmokeRun {
  sourceRoot: string;
  managedRoot: string;
  runRoot: string;
  repo: string;
  markerPath: string;
  token: string;
}

interface CodexSmokeRunMarker {
  schema_version: 1;
  kind: typeof MARKER_KIND;
  token: string;
  source_root: string;
  run_root: string;
  repo_root: string;
  created_at: string;
}

/**
 * Creates one owned container beneath the source repository. The returned repo
 * is intentionally a child of that container so GitController's sibling
 * `repo-worktrees` directory remains inside the same cleanup boundary.
 *
 * A partial or failed creation is deliberately retained for diagnosis.
 */
export function createManagedCodexSmokeRun(sourceRoot: string, requestedToken?: string): ManagedCodexSmokeRun {
  const source = assertSourceRoot(sourceRoot);
  const managedRoot = join(source, ...MANAGED_RUNS_PARTS);
  assertExistingDirectoryChain(source, managedRoot);
  mkdirSync(managedRoot, { recursive: true });
  assertManagedRoot(source, managedRoot);

  const token = assertToken(requestedToken ?? randomUUID());
  const runRoot = join(managedRoot, `${RUN_PREFIX}${token}`);
  const repo = join(runRoot, "repo");
  const markerPath = join(runRoot, CODEX_SMOKE_RUN_MARKER);
  assertDirectChild(managedRoot, runRoot, "smoke_run_not_direct_child");
  assertDirectChild(runRoot, repo, "smoke_repo_not_direct_child");

  mkdirSync(runRoot, { recursive: false });
  mkdirSync(repo, { recursive: false });
  const marker: CodexSmokeRunMarker = {
    schema_version: MARKER_SCHEMA_VERSION,
    kind: MARKER_KIND,
    token,
    source_root: source,
    run_root: runRoot,
    repo_root: repo,
    created_at: new Date().toISOString()
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const run = { sourceRoot: source, managedRoot, runRoot, repo, markerPath, token };
  validateManagedCodexSmokeRun(run);
  const entries = readdirSync(runRoot).sort();
  if (JSON.stringify(entries) !== JSON.stringify([CODEX_SMOKE_RUN_MARKER, "repo"].sort())) {
    throw new Error("smoke_run_initial_layout_invalid");
  }
  if (readdirSync(repo).length !== 0) throw new Error("smoke_repo_initially_not_empty");
  return run;
}

/**
 * Revalidates ownership and containment without mutating the run. Callers can
 * use this before handing the repo to another component.
 */
export function validateManagedCodexSmokeRun(run: ManagedCodexSmokeRun): ManagedCodexSmokeRun {
  const token = assertToken(run.token);
  const source = assertSourceRoot(run.sourceRoot);
  const managedRoot = join(source, ...MANAGED_RUNS_PARTS);
  const runRoot = join(managedRoot, `${RUN_PREFIX}${token}`);
  const repo = join(runRoot, "repo");
  const markerPath = join(runRoot, CODEX_SMOKE_RUN_MARKER);

  assertExactPath(run.managedRoot, managedRoot, "smoke_managed_root_mismatch");
  assertExactPath(run.runRoot, runRoot, "smoke_run_root_mismatch");
  assertExactPath(run.repo, repo, "smoke_repo_root_mismatch");
  assertExactPath(run.markerPath, markerPath, "smoke_marker_path_mismatch");
  assertDirectChild(managedRoot, runRoot, "smoke_run_not_direct_child");
  assertDirectChild(runRoot, repo, "smoke_repo_not_direct_child");
  assertManagedRoot(source, managedRoot);
  assertDirectoryNoLink(runRoot, "smoke_run_root_invalid");
  assertDirectoryNoLink(repo, "smoke_repo_root_invalid");

  const sourceReal = realDirectory(source, "smoke_source_root_invalid");
  const managedReal = realDirectory(managedRoot, "smoke_managed_root_invalid");
  const runReal = realDirectory(runRoot, "smoke_run_root_invalid");
  const repoReal = realDirectory(repo, "smoke_repo_root_invalid");
  assertExactPath(managedReal, join(sourceReal, ...MANAGED_RUNS_PARTS), "smoke_managed_root_realpath_mismatch");
  assertDirectChild(managedReal, runReal, "smoke_run_realpath_not_direct_child");
  assertDirectChild(runReal, repoReal, "smoke_repo_realpath_not_direct_child");

  assertAllowedTopLevel(runRoot);
  assertMarker(markerPath, { source, runRoot, repo, token });
  assertTreeHasNoLinks(runRoot, runReal);
  return { sourceRoot: source, managedRoot, runRoot, repo, markerPath, token };
}

/**
 * Removes only the exact, token-owned run container after a successful smoke.
 * Every failed validation throws before deletion, preserving the run as
 * evidence. The shared `codex-smoke-runs` directory is never removed here.
 */
export function removeSuccessfulManagedCodexSmokeRun(run: ManagedCodexSmokeRun): void {
  const validated = validateManagedCodexSmokeRun(run);
  rmSync(validated.runRoot, { recursive: true, force: false });
  if (existsSync(validated.runRoot)) throw new Error("smoke_run_cleanup_incomplete");
}

function assertSourceRoot(candidate: string) {
  if (typeof candidate !== "string" || !candidate.trim() || !isAbsolute(candidate)) {
    throw new Error("smoke_source_root_must_be_absolute");
  }
  const source = resolve(candidate);
  assertExactPath(candidate, source, "smoke_source_root_not_normalized");
  assertDirectoryNoLink(source, "smoke_source_root_invalid");
  const sourceReal = realDirectory(source, "smoke_source_root_invalid");
  assertExactPath(sourceReal, source, "smoke_source_root_reparse_rejected");
  return source;
}

function assertManagedRoot(source: string, managedRoot: string) {
  assertExistingDirectoryChain(source, managedRoot);
  assertDirectoryNoLink(managedRoot, "smoke_managed_root_invalid");
  const sourceReal = realDirectory(source, "smoke_source_root_invalid");
  const managedReal = realDirectory(managedRoot, "smoke_managed_root_invalid");
  assertExactPath(managedReal, join(sourceReal, ...MANAGED_RUNS_PARTS), "smoke_managed_root_realpath_mismatch");
}

function assertExistingDirectoryChain(root: string, target: string) {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const child = relative(rootPath, targetPath);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("smoke_managed_root_escape");
  assertDirectoryNoLink(rootPath, "smoke_source_root_invalid");
  if (!child) return;
  let current = rootPath;
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    assertDirectoryNoLink(current, "smoke_path_reparse_or_non_directory");
  }
}

function assertDirectoryNoLink(path: string, code: string) {
  if (!existsSync(path)) throw new Error(`${code}:missing`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`${code}:reparse_or_symlink`);
  if (!entry.isDirectory()) throw new Error(`${code}:not_directory`);
}

function realDirectory(path: string, code: string) {
  assertDirectoryNoLink(path, code);
  return realpathSync.native(path);
}

function assertDirectChild(parent: string, child: string, code: string) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const edge = relative(parentPath, childPath);
  if (!edge || edge.startsWith("..") || isAbsolute(edge) || edge.includes(sep) || !samePath(dirname(childPath), parentPath)) {
    throw new Error(code);
  }
}

function assertExactPath(actual: string, expected: string, code: string) {
  if (typeof actual !== "string" || !samePath(actual, expected)) throw new Error(code);
}

function samePath(left: string, right: string) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertToken(token: string) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new Error("smoke_run_token_invalid");
  return token;
}

function assertAllowedTopLevel(runRoot: string) {
  const entries = readdirSync(runRoot, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has(CODEX_SMOKE_RUN_MARKER)) throw new Error("smoke_run_marker_missing");
  if (!names.has("repo")) throw new Error("smoke_repo_root_missing");
  for (const entry of entries) {
    if (!ALLOWED_TOP_LEVEL.has(entry.name)) throw new Error(`smoke_run_top_level_not_allowed:${entry.name}`);
    if (entry.isSymbolicLink()) throw new Error(`smoke_run_top_level_reparse_rejected:${entry.name}`);
    if (entry.name === CODEX_SMOKE_RUN_MARKER && !entry.isFile()) throw new Error("smoke_run_marker_not_file");
    if (entry.name !== CODEX_SMOKE_RUN_MARKER && !entry.isDirectory()) throw new Error(`smoke_run_top_level_not_directory:${entry.name}`);
  }
}

function assertMarker(
  markerPath: string,
  expected: { source: string; runRoot: string; repo: string; token: string }
) {
  if (!existsSync(markerPath)) throw new Error("smoke_run_marker_missing");
  const markerEntry = lstatSync(markerPath);
  if (markerEntry.isSymbolicLink() || !markerEntry.isFile()) throw new Error("smoke_run_marker_invalid");
  if (statSync(markerPath).size > MAX_MARKER_BYTES) throw new Error("smoke_run_marker_too_large");
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("smoke_run_marker_invalid_json");
  }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("smoke_run_marker_invalid");
  const value = marker as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["created_at", "kind", "repo_root", "run_root", "schema_version", "source_root", "token"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) throw new Error("smoke_run_marker_shape_invalid");
  if (
    value.schema_version !== MARKER_SCHEMA_VERSION ||
    value.kind !== MARKER_KIND ||
    value.token !== expected.token ||
    typeof value.source_root !== "string" || !samePath(value.source_root, expected.source) ||
    typeof value.run_root !== "string" || !samePath(value.run_root, expected.runRoot) ||
    typeof value.repo_root !== "string" || !samePath(value.repo_root, expected.repo) ||
    typeof value.created_at !== "string" || !isCanonicalIsoTimestamp(value.created_at)
  ) {
    throw new Error("smoke_run_marker_mismatch");
  }
}

function isCanonicalIsoTimestamp(value: string) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertTreeHasNoLinks(root: string, rootReal: string) {
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) throw new Error(`smoke_run_tree_reparse_rejected:${entry.name}`);
      const canonical = realpathSync.native(path);
      const relation = relative(rootReal, canonical);
      if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`smoke_run_tree_realpath_escape:${entry.name}`);
      if (stats.isDirectory()) visit(path);
      else if (!stats.isFile()) throw new Error(`smoke_run_tree_special_entry_rejected:${entry.name}`);
    }
  };
  visit(root);
}
