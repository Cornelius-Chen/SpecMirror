import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTaskRunPlanProjections } from "./run-plan-api.ts";

afterEach(() => vi.unstubAllGlobals());

const response = () => ({
  schema_version: 1, workspace_id: null, session_id: "current-task", source_cwd: "D:/Work/Mirror",
  projections: [{ workspace_id: null, session_id: "current-task", source_cwd: "D:/Work/Mirror",
    binding: { state: "unassigned", execution_authorized: false, node_id: null, run_id: null, owner: null, contract_key: null } }]
});

describe("task plan observation client", () => {
  it("uses only a read request with the selected task and actual source", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => response() }));
    vi.stubGlobal("fetch", fetch);
    const result = await loadTaskRunPlanProjections("current-task", "d:\\work\\mirror\\");
    expect(result.projections).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url, "http://localhost").searchParams.get("cwd")).toBe("d:\\work\\mirror\\");
    expect(init.method).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it.each(["different-task", "different-cwd", "engineering-authority", "node-link", "workspace-link"])("rejects %s in a task-only response", async variation => {
    const payload = response();
    if (variation === "different-task") payload.projections[0].session_id = "another-task";
    if (variation === "different-cwd") payload.projections[0].source_cwd = "D:/Work/Other";
    if (variation === "engineering-authority") payload.projections[0].binding.execution_authorized = true;
    if (variation === "node-link") Object.assign(payload.projections[0].binding, { node_id: "root" });
    if (variation === "workspace-link") Object.assign(payload.projections[0], { workspace_id: "host" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => payload })));
    await expect(loadTaskRunPlanProjections("current-task", "D:/Work/Mirror")).rejects.toThrow("已拒绝显示");
  });
});
