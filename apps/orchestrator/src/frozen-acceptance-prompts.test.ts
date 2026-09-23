import type { GoalContract } from "@epm/domain";
import { describe, expect, it } from "vitest";
import { EventBus } from "./events.ts";
import { CodexAppServerGateway, MockJsonRpcTransport } from "./jsonrpc.ts";

/** Capture actual gateway requests; no shell, filesystem or model is invoked. */
async function captureWorkerTurns(commands: string[]) {
  const goal: GoalContract = {
    schema_version: 1, id: "goal-frozen-acceptance", change_set_id: "change-frozen-acceptance",
    title: "冻结验收输入", outcome: "只更新指定文件", status: "compiled",
    ownership_modules: ["fixture"], write_globs: ["README.md"], required_gateway: "codex-app-server",
    shared_contracts: [], dependencies: [], acceptance_commands: [...commands],
    unresolved_design_questions: [], max_minutes: 5, max_turns: 3
  };
  const originalGoal = structuredClone(goal);
  const context = { cwd: "D:/fixture/worktree", branch: "codex/goal/goal-frozen-acceptance" };
  let turnNumber = 0;
  const transport = new MockJsonRpcTransport({
    "thread/start": { thread: { id: "worker-frozen-acceptance" } },
    "thread/goal/set": {},
    "turn/start": (params: Record<string, unknown>, mock: MockJsonRpcTransport) => {
      const turnId = `turn-${++turnNumber}`;
      const planning = (params.collaborationMode as { mode: string }).mode === "plan";
      const text = planning ? JSON.stringify({
        outcome: goal.outcome, primaryOutcomes: [goal.outcome], ownershipModules: goal.ownership_modules,
        plannedWriteGlobs: goal.write_globs, sharedContracts: [], unresolvedQuestions: [],
        steps: [{ title: "检查指定文件", acceptance: "仅引用冻结验收命令" }], risks: []
      }) : "isolated response fixture";
      queueMicrotask(() => {
        mock.emit({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "agentMessage", text } } });
        mock.emit({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      });
      return { turn: { id: turnId, status: "inProgress" } };
    }
  });
  const gateway = new CodexAppServerGateway(transport, "D:/fixture", true, "gpt-5.6-sol");
  try {
    await gateway.start(goal, null, context);
    await gateway.plan(goal, context);
    await gateway.implement(goal, new EventBus(), context);
    return {
      goal, originalGoal, context, calls: transport.calls,
      turns: transport.calls.filter(call => call.method === "turn/start").map(call => call.params)
    };
  } finally { await gateway.close(); }
}

function inputText(turn: Record<string, unknown>) { return (turn.input as Array<{ text: string }>)[0]!.text; }

describe("frozen acceptance commands reach both Worker phases", () => {
  it("preserves quotes, multiline content, dollar signs and command boundaries verbatim", async () => {
    const commands = [
      `node -e "const s='a;b'; process.exit(s.includes(';') ? 0 : 1)"`,
      "$value = 'literal $HOME and $(not-executed)'\r\nWrite-Output \"$value\"\r\nif ($LASTEXITCODE -ne 0) { exit 1 }"
    ];
    const { turns, goal, originalGoal } = await captureWorkerTurns(commands);
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      const text = inputText(turn);
      const blocks = [...text.matchAll(/^验收命令 (\d+)：\n```text\n([\s\S]*?)\n```(?=\n|$)/gm)];
      expect(blocks.map(block => block[1])).toEqual(["1", "2"]);
      expect(blocks.map(block => block[2])).toEqual(commands);
      expect(text).toContain("步骤标题不是可执行命令");
      for (const command of commands) expect(text).toContain(command);
    }
    expect(goal).toEqual(originalGoal);
  });

  it("keeps Plan read-only, implementation confined to the same worktree, and the existing stage budget", async () => {
    const { turns: [plan, implementation], calls, context, goal, originalGoal } = await captureWorkerTurns(["pnpm test -- fixture"]);
    expect(calls.map(call => call.method)).toEqual(["thread/start", "thread/goal/set", "turn/start", "turn/start"]);
    expect(plan.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(implementation.sandboxPolicy).toEqual({
      type: "workspaceWrite", writableRoots: [context.cwd], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true
    });
    expect(plan.collaborationMode).toEqual({ mode: "plan", settings: { model: "gpt-5.6-sol", reasoning_effort: "medium", developer_instructions: null } });
    expect(implementation.collaborationMode).toEqual({ mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: null, developer_instructions: null } });
    for (const turn of [plan, implementation]) {
      expect(turn.cwd).toBe(context.cwd);
      expect(turn.threadId).toBe("worker-frozen-acceptance");
      expect(turn.approvalPolicy).toBe("never");
    }
    expect(inputText(plan)).toContain("只规划 Goal Contract");
    expect(inputText(plan)).toContain("不要修改文件");
    expect(inputText(plan)).toContain("本阶段不要执行验收");
    expect(inputText(implementation)).toContain("只允许写入：README.md");
    expect(inputText(implementation)).toContain("按编号逐条运行");
    expect(inputText(implementation)).toContain("每段单独执行，不要拼接命令段");
    expect(plan.outputSchema).toMatchObject({ properties: { steps: { maxItems: goal.max_turns } } });
    expect(implementation.outputSchema).toBeUndefined();
    expect(goal).toEqual(originalGoal);
  });

  it.each([{ commands: [] }, { commands: [""] }, { commands: [" \t\r\n"] }])("does not fabricate a missing command: $commands", async ({ commands }) => {
    const { turns, goal, originalGoal } = await captureWorkerTurns(commands);
    for (const turn of turns) {
      expect(inputText(turn)).toContain("未提供；不得自行补造命令。");
      expect(inputText(turn)).not.toContain("```text");
    }
    expect(goal).toEqual(originalGoal);
  });
});
