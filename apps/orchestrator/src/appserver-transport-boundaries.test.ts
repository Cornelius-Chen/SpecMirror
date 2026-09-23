import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { GoalContract } from "@epm/domain";
import { describe, expect, it } from "vitest";
import { EventBus } from "./events.ts";
import { CodexAppServerGateway, MockJsonRpcTransport } from "./jsonrpc.ts";
import { StdioJsonRpcTransport, type StdioJsonRpcOptions } from "./stdio-jsonrpc.ts";

type RpcMessage = Record<string, unknown>;
type ScriptedChild = ChildProcessWithoutNullStreams & EventEmitter;

function createScriptedChild(
  onMessage: (message: RpcMessage, send: (message: RpcMessage) => void, child: ScriptedChild) => void
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    kill: () => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    }
  }) as unknown as ScriptedChild;
  const send = (message: RpcMessage) => stdout.write(`${JSON.stringify(message)}\n`);
  let buffered = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const boundary = buffered.indexOf("\n");
      const line = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      if (line) onMessage(JSON.parse(line) as RpcMessage, send, child);
    }
  });
  return { child, send };
}

function transportFor(child: ScriptedChild) {
  return new StdioJsonRpcTransport({
    command: "fixture-app-server",
    args: [],
    cwd: process.cwd(),
    requestTimeoutMs: 5_000,
    spawnProcess: (() => child) as unknown as NonNullable<StdioJsonRpcOptions["spawnProcess"]>
  });
}

function rpcGoal(id: string): GoalContract {
  return {
    schema_version: 1,
    id,
    change_set_id: "change-transport-boundary",
    title: "Transport boundary",
    outcome: "Wait for one streamed turn",
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

describe("App Server transport terminal boundaries", () => {
  it("pins immutable Goal fields in the structured plan schema", async () => {
    let outputSchema: Record<string, any> | undefined;
    const goal = rpcGoal("goal-plan-schema");
    const transport = new MockJsonRpcTransport({
      "thread/start": { thread: { id: "thread-plan-schema" } },
      "thread/goal/set": {},
      "turn/start": (params: Record<string, unknown>, mock: MockJsonRpcTransport) => {
        outputSchema = params.outputSchema as Record<string, any>;
        const turnId = "turn-plan-schema";
        queueMicrotask(() => {
          mock.emit({
            method: "item/completed",
            params: {
              threadId: params.threadId,
              turnId,
              item: {
                type: "agentMessage",
                text: JSON.stringify({
                  outcome: goal.outcome,
                  primaryOutcomes: [goal.outcome],
                  ownershipModules: goal.ownership_modules,
                  plannedWriteGlobs: goal.write_globs,
                  sharedContracts: [],
                  unresolvedQuestions: [],
                  steps: [{ title: "Do the bounded work", acceptance: "The declared acceptance command passes" }],
                  risks: []
                })
              }
            }
          });
          mock.emit({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
        });
        return { turn: { id: turnId, status: "inProgress" } };
      }
    });
    const gateway = new CodexAppServerGateway(transport, process.cwd());
    gateway.setReady(true);
    await gateway.start(goal);

    await expect(gateway.plan(goal)).resolves.toMatchObject({ outcome: goal.outcome, primaryOutcomes: [goal.outcome] });
    expect(outputSchema?.properties.outcome.enum).toEqual([goal.outcome]);
    expect(outputSchema?.properties.primaryOutcomes).toMatchObject({ minItems: 1, maxItems: 1 });
    expect(outputSchema?.properties.primaryOutcomes.items.enum).toEqual([goal.outcome]);
    expect(outputSchema?.properties.sharedContracts.maxItems).toBe(0);
    expect(outputSchema?.properties.unresolvedQuestions.maxItems).toBe(0);
    await gateway.close();
  });

  it.each([
    ["error", "codex_app_server_spawn_failed:fixture-child-error"],
    ["close", "codex_app_server_closed:17:none:"]
  ] as const)("rejects every pending request immediately on child %s", async (terminalEvent, expectedError) => {
    let heldRequests = 0;
    const scripted = createScriptedChild((message, send, child) => {
      if (message.method === "initialize") send({ id: message.id, result: {} });
      else if (message.method === "ready") send({ id: message.id, result: { ok: true } });
      else if (typeof message.method === "string" && message.method.startsWith("hold/")) {
        heldRequests += 1;
        if (heldRequests === 2) queueMicrotask(() => {
          if (terminalEvent === "error") child.emit("error", new Error("fixture-child-error"));
          else child.emit("close", 17, null);
        });
      }
    });
    const transport = transportFor(scripted.child);
    const terminalErrors: string[] = [];
    transport.onError((error) => terminalErrors.push(error.message));
    await expect(transport.request("ready", {})).resolves.toEqual({ ok: true });

    const results = await Promise.allSettled([
      transport.request("hold/one", {}),
      transport.request("hold/two", {})
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ message: expectedError });
    }
    expect(terminalErrors).toEqual([expectedError]);
    await transport.close();
  });

  it("answers App Server requests that use string JSON-RPC ids", async () => {
    let pingId: unknown;
    let currentTimeAccepted = false;
    const scripted = createScriptedChild((message, send) => {
      if (message.method === "initialize") send({ id: message.id, result: {} });
      else if (message.method === "ping") {
        pingId = message.id;
        send({ id: "clock-request", method: "currentTime/read", params: {} });
      } else if (message.id === "clock-request") {
        currentTimeAccepted = Number.isInteger((message.result as { currentTimeAt?: unknown } | undefined)?.currentTimeAt);
        send({
          id: "approval-request",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-string", turnId: "turn-string", itemId: "item-string" }
        });
      } else if (message.id === "approval-request") {
        send({
          id: pingId,
          result: {
            currentTimeAccepted,
            decision: (message.result as { decision?: unknown } | undefined)?.decision,
            responseIds: ["clock-request", "approval-request"]
          }
        });
      }
    });
    const transport = transportFor(scripted.child);

    await expect(transport.request("ping", {})).resolves.toEqual({
      currentTimeAccepted: true,
      decision: "decline",
      responseIds: ["clock-request", "approval-request"]
    });
    await transport.close();
  });

  it("rejects a streamed turn waiter when the underlying transport fails", async () => {
    const transport = new MockJsonRpcTransport({
      "thread/start": { thread: { id: "thread-waiter" } },
      "thread/goal/set": {},
      "turn/start": { turn: { id: "turn-waiter", status: "inProgress" } }
    });
    const gateway = new CodexAppServerGateway(transport, process.cwd());
    gateway.setReady(true);
    const goal = rpcGoal("goal-transport-failure");
    await gateway.start(goal);
    const implementing = gateway.implement(goal, new EventBus());
    const rejected = expect(implementing).rejects.toThrow("codex_app_server_closed:fixture");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    transport.fail(new Error("codex_app_server_closed:fixture"));

    await rejected;
    expect(gateway.ready).toBe(false);
    await gateway.close();
  });

  it("rejects a streamed turn waiter when the gateway closes", async () => {
    const transport = new MockJsonRpcTransport({
      "thread/start": { thread: { id: "thread-close" } },
      "thread/goal/set": {},
      "turn/start": { turn: { id: "turn-close", status: "inProgress" } }
    });
    const gateway = new CodexAppServerGateway(transport, process.cwd());
    gateway.setReady(true);
    const goal = rpcGoal("goal-transport-close");
    await gateway.start(goal);
    const implementing = gateway.implement(goal, new EventBus());
    const rejected = expect(implementing).rejects.toThrow("codex_transport_closed");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    await gateway.close();

    await rejected;
    expect(gateway.ready).toBe(false);
  });
});
