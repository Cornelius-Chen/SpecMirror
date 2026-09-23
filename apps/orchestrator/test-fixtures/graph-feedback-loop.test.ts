/**
 * Isolated rehearsal only. These identities are injected into one temporary
 * server; they are neither production Hook observations nor human approvals.
 * Every supervisor request is separately registered in an in-memory grant map.
 * Merely copying its header, using loopback, or omitting Agent headers grants
 * nothing. This fixture has no HTTP grant-issuing endpoint.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringFeedback, EngineeringNode, EngineeringView } from "@epm/domain";
import { readYaml } from "@epm/spec-io";
import type { CompanionSession } from "../src/codex-companion.ts";
import { EventBus } from "../src/events.ts";
import { registerEngineeringRoutes } from "../src/engineering-routes.ts";
import { registerHumanApprovalGuard } from "../src/human-approval.ts";
import { TaskWorkspaces } from "../src/task-workspaces.ts";

const AGENT = "isolated-loop-test-agent";
const OWNER = "isolated-loop-test-owner";
type Method = "GET" | "POST" | "PUT";
type Receipt = { method: Method; path: string; status: number; code?: string; explicitTestHuman: boolean };
const fixtures: Array<{ app: FastifyInstance; root: string; receipts: Receipt[] }> = [];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-graph-loop-"));
  const source = join(root, "isolated-source");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src/result.json"), JSON.stringify({ status: "initial", summary: "尚未交付" }));
  const app = Fastify();
  const grants = new Map<string, { method: Method; url: string; payload: string }>();
  registerHumanApprovalGuard(app, async (request, requirement) => {
    const key = request.headers["x-isolated-test-request-id"];
    const grant = typeof key === "string" ? grants.get(key) : undefined;
    if (!grant || typeof key !== "string") return null;
    // One attempt consumes the registration, even if its payload was altered.
    grants.delete(key);
    if (grant.method !== request.method || grant.url !== request.url || grant.payload !== JSON.stringify(request.body ?? null)) return null;
    return { kind: "authenticated_human_approval", principalId: OWNER,
      approvalId: "isolated-test-" + key, requestDigest: requirement.requestDigest, expiresAt: Date.now() + 30_000 };
  });
  const at = new Date().toISOString();
  const session: CompanionSession = { session_id: AGENT, cwd: source, model: "isolated-fixture", permission_mode: null,
    turn_id: null, stage: "connected", last_event: "isolated-fixture-injection", last_seen_at: at, started_at: at,
    plan_version: null, synced_task_ids: [], plan_steps: [], plan_explanation: null,
    current_task_id: null, task_progress: [], output_preview: null };
  const events = new EventBus();
  const workspaces = new TaskWorkspaces(root, events, { source: async () => { throw new Error("Fixture does not read real Codex tasks"); } }, {
    hostSourceRoots: [source], sessions: () => [session], observations: () => [session]
  });
  registerEngineeringRoutes(app, root, events, undefined, workspaces);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const receipts: Receipt[] = [];
  fixtures.push({ app, root, receipts });
  const register = (method: Method, path: string, payload?: unknown) => {
    const key = randomUUID();
    grants.set(key, { method, url: path, payload: JSON.stringify(payload ?? null) });
    return key;
  };
  const call = async (method: Method, path: string, payload?: unknown, options: { human?: boolean; agent?: boolean; key?: string; expected?: number } = {}) => {
    const key = options.human ? register(method, path, payload) : options.key;
    const response = await fetch(address + path, { method, headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "x-isolated-test-request-id": key } : {}),
      ...(options.agent ? { "x-engineering-agent-session-id": AGENT, "x-engineering-cwd": encodeURIComponent(source) } : {})
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const data = await response.json();
    receipts.push({ method, path, status: response.status, code: data.code, explicitTestHuman: Boolean(options.human) });
    expect(response.status, JSON.stringify(data)).toBe(options.expected ?? 200);
    return data;
  };
  const view = (): Promise<EngineeringView> => call("GET", "/api/engineering");
  const human = (method: Method, path: string, payload?: unknown, expected = 200) => call(method, "/api/engineering" + path, payload, { human: true, expected });
  const agent = (method: Method, path: string, payload?: unknown, expected = 200) => call(method, "/api/engineering" + path, payload, { agent: true, expected });
  const configure = async () => {
    const current = await view();
    const node: EngineeringNode = { ...current.document.nodes[0], title: "隔离演练：研究摘要", owner: "codex:" + AGENT,
      objective: "交付一份内容清楚且可以核对的研究摘要", method: "在冻结的局部范围修改摘要并运行检查", actions: [],
      criteria: [{ id: "clear-summary", kind: "manual", text: "摘要清楚说明研究结论", path: "", expected: "" }],
      delivery: { included: ["一份研究摘要"], excluded: ["交易执行及其他工程"], inputs: [],
        outputs: [{ id: "summary", title: "研究摘要", criterion_ids: ["clear-summary"] }] },
      source_scope: { root: source, allow: ["src/**"], deny: ["src/protected/**"], checks: [{ id: "summary-readable", title: "读取实际交付文件",
        program: "node", args: ["-e", "const a=require('node:assert/strict'),f=JSON.parse(require('node:fs').readFileSync('src/result.json','utf8'));a.equal(f.status,'delivered');a.ok(f.summary.length>5)"] }] }
    };
    const input = { node, expected_revision: current.document.revision, reason: "隔离演练明确成果、执行范围与验收标准" };
    await human("POST", "/nodes/engineering-project/preview", input);
    await human("PUT", "/nodes/engineering-project", input);
  };
  const start = async () => {
    await human("POST", "/nodes/engineering-project/ready", { expected_revision: (await view()).document.revision });
    // The assigned test Agent explicitly dispatches its own frozen task. It has
    // no authority to prepare the task or review the result.
    await agent("POST", "/dispatch", { node_ids: ["engineering-project"], mode: "external" }, 202);
    await workspaces.settled();
    const pending = (await view()).document.runs.at(-1)!;
    expect(pending.handoff?.state).toBe("claimed");
    const packet = await call("GET", `/api/engineering/runs/${pending.id}/handoff`);
    expect(packet.contract_key).toBe(pending.handoff?.contract_key);
    await workspaces.settled();
    expect((await view()).document.runs.at(-1)).toMatchObject({ id: pending.id, status: "running", handoff: { state: "claimed" } });
    return pending.id;
  };
  const writeResult = (summary: string) => writeFileSync(join(source, "src/result.json"), JSON.stringify({ status: "delivered", summary }));
  const finish = (id: string) => agent("POST", `/runs/${id}/finish`, {});
  const reviewPayload = { verdict: "accepted", note: "隔离测试身份已核对当前摘要；不是生产人类批准", checks: [{ criterion_id: "clear-summary", passed: true, note: "测试用例核对当前摘要" }] };
  const review = (id: string) => human("POST", `/runs/${id}/review`, reviewPayload);
  const update = async (feedbackId: string, action: string, runId?: string, expected = 200) => human("POST", `/feedback-items/${feedbackId}/update`, {
    expected_revision: (await view()).document.revision, action, note: "隔离演练：" + action,
    ...(runId ? { run_id: runId } : {})
  }, expected);
  const acceptedOriginal = async () => {
    await configure(); const id = await start();
    writeResult("原摘要结构完整，但解释仍需更清晰");
    await finish(id); await review(id); return id;
  };
  const feedback = async () => {
    const current = await view();
    await human("POST", "/feedback-items", { expected_revision: current.document.revision,
      base_node_revision: current.document.nodes[0].revision, target: { kind: "output", node_id: "engineering-project", id: "summary" },
      kind: "defect", note: "这份研究摘要不够直观，请把结论解释清楚。" }, 201);
    return (await view()).document.feedbacks!.at(-1)!;
  };
  return { root, source, call, view, human, agent, register, configure, start, writeResult, finish, review, reviewPayload, update, acceptedOriginal, feedback };
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.app.close();
    // Keep only isolated fixture evidence for inspection; no workspace cleanup.
    writeFileSync(join(item.root, "isolated-api-receipts.json"), JSON.stringify({ scope: "isolated-test-only", productionConnected: false, receipts: item.receipts }, null, 2));
  }
});

describe("graph feedback loop through real HTTP routes with explicit isolated identities", () => {
  it("rejects anonymous, copied and altered approvals without changing the engineering document", async () => {
    const f = await fixture();
    const current = await f.view();
    const path = "/api/engineering/feedback-items";
    const payload = { expected_revision: current.document.revision, base_node_revision: current.document.nodes[0].revision,
      target: { kind: "node", node_id: current.document.root_id }, kind: "defect", note: "隔离身份拒绝演练" };
    expect(await f.call("POST", path, payload, { expected: 403 })).toMatchObject({ code: "human_approval_required" });
    await f.call("POST", path, payload, { key: randomUUID(), expected: 403 });
    const key = f.register("POST", path, payload);
    await f.call("POST", path, { ...payload, note: "被替换的请求" }, { key, expected: 403 });
    await f.call("POST", path, payload, { key, expected: 403 });
    expect((await f.view()).document).toEqual(current.document);
    await f.call("POST", path, payload, { human: true, expected: 201 });
    const saved = (await f.view()).document.feedbacks!.at(-1)!;
    expect(saved.history[0].actor).toBe("human:" + OWNER);
    const adoptedPath = `/api/engineering/feedback-items/${saved.id}/update`;
    const adopted = { expected_revision: (await f.view()).document.revision, action: "adopt", note: "Agent 不能使用测试人类批准" };
    await f.call("POST", adoptedPath, adopted, { human: true, agent: true, expected: 403 });
    expect((await f.view()).document.feedbacks!.at(-1)!.status).toBe("open");
  });

  it("returns a freshly checked local result to the exact graph output and closes only after explicit test-human review", async () => {
    const f = await fixture(), original = await f.acceptedOriginal(), feedback = await f.feedback();
    expect(feedback.base_run_id).toBe(original);
    expect(feedback.status).toBe("open");
    await f.update(feedback.id, "adopt");
    expect((await f.view()).document.runs.find(run => run.id === original)!.status).toBe("stale");
    const beforeRejected = (await f.view()).document;
    expect(await f.update(feedback.id, "submit", original, 409)).toMatchObject({ code: "engineering_feedback_result_mismatch" });
    expect((await f.view()).document).toEqual(beforeRejected);
    const replacement = await f.start();
    await f.update(feedback.id, "working", replacement);
    f.writeResult("修订摘要：先说明结论，再解释依据与适用边界，用户可以直接核对。");
    await f.finish(replacement);
    const run = (await f.view()).document.runs.find(item => item.id === replacement)!;
    expect(run).toMatchObject({ status: "review", source_proof: { passed: true, changes: [{ path: "src/result.json", kind: "modified", allowed: true }], checks: [{ status: "passed", exit_code: 0 }] } });
    expect(run.source_proof!.changes[0].before_sha256).not.toBe(run.source_proof!.changes[0].after_sha256);
    await f.update(feedback.id, "submit", replacement);
    expect(await f.update(feedback.id, "resolve", undefined, 409)).toMatchObject({ code: "engineering_feedback_review_required" });
    const reviewPath = `/api/engineering/runs/${replacement}/review`;
    await f.call("POST", reviewPath, f.reviewPayload, { expected: 403 });
    await f.call("POST", reviewPath, f.reviewPayload, { agent: true, expected: 403 });
    await f.review(replacement);
    await f.update(feedback.id, "resolve");
    const completed = await f.view();
    const saved = completed.document.feedbacks!.find(item => item.id === feedback.id)!;
    expect(saved).toMatchObject({ target: feedback.target, submitted_run_id: replacement, status: "resolved", resolution_kind: "delivery" });
    expect(saved.history.map(item => item.action)).toEqual(["create", "adopt", "working", "submit", "resolve"]);
    expect(saved.history.at(-1)?.basis?.run_id).toBe(replacement);
    expect(completed.derived[feedback.target.node_id].status).toBe("accepted");
    const persisted = readYaml<{ feedbacks: EngineeringFeedback[] }>(join(f.root, ".project/engineering/recursive/document.yaml"));
    expect(persisted.feedbacks.find(item => item.id === feedback.id)).toEqual(saved);
    expect(JSON.parse(readFileSync(join(f.source, "src/result.json"), "utf8")).summary).toContain("适用边界");
  }, 15_000);

  it("keeps feedback open for review when the source changes after a replacement was accepted", async () => {
    const f = await fixture(); await f.acceptedOriginal(); const feedback = await f.feedback();
    await f.update(feedback.id, "adopt"); const replacement = await f.start();
    f.writeResult("修订摘要通过实际检查，并等待核对"); await f.finish(replacement); await f.review(replacement);
    await f.update(feedback.id, "submit", replacement);
    f.writeResult("核对后再次修改但尚未重新检查的摘要");
    expect(await f.update(feedback.id, "resolve", undefined, 409)).toMatchObject({ code: "engineering_source_changed_after_check" });
    expect((await f.view()).document.feedbacks!.find(item => item.id === feedback.id)?.status).toBe("review");
  });

  it("blocks out-of-scope writes even when the caller claims the result passed", async () => {
    const f = await fixture(); await f.configure(); const runId = await f.start();
    f.writeResult("摘要已完成，但存在范围以外的修改");
    writeFileSync(join(f.source, "outside.txt"), "isolated intentional boundary failure");
    await f.agent("POST", `/runs/${runId}/finish`, { passed: true, status: "accepted" });
    const run = (await f.view()).document.runs.find(item => item.id === runId)!;
    expect(run).toMatchObject({ status: "blocked", source_proof: { passed: false, changes: expect.arrayContaining([expect.objectContaining({ path: "outside.txt", allowed: false })]) } });
    await f.human("POST", `/runs/${runId}/review`, f.reviewPayload, 409);
  });
});
