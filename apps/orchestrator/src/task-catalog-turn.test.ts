import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { TaskCatalog } from "./task-catalog.ts";
import type { JsonRpcTransport } from "./stdio-jsonrpc.ts";

afterEach(() => vi.useRealTimers());
function fixture() {
  const input = { sessionId: "real-task", cwd: process.cwd(), turnId: "new-turn" };
  const thread = { id: input.sessionId, cwd: input.cwd, source: "vscode", ephemeral: false, parentThreadId: null, updatedAt: 100 };
  let turns: unknown = { data: [{ id: input.turnId, status: "inProgress", completedAt: null, items: [{ text: "not-returned" }] }] };
  const request = vi.fn(async (method: string) => method === "thread/read" ? { thread } : turns);
  const close = vi.fn(async () => {});
  const transport = { request, close, notify: async () => {}, onNotification: () => () => {} } as unknown as JsonRpcTransport;
  const factory = vi.fn(() => ({ ...transport }));
  const catalog = new TaskCatalog(process.cwd(), factory);
  return { input, thread, request, close, catalog, factory, setTurns: (value: unknown) => { turns = value; } };
}
describe("signed Hook current-turn corroboration", () => {
  it("uses only bounded read APIs and returns no conversation content or authority", async () => {
    const f = fixture(); expect(await f.catalog.verifyCurrentTurn(f.input)).toEqual(f.input);
    expect(f.request.mock.calls).toEqual([
      ["thread/read", { threadId: "real-task", includeTurns: false }],
      ["thread/turns/list", { threadId: "real-task", limit: 1, sortDirection: "desc", itemsView: "summary" }]
    ]);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(["id", "cwd", "source"])("rejects mismatched thread %s before reading turns", async field => {
    const f = fixture(); Object.assign(f.thread, { [field]: field === "cwd" ? resolve(process.cwd(), "other-workspace") : "wrong" });
    expect(await f.catalog.verifyCurrentTurn(f.input)).toBeNull(); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([{ ephemeral: true }, { ephemeral: undefined }, { parentThreadId: "parent" }, { parentThreadId: undefined }, { updatedAt: NaN }])("rejects non-standalone or incomplete thread metadata: %j", async patch => {
    const f = fixture(); Object.assign(f.thread, patch);
    expect(await f.catalog.verifyCurrentTurn(f.input)).toBeNull(); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { data: [] }, { data: [{ id: "older", status: "inProgress", completedAt: null }] },
    { data: [{ id: "new-turn", status: "completed", completedAt: null }] },
    { data: [{ id: "new-turn", status: "interrupted", completedAt: 100 }] },
    { data: [{ id: "new-turn", status: "inProgress" }] },
    { data: [{ id: "new-turn", status: "unknown", completedAt: null }] }
  ])("rejects missing, ended or unverified current-turn metadata: %j", async value => {
    const f = fixture(); f.setTurns(value); expect(await f.catalog.verifyCurrentTurn(f.input)).toBeNull();
  });
  it("corroborates a recovering desktop turn only while it has no completion timestamp", async () => {
    const f = fixture(); f.setTurns({ data: [{ id: "new-turn", status: "interrupted", completedAt: null }] });
    expect(await f.catalog.verifyCurrentTurn(f.input)).toEqual(f.input);
  });
  it("never reuses a positive answer after a newer turn appears", async () => {
    const f = fixture(); expect(await f.catalog.verifyCurrentTurn(f.input)).toEqual(f.input);
    f.setTurns({ data: [{ id: "later", status: "inProgress", completedAt: null }] });
    expect(await f.catalog.verifyCurrentTurn(f.input)).toBeNull(); expect(f.factory).toHaveBeenCalledTimes(2);
  });
  it("fails closed on RPC failure", async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error("offline"));
    expect(await f.catalog.verifyCurrentTurn(f.input)).toBeNull(); expect(f.close).toHaveBeenCalledOnce();
  });
  it("bounds timeout and concurrency and discards late replies", async () => {
    vi.useFakeTimers(); const f = fixture();
    let release!: (value: { thread: typeof f.thread }) => void;
    f.request.mockImplementation(() => new Promise(resolveReply => { release = resolveReply; }));
    const first = f.catalog.verifyCurrentTurn(f.input), second = f.catalog.verifyCurrentTurn(f.input);
    expect(await f.catalog.verifyCurrentTurn(f.input)).toBeNull(); expect(f.factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await first).toBeNull(); expect(await second).toBeNull();
    release({ thread: f.thread }); await Promise.resolve();
    expect(f.request.mock.calls.every(([method]) => method === "thread/read")).toBe(true);
  });
  it("rejects invalid identities without starting a transport", async () => {
    const f = fixture(); expect(await f.catalog.verifyCurrentTurn({ ...f.input, sessionId: "bad?" })).toBeNull();
    expect(f.factory).not.toHaveBeenCalled();
  });
});
