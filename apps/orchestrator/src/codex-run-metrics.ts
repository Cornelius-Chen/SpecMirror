import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineeringTokenUsageSnapshot } from "@epm/domain";

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const TAIL_BYTES = 8 * 1024 * 1024;
const METADATA_BYTES = 256 * 1024;

type UsageRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    id?: unknown;
    type?: unknown;
    thread_id?: unknown;
    session_id?: unknown;
    thread_token_usage?: unknown;
    info?: { total_token_usage?: unknown } | null;
  };
};

const nonnegative = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function usage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const input = nonnegative(item.input_tokens), cached = nonnegative(item.cached_input_tokens), output = nonnegative(item.output_tokens), reasoning = nonnegative(item.reasoning_output_tokens), total = nonnegative(item.total_tokens);
  if (input === null || cached === null || output === null || reasoning === null || total === null || cached > input) return null;
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total };
}

function chunk(descriptor: number, start: number, bytes: number) {
  const buffer = Buffer.alloc(bytes);
  let read = 0;
  while (read < bytes) {
    const count = readSync(descriptor, buffer, read, bytes - read, start + read);
    if (!count) break;
    read += count;
  }
  return buffer.subarray(0, read).toString("utf8");
}

function sessionMatches(descriptor: number, size: number, sessionId: string) {
  const text = chunk(descriptor, 0, Math.min(size, METADATA_BYTES));
  const newline = text.indexOf("\n");
  if (newline < 0 && size > METADATA_BYTES) return false;
  try {
    const record = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as UsageRecord;
    return record.type === "session_meta" && record.payload?.id === sessionId;
  } catch { return false; }
}

function matchesFile(path: string, sessionId: string) {
  const descriptor = openSync(path, "r");
  try { return sessionMatches(descriptor, fstatSync(descriptor).size, sessionId); }
  finally { closeSync(descriptor); }
}

function tail(path: string, sessionId: string, bytes = TAIL_BYTES) {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    // Validate the same open file that supplies the tail, including cached paths.
    if (!sessionMatches(descriptor, size, sessionId)) return null;
    const start = Math.max(0, size - bytes), text = chunk(descriptor, start, size - start);
    const newline = text.indexOf("\n");
    return start ? newline < 0 ? "" : text.slice(newline + 1) : text;
  } finally { closeSync(descriptor); }
}

/** Reads numeric usage only. Conversation content never leaves the rollout file. */
export class CodexRolloutUsageReader {
  readonly sessionsRoot: string;
  private readonly paths = new Map<string, string>();
  constructor(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) { this.sessionsRoot = join(codexHome, "sessions"); }

  snapshot(sessionId: string): EngineeringTokenUsageSnapshot | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const path = this.rollout(sessionId);
    if (!path) return undefined;
    let content: string | null;
    try { content = tail(path, sessionId); } catch { return undefined; }
    if (content === null) return undefined;
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line.includes('"token_usage_record"') && !line.includes('"token_count"')) continue;
      try {
        const record = JSON.parse(line) as UsageRecord;
        if (!record.payload) continue;
        const ids = [record.payload.thread_id, record.payload.session_id].filter(id => id !== undefined && id !== null);
        if (ids.some(id => id !== sessionId)) continue;
        const value = record.type === "token_usage_record" && ids.length > 0 ? record.payload.thread_token_usage
          : record.type === "event_msg" && record.payload.type === "token_count" ? record.payload.info?.total_token_usage
          : null;
        const total = usage(value), observedAt = typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)) ? record.timestamp : null;
        if (total && observedAt) return { ...total, observed_at: observedAt };
      } catch { /* A partial or malformed line is ignored. */ }
    }
    return undefined;
  }

  private rollout(sessionId: string) {
    const cached = this.paths.get(sessionId);
    if (cached) {
      try { if (matchesFile(cached, sessionId)) return cached; } catch { /* The rollout may have been removed. */ }
      this.paths.delete(sessionId);
    }
    if (!existsSync(this.sessionsRoot)) return null;
    const suffix = `-${sessionId}.jsonl`, queue = [this.sessionsRoot];
    let match: string | null = null, newest = -1;
    while (queue.length) {
      const directory = queue.pop()!;
      let entries: Dirent<string>[];
      try { entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); } catch { continue; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && entry.name.endsWith(suffix)) {
          try {
            const modified = statSync(path).mtimeMs;
            if (modified > newest && matchesFile(path, sessionId)) { newest = modified; match = path; }
          } catch { /* Ignore inaccessible, partial or mismatched candidates. */ }
        }
      }
    }
    if (match) this.paths.set(sessionId, match);
    return match;
  }
}

export interface EngineeringRunUsageObserver { snapshot(sessionId: string): EngineeringTokenUsageSnapshot | undefined }
