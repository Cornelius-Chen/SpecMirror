import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithHumanApproval } from "./human-approval-client.ts";
import { api } from "./api.ts";

vi.mock("./human-approval-client.ts", () => ({
  fetchWithHumanApproval: vi.fn()
}));

describe("Codex smoke API", () => {
  beforeEach(() => vi.mocked(fetchWithHumanApproval).mockReset());

  it.each([
    ["startCodexSmoke", "/api/codex/smoke"],
    ["stopCodexSmoke", "/api/codex/smoke/stop"]
  ] as const)("binds %s to one request-scoped human approval", async (method, url) => {
    const smoke = { status: "idle", message: "ready" };
    vi.mocked(fetchWithHumanApproval).mockResolvedValue(new Response(JSON.stringify(smoke), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    await expect(api[method](undefined, "workspace-current")).resolves.toEqual(smoke);
    const [calledUrl, init, target] = vi.mocked(fetchWithHumanApproval).mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-mirror-workspace-id")).toBe("workspace-current");
    expect(new Headers(init.headers).get("x-mirror-surface")).toBe("current-task");
    expect(target).toEqual({ method: "POST", url, workspace: "workspace-current", body: null });
  });
});
