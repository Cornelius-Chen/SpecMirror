import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { WorkspaceCompanion, type AuthoritativeCodexTurn } from "./workspace-companion.ts";
import type { TaskWorkspaceRecord } from "./task-workspaces.ts";

const fixtures: Array<{ base: string; stores: RuntimeStore[] }> = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "mirror-workspace-identity-"));
  const host = join(base, "host"), source = join(base, "来源任务"), alternate = join(base, "another-source");
  for (const path of [host, source, alternate]) mkdirSync(path);
  const stores: RuntimeStore[] = [];
  const open = () => { const runtime = new RuntimeStore(host); stores.push(runtime); return { runtime, companion: new WorkspaceCompanion(host, runtime, new EventBus()), close: () => { runtime.close(); stores.splice(stores.indexOf(runtime), 1); } }; };
  fixtures.push({ base, stores });
  const record: TaskWorkspaceRecord = { id: "workspace-11111111-2222-3333-4444-555555555555", thread_id: "real-fixture-thread", title: "测试来源任务", source_cwd: source, source_version: "source-v1", kind: "managed", created_at: new Date().toISOString() };
  return { base, host, source, alternate, open, record, ...open() };
}
afterEach(() => {
  vi.useRealTimers();
  for (const { base, stores } of fixtures.splice(0)) {
    for (const runtime of stores) runtime.close();
    const absolute = resolve(base);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_test_cleanup");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("independently verified delegated Codex turns", () => {
  // These isolated lifecycle fixtures have no engineering workspace, owner, or run.
  const workspaces = { records: () => [], contextForAgent: () => undefined, resolve: () => { throw new Error("no workspace should be resolved"); } };
  function stoppedTurn() {
    const f = fixture(), identity = { session_id: f.record.thread_id!, cwd: f.source };
    f.companion.receiveHook({ ...identity, hook_event_name: "SessionStart", turn_id: "old-turn" }, workspaces, 1_000);
    f.companion.receiveHook({ ...identity, hook_event_name: "Stop", turn_id: "old-turn" }, workspaces, 2_000);
    const input = { ...identity, hook_event_name: "PostToolUse", turn_id: "delegated-turn", tool_name: "exec_command" };
    const verified: AuthoritativeCodexTurn = { sessionId: identity.session_id, cwd: f.source, turnId: input.turn_id };
    const state = () => f.runtime.getState("workspace-companion:hook-observations:v1");
    return { ...f, identity, input, verified, state };
  }

  it("observes a signed delegated turn after a same-process Stop only with an exact current-turn attestation", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    const f = stoppedTurn(), before = f.state();
    vi.setSystemTime(new Date("2026-09-12T10:40:00Z"));
    expect(f.companion.needsCurrentTurnVerification(f.input, 3_000)).toBe(true);
    expect(f.state()).toBe(before);
    expect(f.companion.receiveHook(f.input, workspaces, 3_000)).toMatchObject({ accepted: false, ignored: "old_turn_event" });
    expect(f.state()).toBe(before);
    // A caller's body field cannot supply the internal trusted fourth argument.
    const claimedByBody = { ...f.input, authoritativeTurn: f.verified, authenticated: true };
    expect(f.companion.receiveHook(claimedByBody, workspaces, 3_000)).toMatchObject({ accepted: false, identity_observed: false });
    expect(f.state()).toBe(before);

    expect(f.companion.receiveHook(f.input, workspaces, 3_000, f.verified)).toMatchObject({
      accepted: true, identity_observed: true, execution_authorized: false, imported_task_ids: [],
      run_plan_projection: { accepted: false, reason: "lifecycle_only" }
    });
    expect(f.companion.lifecycleObservations(f.record)[0]).toMatchObject({
      turn_id: "delegated-turn", last_event: "PostToolUse", authenticated_at_ms: 3_000, last_seen_at: "2026-09-12T10:40:00.000Z"
    });
    expect(f.companion.needsCurrentTurnVerification(f.input, 3_100)).toBe(false);
    expect(f.companion.receiveHook(f.input, workspaces, 3_100)).toMatchObject({ accepted: true });
    expect(f.companion.receiveHook({ ...f.input, hook_event_name: "Stop" }, workspaces, 3_200)).toMatchObject({ accepted: true });
    expect(f.companion.runPlans.isTurnEnded(f.identity.session_id, "delegated-turn")).toBe(true);
    expect(existsSync(join(f.host, ".project/engineering.yaml"))).toBe(false);
  });

  it.each(["session", "cwd", "turn"])("rejects a current-turn attestation for the wrong %s", field => {
    const f = stoppedTurn(), before = f.state();
    const verified = { ...f.verified, ...(field === "session" ? { sessionId: "other-session" }
      : field === "cwd" ? { cwd: f.alternate } : { turnId: "another-turn" }) };
    expect(f.companion.receiveHook(f.input, workspaces, 3_000, verified)).toMatchObject({ accepted: false, ignored: "old_turn_event" });
    expect(f.state()).toBe(before);
  });

  it("does not request or accept verification for unsigned, non-increasing, wrong-directory, or non-tool events", () => {
    const f = stoppedTurn(), before = f.state();
    const cases = [
      { input: f.input, at: undefined }, { input: f.input, at: 1_999 }, { input: f.input, at: 2_000 },
      { input: f.input, at: Number.NaN }, { input: f.input, at: 3_000.1 },
      { input: { ...f.input, cwd: f.alternate }, at: 3_000 },
      { input: { ...f.input, hook_event_name: "Stop" }, at: 3_000 },
      { input: { ...f.input, hook_event_name: "SubagentStart" }, at: 3_000 },
      { input: { ...f.input, turn_id: "" }, at: 3_000 }
    ];
    for (const candidate of cases) {
      expect(f.companion.needsCurrentTurnVerification(candidate.input, candidate.at)).toBe(false);
      expect(f.companion.receiveHook(candidate.input, workspaces, candidate.at, f.verified)).toMatchObject({ accepted: false, identity_observed: false });
      expect(f.state()).toBe(before);
    }
  });

  it("cannot revive an ended turn or overwrite a newer receipt after an asynchronous lookup", () => {
    const f = stoppedTurn();
    expect(f.companion.needsCurrentTurnVerification(f.input, 3_000)).toBe(true);
    // Another genuine receipt and Stop land while the route awaits its lookup.
    f.companion.receiveHook(f.input, workspaces, 3_100, f.verified);
    f.companion.receiveHook({ ...f.input, hook_event_name: "Stop" }, workspaces, 3_200);
    const ended = f.state();
    expect(f.companion.receiveHook(f.input, workspaces, 3_000, f.verified)).toMatchObject({ accepted: false, ignored: "old_signed_event" });
    expect(f.companion.needsCurrentTurnVerification(f.input, 4_000)).toBe(false);
    expect(f.companion.receiveHook(f.input, workspaces, 4_000, f.verified)).toMatchObject({ accepted: false, ignored: "turn_already_ended" });
    const previous = { ...f.input, turn_id: "old-turn" }, oldAttestation = { ...f.verified, turnId: "old-turn" };
    expect(f.companion.needsCurrentTurnVerification(previous, 5_000)).toBe(false);
    expect(f.companion.receiveHook(previous, workspaces, 5_000, oldAttestation)).toMatchObject({ accepted: false, ignored: "old_turn_event" });
    expect(f.state()).toBe(ended);
  });
});

describe("real Hook observations for task workspace identity", () => {
  it("exposes receipt time without refreshing it on reads and does not stop the parent on SubagentStop", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-06T10:00:00Z"));
    const f = fixture();
    f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.source, hook_event_name: "SubagentStart" });
    const first = f.companion.lifecycleObservations(f.record)[0];
    vi.setSystemTime(new Date("2026-09-06T11:00:00Z"));
    expect(f.companion.lifecycleObservations(f.record)[0].last_seen_at).toBe(first.last_seen_at);
    f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.source, hook_event_name: "SubagentStop" });
    expect(f.companion.lifecycleObservations(f.record)[0].stage).toBe(first.stage);
    expect(f.companion.lifecycleObservations({ ...f.record, source_cwd: f.alternate })).toEqual([]);
    f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.source, hook_event_name: "Stop" });
    expect(f.companion.lifecycleObservations(f.record)[0].stage).toBe("idle");
  });
  it("persists bounded observations across restart without importing plans, arbitrary inputs or authority", () => {
    const f = fixture();
    expect(f.companion.sessions(f.record)).toEqual([]);
    const result = f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.source, hook_event_name: "PostToolUse", tool_name: "update_plan", model: "Bearer fixture-secret", tool_input: { plan: [{ step: "not imported" }], credentials: "fixture-raw-secret" }, last_assistant_message: "fixture-private-message" });
    expect(result).toMatchObject({ identity_observed: true, execution_authorized: false, imported_task_ids: [] });
    const state = f.runtime.getState("workspace-companion:hook-observations:v1")!;
    expect(state).not.toContain("fixture-secret"); expect(state).not.toContain("fixture-raw-secret"); expect(state).not.toContain("fixture-private-message"); expect(state).not.toContain("not imported");
    const original = f.companion.sessions(f.record);
    f.close();
    const reopened = f.open();
    expect(reopened.companion.sessions(f.record)).toEqual(original);
    expect(reopened.companion.lifecycleObservations(f.record)).toEqual([]);
    expect(() => reopened.companion.readStatus({ cwd: f.source, session_id: "real-fixture-thread" })).toThrow("真实 Hook 已发现");
  });

  it("does not infer a session from a source directory and invalidates the old cwd when a real session changes directory", () => {
    const f = fixture();
    expect(() => f.companion.readStatus({ cwd: f.source, session_id: "real-fixture-thread" })).toThrow("尚未被真实 Hook");
    expect(() => f.companion.receiveHook({ session_id: "fake?", cwd: f.source, hook_event_name: "SessionStart" })).toThrow("有效事件");
    expect(() => f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.source, hook_event_name: "Accepted" })).toThrow("有效事件");
    f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.source, hook_event_name: "SessionStart" });
    expect(f.companion.sessions(f.record)).toHaveLength(1);
    const result = f.companion.receiveHook({ session_id: "real-fixture-thread", cwd: f.alternate, hook_event_name: "Stop", stop_hook_active: true });
    expect(result.hook_response).toEqual({ continue: true });
    expect(f.companion.sessions(f.record)).toEqual([]);
    expect(() => f.companion.readStatus({ cwd: f.source, session_id: "real-fixture-thread" })).toThrow("尚未被真实 Hook");
  });

  it("keeps unbound legacy host sessions and descendant cwd reads compatible", () => {
    const f = fixture(), child = join(f.host, "feature"); mkdirSync(child);
    f.companion.receiveHook({ session_id: "legacy-fixture", cwd: child, hook_event_name: "SessionStart" });
    const hostRecord: TaskWorkspaceRecord = { ...f.record, id: "host", thread_id: null, source_cwd: f.host, kind: "existing" };
    expect(f.companion.sessions(hostRecord).map(session => session.session_id)).toEqual(["legacy-fixture"]);
    expect(f.companion.readStatus({ cwd: child, session_id: "legacy-fixture" })).toMatchObject({ project_root: f.host, sessions: [{ session_id: "legacy-fixture", cwd: child }] });
    expect(f.companion.readStatus().workspace).toBeUndefined();
  });

  it("read-only legacy mode admits host Hook identity without importing a Plan into the old archive", () => {
    const f = fixture(), companion = new WorkspaceCompanion(f.host, f.runtime, new EventBus(), { readonlyLegacy: true });
    const result = companion.receiveHook({ session_id: "legacy-fixture", cwd: f.host, hook_event_name: "PostToolUse", tool_name: "update_plan", tool_input: { plan: [{ step: "must not import", status: "in_progress" }] } });
    expect(result).toMatchObject({ identity_observed: true, execution_authorized: false, imported_task_ids: [] });
    expect(companion.sessions({ ...f.record, id: "host", thread_id: null, source_cwd: f.host, kind: "existing" })).toHaveLength(1);
    expect(f.runtime.getState("codex-companion:sessions")).toBeUndefined();
    expect(existsSync(join(f.host, ".project/supervision/specmirror-m1.yaml"))).toBe(false);
  });
});
