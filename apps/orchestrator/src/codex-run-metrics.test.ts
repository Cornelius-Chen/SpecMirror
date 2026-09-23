import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRolloutUsageReader } from "./codex-run-metrics.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const absolute = realpathSync(root);
    if (dirname(absolute) !== realpathSync(tmpdir()) || !basename(absolute).startsWith("mirror-codex-usage-")) throw new Error("unsafe_usage_test_cleanup");
    rmSync(absolute, { recursive: true, force: false });
  }
});

const at = "2026-09-11T10:00:00.000Z";
const metadata = (id: string) => JSON.stringify({ type: "session_meta", payload: { id } });
const tokens = (total = 100) => ({ input_tokens: total - 10, cached_input_tokens: total - 20, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: total });
const legacy = (id: string, total = 100, timestamp = at) => ({ timestamp, type: "token_usage_record", payload: { thread_id: id, session_id: id, thread_token_usage: tokens(total) } });
const event = (total: unknown = tokens(), timestamp = at) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } });
function fixture(sessionId: string, records: unknown[], identity: string | null = sessionId) {
  const home = mkdtempSync(join(tmpdir(), "mirror-codex-usage-")); roots.push(home);
  const directory = join(home, "sessions", "2026", "09", "11"); mkdirSync(directory, { recursive: true });
  const path = join(directory, `rollout-test-${sessionId}.jsonl`);
  writeFileSync(path, [
    ...(identity === null ? [] : [metadata(identity)]),
    ...records.map(record => typeof record === "string" ? record : JSON.stringify(record))
  ].join("\n"));
  return { home, directory, path, reader: new CodexRolloutUsageReader(home) };
}

describe("Codex rollout usage reader", () => {
  it("reads only the latest numeric thread usage for the requested session", () => {
    const sessionId = "session-usage";
    const { reader } = fixture(sessionId, [
      "{malformed", legacy(sessionId),
      legacy("another-session", 999, "2026-09-11T10:00:01.000Z"),
      legacy(sessionId, 150, "2026-09-11T10:00:02.000Z")
    ]);
    expect(reader.snapshot(sessionId)).toEqual({
      input_tokens: 140, cached_input_tokens: 130, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 150,
      observed_at: "2026-09-11T10:00:02.000Z"
    });
  });

  it("reads App Server cumulative token_count without adding reasoning twice or returning raw fields", () => {
    const sessionId = "session-app-server";
    const total = { input_tokens: 106538, cached_input_tokens: 76639, output_tokens: 1087, reasoning_output_tokens: 252, total_tokens: 107625 };
    const record = event({ ...total, raw_text: "fixture private text" });
    const { reader } = fixture(sessionId, [record]);
    expect(reader.snapshot(sessionId)).toEqual({ ...total, observed_at: at });
  });

  it.each(["event", "legacy"])("selects the latest valid cumulative record across schemas ending with %s", schema => {
    const sessionId = "session-mixed", later = "2026-09-11T10:00:05.000Z";
    const records = schema === "event"
      ? [legacy(sessionId), event(tokens(150), later)]
      : [event(), legacy(sessionId, 150, later)];
    const { reader } = fixture(sessionId, records);
    expect(reader.snapshot(sessionId)).toEqual({ ...tokens(150), observed_at: later });
  });

  it.each(["another-session", null])("rejects filename matches when session_meta identity is %s", identity => {
    const sessionId = "session-wrong-meta";
    const { reader } = fixture(sessionId, [legacy(sessionId), event()], identity);
    expect(reader.snapshot(sessionId)).toBeUndefined();
  });

  it("rechecks metadata on cached paths and skips a newer file with the wrong identity", () => {
    const sessionId = "session-cache";
    const { reader, path, directory } = fixture(sessionId, [event()]);
    const wrong = join(directory, `rollout-newer-${sessionId}.jsonl`);
    writeFileSync(wrong, [metadata("another-session"), JSON.stringify(event(tokens(900)))].join("\n"));
    utimesSync(path, new Date("2026-09-10"), new Date("2026-09-10"));
    utimesSync(wrong, new Date("2026-09-11"), new Date("2026-09-11"));
    expect(reader.snapshot(sessionId)).toEqual({ ...tokens(), observed_at: at });
    writeFileSync(path, [metadata("another-session"), JSON.stringify(event(tokens(200)))].join("\n"));
    expect(reader.snapshot(sessionId)).toBeUndefined();
  });

  it("ignores malformed, partial, null and incomplete usage without manufacturing zero", () => {
    const sessionId = "session-incomplete";
    const invalid = [
      event(null), event({ input_tokens: 10 }), event({ ...tokens(), cached_input_tokens: 999 }),
      event({ ...tokens(), reasoning_output_tokens: null }), event({ ...tokens(), total_tokens: -1 }),
      { ...event(), payload: { type: "token_count", info: null } },
      { ...event(), payload: { type: "token_count", info: { last_token_usage: tokens() } } },
      event(tokens(200), "invalid-time"), '{"type":"event_msg","payload":'
    ];
    const empty = fixture(sessionId, invalid);
    expect(empty.reader.snapshot(sessionId)).toBeUndefined();
    const withEarlier = fixture(sessionId, [event(), ...invalid]);
    expect(withEarlier.reader.snapshot(sessionId)).toEqual({ ...tokens(), observed_at: at });
  });

  it("rejects conflicting explicit session identities and token text in other record types", () => {
    const sessionId = "session-conflict";
    const { reader } = fixture(sessionId, [
      { ...legacy(sessionId), payload: { ...legacy(sessionId).payload, thread_id: "another-session" } },
      { ...event(), payload: { ...event().payload, session_id: "another-session" } },
      { ...event(), type: "response_item" }
    ]);
    expect(reader.snapshot(sessionId)).toBeUndefined();
  });

  it("verifies header identity when it is outside the bounded tail and does not search older usage", () => {
    const sessionId = "session-large";
    const { reader, path } = fixture(sessionId, [
      legacy(sessionId, 900), JSON.stringify({ type: "response_item", payload: "x".repeat(8 * 1024 * 1024) }), event()
    ]);
    expect(reader.snapshot(sessionId)).toEqual({ ...tokens(), observed_at: at });
    writeFileSync(path, [metadata(sessionId), JSON.stringify(legacy(sessionId, 900)), "x".repeat(8 * 1024 * 1024 + 1)].join("\n"));
    expect(reader.snapshot(sessionId)).toBeUndefined();
  });

  it("fails closed for an invalid or unavailable session", () => {
    const home = mkdtempSync(join(tmpdir(), "mirror-codex-usage-")); roots.push(home);
    const reader = new CodexRolloutUsageReader(home);
    expect(reader.snapshot("../escape")).toBeUndefined();
    expect(reader.snapshot("missing-session")).toBeUndefined();
  });
});
