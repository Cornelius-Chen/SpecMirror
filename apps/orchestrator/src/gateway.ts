import type { GoalContract, StructuredGoalPlan } from "@epm/domain";
import type { EventBus } from "./events.ts";
import { redactSecrets } from "./stdio-jsonrpc.ts";

export interface GoalPlan extends StructuredGoalPlan {}

export interface ReviewResult {
  approved: boolean;
  requirementDiffTestMap: Array<{ requirement: string; evidence: string }>;
  findings: string[];
}

export interface AgentImplementationResult {
  changedFiles: string[];
  evidence: string[];
  summary?: string;
  artifactRef?: string;
  checks?: Array<{ criterion: string; result: "pass" | "partial" | "fail" | "pending"; note: string }>;
}

export interface GoalExecutionContext {
  cwd: string;
  branch: string;
  signal?: AbortSignal;
  /** Findings from this run's rejected review, never an amendment to its Goal Contract. */
  reviewFeedback?: readonly string[];
}

/** Bound and redact review text before persisting it or sending it to a Worker. */
export function normalizeReviewFeedback(findings: readonly string[] = []): string[] {
  let remaining = 6000;
  const result: string[] = [];
  for (const finding of findings.slice(0, 12)) {
    if (typeof finding !== "string" || !remaining) continue;
    const safe = redactSecrets(finding)
      .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
      .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim().slice(0, Math.min(2000, remaining));
    if (safe) { result.push(safe); remaining -= safe.length; }
  }
  return result;
}

export interface AgentGateway {
  readonly kind: "mock" | "codex-app-server";
  readonly ready?: boolean;
  start(goal: GoalContract, existingThreadId?: string | null, context?: GoalExecutionContext): Promise<{ threadId: string }>;
  plan(goal: GoalContract, context?: GoalExecutionContext, feedback?: string[]): Promise<GoalPlan>;
  implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext): Promise<AgentImplementationResult>;
  review(goal: GoalContract, changedFiles: string[], context?: GoalExecutionContext): Promise<ReviewResult>;
  setGoalStatus?(threadId: string, status: "paused" | "blocked" | "usageLimited" | "complete"): Promise<void>;
  interrupt?(threadId: string): Promise<void>;
  close?(): Promise<void>;
  attachEvents?(events: EventBus): void;
}

export class MockAgentGateway implements AgentGateway {
  readonly kind: "mock" | "codex-app-server" = "mock";
  readonly ready = true;

  async start(goal: GoalContract, existingThreadId?: string | null, _context?: GoalExecutionContext) { return { threadId: existingThreadId ?? `mock-thread-${goal.id}` }; }

  async plan(goal: GoalContract, _context?: GoalExecutionContext, _feedback?: string[]): Promise<GoalPlan> {
    return {
      outcome: goal.outcome,
      primaryOutcomes: [goal.outcome],
      ownershipModules: [...goal.ownership_modules],
      plannedWriteGlobs: [...goal.write_globs],
      sharedContracts: [...goal.shared_contracts],
      unresolvedQuestions: [],
      steps: [
        { title: "核对 Goal Contract", acceptance: "范围、依赖和验收命令明确" },
        { title: "执行确定性离线实现", acceptance: "只触及允许写域" },
        { title: "独立审查与回归", acceptance: goal.acceptance_commands.join(" && ") }
      ],
      risks: goal.shared_contracts.length ? ["共享契约需要串行锁"] : []
    };
  }

  async implement(goal: GoalContract, events: EventBus, _context?: GoalExecutionContext): Promise<AgentImplementationResult> {
    events.emit({ type: "execution", goalId: goal.id, message: "Mock Worker 已进入受控实现阶段。" });
    await Promise.resolve();
    return {
      changedFiles: [],
      evidence: ["mock:no-files-written", ...goal.acceptance_commands.map((command) => `acceptance:${command}`)],
      summary: goal.supervision_context ? `确定性 Mock 已接收“${goal.title}”的正式 Goal；它未写入真实文件，因此不能作为完成证据。` : undefined,
      checks: goal.supervision_context?.acceptance.map((criterion) => ({ criterion, result: "pending" as const, note: "Mock 仅验证编排链路，等待真实 Agent 与验收证据。" }))
    };
  }

  async review(goal: GoalContract, changedFiles: string[], _context?: GoalExecutionContext): Promise<ReviewResult> {
    const requirements = goal.supervision_context?.acceptance.length ? goal.supervision_context.acceptance : [goal.outcome];
    return {
      approved: true,
      requirementDiffTestMap: requirements.map((requirement) => ({ requirement, evidence: `${changedFiles.join(", ") || "mock:no-diff"}；${goal.acceptance_commands.join(" && ")}` })),
      findings: goal.supervision_context && !changedFiles.length ? ["离线演练：未写入真实代码。"] : []
    };
  }

  async setGoalStatus(_threadId: string, _status: "paused" | "blocked" | "usageLimited" | "complete") { await Promise.resolve(); }
  async interrupt(_threadId: string) { await Promise.resolve(); }
}

export class DeferredCodexGateway implements AgentGateway {
  readonly kind = "codex-app-server" as const;
  readonly ready = false;
  constructor(readonly reason = "credential_required: 真实 Codex Gateway 已延期；请先安全配置 API Key 并显式启用。") {}
  #error(): never { throw new Error(this.reason) }
  async start(_goal: GoalContract, _existingThreadId?: string | null, _context?: GoalExecutionContext): Promise<{ threadId: string }> { return this.#error(); }
  async plan(_goal: GoalContract, _context?: GoalExecutionContext, _feedback?: string[]): Promise<GoalPlan> { return this.#error(); }
  async implement(_goal: GoalContract, _events: EventBus, _context?: GoalExecutionContext): Promise<AgentImplementationResult> { return this.#error(); }
  async review(_goal: GoalContract, _changedFiles: string[], _context?: GoalExecutionContext): Promise<ReviewResult> { return this.#error(); }
  async interrupt(_threadId: string): Promise<void> { return this.#error(); }
}
