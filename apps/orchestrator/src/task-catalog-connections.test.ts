import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { TaskCatalog, registerTaskCatalogRoutes, type TaskConnectionCandidate } from "./task-catalog.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";
import type { JsonRpcTransport } from "./stdio-jsonrpc.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(read?: (id: string) => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), "mirror-connections-"));
  cleanups.push(() => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe_test_cleanup"); rmSync(root, { recursive: true, force: true }); });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transports: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const thread = (id: string) => ({ id, name: `任务 ${id}`, cwd: root, updatedAt: 100, source: "vscode", ephemeral: false, parentThreadId: null });
  const factory = () => {
    const transport = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "thread/read") return { thread: await (read?.(String(params.threadId)) ?? thread(String(params.threadId))) };
        if (method === "thread/list") return { data: [thread("original-directory")], nextCursor: "existing-cursor" };
        throw Error("unexpected_rpc");
      }, close: vi.fn(async () => {}), notify: async () => {}, onNotification: () => () => {}
    };
    transports.push(transport); return transport as JsonRpcTransport;
  };
  const candidate = (id: string, overrides: Partial<TaskConnectionCandidate> = {}): TaskConnectionCandidate => ({ thread_id: id, cwd: root, source: "hook", observed_at: new Date().toISOString(), ...overrides });
  const catalog = new TaskCatalog(root, factory);
  return { root, catalog, calls, transports, candidate, thread };
}

describe("bounded recent Codex connections", () => {
  it("registers the static read-only route separately from current and archive pagination", async () => {
    const f = fixture(), app = Fastify();
    registerTaskCatalogRoutes(app, f.root, f.catalog, () => [f.candidate("connected")]);
    const response = await app.inject({ url: "/api/task-inbox/connections?archived=true&search=ignored" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ id: "connected", title: "任务 connected", cwd: f.root, updatedAt: 100, archive_status: "unknown" }], partial: false });
    expect(f.calls).toEqual([{ method: "thread/read", params: { threadId: "connected", includeTurns: false } }]);
    const original = await app.inject({ url: "/api/task-inbox?archived=true&search=原目录&cursor=older" });
    expect(original.json().data.map((item: {id:string}) => item.id)).toEqual(["original-directory"]);
    expect(original.json().nextCursor).toBe("existing-cursor");
    expect(f.calls.at(-1)).toMatchObject({ method: "thread/list", params: { archived: true, searchTerm: "原目录", cursor: "older", useStateDbOnly: true } });
    expect(original.json().data[0].archive_status).toBeUndefined();
    await app.close();
  });

  it("deduplicates candidates, caps reads at twenty and uses at most two concurrent requests", async () => {
    vi.useFakeTimers(); let active = 0, peak = 0;
    const f = fixture(async id => { active++; peak = Math.max(active, peak); await new Promise(done => setTimeout(done, 10)); active--; return f.thread(id); });
    const input = Array.from({ length: 25 }, (_, index) => f.candidate(`task-${index}`));
    const result = f.catalog.connections([...input, f.candidate("task-0", { source: "workspace" })]);
    await vi.runAllTimersAsync();
    expect((await result).data).toHaveLength(20); expect((await result).partial).toBe(true);
    expect(f.calls).toHaveLength(20); expect(new Set(f.calls.map(call => call.params.threadId)).size).toBe(20); expect(peak).toBe(2);
  });

  it("coalesces simultaneous requests and caches success without invalidation from a new Hook timestamp", async () => {
    vi.useFakeTimers(); const f = fixture(async id => { await new Promise(done => setTimeout(done, 20)); return f.thread(id); });
    const input = [f.candidate("one"), f.candidate("two")];
    const first = f.catalog.connections(input), second = f.catalog.connections(input);
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toEqual(await second); expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await f.catalog.connections([f.candidate("one"), f.candidate("two")])).data).toHaveLength(2); expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    const expired = f.catalog.connections(input); await vi.advanceTimersByTimeAsync(20);
    expect((await expired).data).toHaveLength(2); expect(f.calls).toHaveLength(4);
  });

  it("allows immediate retry after failure without manufacturing inaccessible tasks", async () => {
    vi.useFakeTimers(); let available = false;
    const f = fixture(async id => { if (!available) throw Error("thread_not_found_with_private_detail"); return f.thread(id); });
    const input = [f.candidate("missing")];
    const failed = await f.catalog.connections(input);
    expect(failed).toMatchObject({ data: [], partial: true }); expect(JSON.stringify(failed)).not.toContain("private_detail");
    available = true;
    expect((await f.catalog.connections(input)).data[0].id).toBe("missing"); expect(f.calls).toHaveLength(2);
  });

  it("rejects identity, cwd, source, parent and ephemeral mismatches and missing metadata", async () => {
    const invalid: Record<string, object> = {
      identity: { id: "someone-else" }, cwd: { cwd: join(tmpdir(), "different-project") },
      exec: { source: "exec" }, unknown: { source: "unknown" }, child: { source: { subAgent: { other: "worker" } } },
      ephemeral: { ephemeral: true }, parent: { parentThreadId: "parent" }, missingParent: { parentThreadId: undefined },
      missingEphemeral: { ephemeral: undefined }, missingSource: { source: undefined }, badTime: { updatedAt: Number.NaN }
    };
    const f = fixture(async id => ({ ...f.thread(id), ...invalid[id] }));
    const result = await f.catalog.connections([...Object.keys(invalid).map(id => f.candidate(id)), f.candidate("good")]);
    expect(result.data.map(task => task.id)).toEqual(["good"]); expect(result.partial).toBe(true);
  });

  it("ignores stale Hook and invalid candidates and removes expired or deleted hints from cached responses", async () => {
    vi.useFakeTimers(); const f = fixture(), old = new Date(Date.now() - 31 * 60_000).toISOString();
    expect((await f.catalog.connections([f.candidate("stale", { observed_at: old }), f.candidate("relative", { cwd: "relative" }), f.candidate("bad?id")])).data).toEqual([]);
    expect(f.calls).toHaveLength(0);
    const fresh = f.candidate("fresh"); expect((await f.catalog.connections([fresh])).data).toHaveLength(1);
    expect((await f.catalog.connections([])).data).toEqual([]);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect((await f.catalog.connections([fresh])).data).toEqual([]);
    // Persistently bound workspaces remain candidates independently of Hook freshness.
    expect((await f.catalog.connections([f.candidate("bound", { source: "workspace", observed_at: old })])).data[0].id).toBe("bound");
  });

  it("does not return a removed candidate when candidate sources change during an in-flight batch", async () => {
    vi.useFakeTimers(); const f = fixture(async id => { await new Promise(done => setTimeout(done, 20)); return f.thread(id); });
    const original = f.catalog.connections([f.candidate("old")]);
    const changed = f.catalog.connections([f.candidate("new")]);
    await vi.advanceTimersByTimeAsync(20);
    expect((await original).data[0].id).toBe("old"); expect(await changed).toMatchObject({ data: [], partial: true });
    const next = f.catalog.connections([f.candidate("new")]); await vi.advanceTimersByTimeAsync(20);
    expect((await next).data[0].id).toBe("new");
  });

  it("ends a stalled batch at its deadline without blocking or closing normal catalog reads", async () => {
    vi.useFakeTimers(); const f = fixture(async () => new Promise(() => {}));
    await f.catalog.list({}); // Separate original-directory transport.
    const result = f.catalog.connections(Array.from({ length: 20 }, (_, index) => f.candidate(`slow-${index}`)));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ data: [], partial: true });
    expect(f.calls.filter(call => call.method === "thread/read")).toHaveLength(2);
    expect(f.transports[0].close).not.toHaveBeenCalled(); expect(f.transports[1].close).toHaveBeenCalledOnce();
    expect((await f.catalog.list({ archived: true })).data[0].id).toBe("original-directory");
  });

  it("reports provider failures as retryable instead of an empty successful connection list", async () => {
    const f = fixture(), app = Fastify();
    registerTaskCatalogRoutes(app, f.root, f.catalog, () => { throw Error("registry_unavailable"); });
    const response = await app.inject({ url: "/api/task-inbox/connections" });
    expect(response.statusCode).toBe(503); expect(response.json().data).toBeUndefined();
    expect(f.calls).toHaveLength(0); await app.close();
  });

  it("uses only recent signed Hook records as discovery hints while leaving restart presence unproven", () => {
    vi.useFakeTimers(); const f = fixture(), runtime = new RuntimeStore(f.root);
    cleanups.push(() => runtime.close());
    const companion = new WorkspaceCompanion(f.root, runtime, new EventBus(), { readonlyLegacy: true });
    companion.receiveHook({ session_id: "unsigned", cwd: f.root, hook_event_name: "SessionStart" });
    companion.receiveHook({ session_id: "signed", cwd: f.root, hook_event_name: "SessionStart" }, undefined, Date.now());
    const before = runtime.getState("workspace-companion:hook-observations:v1");
    const restarted = new WorkspaceCompanion(f.root, runtime, new EventBus(), { readonlyLegacy: true });
    expect(restarted.taskConnectionCandidates().map(candidate => candidate.thread_id)).toEqual(["signed"]);
    expect(restarted.lifecycleObservations({ id: "host", thread_id: null, title: "host", source_cwd: f.root, kind: "existing", source_version: null, created_at: new Date().toISOString() })).toEqual([]);
    expect(runtime.getState("workspace-companion:hook-observations:v1")).toBe(before);
    vi.advanceTimersByTime(31 * 60_000); expect(restarted.taskConnectionCandidates()).toEqual([]);
  });
});
