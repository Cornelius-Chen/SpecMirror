import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialedAppServerTransport, projectCodexLaunchOptions } from "./codex-app-server-runtime.ts";
import { AppServerRpcError, type JsonRpcNotification, type JsonRpcTransport } from "./stdio-jsonrpc.ts";

class RecordingTransport implements JsonRpcTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(readonly respond: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>) {}

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    return await this.respond(method, params) as T;
  }

  async notify(method: string, params: Record<string, unknown> = {}) { this.calls.push({ method, params }); }
  onNotification(_listener: (notification: JsonRpcNotification) => void) { return () => undefined; }
  async close() { await Promise.resolve(); }
}

describe("credentialed Codex App Server transport", () => {
  it("authenticates once through the pinned API-key RPC before concurrent operational requests", async () => {
    const secret = "sk-test-only-secret-123456";
    let accountReads = 0;
    const raw = new RecordingTransport((method) => {
      if (method === "account/read") return ++accountReads === 1
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      if (method === "account/login/start") return { type: "apiKey" };
      if (method === "model/list") return { data: [{ id: "gpt-5.4", model: "gpt-5.4" }] };
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "thread/resume") return { thread: { id: "thread-2" } };
      throw new Error(`unexpected:${method}`);
    });
    const transport = new CredentialedAppServerTransport(raw, secret, "gpt-5.4");

    await expect(Promise.all([
      transport.request("thread/start", { sandbox: "workspace-write" }),
      transport.request("thread/resume", { sandbox: "workspace-write" })
    ])).resolves.toHaveLength(2);

    expect(raw.calls.map((call) => call.method)).toEqual([
      "account/read", "account/login/start", "account/read", "model/list", "thread/start", "thread/resume"
    ]);
    expect(raw.calls[1]).toEqual({ method: "account/login/start", params: { type: "apiKey", apiKey: secret } });
    expect(raw.calls.filter((call) => call.method === "account/login/start")).toHaveLength(1);
    expect(transport.readiness()).toEqual({ status: "ready", credential_source: "api-key", model_count: 1, selected_model: "gpt-5.4", reason: null });
    expect(JSON.stringify(transport.readiness())).not.toContain(secret);
    expect(JSON.stringify(transport)).not.toContain(secret);
  });

  it("uses an existing App Server account without forwarding the supplied key", async () => {
    const raw = new RecordingTransport((method) => {
      if (method === "account/read") return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      if (method === "model/list") return { data: [{ id: "gpt-5.4", model: "gpt-5.4" }] };
      if (method === "thread/start") return { thread: { id: "thread-stored" } };
      throw new Error(`unexpected:${method}`);
    });
    const transport = new CredentialedAppServerTransport(raw, "sk-unused-secret-123456", "gpt-5.4");

    await transport.request("thread/start", {});

    expect(raw.calls.map((call) => call.method)).toEqual(["account/read", "model/list", "thread/start"]);
    expect(transport.readiness().credential_source).toBe("stored");
  });

  it("uses the App Server default model when no model override is configured", async () => {
    const raw = new RecordingTransport((method) => {
      if (method === "account/read") return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
      if (method === "model/list") return { data: [
        { id: "older-model", model: "older-model", isDefault: false },
        { id: "current-default", model: "current-default", isDefault: true }
      ] };
      if (method === "thread/start") return { thread: { id: "thread-default" } };
      throw new Error(`unexpected:${method}`);
    });
    const transport = new CredentialedAppServerTransport(raw);

    await expect(transport.request("thread/start", {})).resolves.toEqual({ thread: { id: "thread-default" } });

    expect(transport.readiness()).toEqual({ status: "ready", credential_source: "stored", model_count: 2, selected_model: "current-default", reason: null });
    expect(transport.selectedModel()).toBe("current-default");
  });

  it("reads every model/list page before accepting an expected model", async () => {
    const raw = new RecordingTransport((method, params) => {
      if (method === "account/read") return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      if (method === "model/list" && params.cursor === undefined) {
        return { data: [{ id: "first-page-model", model: "first-page-model" }], nextCursor: "page-2" };
      }
      if (method === "model/list" && params.cursor === "page-2") {
        return { data: [{ id: "gpt-5.4", model: "gpt-5.4" }], nextCursor: null };
      }
      if (method === "thread/start") return { thread: { id: "thread-paged" } };
      throw new Error(`unexpected:${method}`);
    });
    const transport = new CredentialedAppServerTransport(raw, undefined, "gpt-5.4");

    await expect(transport.request("thread/start", {})).resolves.toEqual({ thread: { id: "thread-paged" } });

    expect(raw.calls).toEqual([
      { method: "account/read", params: { refreshToken: false } },
      { method: "model/list", params: { limit: 20, includeHidden: false } },
      { method: "model/list", params: { limit: 20, includeHidden: false, cursor: "page-2" } },
      { method: "thread/start", params: {} }
    ]);
    expect(transport.readiness()).toEqual({ status: "ready", credential_source: "stored", model_count: 2, selected_model: "gpt-5.4", reason: null });
  });

  it("fails closed before operational RPCs for missing credentials, rejected auth, and unavailable models", async () => {
    const missing = new RecordingTransport((method) => method === "account/read"
      ? { account: null, requiresOpenaiAuth: true }
      : (() => { throw new Error(`unexpected:${method}`); })());
    const missingTransport = new CredentialedAppServerTransport(missing, undefined, "gpt-5.4");
    await expect(missingTransport.request("thread/start", {})).rejects.toThrow("credential_required:codex-app-server");
    expect(missing.calls.map((call) => call.method)).toEqual(["account/read"]);

    const rejected = new RecordingTransport((method) => {
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
      if (method === "account/login/start") throw new AppServerRpcError(method, 401, "unauthorized");
      throw new Error(`unexpected:${method}`);
    });
    const rejectedTransport = new CredentialedAppServerTransport(rejected, "sk-rejected-secret-123456", "gpt-5.4");
    await expect(rejectedTransport.request("thread/start", {})).rejects.toThrow("authentication_error:codex-app-server");
    expect(rejected.calls.map((call) => call.method)).toEqual(["account/read", "account/login/start"]);
    expect(JSON.stringify(rejectedTransport.readiness())).not.toContain("sk-rejected-secret-123456");

    const unavailable = new RecordingTransport((method) => {
      if (method === "account/read") return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      if (method === "model/list") return { data: [{ id: "different-model", model: "different-model" }] };
      throw new Error(`unexpected:${method}`);
    });
    const unavailableTransport = new CredentialedAppServerTransport(unavailable, undefined, "gpt-5.4");
    await expect(unavailableTransport.request("thread/start", {})).rejects.toThrow("codex_model_unavailable:model/list");
    expect(unavailable.calls.map((call) => call.method)).toEqual(["account/read", "model/list"]);
  });

  it("uses an isolated ephemeral credential store and removes the key from the App Server environment", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-codex-runtime-"));
    const secret = "sk-launch-secret-123456";
    try {
      const options = projectCodexLaunchOptions(root, {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        OPENAI_API_KEY: secret,
        UNRELATED_SECRET: "must-not-pass"
      });
      expect(options.cwd).toBe(root);
      expect(options.args).toEqual(expect.arrayContaining(["-c", 'cli_auth_credentials_store="ephemeral"', "app-server", "--listen", "stdio://"]));
      if (process.platform === "win32") {
        expect(options.args).toEqual(expect.arrayContaining(["-c", 'windows.sandbox="unelevated"']));
      } else {
        expect(options.args).not.toContain('windows.sandbox="unelevated"');
      }
      expect(options.env?.CODEX_HOME).toBe(join(root, ".project", ".runtime", "codex-home"));
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(readTree(root)).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses the existing Codex home only when no API key fallback is configured", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-codex-stored-runtime-"));
    try {
      const options = projectCodexLaunchOptions(root, {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: process.env.USERPROFILE,
        HOME: process.env.HOME,
        UNRELATED_SECRET: "must-not-pass"
      });
      expect(options.args).not.toContain('cli_auth_credentials_store="ephemeral"');
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(options.env?.CODEX_HOME).toBeUndefined();
      expect(options.env?.USERPROFILE).toBe(process.env.USERPROFILE);
      expect(readTree(root)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function readTree(root: string) {
  const content: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) content.push(readTree(path));
    else if (entry.isFile() && statSync(path).size < 1_000_000) content.push(readFileSync(path, "utf8"));
  }
  return content.join("\n");
}
