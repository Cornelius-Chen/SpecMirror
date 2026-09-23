import Fastify from "fastify";
import type { GoalContract } from "@epm/domain";
import { afterEach, describe, expect, it } from "vitest";
import { registerCodexReadinessRoutes, type GatewaySelection } from "./app.ts";
import { CodexReadinessManager } from "./codex-readiness.ts";
import { EventBus } from "./events.ts";
import { CodexAppServerGateway, MockJsonRpcTransport } from "./jsonrpc.ts";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
});

describe("live Codex readiness", () => {
  it("fails the readiness, health and smoke gates immediately after transport failure", async () => {
    const state = new Map<string, string>();
    const runtime = {
      getState: (key: string) => state.get(key),
      setState: (key: string, value: string) => { state.set(key, value); }
    };
    const transport = new MockJsonRpcTransport({});
    const gateway = new CodexAppServerGateway(transport, process.cwd());
    gateway.setReady(true);
    const selection: GatewaySelection = {
      gateway,
      health: { credential: "configured", runtime: "ready", enabled: true, app_server: "ready" }
    };
    const codexReadiness = new CodexReadinessManager({
      root: process.cwd(),
      gatewaySelected: true,
      gatewayReady: () => gateway.ready,
      credentialStatus: "configured",
      runtimeReady: true,
      runtime,
      events: new EventBus(),
      env: { EPM_ENABLE_CODEX: "1" }
    });
    const app = Fastify({ logger: false });
    registerCodexReadinessRoutes(app, {
      selection,
      requestedGateway: "codex-app-server",
      readonlyLegacy: false,
      codexReadiness
    });

    expect((await app.inject({ method: "GET", url: "/api/codex/readiness" })).json()).toMatchObject({ ready_to_run: true });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ gateway_ready: true, app_server: "ready" });

    transport.fail(new Error("codex_app_server_closed:fixture"));

    expect((await app.inject({ method: "GET", url: "/api/codex/readiness" })).json()).toMatchObject({ ready_to_run: false });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ gateway_ready: false, app_server: "unavailable" });
    const smoke = await app.inject({ method: "POST", url: "/api/codex/smoke" });
    expect(smoke.statusCode).toBe(409);
    expect(smoke.json()).toEqual({ error: "codex_smoke_not_ready" });

    await app.close();
    await gateway.close();
  });

  it("redacts turn errors before they can enter a thrown error or run event", async () => {
    const secret = "local-exact-secret-that-is-not-an-openai-token";
    process.env.OPENAI_API_KEY = secret;
    const transport = new MockJsonRpcTransport({
      "thread/start": { thread: { id: "thread-redaction" } },
      "thread/goal/set": {},
      "turn/start": { turn: { id: "turn-redaction", status: "inProgress" } }
    });
    const gateway = new CodexAppServerGateway(transport, process.cwd(), true);
    const goal = testGoal();
    await gateway.start(goal);
    const implementation = gateway.implement(goal, new EventBus());
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    transport.emit({
      method: "turn/completed",
      params: { turn: { id: "turn-redaction", status: "failed", error: { message: `server echoed ${secret}` } } }
    });

    let message = "";
    try { await implementation; }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(secret);
    await gateway.close();
  });
});

function testGoal(): GoalContract {
  return {
    schema_version: 1,
    id: "goal-error-redaction",
    change_set_id: "change-error-redaction",
    title: "Redact turn errors",
    outcome: "Keep runtime records free of credentials",
    status: "compiled",
    ownership_modules: ["orchestrator"],
    write_globs: ["apps/orchestrator/**"],
    shared_contracts: [],
    dependencies: [],
    acceptance_commands: ["pnpm test"],
    unresolved_design_questions: [],
    max_minutes: 5,
    max_turns: 1
  };
}
