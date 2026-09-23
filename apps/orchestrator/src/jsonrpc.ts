import type { GoalContract } from "@epm/domain";
import type { EventBus } from "./events.ts";
import type { AgentGateway, GoalExecutionContext, GoalPlan, ReviewResult } from "./gateway.ts";
import { normalizeReviewFeedback } from "./gateway.ts";
import type { JsonRpcNotification, JsonRpcTransport } from "./stdio-jsonrpc.ts";
import { redactSecrets } from "./stdio-jsonrpc.ts";

interface TurnTrace { goalId: string; phase: "plan" | "implementation" | "review" }

interface TurnCapture {
  status?: string;
  error?: unknown;
  agentMessages: string[];
  plans: string[];
  review?: string;
  diff?: string;
  evidence: string[];
}

interface TurnWaiter { resolve(capture: TurnCapture): void; reject(error: Error): void }

function planSchema(goal: GoalContract) {
  return {
    type: "object",
    properties: {
      // These fields are frozen contract identity, not prose for the model to
      // rewrite. Enum constraints keep punctuation or paraphrase drift from
      // creating a false ChangeProposal while the linter still fails closed.
      outcome: { type: "string", enum: [goal.outcome] },
      primaryOutcomes: {
        type: "array",
        items: { type: "string", enum: [goal.outcome] },
        minItems: 1,
        maxItems: 1
      },
      ownershipModules: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
      plannedWriteGlobs: { type: "array", items: { type: "string" }, minItems: 1 },
      sharedContracts: goal.shared_contracts.length
        ? { type: "array", items: { type: "string", enum: goal.shared_contracts }, uniqueItems: true }
        : { type: "array", items: { type: "string" }, maxItems: 0 },
      unresolvedQuestions: { type: "array", items: { type: "string" }, maxItems: 0 },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: goal.max_turns,
        items: {
          type: "object",
          properties: { title: { type: "string" }, acceptance: { type: "string" } },
          required: ["title", "acceptance"],
          additionalProperties: false
        }
      },
      risks: { type: "array", items: { type: "string" } }
    },
    required: ["outcome", "primaryOutcomes", "ownershipModules", "plannedWriteGlobs", "sharedContracts", "unresolvedQuestions", "steps", "risks"],
    additionalProperties: false
  };
}

const supervisionOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    artifactRef: { type: "string" },
    checks: { type: "array", items: { type: "object", properties: { criterion: { type: "string" }, result: { type: "string", enum: ["pass", "partial", "fail", "pending"] }, note: { type: "string" } }, required: ["criterion", "result", "note"], additionalProperties: false } }
  },
  required: ["summary", "checks"],
  additionalProperties: false
};

const reviewOutputSchema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    requirementDiffTestMap: { type: "array", items: { type: "object", properties: { requirement: { type: "string" }, evidence: { type: "string" } }, required: ["requirement", "evidence"], additionalProperties: false } },
    findings: { type: "array", items: { type: "string" } }
  },
  required: ["approved", "requirementDiffTestMap", "findings"],
  additionalProperties: false
};

function collaborationMode(mode: "plan" | "default", model: string) {
  return {
    mode,
    settings: {
      model,
      reasoning_effort: mode === "plan" ? "medium" : null,
      developer_instructions: null
    }
  };
}

function frozenAcceptancePrompt(goal: GoalContract, phase: "plan" | "implementation") {
  const instruction = phase === "plan"
    ? "仅核对以下冻结验收命令，本阶段不要执行验收。"
    : "按编号逐条运行以下冻结验收命令；每段单独执行，不要拼接命令段。";
  const commands = goal.acceptance_commands.map((command, index) => {
    if (!command.trim()) return `验收命令 ${index + 1}：未提供；不得自行补造命令。`;
    const fence = "`".repeat(Math.max(3, ...[...command.matchAll(/`+/g)].map(match => match[0].length + 1)));
    return `验收命令 ${index + 1}：\n${fence}text\n${command}\n${fence}`;
  });
  return `\n${instruction}\n步骤标题不是可执行命令；只使用各代码块内的命令原文。\n${commands.join("\n\n") || "验收命令：未提供；不得自行补造命令。"}`;
}

export class CodexAppServerGateway implements AgentGateway {
  readonly kind = "codex-app-server" as const;
  #ready: boolean;
  readonly #threads = new Map<string, string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #captures = new Map<string, TurnCapture>();
  readonly #turnTraces = new Map<string, TurnTrace>();
  readonly #pendingThreadTraces = new Map<string, TurnTrace>();
  readonly #waiters = new Map<string, TurnWaiter>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeError: () => void;
  #events?: EventBus;
  #transportFailure?: Error;

  constructor(readonly transport: JsonRpcTransport, readonly cwd: string, ready = false, readonly resolvedModel?: string | (() => string | undefined)) {
    this.#ready = ready;
    this.#unsubscribe = transport.onNotification((notification) => this.#onNotification(notification));
    this.#unsubscribeError = transport.onError?.((error) => this.#failWaiters(error)) ?? (() => undefined);
  }

  get ready() { return this.#ready; }
  setReady(ready: boolean) { this.#ready = ready; }

  #model() {
    const resolved = typeof this.resolvedModel === "function" ? this.resolvedModel() : this.resolvedModel;
    return resolved?.trim() || process.env.EPM_CODEX_MODEL?.trim() || "gpt-5.6-sol";
  }

  attachEvents(events: EventBus) { this.#events = events; }

  async start(goal: GoalContract, existingThreadId?: string | null, context?: GoalExecutionContext) {
    const cwd = context?.cwd ?? this.cwd;
    const response = existingThreadId
      ? await this.transport.request<{ thread: { id: string } }>("thread/resume", { threadId: existingThreadId, cwd, approvalPolicy: "never", sandbox: "workspace-write" })
      : await this.transport.request<{ thread: { id: string } }>("thread/start", { cwd, approvalPolicy: "never", sandbox: "workspace-write", serviceName: "specmirror" });
    const threadId = response.thread.id;
    await this.transport.request("thread/goal/set", {
      threadId,
      objective: `${goal.outcome}\n\n验收命令：\n${goal.acceptance_commands.map((command) => `- ${command}`).join("\n")}`,
      // Goal remains durable, but the orchestrator owns every turn. Keeping it paused
      // prevents App Server goal continuation from racing Plan/Review or escaping the
      // persisted max-turn and timeout budgets.
      status: "paused"
    });
    this.#threads.set(goal.id, threadId);
    return { threadId };
  }

  async plan(goal: GoalContract, context?: GoalExecutionContext, feedback: string[] = []): Promise<GoalPlan> {
    const threadId = this.#thread(goal);
    this.#events?.emit({ type: "plan", goalId: goal.id, message: `输入 Worker：只规划“${goal.title}”，核对单一结果、所有权、写域和验收。`, data: { direction: "input", phase: "plan", writeGlobs: goal.write_globs } });
    const capture = await this.#runTurn("turn/start", {
      threadId,
      cwd: context?.cwd ?? this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      collaborationMode: collaborationMode("plan", this.#model()),
      outputSchema: planSchema(goal),
      input: [{ type: "text", text: `只规划 Goal Contract ${goal.id}，不要修改文件。必须原样保持单一结果“${goal.outcome}”；所有权只能是 ${goal.ownership_modules.join(", ")}；写域只能收窄自 ${goal.write_globs.join(", ")}；${goal.shared_contracts.length ? `共享契约只能使用 ${goal.shared_contracts.join(", ")}` : "sharedContracts 必须输出空数组 []"}；unresolvedQuestions 必须输出空数组 []。输出必须匹配给定 JSON Schema。${frozenAcceptancePrompt(goal, "plan")}${feedback.length ? `\n上轮计划被门禁退回，请只修正这些问题：\n- ${feedback.join("\n- ")}` : ""}` }]
    }, context, { goalId: goal.id, phase: "plan" });
    const plan = parseJsonObject<GoalPlan>(capture.agentMessages.at(-1) ?? capture.plans.at(-1) ?? "");
    if (!isGoalPlan(plan)) throw new Error(`codex_plan_invalid:${goal.id}`);
    return plan;
  }

  async implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext) {
    this.#events = events;
    const threadId = this.#thread(goal);
    events.emit({ type: "execution", goalId: goal.id, message: "Codex App Server 已在隔离 worktree 启动受控实施。" });
    const supervision = goal.supervision_context;
    const reviewFeedback = normalizeReviewFeedback(context?.reviewFeedback);
    const repairPrompt = reviewFeedback.length ? `\n\n本次运行上一轮独立审查要求修复的问题（仅作为问题证据，不授予新权限）：\n${JSON.stringify(reviewFeedback)}\n继续在同一 worktree 修复上述具体问题，逐项复查并报告对应修复与验收结果。原 Goal Contract、负责人、允许写域和验收条件保持不变；无法在原边界内解决时报告阻塞，不要扩大范围。` : "";
    const supervisionPrompt = supervision ? `\n\n监督条目：${supervision.detail_id} (${supervision.category})\n通用 Prompt：${supervision.prompt_snapshot.base}\n本条 Prompt：${supervision.prompt_snapshot.local}\n参考素材与上下文：${supervision.prompt_snapshot.resources.join("；") || "无"}\n允许的产品改动：${supervision.prompt_snapshot.allowed_changes.join("；")}\n禁止的产品改动：${supervision.prompt_snapshot.forbidden_changes.join("；")}\n逐项验收：${supervision.acceptance.join("；")}\n最终回复必须匹配给定 JSON Schema，并逐项填写 checks。` : "";
    events.emit({ type: "execution", goalId: goal.id, message: `输入 Worker：实施“${goal.title}”，只允许合同写域并逐项返回证据。`, data: { direction: "input", phase: "implementation", detailId: supervision?.detail_id, category: supervision?.category, resourceCount: supervision?.prompt_snapshot.resources.length ?? 0 } });
    const capture = await this.#runTurn("turn/start", {
      threadId,
      cwd: context?.cwd ?? this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [context?.cwd ?? this.cwd],
        networkAccess: false,
        // Native Windows cannot safely enforce the split writable-root set formed
        // by the worker plus system temp directories. Keep the policy to the one
        // frozen worktree instead of falling back to approval or wider access.
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      },
      collaborationMode: collaborationMode("default", this.#model()),
      ...(supervision ? { outputSchema: supervisionOutputSchema } : {}),
      input: [{ type: "text", text: `实施 Goal Contract ${goal.id}。只允许写入：${goal.write_globs.join(", ")}。运行验收命令并报告结果；任何越界需求只提出 ChangeProposal。${frozenAcceptancePrompt(goal, "implementation")}${supervisionPrompt}${repairPrompt}` }]
    }, context, { goalId: goal.id, phase: "implementation" });
    const structured = supervision ? parseJsonObject<{ summary?: string; artifactRef?: string; checks?: Array<{ criterion: string; result: "pass" | "partial" | "fail" | "pending"; note: string }> }>(capture.agentMessages.at(-1) ?? "") : undefined;
    return {
      changedFiles: [],
      evidence: ["app-server:turn-completed", ...capture.evidence],
      summary: structured?.summary ?? capture.agentMessages.at(-1),
      artifactRef: structured?.artifactRef,
      checks: structured?.checks
    };
  }

  async review(goal: GoalContract, changedFiles: string[], context?: GoalExecutionContext): Promise<ReviewResult> {
    const cwd = context?.cwd ?? this.cwd;
    const reviewerThreadId = (await this.transport.request<{ thread: { id: string } }>("thread/start", {
      cwd, approvalPolicy: "never", sandbox: "read-only", serviceName: "specmirror-reviewer"
    })).thread.id;
    const requirements = goal.supervision_context?.acceptance.length ? goal.supervision_context.acceptance : [goal.outcome];
    await this.transport.request("thread/goal/set", {
      threadId: reviewerThreadId,
      objective: `独立审查 Goal ${goal.id}：${goal.outcome}\n逐项要求：\n${requirements.map((item) => `- ${item}`).join("\n")}\n验收命令：\n${goal.acceptance_commands.map((item) => `- ${item}`).join("\n")}`,
      status: "paused"
    });
    this.#events?.emit({ type: "test", goalId: goal.id, message: `输入 Reviewer：独立核对“${goal.title}”的需求—差异—测试映射。`, data: { direction: "input", phase: "review", changedFileCount: changedFiles.length } });
    const capture = await this.#runTurn("turn/start", {
      threadId: reviewerThreadId,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: reviewOutputSchema,
      input: [{ type: "text", text: `只读审查当前 worktree 的未提交差异，不要修改文件。检查范围漂移、孤儿代码、受保护基线回归和证据完整性。必须为以下每条要求各返回一条 requirementDiffTestMap，requirement 必须原样一致，evidence 必须同时写明对应 Diff 文件/符号与测试命令/结果：\n${requirements.map((item) => `- ${item}`).join("\n")}\n已变更文件：${changedFiles.join(", ") || "无"}\n验收命令：${goal.acceptance_commands.join("；")}` }]
    }, context, { goalId: goal.id, phase: "review" });
    const reviewText = capture.agentMessages.at(-1) ?? capture.review ?? "";
    const structured = parseJsonObject<ReviewResult>(reviewText);
    if (!isReviewResult(structured)) return { approved: false, requirementDiffTestMap: [], findings: [`Reviewer 未返回合法结构化结论：${summarizeReview(reviewText)}`] };
    return structured;
  }

  async interrupt(threadId: string) {
    const turnId = this.#activeTurns.get(threadId);
    if (!turnId) return;
    await this.transport.request("turn/interrupt", { threadId, turnId });
  }

  async setGoalStatus(threadId: string, status: "paused" | "blocked" | "usageLimited" | "complete") {
    await this.transport.request("thread/goal/set", { threadId, status });
  }

  async close() {
    this.#failWaiters(new Error("codex_transport_closed"));
    this.#unsubscribe();
    this.#unsubscribeError();
    await this.transport.close();
  }

  async #runTurn(method: "turn/start" | "review/start", params: Record<string, unknown>, context?: GoalExecutionContext, trace?: TurnTrace) {
    const requestedThreadId = String(params.threadId);
    if (trace) this.#pendingThreadTraces.set(requestedThreadId, trace);
    let response: { turn: { id: string }; reviewThreadId?: string };
    try {
      response = await this.transport.request<{ turn: { id: string }; reviewThreadId?: string }>(method, params);
    } catch (error) {
      this.#pendingThreadTraces.delete(requestedThreadId);
      throw error;
    }
    const turnId = response.turn.id;
    const threadId = response.reviewThreadId ?? String(params.threadId);
    if (trace) this.#turnTraces.set(turnId, trace);
    this.#pendingThreadTraces.delete(requestedThreadId);
    this.#activeTurns.set(threadId, turnId);
    const abort = () => { void this.transport.request("turn/interrupt", { threadId, turnId }).catch(() => undefined); };
    if (context?.signal?.aborted) abort();
    else context?.signal?.addEventListener("abort", abort, { once: true });
    try { return await this.#waitForTurn(turnId); }
    finally {
      context?.signal?.removeEventListener("abort", abort);
      this.#activeTurns.delete(threadId);
      this.#turnTraces.delete(turnId);
    }
  }

  #waitForTurn(turnId: string) {
    if (this.#transportFailure) return Promise.reject(this.#transportFailure);
    const existing = this.#captures.get(turnId);
    if (existing?.status) return turnResult(turnId, existing);
    return new Promise<TurnCapture>((resolve, reject) => this.#waiters.set(turnId, { resolve, reject }));
  }

  #failWaiters(error: Error) {
    this.#ready = false;
    if (!this.#transportFailure) this.#transportFailure = error;
    for (const waiter of this.#waiters.values()) waiter.reject(this.#transportFailure);
    this.#waiters.clear();
  }

  #onNotification(notification: JsonRpcNotification) {
    const params = notification.params ?? {};
    const turn = params.turn as { id?: string; status?: string; error?: unknown } | undefined;
    const item = params.item as { type?: string; text?: string; review?: string; id?: string; changes?: unknown[]; status?: string } | undefined;
    const turnId = String(params.turnId ?? turn?.id ?? "");
    if (!turnId) return;
    const capture = this.#captures.get(turnId) ?? { agentMessages: [], plans: [], evidence: [] };
    const notificationThreadId = String(params.threadId ?? "");
    const trace = this.#turnTraces.get(turnId) ?? (notificationThreadId ? this.#pendingThreadTraces.get(notificationThreadId) : undefined);
    if (notification.method === "approval/denied" && trace && this.#events) {
      this.#events.emit({ type: "approval", goalId: trace.goalId, message: "异常审批请求已按 Goal 的 never 策略自动拒绝。", data: { direction: "status", phase: trace.phase, requestMethod: params.requestMethod } });
    }
    if (notification.method === "item/completed" && item) {
      if (item.type === "agentMessage" && typeof item.text === "string") capture.agentMessages.push(item.text);
      if (item.type === "plan" && typeof item.text === "string") capture.plans.push(item.text);
      if (item.type === "exitedReviewMode" && typeof item.review === "string") capture.review = item.review;
      if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type ?? "")) capture.evidence.push(`${item.type}:${item.status ?? "completed"}`);
      if (trace && this.#events) {
        const eventType = trace.phase === "plan" ? "plan" : trace.phase === "review" ? "test" : "execution";
        const text = typeof item.text === "string" ? compactAgentText(item.text) : item.type === "exitedReviewMode" && typeof item.review === "string" ? compactAgentText(item.review) : `${item.type ?? "item"} · ${item.status ?? "completed"}`;
        this.#events.emit({ type: eventType, goalId: trace.goalId, message: `Agent 输出：${text}`, data: { direction: "output", phase: trace.phase, itemType: item.type ?? "unknown" } });
      }
    }
    if (notification.method === "turn/diff/updated" && typeof params.diff === "string") capture.diff = params.diff;
    if (notification.method === "turn/completed" && turn) {
      capture.status = turn.status;
      capture.error = turn.error;
      if (trace && this.#events) this.#events.emit({ type: trace.phase === "review" ? "test" : trace.phase === "plan" ? "plan" : "execution", goalId: trace.goalId, message: `Agent ${trace.phase} 回合结束：${turn.status ?? "unknown"}`, data: { direction: "status", phase: trace.phase, status: turn.status } });
    }
    this.#captures.set(turnId, capture);
    if (capture.status) {
      const waiter = this.#waiters.get(turnId);
      if (waiter) {
        this.#waiters.delete(turnId);
        turnResult(turnId, capture).then(waiter.resolve, waiter.reject);
      }
    }
  }

  #thread(goal: GoalContract) {
    const threadId = this.#threads.get(goal.id);
    if (!threadId) throw new Error(`thread_not_started:${goal.id}`);
    return threadId;
  }
}

export class MockJsonRpcTransport implements JsonRpcTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly #listeners = new Set<(notification: JsonRpcNotification) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  #failure?: Error;
  constructor(readonly responses: Record<string, unknown>) {}
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.#failure) throw this.#failure;
    this.calls.push({ method, params });
    if (!(method in this.responses)) throw new Error(`mock_response_missing:${method}`);
    const response = this.responses[method];
    return (typeof response === "function" ? await (response as (params: Record<string, unknown>, transport: MockJsonRpcTransport) => unknown)(params, this) : response) as T;
  }
  async notify(method: string, params: Record<string, unknown> = {}) { this.calls.push({ method, params }); }
  onNotification(listener: (notification: JsonRpcNotification) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onError(listener: (error: Error) => void) { this.#errorListeners.add(listener); return () => this.#errorListeners.delete(listener); }
  emit(notification: JsonRpcNotification) { for (const listener of this.#listeners) listener(notification); }
  fail(error: Error) {
    if (this.#failure) return;
    this.#failure = error;
    for (const listener of this.#errorListeners) listener(error);
  }
  async close() { this.#listeners.clear(); this.#errorListeners.clear(); }
}

async function turnResult(turnId: string, capture: TurnCapture) {
  if (capture.status === "completed") return capture;
  if (capture.status === "interrupted") throw new Error("run_stopped");
  const serialized = redactSecrets(JSON.stringify(capture.error ?? "")).toLowerCase();
  if (/usagelimit|usage.limit|rate.limit|quota/.test(serialized)) throw new Error(`usage_limit:${turnId}`);
  if (/unauthorized|authentication|api.key|401|403/.test(serialized)) throw new Error(`authentication_error:${turnId}`);
  throw new Error(`codex_turn_failed:${turnId}:${summarizeReview(serialized)}`);
}

function parseJsonObject<T>(text: string): T | undefined {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(normalized) as T; }
  catch {
    const start = normalized.indexOf("{"); const end = normalized.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try { return JSON.parse(normalized.slice(start, end + 1)) as T; } catch { return undefined; }
  }
}

function isGoalPlan(value: GoalPlan | undefined): value is GoalPlan {
  return !!value && typeof value.outcome === "string" && Array.isArray(value.risks) && value.risks.every((item) => typeof item === "string")
    && Array.isArray(value.primaryOutcomes) && value.primaryOutcomes.every((item) => typeof item === "string")
    && Array.isArray(value.ownershipModules) && value.ownershipModules.every((item) => typeof item === "string")
    && Array.isArray(value.plannedWriteGlobs) && value.plannedWriteGlobs.every((item) => typeof item === "string")
    && Array.isArray(value.sharedContracts) && value.sharedContracts.every((item) => typeof item === "string")
    && Array.isArray(value.unresolvedQuestions) && value.unresolvedQuestions.every((item) => typeof item === "string")
    && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.every((step) => typeof step?.title === "string" && typeof step?.acceptance === "string");
}

function isReviewResult(value: ReviewResult | undefined): value is ReviewResult {
  return !!value && typeof value.approved === "boolean"
    && Array.isArray(value.requirementDiffTestMap) && value.requirementDiffTestMap.every((item) => typeof item?.requirement === "string" && typeof item?.evidence === "string")
    && Array.isArray(value.findings) && value.findings.every((item) => typeof item === "string");
}

function summarizeReview(text: string) { return text.replace(/\s+/g, " ").trim().slice(0, 500) || "无审查文本"; }
function compactAgentText(text: string) { return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, 240) || "空输出"; }
