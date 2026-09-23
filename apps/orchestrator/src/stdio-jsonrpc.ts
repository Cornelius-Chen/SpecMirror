import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcId = string | number;

export interface JsonRpcTransport {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  onError?(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface StdioJsonRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export class AppServerRpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(classifyRpcError(method, code, message, data));
    this.name = "AppServerRpcError";
  }
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  readonly #events = new EventEmitter();
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #requestTimeoutMs: number;
  #nextId = 1;
  #process?: ChildProcessWithoutNullStreams;
  #initializing?: Promise<void>;
  #closed = false;
  #terminalError?: Error;
  #stderrTail = "";

  constructor(readonly options: StdioJsonRpcOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  static projectLocal(root: string, env = safeAppServerEnvironment(process.env)) {
    return new StdioJsonRpcTransport({
      command: process.execPath,
      args: [join(root, "node_modules", "@openai", "codex", "bin", "codex.js"), "app-server", "--listen", "stdio://"],
      cwd: root,
      env: isolatedAppServerEnvironment(env, root)
    });
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.#ensureInitialized();
    return this.#requestRaw<T>(method, params);
  }

  async notify(method: string, params: Record<string, unknown> = {}) {
    await this.#ensureInitialized();
    this.#write({ method, params });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void) {
    this.#events.on("notification", listener);
    return () => this.#events.off("notification", listener);
  }

  onError(listener: (error: Error) => void) {
    this.#events.on("transportError", listener);
    return () => this.#events.off("transportError", listener);
  }

  async close() {
    this.#closed = true;
    this.#failAll(new Error("codex_transport_closed"));
    const child = this.#process;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  async #ensureInitialized() {
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closed) throw new Error("codex_transport_closed");
    if (!this.#initializing) this.#initializing = this.#startAndInitialize();
    return this.#initializing;
  }

  async #startAndInitialize() {
    const launch = this.options.spawnProcess ?? spawn;
    const child = launch(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.#process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = redactSecrets(`${this.#stderrTail}${chunk}`).slice(-8_192);
    });
    child.once("error", (error) => this.#failAll(new Error(`codex_app_server_spawn_failed:${error.message}`)));
    child.once("exit", (code, signal) => this.#failAll(new Error(`codex_app_server_exited:${code ?? "null"}:${signal ?? "none"}:${this.#stderrTail}`)));
    child.once("close", (code, signal) => this.#failAll(new Error(`codex_app_server_closed:${code ?? "null"}:${signal ?? "none"}:${this.#stderrTail}`)));
    await this.#requestRaw("initialize", {
      clientInfo: { name: "specmirror", title: "映构 SpecMirror", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.#write({ method: "initialized", params: {} });
  }

  #requestRaw<T>(method: string, params: Record<string, unknown>) {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#closed) return Promise.reject(new Error("codex_transport_closed"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex_rpc_timeout:${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.#write({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #write(message: unknown) {
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closed) throw new Error("codex_transport_closed");
    if (!this.#process?.stdin.writable) throw new Error("codex_app_server_not_writable");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string) {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { this.#events.emit("notification", { method: "transport/invalidJson", params: {} }); return; }
    if (isJsonRpcId(message.id) && typeof message.method === "string") {
      if (message.method === "currentTime/read") {
        this.#write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
        return;
      }
      const denial = approvalDenial(message.method);
      if (denial) {
        this.#write(denial.result
          ? { id: message.id, result: denial.result }
          : { id: message.id, error: { code: -32_001, message: "Approval denied by client policy" } });
        const params = message.params as Record<string, unknown> | undefined;
        this.#events.emit("notification", {
          method: "approval/denied",
          params: {
            threadId: params?.threadId ?? params?.conversationId,
            turnId: params?.turnId,
            itemId: params?.itemId,
            requestMethod: message.method
          }
        });
      } else {
        this.#write({ id: message.id, error: { code: -32601, message: "Client method not supported" } });
      }
      return;
    }
    if (isJsonRpcId(message.id)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      const rpcError = message.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (rpcError) pending.reject(new AppServerRpcError(pending.method, rpcError.code ?? -32_000, rpcError.message ?? "Unknown RPC error", rpcError.data));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.#events.emit("notification", { method: message.method, params: message.params as Record<string, unknown> | undefined });
  }

  #failAll(error: Error) {
    if (this.#terminalError) return;
    this.#terminalError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#events.emit("transportError", error);
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function approvalDenial(method: string): { result?: Record<string, unknown> } | undefined {
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) return { result: { decision: "decline" } };
  if (["applyPatchApproval", "execCommandApproval"].includes(method)) return { result: { decision: "denied" } };
  if (method === "item/permissions/requestApproval") return {
    result: {
      permissions: { fileSystem: { entries: [] }, network: { enabled: false } },
      scope: "turn"
    }
  };
  return undefined;
}

export function safeAppServerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"];
  return Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]])) as NodeJS.ProcessEnv;
}

export function isolatedAppServerEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const codexHome = join(root, ".project", ".runtime", "codex-home");
  mkdirSync(codexHome, { recursive: true });
  return { ...safeAppServerEnvironment(source), CODEX_HOME: codexHome };
}

export function redactSecrets(value: string) {
  const configured = process.env.OPENAI_API_KEY;
  const withoutConfigured = configured ? value.replaceAll(configured, "[REDACTED]") : value;
  return withoutConfigured.replace(/(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
}

function classifyRpcError(method: string, code: number, message: string, data?: unknown) {
  const safe = redactSecrets(message);
  const detail = JSON.stringify(data ?? "").toLowerCase();
  const combined = `${safe} ${detail}`.toLowerCase();
  if (/usagelimit|usage.limit|rate.limit|quota/.test(combined)) return `usage_limit:${method}`;
  if (/unauthorized|authentication|api.key|401|403/.test(combined)) return `authentication_error:${method}`;
  return `codex_rpc_error:${method}:${code}:${safe}`;
}
