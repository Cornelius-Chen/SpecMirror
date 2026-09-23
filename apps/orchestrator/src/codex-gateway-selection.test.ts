import { describe, expect, it } from "vitest";
import { selectGateway } from "./app.ts";
import { CredentialedAppServerTransport } from "./codex-app-server-runtime.ts";
import { MockJsonRpcTransport } from "./jsonrpc.ts";

describe("Codex gateway selection", () => {
  it("accepts a verified Codex-managed ChatGPT login without an API key", async () => {
    const transport = new CredentialedAppServerTransport(new MockJsonRpcTransport({
      "account/read": { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      "model/list": { data: [{ id: "current-default", model: "current-default", isDefault: true }] }
    }));
    const selection = selectGateway("fixture", "codex-app-server", { EPM_ENABLE_CODEX: "1" }, {
      runtimeReady: () => true,
      createTransport: () => transport
    });

    await selection.initialize?.();

    expect(selection.gateway.kind).toBe("codex-app-server");
    expect(selection.gateway.ready).toBe(true);
    expect(selection.health).toMatchObject({
      credential: "configured",
      credential_source: "stored",
      codex_model: "current-default",
      app_server: "ready"
    });
    await selection.gateway.close?.();
  });

  it("fails closed when neither a stored account nor an API key is available", async () => {
    const transport = new CredentialedAppServerTransport(new MockJsonRpcTransport({
      "account/read": { account: null, requiresOpenaiAuth: true }
    }));
    const selection = selectGateway("fixture", "codex-app-server", { EPM_ENABLE_CODEX: "1" }, {
      runtimeReady: () => true,
      createTransport: () => transport
    });

    await selection.initialize?.();

    expect(selection.gateway.ready).toBe(false);
    expect(selection.health).toMatchObject({
      credential: "required",
      credential_source: "none",
      app_server: "unavailable",
      readiness_failure: "credential_required:codex-app-server"
    });
    await selection.gateway.close?.();
  });

  it("does not start App Server until live execution is explicitly enabled", () => {
    let created = false;
    const selection = selectGateway("fixture", "codex-app-server", {}, {
      runtimeReady: () => true,
      createTransport: () => {
        created = true;
        throw new Error("must not start");
      }
    });

    expect(created).toBe(false);
    expect(selection.gateway.ready).toBe(false);
    expect(selection.health).toMatchObject({ enabled: false, app_server: "unavailable" });
  });
});
