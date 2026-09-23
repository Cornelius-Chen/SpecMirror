import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConnectedTasks, visibleConnectedTasks, type ConnectedTask } from "./connected-tasks.ts";

const task = (id: string, title = "图上查看结果"): ConnectedTask => ({ id, title, cwd: "D:/project", updatedAt: 100, archive_status: "unknown" });
afterEach(() => vi.unstubAllGlobals());

describe("connected task navigation", () => {
  it("deduplicates against visible directory entries and searches the actual display name", () => {
    const rows = [task("listed"), task("new", "Codex 新任务"), task("new"), task("other")];
    expect(visibleConnectedTasks(rows, ["listed"], " CODEX ").map(row => row.id)).toEqual(["new"]);
    expect(visibleConnectedTasks(rows, ["listed"], "").map(row => row.id)).toEqual(["new", "other"]);
  });
  it("performs only a read and preserves unknown archive status independently of task progress", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [task("new")], partial: false }) }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await loadConnectedTasks(controller.signal)).toEqual({ data: [task("new")], partial: false });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/task-inbox/connections", { signal: controller.signal, cache: "no-store" });
  });
  it("does not convert failed, malformed, or over-limit responses into an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    await expect(loadConnectedTasks()).rejects.toThrow("暂时无法读取");
    for (const value of [{ data: [], partial: undefined }, { data: [task("x"), { id: "bad" }], partial: false }, { data: Array.from({ length: 21 }, (_, i) => task(String(i))), partial: false }]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => value })));
      await expect(loadConnectedTasks()).rejects.toThrow("记录无效");
    }
  });
  it("preserves partial failure instead of implying every observed candidate was resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [task("new")], partial: true }) })));
    expect((await loadConnectedTasks()).partial).toBe(true);
  });
});
