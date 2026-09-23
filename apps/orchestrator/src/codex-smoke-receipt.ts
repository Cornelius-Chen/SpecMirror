import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentRun, ReviewRecord } from "@epm/domain";
import { CODEX_SMOKE_RUN_MARKER, validateManagedCodexSmokeRun, type ManagedCodexSmokeRun } from "./codex-smoke-paths.ts";
import { CodexRolloutUsageReader } from "./codex-run-metrics.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const RECEIPT_REF = new RegExp(`^\\.project/\\.runtime/codex-smoke-runs/run-(${UUID})/repo/\\.project/smoke-receipt\\.json$`, "i");
const SMOKE_ID = new RegExp(`^codex-smoke-${UUID}$`, "i");
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 256 * 1024;

export interface CodexSmokeReceiptReference { ref: string; sha256: string }
interface SmokeTokenUsage {
  input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number;
}
export interface CodexSmokeReceipt {
  schema_version: 1;
  kind: "codex-smoke-receipt";
  smoke_id: string;
  status: "passed" | "failed";
  scope: "isolated-single-goal";
  gateway: "codex-app-server";
  model: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  token_usage: SmokeTokenUsage | null;
  token_usage_note: "not_collected" | "isolated_rollouts_complete" | "partial_rollouts";
  token_sessions: Array<{ session_id: string; usage: SmokeTokenUsage }>;
  checks: { run_verified: boolean; change_verified: boolean; main_changed: boolean; marker_present: boolean; checkpoint_matches_start: boolean };
  commits: { start: string | null; main: string | null; checkpoint: string | null };
  runs: Array<Pick<AgentRun, "id" | "goal_id" | "thread_id" | "status" | "started_at" | "finished_at" | "attempt">>;
  reviews: Array<Pick<ReviewRecord, "id" | "run_ids" | "status" | "reviewer" | "evidence_complete" | "recorded_at"> & { checks: Array<{ exit_code: number; duration_ms: number }> }>;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export function codexSmokeId(value: string | undefined, token: string) {
  const id = value ?? `codex-smoke-${token}`;
  if (!SMOKE_ID.test(id)) throw new Error("smoke_receipt_id_invalid");
  return id;
}

/** Keep the small fixture and its original YAML/Git evidence; never copy the host project. */
export function saveCodexSmokeReceipt(run: ManagedCodexSmokeRun, input: {
  smokeId: string; status: "passed" | "failed"; model?: string | null;
  startedAt: string; finishedAt: string; runs: AgentRun[]; reviews: ReviewRecord[];
  startSha?: string; finalMain?: string; checkpoint?: string | null; markerPresent?: boolean; changeVerified?: boolean;
}): CodexSmokeReceiptReference {
  const managed = validateManagedCodexSmokeRun(run);
  mkdirSync(join(managed.repo, ".project"), { recursive: true });
  const files: CodexSmokeReceipt["files"] = [];
  for (const file of ["README.md", ".project/project.yaml", ".project/trace.yaml"]) add(file);
  for (const directory of [".project/goals", ".project/changes", ".project/runs", ".project/reviews"]) {
    const path = join(managed.repo, directory);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".yaml")) add(`${directory}/${entry.name}`);
    }
  }
  const tokens = collectIsolatedUsage(managed.repo, input.runs.map(item => item.thread_id).filter((id): id is string => Boolean(id)));
  for (const path of tokens.files) add(path);
  function add(path: string) {
    const absolute = join(managed.repo, path);
    if (!existsSync(absolute)) return;
    const bytes = readFileSync(absolute);
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  const duration = Date.parse(input.finishedAt) - Date.parse(input.startedAt);
  if (!Number.isFinite(duration) || duration < 0) throw new Error("smoke_receipt_time_invalid");
  const receipt: CodexSmokeReceipt = {
    schema_version: 1, kind: "codex-smoke-receipt", smoke_id: codexSmokeId(input.smokeId, run.token),
    status: input.status, scope: "isolated-single-goal", gateway: "codex-app-server", model: input.model ?? null,
    started_at: input.startedAt, finished_at: input.finishedAt, duration_ms: duration,
    token_usage: tokens.total, token_usage_note: tokens.note, token_sessions: tokens.sessions,
    checks: {
      run_verified: input.runs.length > 0 && input.runs.every(item => item.gateway === "codex-app-server" && item.status === "verified"),
      change_verified: input.changeVerified === true,
      main_changed: Boolean(input.startSha && input.finalMain && input.startSha !== input.finalMain),
      marker_present: input.markerPresent === true,
      checkpoint_matches_start: Boolean(input.startSha && input.checkpoint === input.startSha)
    },
    commits: { start: input.startSha ?? null, main: input.finalMain ?? null, checkpoint: input.checkpoint ?? null },
    runs: input.runs.map(({ id, goal_id, thread_id, status, started_at, finished_at, attempt }) => ({ id, goal_id, thread_id, status, started_at, finished_at, attempt })),
    reviews: input.reviews.map(({ id, run_ids, status, reviewer, evidence_complete, recorded_at, acceptance_results }) => ({
      id, run_ids, status, reviewer, evidence_complete, recorded_at,
      checks: acceptance_results.map(({ exit_code, duration_ms }) => ({ exit_code, duration_ms }))
    })),
    files
  };
  if (receipt.status === "passed" && !Object.values(receipt.checks).every(Boolean)) throw new Error("smoke_receipt_success_not_verified");
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_RECEIPT_BYTES) throw new Error("smoke_receipt_too_large");
  const path = join(managed.repo, ".project", "smoke-receipt.json");
  // Exclusive creation prevents an older run from being overwritten or relabeled.
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", flush: true });
  return { ref: relative(managed.sourceRoot, path).replaceAll("\\", "/"), sha256: hash(content) };
}

/** The caller supplies only the persisted receipt reference, never an arbitrary browser path. */
export function readCodexSmokeReceipt(sourceRoot: string, smokeId: string, reference: CodexSmokeReceiptReference): CodexSmokeReceipt {
  const match = typeof reference?.ref === "string" ? RECEIPT_REF.exec(reference.ref) : null;
  if (!match || !SHA256.test(reference.sha256) || !SMOKE_ID.test(smokeId)) throw new Error("smoke_receipt_reference_invalid");
  const token = match[1], managedRoot = join(sourceRoot, ".project", ".runtime", "codex-smoke-runs");
  const runRoot = join(managedRoot, `run-${token}`), repo = join(runRoot, "repo");
  validateManagedCodexSmokeRun({ sourceRoot, managedRoot, runRoot, repo, token, markerPath: join(runRoot, CODEX_SMOKE_RUN_MARKER) });
  const path = join(sourceRoot, reference.ref);
  if (statSync(path).size > MAX_RECEIPT_BYTES) throw new Error("smoke_receipt_too_large");
  const content = readFileSync(path);
  if (hash(content) !== reference.sha256) throw new Error("smoke_receipt_hash_mismatch");
  const value = JSON.parse(content.toString("utf8")) as CodexSmokeReceipt;
  if (value.kind !== "codex-smoke-receipt" || value.schema_version !== 1 || value.smoke_id !== smokeId || value.scope !== "isolated-single-goal" || value.gateway !== "codex-app-server") throw new Error("smoke_receipt_identity_mismatch");
  // Verify retained evidence as well as the receipt so changed or missing files cannot look replayable.
  for (const file of value.files) {
    const contractFile = /^(?:README\.md|\.project\/(?:project\.yaml|trace\.yaml|(?:goals|changes|runs|reviews)\/[^/\\]+\.yaml))$/.test(file.path);
    const usageFile = /^\.project\/\.runtime\/codex-home\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9-]+\.jsonl$/.test(file.path);
    if ((!contractFile && !usageFile) || file.path.includes("..")) throw new Error("smoke_receipt_file_invalid");
    const bytes = readFileSync(join(repo, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error("smoke_receipt_evidence_changed");
  }
  return value;
}

function hash(content: string | Buffer) { return createHash("sha256").update(content).digest("hex"); }

/** Inspect only this disposable run's private session directory, never the user's general conversation history. */
function collectIsolatedUsage(repo: string, workers: string[]) {
  const home = join(repo, ".project/.runtime/codex-home"), directory = join(home, "sessions");
  const result: { total: SmokeTokenUsage | null; note: CodexSmokeReceipt["token_usage_note"]; sessions: CodexSmokeReceipt["token_sessions"]; files: string[] } = { total: null, note: "not_collected", sessions: [], files: [] };
  if (!existsSync(directory)) return result;
  const candidates: Array<{ id: string; path: string }> = [];
  const visit = (path: string, depth: number) => {
    if (depth > 3 || candidates.length > 16) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) visit(join(path, entry.name), depth + 1);
      else if (entry.isFile() && depth === 3) {
        const id = new RegExp(`-(${SESSION_UUID})\\.jsonl$`, "i").exec(entry.name)?.[1];
        if (id) candidates.push({ id, path: relative(repo, join(path, entry.name)).replaceAll("\\", "/") });
      }
    }
  };
  visit(directory, 0);
  if (candidates.length === 0 || candidates.length > 16) return result;
  const reader = new CodexRolloutUsageReader(home);
  for (const candidate of candidates) {
    const snapshot = reader.snapshot(candidate.id);
    if (!snapshot || result.sessions.some(item => item.session_id === candidate.id)) continue;
    const { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens } = snapshot;
    result.sessions.push({ session_id: candidate.id, usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens } });
    result.files.push(candidate.path);
  }
  result.note = "partial_rollouts";
  if (!workers.length || result.sessions.length !== candidates.length || !workers.every(id => result.sessions.some(item => item.session_id === id))) return result;
  const sum: SmokeTokenUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (const item of result.sessions) for (const key of Object.keys(sum) as Array<keyof SmokeTokenUsage>) sum[key] += item.usage[key];
  if (!Object.values(sum).every(Number.isSafeInteger)) return result;
  result.total = sum; result.note = "isolated_rollouts_complete";
  return result;
}
