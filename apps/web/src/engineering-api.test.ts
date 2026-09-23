import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngineeringApi } from "./engineering-api.ts";
import { humanApprovalHeaders } from "./human-approval-client.ts";

vi.mock("./human-approval-client.ts", () => ({
  humanApprovalHeaders: vi.fn(async () => ({
    "x-mirror-human-approval-attempt": "attempt-one",
    "x-mirror-human-approval-assertion": "signed-assertion"
  }))
}));

afterEach(() => vi.unstubAllGlobals());

describe("structure proposal client", () => {
  it("binds preview and commit to one proposal without inventing human identity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    const api = createEngineeringApi("workspace-one");

    await api.previewStructure("proposal-one");
    await api.commitStructure("proposal-one", "preview-token", 118);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "/api/engineering/structure-proposal/preview",
      init: { method: "POST", body: JSON.stringify({ proposal_id: "proposal-one" }) }
    });
    expect(calls[1]).toMatchObject({
      url: "/api/engineering/structure-proposal/commit",
      init: { method: "POST", body: JSON.stringify({ proposal_id: "proposal-one", token: "preview-token", expected_revision: 118 }) }
    });
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["x-mirror-workspace-id"]).toBe("workspace-one");
      expect(headers["x-engineering-agent-session-id"]).toBeUndefined();
      expect(headers["x-engineering-cwd"]).toBeUndefined();
      expect(headers["x-human-approved"]).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    }
  });

  it("retries an exact supervisor request only after a verified approval ceremony", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return { ok: false, status: 403, json: async () => ({ code: "human_approval_required" }) } as Response;
      return { ok: true, status: 200, json: async () => ({ document: { revision: 119 } }) } as Response;
    }));

    await createEngineeringApi("workspace-one").ready("node-one", 118);

    expect(humanApprovalHeaders).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/engineering/nodes/node-one/ready",
      workspace: "workspace-one",
      body: { expected_revision: 118 }
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].init?.headers).toMatchObject({
      "x-mirror-workspace-id": "workspace-one",
      "x-mirror-human-approval-attempt": "attempt-one",
      "x-mirror-human-approval-assertion": "signed-assertion"
    });
  });
});

describe("read-only run results", () => {
  const payload = (workspace = "workspace /中文", runId = "run /中文") => ({ schema_version: 1, kind: "engineering-run-result", workspace_id: workspace, node_id: "node-one", run_id: runId,
    observed_at: "2026-09-12T21:00:00Z", contract_key: "frozen", node_revision: 1, run_status: "review", current_contract: true,
    started_at: "2026-09-12T20:00:00Z", finished_at: null, review: null, artifacts: [], source_checks: [], metrics: null, issues: [] });
  it("uses one scoped, encoded, uncached GET for reads and downloads and forwards cancellation", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 })); vi.stubGlobal("fetch", fetcher);
    const api = createEngineeringApi("workspace /中文"), controller = new AbortController();
    await api.result("run /中文", controller.signal);
    expect(fetcher).toHaveBeenCalledWith(api.resultUrl("run /中文"), expect.objectContaining({ method: "GET", cache: "no-store", signal: controller.signal }));
    const url = new URL(api.resultUrl("run /中文"), "http://localhost");
    expect(decodeURIComponent(url.pathname)).toBe("/api/engineering/runs/run /中文/result");
    expect([...url.searchParams]).toEqual([["workspace", "workspace /中文"]]);
    expect(createEngineeringApi().resultUrl("run-one")).toBe("/api/engineering/runs/run-one/result?workspace=host");
  });
  it("rejects wrong workspace/run and never starts a human approval ceremony on a result read", async () => {
    vi.mocked(humanApprovalHeaders).mockClear();
    for (const value of [payload("foreign"), payload(undefined, "foreign")]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value))));
      await expect(createEngineeringApi("workspace /中文").result("run /中文")).rejects.toThrow("不匹配");
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: "human_approval_required", error: "sensitive source path" }), { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(createEngineeringApi("workspace /中文").result("run /中文")).rejects.toThrow("403");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(humanApprovalHeaders).not.toHaveBeenCalled();
  });
  it("reports 404 and malformed JSON without returning stale data or raw errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private stack", { status: 404 })));
    await expect(createEngineeringApi().result("missing")).rejects.toThrow("不存在");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>error</html>")));
    await expect(createEngineeringApi().result("missing")).rejects.toThrow("JSON");
  });
});

describe("check configuration revalidation package", () => {
  it("approves the exact combined request once and never dispatches or accepts a run", async () => {
    vi.mocked(humanApprovalHeaders).mockClear();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 2) return new Response(JSON.stringify({ code: "human_approval_required" }), { status: 403 });
      return new Response(JSON.stringify({ document: { revision: 10 } }));
    }));
    const request = { expected_revision: 9, reason: "修正检查配置，保留旧记录并复验", items: [
      { node_id: "one", prior_run_id: "old-one", checks: [{ id: "tests", args: ["vitest.mjs", "--config", "vitest.config.ts"] }] },
      { node_id: "two", prior_run_id: "old-two", checks: [{ id: "tests", args: ["vitest.mjs", "--config", "vitest.config.ts"] }] }
    ] };
    const api = createEngineeringApi("work");
    await api.previewRecheckWorkPackage(request);
    await api.commitRecheckWorkPackage("preview", request);
    expect(humanApprovalHeaders).toHaveBeenCalledTimes(1);
    expect(humanApprovalHeaders).toHaveBeenCalledWith({ method: "POST", url: "/api/engineering/work-package/recheck/commit", workspace: "work", body: { token: "preview", request } });
    expect(calls.map(call => call.url)).toEqual(["/api/engineering/work-package/recheck/preview", "/api/engineering/work-package/recheck/commit", "/api/engineering/work-package/recheck/commit"]);
    expect(calls[1].init?.body).toBe(calls[2].init?.body);
    expect(calls.every(call => (call.init?.headers as Record<string, string>)["x-mirror-workspace-id"] === "work")).toBe(true);
  });
});
