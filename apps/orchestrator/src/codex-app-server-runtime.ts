import { createRequire } from "node:module";
import { join } from "node:path";
import type { JsonRpcNotification, JsonRpcTransport, StdioJsonRpcOptions } from "./stdio-jsonrpc.ts";
import { AppServerRpcError, StdioJsonRpcTransport, isolatedAppServerEnvironment, redactSecrets, safeAppServerEnvironment } from "./stdio-jsonrpc.ts";

type AccountReadResult = {
  account?: { type?: string } | null;
  requiresOpenaiAuth?: boolean;
};

type ModelListResult = {
  data?: Array<{ id?: string; model?: string; isDefault?: boolean }>;
  nextCursor?: string | null;
};

export interface AppServerAuthReadiness {
  status: "idle" | "checking" | "ready" | "failed";
  credential_source: "none" | "stored" | "api-key" | "provider";
  model_count: number;
  selected_model: string | null;
  reason: string | null;
}

/**
 * Authenticates the pinned App Server before any operational RPC is allowed.
 * Existing Codex-managed login state may be reused without exposing tokens to
 * this process. An API key remains an isolated fallback and is never inherited
 * through the spawned child environment.
 */
export class CredentialedAppServerTransport implements JsonRpcTransport {
  #authentication?: Promise<void>;
  #readiness: AppServerAuthReadiness = { status: "idle", credential_source: "none", model_count: 0, selected_model: null, reason: null };
  readonly #apiKey?: string;
  readonly #transport: JsonRpcTransport;

  constructor(
    transport: JsonRpcTransport,
    apiKey?: string,
    readonly expectedModel = ""
  ) { this.#transport = transport; this.#apiKey = apiKey; }

  readiness(): AppServerAuthReadiness { return { ...this.#readiness }; }
  selectedModel() { return this.#readiness.selected_model ?? undefined; }

  async verify() {
    await this.#ensureAuthenticated();
    return this.readiness();
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.#ensureAuthenticated();
    return this.#transport.request<T>(method, params);
  }

  async notify(method: string, params: Record<string, unknown> = {}) {
    await this.#ensureAuthenticated();
    return this.#transport.notify(method, params);
  }

  onNotification(listener: (notification: JsonRpcNotification) => void) {
    return this.#transport.onNotification(listener);
  }

  onError(listener: (error: Error) => void) {
    return this.#transport.onError?.(listener) ?? (() => undefined);
  }

  close() { return this.#transport.close(); }

  #ensureAuthenticated() {
    return this.#authentication ??= this.#authenticate();
  }

  async #authenticate() {
    let source: AppServerAuthReadiness["credential_source"] = "none";
    this.#readiness = { status: "checking", credential_source: source, model_count: 0, selected_model: null, reason: null };
    try {
      let account = await this.#transport.request<AccountReadResult>("account/read", { refreshToken: false });
      source = account.account ? "stored" : account.requiresOpenaiAuth === false ? "provider" : "none";
      if (!account.account && account.requiresOpenaiAuth !== false) {
        if (!this.#apiKey?.trim()) throw new Error("credential_required:codex-app-server");
        const login = await this.#transport.request<{ type?: string }>("account/login/start", { type: "apiKey", apiKey: this.#apiKey });
        if (login.type !== "apiKey") throw new Error("authentication_error:account/login/start");
        account = await this.#transport.request<AccountReadResult>("account/read", { refreshToken: false });
        if (account.account?.type !== "apiKey") throw new Error("authentication_error:account/read");
        source = "api-key";
      }
      if (!account.account && account.requiresOpenaiAuth !== false) throw new Error("authentication_error:account/read");
      const models: NonNullable<ModelListResult["data"]> = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.#transport.request<ModelListResult>("model/list", {
          limit: 20,
          includeHidden: false,
          ...(cursor ? { cursor } : {})
        });
        if (!Array.isArray(page.data)) throw new Error("codex_runtime_unavailable:model/list");
        models.push(...page.data);
        if (page.nextCursor === undefined || page.nextCursor === null) break;
        if (typeof page.nextCursor !== "string" || !page.nextCursor || seenCursors.has(page.nextCursor)) {
          throw new Error("codex_runtime_unavailable:model/list");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (true);
      if (models.length === 0) throw new Error("codex_runtime_unavailable:model/list");
      const explicitModel = this.expectedModel.trim();
      const selected = explicitModel
        ? models.find((model) => model.id === explicitModel || model.model === explicitModel)
        : models.find((model) => model.isDefault) ?? models[0];
      const selectedModel = selected?.id ?? selected?.model;
      if (explicitModel && !selected) {
        throw new Error("codex_model_unavailable:model/list");
      }
      if (!selectedModel) throw new Error("codex_runtime_unavailable:model/list");
      this.#readiness = { status: "ready", credential_source: source, model_count: models.length, selected_model: selectedModel, reason: null };
    } catch (error) {
      const reason = safeReadinessFailure(error, this.#apiKey);
      this.#readiness = { status: "failed", credential_source: source, model_count: 0, selected_model: null, reason };
      throw new Error(reason);
    }
  }
}

export function createProjectCodexTransport(root: string, source: NodeJS.ProcessEnv = process.env, runtimeRoot = root) {
  const apiKey = source.OPENAI_API_KEY?.trim();
  const transport = new StdioJsonRpcTransport(projectCodexLaunchOptions(root, source, runtimeRoot));
  return new CredentialedAppServerTransport(transport, apiKey, source.EPM_CODEX_MODEL?.trim());
}

export function projectCodexLaunchOptions(root: string, source: NodeJS.ProcessEnv = process.env, runtimeRoot = root): StdioJsonRpcOptions {
  const useApiKey = Boolean(source.OPENAI_API_KEY?.trim());
  const childEnv = useApiKey ? isolatedAppServerEnvironment(source, root) : safeAppServerEnvironment(source);
  delete childEnv.OPENAI_API_KEY;
  return {
    command: process.execPath,
    args: [
      join(runtimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
      ...(useApiKey ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : []),
      ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
      "app-server", "--listen", "stdio://"
    ],
    cwd: root,
    env: childEnv
  };
}

export function localCodexRuntimeReady(root: string) {
  try {
    const projectRequire = createRequire(join(root, "package.json"));
    const wrapperPackage = projectRequire.resolve("@openai/codex/package.json");
    const wrapperRequire = createRequire(wrapperPackage);
    const suffix = process.platform === "win32" ? `win32-${process.arch}` : process.platform === "darwin" ? `darwin-${process.arch}` : `linux-${process.arch}`;
    wrapperRequire.resolve(`@openai/codex-${suffix}/package.json`);
    return true;
  } catch { return false; }
}

function safeReadinessFailure(error: unknown, apiKey?: string) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(apiKey ? raw.replaceAll(apiKey, "[REDACTED]") : raw);
  if (/credential_required/.test(message)) return "credential_required:codex-app-server";
  if (/usage_limit|quota|rate.limit/i.test(message)) return "usage_limit:codex-app-server";
  if (/model_unavailable/.test(message)) return "codex_model_unavailable:model/list";
  if ((error instanceof AppServerRpcError && [401, 403].includes(error.code)) || /authentication|unauthorized|api.key|\b401\b|\b403\b/i.test(message)) return "authentication_error:codex-app-server";
  return "codex_runtime_unavailable:app-server";
}
