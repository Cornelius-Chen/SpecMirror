import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeStore } from "@epm/spec-io";
import type { EventBus } from "./events.ts";
import { redactSecrets, safeAppServerEnvironment } from "./stdio-jsonrpc.ts";
import { readCodexSmokeReceipt, type CodexSmokeReceiptReference } from "./codex-smoke-receipt.ts";

const STATE_KEY = "codex_smoke_state";
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

interface ActiveCodexSmokeRun {
  state: CodexSmokeState;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  stopping: boolean;
  failed: boolean;
  exited: boolean;
  closed: Promise<void>;
  resolveClosed: () => void;
  stopPromise?: Promise<CodexSmokeState>;
}

interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  spawnProcess?: typeof spawn;
}

/** Mirrors the bounded process-tree termination used by real source checks. */
export async function terminateCodexSmokeProcessTree(child: ChildProcess, dependencies: ProcessTreeDependencies = {}) {
  if (!child.pid || child.exitCode !== null) return;
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    const launch = dependencies.spawnProcess ?? spawn;
    const fallback = () => { try { child.kill("SIGKILL"); } catch { /* the child may already be gone */ } };
    let killer: ChildProcess;
    try {
      killer = launch(join(dependencies.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      fallback();
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      killer.once("error", () => { fallback(); finish(); });
      killer.once("close", (code) => { if (code !== 0) fallback(); finish(); });
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* the child may already be gone */ } }
}

export interface CodexSmokeState {
  id: string | null;
  status: "idle" | "running" | "passed" | "failed" | "stopped";
  started_at: string | null;
  finished_at: string | null;
  message: string;
  receipt?: CodexSmokeReceiptReference;
  run_ref?: string;
}

export interface CodexReadinessOptions {
  root: string;
  gatewaySelected: boolean;
  gatewayReady?: () => boolean;
  credentialStatus?: "configured" | "required" | "rejected";
  credentialSource?: "none" | "stored" | "api-key" | "provider";
  selectedModel?: string | null;
  runtimeReady: boolean;
  runtime: Pick<RuntimeStore, "getState" | "setState">;
  events: EventBus;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  terminateProcessTree?: (child: ChildProcess) => Promise<void>;
  stopTimeoutMs?: number;
}

export class CodexReadinessManager {
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly terminateProcessTree: (child: ChildProcess) => Promise<void>;
  readonly stopTimeoutMs: number;
  #active?: ActiveCodexSmokeRun;

  constructor(readonly options: CodexReadinessOptions) {
    this.env = options.env ?? process.env;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.terminateProcessTree = options.terminateProcessTree ?? terminateCodexSmokeProcessTree;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    if (!Number.isFinite(this.stopTimeoutMs) || this.stopTimeoutMs < 10 || this.stopTimeoutMs > 60_000) throw new Error("invalid_codex_smoke_stop_timeout");
    const previous = this.#loadState();
    if (previous.status === "running") {
      this.#saveState({ ...previous, status: "failed", finished_at: new Date().toISOString(), message: "服务重启中断了烟雾测试；临时仓库现场已保留，可重新开始。" });
    }
  }

  readiness() {
    const credential = this.options.credentialStatus ?? (this.env.OPENAI_API_KEY ? "configured" : "required");
    const credentialConfigured = credential === "configured";
    const explicitlyEnabled = this.env.EPM_ENABLE_CODEX === "1";
    const gatewayReady = this.options.gatewayReady?.() ?? this.options.gatewaySelected;
    const storedSmoke = this.#loadState();
    let evidenceStatus: "verified" | "unavailable" | "invalid" = "unavailable";
    if (storedSmoke.receipt) {
      try { this.receipt(); evidenceStatus = "verified"; }
      catch { evidenceStatus = "invalid"; }
    }
    const smoke = { ...storedSmoke, evidence_status: evidenceStatus };
    const credentialNote = credentialConfigured
      ? this.options.credentialSource === "stored" ? "已验证本机 Codex 的 ChatGPT 登录"
        : this.options.credentialSource === "api-key" ? "已验证隔离的服务端 API Key；值不会返回浏览器"
        : this.options.credentialSource === "provider" ? "已验证当前模型提供方登录"
        : "App Server 已验证登录状态；凭证不会返回浏览器"
      : credential === "rejected" ? "Codex 拒绝了当前登录"
      : "需要先在本机登录 Codex，或配置服务端 API Key";
    const checks = [
      { id: "runtime", title: "项目本地 Codex 运行时", status: this.options.runtimeReady ? "ready" : "waiting", note: this.options.runtimeReady ? `锁定版本 ${this.#codexVersion()}` : "项目本地运行时不完整" },
      { id: "credential", title: "Codex 登录", status: credentialConfigured ? "ready" : credential === "rejected" ? "failed" : "waiting", note: credentialNote },
      { id: "enable", title: "无人值守执行开关", status: explicitlyEnabled ? "ready" : "waiting", note: explicitlyEnabled ? "已显式启用" : "需要 EPM_ENABLE_CODEX=1" },
      { id: "gateway", title: "控制面 Gateway", status: gatewayReady ? "ready" : this.options.gatewaySelected ? "failed" : "waiting", note: gatewayReady ? "App Server 握手、鉴权和模型目录均已验证" : this.options.gatewaySelected ? "已选择但 App Server 尚未通过就绪检查" : "当前仍是 Mock Gateway" },
      { id: "smoke", title: "临时仓库安全烟测", status: smoke.status, note: smoke.message }
    ];
    return {
      ready_to_run: credentialConfigured && explicitlyEnabled && this.options.gatewaySelected && gatewayReady && this.options.runtimeReady,
      credential,
      credential_source: this.options.credentialSource ?? "none",
      credential_location: "server-only",
      runtime: this.options.runtimeReady ? "ready" : "required",
      enabled: explicitlyEnabled,
      gateway_selected: this.options.gatewaySelected,
      locked_codex_version: this.#codexVersion(),
      selected_model: this.options.selectedModel ?? null,
      checks,
      smoke
    };
  }

  start() {
    const readiness = this.readiness();
    if (!readiness.ready_to_run) throw new Error("codex_smoke_not_ready");
    if (this.#active) throw new Error("codex_smoke_already_running");
    const now = new Date().toISOString();
    const token = randomUUID();
    const state: CodexSmokeState = { id: `codex-smoke-${token}`, status: "running", started_at: now, finished_at: null, message: "正在临时仓库执行 Plan、实现、Reviewer、回归、检查点与主分支合并。", run_ref: `.project/.runtime/codex-smoke-runs/run-${token}` };
    this.#saveState(state);
    this.options.events.emit({ type: "test", message: "真实 Codex 临时仓库烟雾测试已开始；App Server 子进程环境不含凭证。", data: { kind: "codex-smoke", smokeId: state.id } });

    const tsxCli = join(this.options.root, "node_modules", "tsx", "dist", "cli.mjs");
    const smokeScript = join(this.options.root, "apps", "orchestrator", "src", "codex-smoke.ts");
    const childEnvironment = safeAppServerEnvironment(this.env);
    delete childEnvironment.OPENAI_API_KEY;
    let child: ChildProcess;
    try {
      child = this.spawnProcess(process.execPath, [tsxCli, smokeScript, state.id!], {
        cwd: this.options.root,
        env: { ...childEnvironment, EPM_ENABLE_CODEX: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch {
      this.#finish(state, "failed", "无法启动真实烟测子进程；主项目未被修改，可修复本地运行时后重试。");
      throw new Error("codex_smoke_spawn_failed");
    }
    let resolveClosed: () => void = () => undefined;
    const active: ActiveCodexSmokeRun = {
      state,
      child,
      stdout: "",
      stderr: "",
      stopping: false,
      failed: false,
      exited: false,
      closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
      resolveClosed
    };
    active.resolveClosed = resolveClosed;
    this.#active = active;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { active.stdout = redactSecrets(`${active.stdout}${chunk}`).slice(-16_384); });
    child.stderr?.on("data", (chunk: string) => { active.stderr = redactSecrets(`${active.stderr}${chunk}`).slice(-16_384); });
    child.once("error", () => {
      if (active.exited || active.failed) return;
      active.failed = true;
      if (!active.stopping) this.#finish(state, "failed", "无法启动真实烟雾测试子进程。");
    });
    child.once("close", (code) => {
      if (active.exited) return;
      active.exited = true;
      if (this.#active === active) this.#active = undefined;
      if (active.stopping) {
        this.#markStopped(active);
        active.resolveClosed();
        return;
      }
      if (active.failed) {
        active.resolveClosed();
        return;
      }
      const lines = active.stdout.trim().split(/\r?\n/).filter(Boolean);
      let verified = false;
      let receipt: CodexSmokeReceiptReference | undefined;
      try {
        const result = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
        const reference = result.receipt as CodexSmokeReceiptReference;
        const saved = readCodexSmokeReceipt(this.options.root, state.id!, reference);
        receipt = reference;
        verified = result.ok === true
          && result.gateway === "codex-app-server"
          && result.run === "verified"
          && result.changeSet === "verified"
          && result.checkpoint === true
          && result.mainMerged === true
          && saved.status === "passed"
          && Object.values(saved.checks).every(Boolean);
      } catch { verified = false; }
      const completed = receipt ? { ...state, receipt } : state;
      if (code === 0 && verified) this.#finish(completed, "passed", "临时仓库的单任务已完成计划、实现、独立审查、标记验收与合并；运行记录已保留。" );
      else {
        const combined = `${active.stdout}\n${active.stderr}`.toLowerCase();
        const message = /usage_limit|quota|rate.limit/.test(combined) ? "用量限制阻止了烟测；未继续派发。"
          : /authentication|unauthorized|api.key|401|403/.test(combined) ? "凭证鉴权失败；未继续派发。"
          : "烟雾测试未通过；临时仓库现场已保留，主项目没有被合并。";
        this.#finish(completed, "failed", message);
      }
      active.resolveClosed();
    });
    return state;
  }

  stop(): Promise<CodexSmokeState> {
    const active = this.#active;
    if (!active) throw new Error("codex_smoke_not_running");
    if (active.stopPromise) return active.stopPromise;
    active.stopping = true;
    const current = this.#loadState();
    if (current.id === active.state.id && current.status === "running") {
      this.#saveState({ ...current, message: "正在停止烟雾测试；等待本次子进程树退出，期间不会启动下一次。" });
    }
    active.stopPromise = (async () => {
      await this.terminateProcessTree(active.child);
      await this.#waitForClose(active);
      const stopped = this.#loadState();
      if (stopped.id !== active.state.id || stopped.status !== "stopped") throw new Error("codex_smoke_stop_incomplete");
      return stopped;
    })().catch((failure) => {
      if (!active.exited) {
        const pending = this.#loadState();
        if (pending.id === active.state.id && pending.status === "running") {
          this.#saveState({ ...pending, message: "停止请求已发出，但进程退出尚未确认；已禁止重新开始，可再次停止。" });
        }
      }
      if (failure instanceof Error && failure.message === "codex_smoke_stop_timeout") throw failure;
      throw new Error("codex_smoke_stop_failed");
    }).finally(() => { active.stopPromise = undefined; });
    return active.stopPromise;
  }

  receipt() {
    const state = this.#loadState();
    if (!state.id || !state.receipt) throw new Error("smoke_receipt_unavailable");
    return readCodexSmokeReceipt(this.options.root, state.id, state.receipt);
  }

  close() {
    const active = this.#active;
    if (!active || active.exited) return;
    active.stopping = true;
    void this.terminateProcessTree(active.child).catch(() => undefined);
  }

  #finish(started: CodexSmokeState, status: "passed" | "failed", message: string) {
    const current = this.#loadState();
    if (current.id !== started.id || current.status !== "running") return current;
    const finished = { ...started, status, finished_at: new Date().toISOString(), message };
    this.#saveState(finished);
    this.options.events.emit({ type: status === "passed" ? "integration" : "system", message, data: { kind: "codex-smoke", smokeId: started.id, status } });
    return finished;
  }

  #markStopped(active: ActiveCodexSmokeRun) {
    const current = this.#loadState();
    if (current.id !== active.state.id || current.status !== "running") return current;
    const stopped = { ...current, status: "stopped" as const, finished_at: new Date().toISOString(), message: "烟雾测试已停止；临时仓库现场保留，未修改主项目。" };
    this.#saveState(stopped);
    this.options.events.emit({ type: "system", message: stopped.message, data: { kind: "codex-smoke", smokeId: stopped.id } });
    return stopped;
  }

  async #waitForClose(active: ActiveCodexSmokeRun) {
    if (active.exited) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        active.closed,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("codex_smoke_stop_timeout")), this.stopTimeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #loadState(): CodexSmokeState {
    const raw = this.options.runtime.getState(STATE_KEY);
    if (!raw) return { id: null, status: "idle", started_at: null, finished_at: null, message: "尚未运行；等待全部服务端门禁就绪。" };
    try { return JSON.parse(raw) as CodexSmokeState; }
    catch { return { id: null, status: "failed", started_at: null, finished_at: null, message: "烟测状态损坏；可安全重新运行。" }; }
  }

  #saveState(state: CodexSmokeState) { this.options.runtime.setState(STATE_KEY, JSON.stringify(state)); }

  #codexVersion() {
    try {
      const manifest = JSON.parse(readFileSync(join(this.options.root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
      return manifest.devDependencies?.["@openai/codex"] ?? "unknown";
    } catch { return "unknown"; }
  }
}
