import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp, resolveSseCursor, serializeSseEvent } from "./app.ts";
import { EventBus } from "./events.ts";
import { mergeGateFailures, GitController } from "./git.ts";
import { CodexAppServerGateway, MockJsonRpcTransport } from "./jsonrpc.ts";
import { isolatedAppServerEnvironment, safeAppServerEnvironment, StdioJsonRpcTransport, type JsonRpcNotification } from "./stdio-jsonrpc.ts";
import type { GoalContract } from "@epm/domain";
import { atomicWriteYaml, freezeSupervisionTask, loadProject, loadSupervision, loadSupervisionRuns, RuntimeStore, writeGoal, writeRun, writeSupervisionDetail, writeSupervisionRun } from "@epm/spec-io";
import { MockAgentGateway, type GoalExecutionContext } from "./gateway.ts";
import { GoalOrchestrator } from "./orchestrator.ts";
import { dispatchSupervisionGoal, resumeSupervisionGoalRun } from "./supervision.ts";
import { CodexReadinessManager, terminateCodexSmokeProcessTree } from "./codex-readiness.ts";
import type { HumanApprovalVerifier } from "./human-approval.ts";
import { signHookPayload } from "./hook-auth.ts";

const root = process.cwd();
const hookAuthDataDirectory = mkdtempSync(join(tmpdir(), "epm-hook-auth-suite-"));
let isolatedApproval = 0;
const isolatedHumanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
  kind: "authenticated_human_approval",
  principalId: "isolated-orchestrator-test-owner",
  approvalId: `orchestrator-test-approval-${++isolatedApproval}`,
  requestDigest: requirement.requestDigest,
  expiresAt: Date.now() + 60_000
});
function buildTestApp(options: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({ hookAuthDataDirectory, ...options, humanApprovalVerifier: isolatedHumanApproval });
}

afterAll(() => rmSync(hookAuthDataDirectory, { recursive: true, force: true }));

// The synchronous Git fixtures otherwise starve worker-to-reporter RPC between tests.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

function copyProjectTruth(repo: string) {
  cpSync(join(root, ".project"), join(repo, ".project"), {
    recursive: true,
    filter: (source) => !source.replaceAll("\\", "/").includes("/.project/.runtime")
  });
}

function bumpTag(value: string, prefix: string) {
  return `${prefix}${Number(value.match(/\d+$/)?.[0] ?? 0) + 1}`;
}

describe("local API", () => {
  it("uses standard SSE IDs so browser reconnects resume after the last delivered event", () => {
    expect(resolveSseCursor(undefined, "41")).toBe(41);
    expect(resolveSseCursor("42", "41")).toBe(42);
    expect(resolveSseCursor("invalid", "41")).toBe(0);
    expect(serializeSseEvent({ id: 42 })).toBe('id: 42\ndata: {"id":42}\n\n');
  });

  it("serves project map and refuses empty capture", async () => {
    const app = await buildTestApp({ root, gateway: "mock" });
    const map = await app.inject({ method: "GET", url: "/api/project/map" });
    expect(map.statusCode).toBe(200);
    expect(map.json().metrics.baselineProgress).toBe(100);
    expect(map.json().bindings).toEqual(expect.arrayContaining([expect.objectContaining({ mark: "W01", symbol: "FieldTraceLens" })]));
    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json().runnable).not.toContain("goal-y1-appserver-gateway");
    expect(status.json().gatewayWaiting).toContain("goal-y1-appserver-gateway");
    const completion = await app.inject({ method: "GET", url: "/api/completion" });
    expect(completion.statusCode).toBe(200);
    expect(completion.json()).toMatchObject({ countingRule: "atomic_tasks_equal_weight_done_only", total: expect.any(Number), waitingUser: expect.any(Number), workstreams: expect.any(Array) });
    expect(completion.json().waitingUser).toBe(completion.json().workstreams.flatMap((stream: { tasks: Array<{ status: string }> }) => stream.tasks).filter((task: { status: string }) => task.status === "waiting_user").length);
    const invalid = await app.inject({ method: "POST", url: "/api/inbox/capture", payload: { title: "" } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/inbox/capture", payload: { title: 42 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/plan/import", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/impact", payload: { id: "missing-entity" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/changesets/missing-change/compile" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/changesets/missing-change/dispatch" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/runs/run-x0-bootstrap/stop" })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/runs/run-x0-bootstrap/resume" })).statusCode).toBe(409);
    await app.close();
  }, 15_000);

  it("serves newly built frontend assets without falling back to the HTML shell", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-static-"));
    copyProjectTruth(repo);
    const dist = join(repo, "apps", "web", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    writeFileSync(join(dist, "late-build.js"), "globalThis.__epmAssetLoaded = true;", "utf8");

    const asset = await app.inject({ method: "GET", url: "/late-build.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript/);
    expect(asset.body).toContain("__epmAssetLoaded");
    await app.close();
  }, 15_000);

  it("updates human verdicts but does not count a historical smoke summary without retained evidence as current completion", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-completion-gates-"));
    copyProjectTruth(repo);
    atomicWriteYaml(join(repo, ".project", "audits", "completion.yaml"), {
      schema_version: 1,
      id: "audit-completion-gates",
      title: "自动完成门禁",
      updated_at: new Date().toISOString(),
      counting_rule: "atomic_tasks_equal_weight_done_only",
      workstreams: [{ id: "stream-gates", title: "门禁", description: "读取真实状态", tasks: [
        { id: "verdict-function", title: "人工功能判断", status: "waiting_user", evidence: [], action: "检查", condition: { kind: "supervision_detail_accepted", detail_id: "detail-function-progress" } },
        { id: "orchestration-real-smoke", title: "真实烟测", status: "waiting_user", evidence: [], action: "烟测", condition: { kind: "codex_smoke_passed" } }
      ] }]
    });
    const detail = loadSupervision(repo).details.find((item) => item.id === "detail-function-progress")!;
    writeSupervisionDetail(repo, { ...detail, status: "accepted", output: { ...detail.output!, reviewer_status: "accepted", reviewer_note: "已核对" } });
    const runtime = new RuntimeStore(repo);
    runtime.setState("codex_smoke_state", JSON.stringify({ id: "smoke-test", status: "passed", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), message: "测试状态" }));
    runtime.close();
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const completion = await app.inject({ method: "GET", url: "/api/completion" });
    expect(completion.statusCode).toBe(200);
    expect(completion.json()).toMatchObject({ done: 1, total: 2, waitingUser: 1 });
    expect(completion.json().workstreams.flatMap((stream: { tasks: unknown[] }) => stream.tasks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "verdict-function", status: "done", declaredStatus: "waiting_user", resolved: true }),
      expect.objectContaining({ id: "orchestration-real-smoke", status: "waiting_user", declaredStatus: "waiting_user", resolved: false })
    ]));
    await app.close();
  });

  it("imports a Plan only as candidates and computes impact from formal edges", async () => {
    const app = await buildTestApp({ root, gateway: "mock" });
    const imported = await app.inject({ method: "POST", url: "/api/plan/import", payload: { text: "设计监督入口\n验证受保护基线" } });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ candidates: [{ id: "candidate-1", title: "设计监督入口", kind: "design", status: "suggested", formal: false }, { id: "candidate-2", title: "验证受保护基线", kind: "evidence", status: "suggested", formal: false }] });
    const impact = await app.inject({ method: "POST", url: "/api/impact", payload: { id: "design-x0-workbench" } });
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toMatchObject({ direct: expect.any(Array), transitive: expect.any(Array), guardedAtRisk: expect.any(Array) });
    await app.close();
  });

  it("defers credential discovery without reading or writing a secret", async () => {
    const app = await buildTestApp({ root, gateway: "codex-app-server" });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.json()).toMatchObject({ gateway: "codex-app-server", credential: "unchecked", credential_source: "none", enabled: false });
    await app.close();
  });

  it("reports Codex readiness without exposing a credential and refuses premature smoke tests", async () => {
    const app = await buildTestApp({ root, gateway: "mock" });
    const readiness = await app.inject({ method: "GET", url: "/api/codex/readiness" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ ready_to_run: false, credential_location: "server-only", runtime: "ready", gateway_selected: false, locked_codex_version: "0.144.6" });
    expect(JSON.stringify(readiness.json())).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
    expect((await app.inject({ method: "POST", url: "/api/codex/smoke" })).statusCode).toBe(409);
    await app.close();
  });

  it("edits one supervision detail and records a human verdict", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-api-"));
    copyProjectTruth(repo);
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const current = await app.inject({ method: "GET", url: "/api/supervision" });
    expect(current.statusCode).toBe(200);
    const document = current.json();
    const detail = document.details.find((item: { id: string }) => item.id === "detail-function-progress");
    const historicalRuns = loadSupervisionRuns(repo).filter((run) => run.status === "accepted");
    const reviewed = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/review`, payload: { verdict: "needs_revision", note: "自动证据尚未接入" } });
    expect(reviewed.statusCode).toBe(200);
    const reviewedDetail = reviewed.json().details.find((item: { id: string }) => item.id === detail.id);
    expect(reviewedDetail).toMatchObject({ status: "needs_revision", output: { reviewer_status: "needs_revision", reviewer_note: "自动证据尚未接入" } });
    expect(loadSupervisionRuns(repo).filter((run) => run.status === "accepted")).toEqual(historicalRuns);
    const skippedRework = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/review`, payload: { verdict: "accepted", note: "不能跳过局部重做" } });
    expect(skippedRework.statusCode).toBe(409);
    expect(skippedRework.json().error).toContain("Invalid supervision transition");
    const edited = { ...reviewedDetail, intent: "由监督者更新后的目标", version: bumpTag(reviewedDetail.version, "v"), prompt: { ...reviewedDetail.prompt, version: bumpTag(reviewedDetail.prompt.version, "p") } };
    const saved = await app.inject({ method: "PUT", url: `/api/supervision/details/${detail.id}`, payload: edited });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().details.find((item: { id: string }) => item.id === detail.id)).toMatchObject({ intent: "由监督者更新后的目标", status: "ready", version: edited.version });
    expect(saved.json().details.find((item: { id: string }) => item.id === detail.id).output).toBeUndefined();
    const stale = await app.inject({ method: "PUT", url: `/api/supervision/details/${detail.id}`, payload: { ...edited, intent: "过期版本修改" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("detail_version_conflict");
    await app.close();
  });

  it("adds a human-owned design draft without silently creating engineering work", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-create-"));
    copyProjectTruth(repo);
    const before = loadProject(repo);
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    expect((await app.inject({ method: "POST", url: "/api/supervision/details", payload: { category: "unknown" } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/api/supervision/details", payload: { category: "visual" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ detail: { category: "visual", status: "draft", version: "v1", title: "新的视觉要求" } });
    expect(created.json().detail.id).toMatch(/^detail-visual-/);
    expect(loadSupervision(repo).details).toContainEqual(expect.objectContaining({ id: created.json().detail.id, status: "draft" }));
    const after = loadProject(repo);
    expect(after.goals).toHaveLength(before.goals.length);
    expect(after.runs).toHaveLength(before.runs.length);
    expect(after.bindings).toHaveLength(before.bindings.length);
    await app.close();
  });

  it("imports Codex Plan tasks, keeps them editable, and requires an explicit task freeze", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-plan-"));
    copyProjectTruth(repo);
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const imported = await app.inject({ method: "POST", url: "/api/supervision/plan/import", payload: { text: "1. 建立安全事件流\n2. 更新移动端图表" } });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ document: { plan: { source: "codex-plan" } }, imported_task_ids: [expect.any(String), expect.any(String)] });
    const taskId = imported.json().imported_task_ids[0];
    const task = imported.json().document.tasks.find((item: { id: string }) => item.id === taskId);
    const detail = imported.json().document.details.find((item: { task_id: string }) => item.task_id === taskId);
    expect(task).toMatchObject({ title: "建立安全事件流", status: "draft", version: "t1" });
    expect(detail).toMatchObject({ task_id: taskId, category: "function", status: "draft" });
    expect((await app.inject({ method: "POST", url: `/api/supervision/tasks/${taskId}/freeze` })).statusCode).toBe(409);

    const savedDetail = await app.inject({ method: "PUT", url: `/api/supervision/details/${detail.id}`, payload: {
      ...detail,
      version: bumpTag(detail.version, "v"),
      acceptance: ["事件完成后两秒内可见"],
      prompt: { ...detail.prompt, version: bumpTag(detail.prompt.version, "p") }
    } });
    expect(savedDetail.statusCode).toBe(200);
    const frozen = await app.inject({ method: "POST", url: `/api/supervision/tasks/${taskId}/freeze` });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().tasks.find((item: { id: string }) => item.id === taskId)).toMatchObject({ status: "frozen", version: "t2" });

    const currentTask = frozen.json().tasks.find((item: { id: string }) => item.id === taskId);
    const savedTask = await app.inject({ method: "PUT", url: `/api/supervision/tasks/${taskId}`, payload: { ...currentTask, title: "建立去重安全事件流", version: bumpTag(currentTask.version, "t"), status: "ready" } });
    expect(savedTask.statusCode).toBe(200);
    expect(savedTask.json().tasks.find((item: { id: string }) => item.id === taskId)).toMatchObject({ title: "建立去重安全事件流", status: "ready", version: "t3" });
    await app.close();
  });

  it("automatically binds a Codex hook session, synchronizes update_plan, and delivers reviewed feedback at Stop", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-codex-companion-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const sessionId = "session-specmirror-test";
    const hookAt = Date.now();

    const startPayload = {
      session_id: sessionId, cwd: repo, hook_event_name: "SessionStart", model: "test-model", permission_mode: "plan", source: "startup"
    };
    const unsigned = await app.inject({ method: "POST", url: "/api/codex-companion/hooks", payload: startPayload });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json()).toEqual({ code: "codex_hook_auth_failed", error: "Codex Hook authentication failed; the lifecycle event was ignored." });
    const started = await app.inject({ method: "POST", url: "/api/codex-companion/hooks", payload: startPayload,
      headers: signHookPayload(startPayload, { dataDirectory: hookAuthDataDirectory, timestamp: hookAt }) });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ accepted: true, session: { session_id: sessionId, stage: "connected" } });
    const statusBeforeStale = (await app.inject({ method: "GET", url: "/api/codex-companion/status" })).json();
    const stale = await app.inject({ method: "POST", url: "/api/codex-companion/hooks", payload: startPayload,
      headers: signHookPayload(startPayload, { dataDirectory: hookAuthDataDirectory, timestamp: hookAt - 1 }) });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ accepted: false, ignored: "old_signed_event", identity_observed: false });
    expect((await app.inject({ method: "GET", url: "/api/codex-companion/status" })).json().latest_session.last_seen_at)
      .toBe(statusBeforeStale.latest_session.last_seen_at);

    const planPayload = {
      session_id: sessionId, cwd: repo, hook_event_name: "PostToolUse", turn_id: "turn-plan", tool_name: "update_plan",
      tool_input: { explanation: "同步测试", plan: [{ step: "建立自动线程绑定", status: "in_progress" }, { step: "验证安全反馈回送", status: "pending" }] }
    };
    const synchronized = await app.inject({ method: "POST", url: "/api/codex-companion/hooks", payload: planPayload,
      headers: signHookPayload(planPayload, { dataDirectory: hookAuthDataDirectory, timestamp: hookAt + 1 }) });
    expect(synchronized.statusCode).toBe(200);
    expect(synchronized.json().imported_task_ids).toHaveLength(2);
    const status = (await app.inject({ method: "GET", url: "/api/codex-companion/status" })).json();
    expect(status).toMatchObject({ connected: true, latest_session: { session_id: sessionId, stage: "planning", plan_version: expect.any(String) } });
    const taskId = synchronized.json().imported_task_ids[0];

    const queued = await app.inject({ method: "POST", url: "/api/codex-companion/feedback", payload: { task_id: taskId, text: "只调整该任务的设计细节，不扩大工程范围。" } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ feedback: { session_id: sessionId, task_id: taskId, status: "pending" } });

    const stopPayload = {
      session_id: sessionId, cwd: repo, hook_event_name: "Stop", turn_id: "turn-plan", last_assistant_message: "本轮完成"
    };
    const stopped = await app.inject({ method: "POST", url: "/api/codex-companion/hooks", payload: stopPayload,
      headers: signHookPayload(stopPayload, { dataDirectory: hookAuthDataDirectory, timestamp: hookAt + 2 }) });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().hook_response).toMatchObject({ decision: "block", reason: expect.stringContaining("只调整该任务") });
    const delivered = (await app.inject({ method: "GET", url: "/api/codex-companion/status" })).json();
    expect(delivered.feedback[0]).toMatchObject({ status: "delivered", delivered_at: expect.any(String) });
    await app.close();
  });

  it("attaches a current external Agent receipt only when every design criterion is mapped exactly once", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-external-receipt-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const detail = loadSupervision(repo).details.find((item) => item.id === "detail-function-progress")!;
    writeSupervisionDetail(repo, { ...detail, status: "ready", output: undefined });
    const receipt = {
      agent_label: "当前 Codex · 本地实现审计",
      summary: "已把当前实现证据逐项回挂，等待监督者判断。",
      artifact_kind: "behavior",
      artifact_ref: "/specmirror-progress.html",
      checks: detail.acceptance.map((criterion) => ({ criterion, result: "pass", note: "受控 API 与自动化测试均已核对。" }))
    };
    const attached = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/external-output`, payload: receipt });
    expect(attached.statusCode).toBe(201);
    expect(attached.json()).toMatchObject({
      run: { detail_id: detail.id, mode: "external", status: "reviewing", prompt_snapshot: detail.prompt },
      document: { details: expect.arrayContaining([expect.objectContaining({ id: detail.id, status: "reviewing", output: expect.objectContaining({ source: "external", agent_label: receipt.agent_label, reviewer_status: "pending" }) })]) },
      progress: { evidenceCoverage: expect.any(Number) }
    });
    const missing = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/external-output`, payload: { ...receipt, checks: receipt.checks.slice(1) } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("external_receipt_check_mismatch");
    const unsafe = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/external-output`, payload: { ...receipt, artifact_ref: "file:///C:/secret.txt" } });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error).toContain("artifact_ref_unsafe");
    expect(loadSupervisionRuns(repo)).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/review`, payload: { verdict: "accepted", note: "确认当前证据" } })).statusCode).toBe(200);
    const acceptedDocument = loadSupervision(repo);
    const acceptedRuns = loadSupervisionRuns(repo);
    const overwriteAccepted = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/external-output`, payload: receipt });
    expect(overwriteAccepted.statusCode).toBe(400);
    expect(overwriteAccepted.json().error).toContain("Invalid supervision transition");
    expect(loadSupervision(repo)).toEqual(acceptedDocument);
    expect(loadSupervisionRuns(repo)).toEqual(acceptedRuns);
    await app.close();
  });

  it("dispatches one category with an immutable prompt snapshot and evidence progress", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-dispatch-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const before = (await app.inject({ method: "GET", url: "/api/supervision" })).json();
    const progressBefore = (await app.inject({ method: "GET", url: "/api/supervision/progress" })).json();
    const originalTarget = before.details.find((item: { id: string }) => item.id === "detail-asset-permission");
    const resources = ["assets/brand/reference.png", "asset-id:hero-warm-paper"];
    const savedTarget = await app.inject({ method: "PUT", url: `/api/supervision/details/${originalTarget.id}`, payload: { ...originalTarget, version: bumpTag(originalTarget.version, "v"), prompt: { ...originalTarget.prompt, version: bumpTag(originalTarget.prompt.version, "p"), resources } } });
    expect(savedTarget.statusCode).toBe(200);
    const target = savedTarget.json().details.find((item: { id: string }) => item.id === originalTarget.id);
    const untouched = before.details.find((item: { id: string }) => item.id === "detail-copy-human-first");
    const response = await app.inject({ method: "POST", url: `/api/supervision/details/${target.id}/dispatch`, payload: { mode: "mock" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ detail_id: target.id, category: "asset", mode: "mock", status: "reviewing", attempt: 1, prompt_snapshot: target.prompt, permission_snapshot: { category_only: true, resource_refs: resources } });
    expect(response.json().document.details.find((item: { id: string }) => item.id === target.id)).toMatchObject({ status: "reviewing", output: { source: "mock", reviewer_status: "pending" } });
    expect(response.json().document.details.find((item: { id: string }) => item.id === untouched.id)).toEqual(untouched);
    const progress = (await app.inject({ method: "GET", url: "/api/supervision/progress" })).json();
    expect(progress).toMatchObject({ totalDetails: before.details.length, totalRuns: 1 });
    expect(progress.outputCoverage).toBeGreaterThanOrEqual(progressBefore.outputCoverage);
    expect(progress.nextBestAction?.detailId).not.toBe(target.id);
    const liveAttempt = await app.inject({ method: "POST", url: `/api/supervision/details/${target.id}/dispatch`, payload: { mode: "codex" } });
    expect(liveAttempt.statusCode).toBe(409);
    await app.close();
  });

  it("compiles a supervision detail into a bounded Goal and refuses Mock verification", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-goal-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    rmSync(join(repo, ".project", "runs"), { recursive: true, force: true });
    rmSync(join(repo, ".project", "reviews"), { recursive: true, force: true });
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    execFileSync("git", ["-C", repo, "branch", "-M", "master"]);

    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const document = (await app.inject({ method: "GET", url: "/api/supervision" })).json();
    const detail = document.details.find((item: { id: string }) => item.id === "detail-function-progress");
    const bounded = {
      ...detail,
      version: bumpTag(detail.version, "v"),
      prompt: { ...detail.prompt, version: bumpTag(detail.prompt.version, "p") },
      status: "ready",
      execution: { ownership_modules: ["formal-supervision-test"], write_globs: ["allowed/**"], shared_contracts: [], acceptance_commands: ["exit 0"] }
    };
    expect((await app.inject({ method: "PUT", url: `/api/supervision/details/${detail.id}`, payload: bounded })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/supervision/tasks/${detail.task_id}/freeze` })).statusCode).toBe(200);

    const compiled = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/compile-goal` });
    expect(compiled.statusCode).toBe(201);
    expect(compiled.json()).toMatchObject({
      goal: { status: "compiled", required_gateway: "codex-app-server", write_globs: ["allowed/**"], supervision_context: { detail_id: detail.id, task_id: detail.task_id, task_version: expect.any(String), plan_version: expect.any(String), category: "function", prompt_snapshot: bounded.prompt } },
      change: { status: "compiled", design_ids: ["design-y1-supervision-workbench"], protected_baselines: ["X0"] },
      validation: { valid: true }
    });

    const dispatched = await app.inject({ method: "POST", url: `/api/supervision/details/${detail.id}/dispatch-goal` });
    expect(dispatched.statusCode).toBe(409);
    expect(dispatched.json()).toMatchObject({ error: "gateway_required:codex-app-server" });
    expect(loadSupervisionRuns(repo).find((run) => run.goal_id === compiled.json().goal.id)).toBeUndefined();
    expect(loadProject(repo).goals.find((goal) => goal.id === compiled.json().goal.id)?.status).toBe("compiled");
    expect(loadProject(repo).changes.find((change) => change.id === compiled.json().change.id)?.status).toBe("compiled");
    await app.close();
  }, 40_000);

  it("recovers an interrupted Mock supervision run after service restart", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-recover-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    const detail = loadSupervision(repo).details.find((item) => item.id === "detail-asset-permission")!;
    const now = new Date().toISOString();
    writeSupervisionRun(repo, {
      schema_version: 1, id: "supervision-run-recover", detail_id: detail.id, category: detail.category, mode: "mock", status: "queued", attempt: 1, thread_id: null,
      prompt_snapshot: detail.prompt, permission_snapshot: { category_only: true, resource_refs: detail.prompt.resources, allowed_changes: detail.prompt.allowed_changes, forbidden_changes: detail.prompt.forbidden_changes },
      requested_at: now, started_at: null, finished_at: null, events: [{ type: "queued", message: "等待执行", at: now }], capability_contract_ids: []
    });
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    expect(loadSupervisionRuns(repo)[0]).toMatchObject({ status: "reviewing", output: { source: "mock", reviewer_status: "pending" } });
    expect(loadSupervision(repo).details.find((item) => item.id === detail.id)).toMatchObject({ status: "reviewing", output: { source: "mock" } });
    await app.close();
  });

  it("resumes a failed formal supervision run and reattaches the recovered result", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-resume-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    rmSync(join(repo, ".project", "runs"), { recursive: true, force: true });
    rmSync(join(repo, ".project", "reviews"), { recursive: true, force: true });
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    execFileSync("git", ["-C", repo, "branch", "-M", "master"]);
    const detail = loadSupervision(repo).details.find((item) => item.id === "detail-function-progress")!;
    writeSupervisionDetail(repo, { ...detail, status: "ready", execution: { ownership_modules: ["resume-test"], write_globs: ["allowed/**"], shared_contracts: [], acceptance_commands: ["exit 0"] } });
    freezeSupervisionTask(repo, detail.task_id);

    class CodexLikeGateway extends MockAgentGateway { override readonly kind = "codex-app-server" as const; }
    class FailOnceGateway extends CodexLikeGateway {
      failed = false;
      override async implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext) {
        if (!this.failed) { this.failed = true; throw new Error("temporary_infrastructure_failure"); }
        const result = await super.implement(goal, events, context);
        return { ...result, checks: goal.supervision_context?.acceptance.map((criterion) => ({ criterion, result: "pass" as const, note: "临时仓库真实路径模拟证据" })) };
      }
      override async review(goal: GoalContract) {
        const requirements = goal.supervision_context?.acceptance ?? [goal.outcome];
        return { approved: true, requirementDiffTestMap: requirements.map((requirement) => ({ requirement, evidence: `受控 worktree；${goal.acceptance_commands.join(" && ")} passed` })), findings: [] };
      }
    }
    const orchestrator = new GoalOrchestrator(repo, new FailOnceGateway());
    const dispatched = dispatchSupervisionGoal(repo, orchestrator, detail.id);
    await orchestrator.active.get(dispatched.goal.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = loadSupervisionRuns(repo).find((run) => run.goal_id === dispatched.goal.id)!;
    expect(failed).toMatchObject({ status: "failed", agent_run_id: expect.stringMatching(/^run-/) });

    expect(resumeSupervisionGoalRun(repo, orchestrator, failed.id)).toMatchObject({ status: "running" });
    await orchestrator.active.get(dispatched.goal.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadSupervisionRuns(repo).find((run) => run.id === failed.id)).toMatchObject({ status: "reviewing", output: { source: "codex", reviewer_status: "pending" } });
    expect(loadProject(repo).goals.find((goal) => goal.id === dispatched.goal.id)?.status).toBe("verified");
    orchestrator.runtime?.close();
  }, 40_000);

  it("creates task-scoped permission drafts and only snapshots approved active capabilities", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-capability-contract-"));
    copyProjectTruth(repo);
    rmSync(join(repo, ".project", "permission-contracts"), { recursive: true, force: true });
    rmSync(join(repo, ".project", "supervision-runs"), { recursive: true, force: true });
    const app = await buildTestApp({ root: repo, gateway: "mock" });
    const registry = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(registry.statusCode).toBe(200);
    expect(registry.json().capabilities).toHaveLength(5);
    const proposed = await app.inject({ method: "POST", url: "/api/permission-contracts", payload: { capability_id: "capability-mock-worker", detail_id: "detail-asset-permission" } });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json()).toMatchObject({ status: "proposed", credential_mode: "none", detail_id: "detail-asset-permission" });
    expect(JSON.stringify(proposed.json())).not.toMatch(/api[_-]?key|secret/i);
    const approved = await app.inject({ method: "POST", url: `/api/permission-contracts/${proposed.json().id}/review`, payload: { verdict: "approved" } });
    expect(approved.json()).toMatchObject({ status: "approved" });
    const dispatched = await app.inject({ method: "POST", url: "/api/supervision/details/detail-asset-permission/dispatch", payload: { mode: "mock" } });
    expect(dispatched.json().run.capability_contract_ids).toEqual([proposed.json().id]);
    await app.inject({ method: "POST", url: `/api/permission-contracts/${proposed.json().id}/review`, payload: { verdict: "revoked" } });
    const illegalReapprove = await app.inject({ method: "POST", url: `/api/permission-contracts/${proposed.json().id}/review`, payload: { verdict: "approved" } });
    expect(illegalReapprove.statusCode).toBe(409);
    expect(illegalReapprove.json().error).toContain("Invalid permission transition");
    const rerun = await app.inject({ method: "POST", url: "/api/supervision/details/detail-asset-permission/dispatch", payload: { mode: "mock" } });
    expect(rerun.json().run.capability_contract_ids).toEqual([]);
    const disabled = await app.inject({ method: "POST", url: "/api/permission-contracts", payload: { capability_id: "capability-openai-api", detail_id: "detail-copy-human-first" } });
    const refused = await app.inject({ method: "POST", url: `/api/permission-contracts/${disabled.json().id}/review`, payload: { verdict: "approved" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "capability_disabled" });
    await app.close();
  });
});

describe("App Server JSON-RPC adapter", () => {
  it("performs the initialize handshake over newline-delimited stdio", async () => {
    const fakeServer = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      let initialized = false;
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-app-server" } });
        else if (message.method === "initialized") initialized = true;
        else if (message.method === "ping") { send({ id: message.id, result: { ok: initialized } }); send({ method: "fake/event", params: { safe: true } }); }
      });
    `;
    const transport = new StdioJsonRpcTransport({ command: process.execPath, args: ["-e", fakeServer], cwd: root, env: safeAppServerEnvironment({ ...process.env, OPENAI_API_KEY: undefined }), requestTimeoutMs: 5_000 });
    const notification = new Promise<string>((resolve) => transport.onNotification((event) => resolve(event.method)));
    await expect(transport.request("ping", {})).resolves.toEqual({ ok: true });
    await expect(notification).resolves.toBe("fake/event");
    await transport.close();
  });

  it("sets a durable goal, waits for streamed turns, implements with no approvals, and reviews", async () => {
    const plan = {
      outcome: "done", primaryOutcomes: ["done"], ownershipModules: ["a"], plannedWriteGlobs: ["apps/**"],
      sharedContracts: [], unresolvedQuestions: [], steps: [{ title: "one", acceptance: "pass" }], risks: []
    };
    let threadNumber = 0;
    let turnNumber = 0;
    const transport = new MockJsonRpcTransport({
      "thread/start": () => ({ thread: { id: `thread-${++threadNumber}` } }), "thread/goal/set": { ok: true },
      "turn/start": (params: Record<string, unknown>, mock: MockJsonRpcTransport) => {
        const turnId = `turn-${++turnNumber}`;
        const mode = (params.collaborationMode as { mode?: string } | undefined)?.mode;
        const sandbox = params.sandboxPolicy as { type?: string } | undefined;
        const isReview = sandbox?.type === "readOnly" && mode !== "plan";
        queueMicrotask(() => {
          const item = mode === "plan" ? { type: "agentMessage", text: JSON.stringify(plan) }
            : isReview ? { type: "agentMessage", text: JSON.stringify({ approved: true, requirementDiffTestMap: [{ requirement: "done", evidence: "apps/a.ts；pnpm test passed" }], findings: [] }) }
            : { type: "fileChange", status: "completed" };
          mock.emit({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
          mock.emit({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
        });
        return { turn: { id: turnId, status: "inProgress" } };
      }
    });
    const gateway = new CodexAppServerGateway(transport, root);
    const liveEvents = new EventBus();
    gateway.attachEvents(liveEvents);
    const goal: GoalContract = { schema_version: 1, id: "goal-rpc", change_set_id: "change-rpc", title: "RPC", outcome: "done", status: "compiled", ownership_modules: ["a"], write_globs: ["apps/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["pnpm test"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    expect(await gateway.start(goal)).toEqual({ threadId: "thread-1" });
    expect(await gateway.plan(goal)).toEqual(plan);
    expect(await gateway.implement(goal, liveEvents)).toMatchObject({ changedFiles: [], evidence: expect.arrayContaining(["fileChange:completed"]) });
    expect((await gateway.review(goal, ["apps/a.ts"])).approved).toBe(true);
    await gateway.setGoalStatus("thread-1", "complete");
    expect(transport.calls.map((call) => call.method)).toEqual(["thread/start", "thread/goal/set", "turn/start", "turn/start", "thread/start", "thread/goal/set", "turn/start", "thread/goal/set"]);
    expect(transport.calls[0].params).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "never" });
    expect(transport.calls[1].params).toMatchObject({ threadId: "thread-1", status: "paused", objective: expect.stringContaining("done") });
    expect(transport.calls[2].params).toMatchObject({ collaborationMode: { mode: "plan" }, sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
    expect(transport.calls[3].params).toMatchObject({
      collaborationMode: { mode: "default" },
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [root],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      },
      approvalPolicy: "never"
    });
    expect(transport.calls[4].params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    expect(transport.calls[5].params).toMatchObject({ threadId: "thread-2", status: "paused", objective: expect.stringContaining("done") });
    expect(transport.calls[6].params).toMatchObject({ threadId: "thread-2", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never", outputSchema: expect.any(Object) });
    expect(transport.calls[7]).toEqual({ method: "thread/goal/set", params: { threadId: "thread-1", status: "complete" } });
    expect(liveEvents.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: goal.id, data: expect.objectContaining({ direction: "input", phase: "plan" }) }),
      expect.objectContaining({ goalId: goal.id, data: expect.objectContaining({ direction: "output", phase: "implementation", itemType: "fileChange" }) }),
      expect.objectContaining({ goalId: goal.id, data: expect.objectContaining({ direction: "input", phase: "review" }) })
    ]));
  });

  it("interrupts the exact active turn required by the official protocol", async () => {
    let resolveTurn!: () => void;
    const transport = new MockJsonRpcTransport({
      "thread/start": { thread: { id: "thread-stop" } }, "thread/goal/set": {},
      "turn/start": (_params: Record<string, unknown>, mock: MockJsonRpcTransport) => ({ turn: { id: "turn-stop", status: "inProgress" }, ready: new Promise<void>((resolve) => { resolveTurn = () => { mock.emit({ method: "turn/completed", params: { turn: { id: "turn-stop", status: "interrupted" } } }); resolve(); }; }) }),
      "turn/interrupt": () => { resolveTurn(); return {}; }
    });
    const gateway = new CodexAppServerGateway(transport, root);
    const goal: GoalContract = { schema_version: 1, id: "goal-stop-rpc", change_set_id: "change-rpc", title: "RPC stop", outcome: "stop", status: "compiled", ownership_modules: ["a"], write_globs: ["apps/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["pnpm test"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    await gateway.start(goal);
    const implementing = gateway.implement(goal, new EventBus());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await gateway.interrupt("thread-stop");
    await expect(implementing).rejects.toThrow("run_stopped");
    expect(transport.calls.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: "thread-stop", turnId: "turn-stop" } });
  });

  it("resumes a thread with the pinned kebab-case sandbox enum", async () => {
    const transport = new MockJsonRpcTransport({
      "thread/resume": { thread: { id: "thread-existing" } },
      "thread/goal/set": {}
    });
    const gateway = new CodexAppServerGateway(transport, root);
    const goal: GoalContract = { schema_version: 1, id: "goal-resume-rpc", change_set_id: "change-rpc", title: "RPC resume", outcome: "resume", status: "compiled", ownership_modules: ["a"], write_globs: ["apps/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["pnpm test"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };

    await expect(gateway.start(goal, "thread-existing")).resolves.toEqual({ threadId: "thread-existing" });
    expect(transport.calls[0]).toEqual({
      method: "thread/resume",
      params: { threadId: "thread-existing", cwd: root, approvalPolicy: "never", sandbox: "workspace-write" }
    });
    await gateway.close();
  });

  it("keeps only required operating-system values in the child environment", () => {
    const env = safeAppServerEnvironment({ PATH: "bin", SystemRoot: "windows", OPENAI_API_KEY: "secret-value", UNRELATED_SECRET: "must-not-pass" });
    expect(env).toMatchObject({ PATH: "bin", SystemRoot: "windows" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("UNRELATED_SECRET");
    const isolated = isolatedAppServerEnvironment(env, root);
    expect(isolated.CODEX_HOME).toBe(join(root, ".project", ".runtime", "codex-home"));
  });

  it("does not authenticate through the App Server environment or serialize the key", async () => {
    const fakeServer = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
      let loginCalled = false;
      const environmentContainsKey = Boolean(process.env.OPENAI_API_KEY);
      let secretSerialized = false;
      rl.on("line", (line) => {
        secretSerialized ||= line.includes("test-only-secret");
        const message = JSON.parse(line);
        if (message.method === "initialize") send({ id: message.id, result: {} });
        else if (message.method === "account/login/start") loginCalled = true;
        else if (message.method === "ping") send({ id: message.id, result: { ok: true, loginCalled, secretSerialized, environmentContainsKey } });
      });
    `;
    const transport = new StdioJsonRpcTransport({ command: process.execPath, args: ["-e", fakeServer], cwd: root, env: safeAppServerEnvironment({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: "test-only-secret" }), requestTimeoutMs: 5_000 });
    await expect(transport.request("ping", {})).resolves.toEqual({ ok: true, loginCalled: false, secretSerialized: false, environmentContainsKey: false });
    await transport.close();
  });

  it("answers current-time and permission server requests with protocol-safe bounded responses", async () => {
    const fakeServer = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
      let pingId;
      let timeOk = false;
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") send({ id: message.id, result: {} });
        else if (message.method === "ping") { pingId = message.id; send({ id: 901, method: "currentTime/read", params: {} }); }
        else if (message.id === 901) { timeOk = Number.isInteger(message.result?.currentTimeAt); send({ id: 902, method: "item/permissions/requestApproval", params: { threadId: "thread-safe", turnId: "turn-safe" } }); }
        else if (message.id === 902) send({ id: pingId, result: { timeOk, permissions: message.result } });
      });
    `;
    const transport = new StdioJsonRpcTransport({ command: process.execPath, args: ["-e", fakeServer], cwd: root, env: safeAppServerEnvironment({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }), requestTimeoutMs: 5_000 });
    await expect(transport.request("ping", {})).resolves.toEqual({
      timeOk: true,
      permissions: { permissions: { fileSystem: { entries: [] }, network: { enabled: false } }, scope: "turn" }
    });
    await transport.close();
  });

  it("deterministically declines an unexpected approval request under the never policy", async () => {
    const fakeServer = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
      let pingId;
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") send({ id: message.id, result: {} });
        else if (message.method === "ping") {
          pingId = message.id;
          send({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "thread-safe", turnId: "turn-safe", itemId: "item-safe", command: "must-not-be-forwarded" } });
        } else if (message.id === 900) {
          send({ id: pingId, result: { approvalDecision: message.result?.decision } });
        }
      });
    `;
    const transport = new StdioJsonRpcTransport({ command: process.execPath, args: ["-e", fakeServer], cwd: root, env: safeAppServerEnvironment({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }), requestTimeoutMs: 5_000 });
    const notifications: JsonRpcNotification[] = [];
    transport.onNotification((notification) => notifications.push(notification));
    await expect(transport.request("ping", {})).resolves.toEqual({ approvalDecision: "decline" });
    expect(notifications).toEqual([expect.objectContaining({ method: "approval/denied", params: expect.objectContaining({ requestMethod: "item/commandExecution/requestApproval", threadId: "thread-safe", turnId: "turn-safe" }) })]);
    expect(JSON.stringify(notifications)).not.toContain("must-not-be-forwarded");
    await transport.close();
  });
});

describe("event recovery", () => {
  it("restores sequenced SSE history from SQLite after service restart", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-events-"));
    const firstStore = new RuntimeStore(repo);
    const firstBus = new EventBus(firstStore);
    const emitted = firstBus.emit({ type: "plan", goalId: "goal-restart", message: "计划已保存" });
    firstStore.close();
    const secondStore = new RuntimeStore(repo);
    const recovered = new EventBus(secondStore).since(emitted.id - 1);
    expect(recovered).toEqual([expect.objectContaining({ id: emitted.id, type: "plan", goalId: "goal-restart", message: "计划已保存" })]);
    secondStore.close();
  });
});

describe("real Codex smoke readiness", () => {
  it("uses the existing Windows process-tree termination shape for a smoke child", async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; kill(signal?: NodeJS.Signals | number): boolean };
    child.pid = 4242; child.exitCode = null; child.kill = () => true;
    const killer = new EventEmitter();
    let launched: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
    const launch = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      launched = { command, args, options };
      queueMicrotask(() => killer.emit("close", 0));
      return killer;
    }) as unknown as typeof spawn;

    await terminateCodexSmokeProcessTree(child as never, { platform: "win32", systemRoot: "C:\\Windows", spawnProcess: launch });

    expect(launched).toEqual({
      command: join("C:\\Windows", "System32", "taskkill.exe"),
      args: ["/PID", "4242", "/T", "/F"],
      options: { shell: false, windowsHide: true, stdio: "ignore" }
    });
  });

  it("waits for the same smoke child to exit before restart and ignores its later events", async () => {
    const state = new Map<string, string>();
    const runtime = { getState: (key: string) => state.get(key), setState: (key: string, value: string) => { state.set(key, value); } };
    const makeChild = (pid: number) => {
      const child = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill(): boolean };
      child.pid = pid; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kill = () => true;
      return child;
    };
    const children = [makeChild(5001), makeChild(5002)];
    let spawnIndex = 0;
    const terminated: number[] = [];
    const manager = new CodexReadinessManager({
      root, gatewaySelected: true, runtimeReady: true, runtime, events: new EventBus(),
      spawnProcess: (() => children[spawnIndex++]) as unknown as typeof spawn,
      terminateProcessTree: async (child) => { terminated.push(child.pid!); },
      stopTimeoutMs: 1_000,
      env: { OPENAI_API_KEY: "test-only-secret", EPM_ENABLE_CODEX: "1" }
    });

    const first = manager.start();
    const stopping = manager.stop();
    await Promise.resolve();
    expect(terminated).toEqual([5001]);
    expect(manager.readiness().smoke).toMatchObject({ id: first.id, status: "running", message: expect.stringContaining("等待本次子进程树退出") });
    expect(() => manager.start()).toThrow("codex_smoke_already_running");

    children[0].exitCode = 0; children[0].emit("close", 0);
    await expect(stopping).resolves.toMatchObject({ id: first.id, status: "stopped" });

    const second = manager.start();
    expect(second.id).not.toBe(first.id);
    children[0].emit("error", new Error("late event from prior run"));
    expect(manager.readiness().smoke).toMatchObject({ id: second.id, status: "running" });

    const stoppingSecond = manager.stop();
    children[1].exitCode = 0; children[1].emit("close", 0);
    await expect(stoppingSecond).resolves.toMatchObject({ id: second.id, status: "stopped" });
    expect(terminated).toEqual([5001, 5002]);
  });

  it("records a recoverable failure when the isolated child cannot start", () => {
    const state = new Map<string, string>();
    const runtime = { getState: (key: string) => state.get(key), setState: (key: string, value: string) => { state.set(key, value); } };
    const manager = new CodexReadinessManager({
      root, gatewaySelected: true, runtimeReady: true, runtime, events: new EventBus(),
      spawnProcess: (() => { throw new Error("spawn failed"); }) as unknown as typeof spawn,
      env: { OPENAI_API_KEY: "test-only-secret", EPM_ENABLE_CODEX: "1" }
    });
    expect(() => manager.start()).toThrow("codex_smoke_spawn_failed");
    expect(manager.readiness().smoke).toMatchObject({ status: "failed" });
    expect(JSON.stringify(manager.readiness())).not.toContain("test-only-secret");
  });

  it("keeps credentials out of the smoke child and rejects a success summary without retained evidence", async () => {
    const state = new Map<string, string>();
    const runtime = { getState: (key: string) => state.get(key), setState: (key: string, value: string) => { state.set(key, value); } };
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill(): boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kill = () => true;
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => { childEnvironment = options.env; return child; }) as unknown as typeof spawn;
    const manager = new CodexReadinessManager({
      root, gatewaySelected: true, runtimeReady: true, runtime, events: new EventBus(), spawnProcess: fakeSpawn,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: "test-only-secret", EPM_ENABLE_CODEX: "1", UNRELATED_SECRET: "must-not-pass" }
    });
    expect(manager.readiness()).toMatchObject({ ready_to_run: true, credential: "configured" });
    expect(manager.start()).toMatchObject({ status: "running" });
    expect(childEnvironment).toMatchObject({ EPM_ENABLE_CODEX: "1" });
    expect(childEnvironment).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnvironment).not.toHaveProperty("UNRELATED_SECRET");
    child.stdout.write('{"ok":true,"gateway":"codex-app-server","run":"verified","changeSet":"verified","checkpoint":true,"mainMerged":true}\n');
    child.exitCode = 0; child.emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const safeReadiness = manager.readiness();
    expect(safeReadiness.smoke).toMatchObject({ status: "failed" });
    expect(JSON.stringify(safeReadiness)).not.toContain("test-only-secret");
  });

  it("does not promote an unsubstantiated bare ok smoke result", async () => {
    const state = new Map<string, string>();
    const runtime = { getState: (key: string) => state.get(key), setState: (key: string, value: string) => { state.set(key, value); } };
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill(): boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kill = () => true;
    const manager = new CodexReadinessManager({
      root, gatewaySelected: true, runtimeReady: true, runtime, events: new EventBus(),
      spawnProcess: (() => child) as unknown as typeof spawn,
      env: { OPENAI_API_KEY: "test-only-secret", EPM_ENABLE_CODEX: "1" }
    });
    manager.start();
    child.stdout.write('{"ok":true}\n');
    child.exitCode = 0; child.emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.readiness().smoke).toMatchObject({ status: "failed" });
  });
});

describe("offline orchestration lifecycle", () => {
  it("reconciles terminal YAML runs back to persisted Codex Goal status after restart", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-thread-status-reconcile-"));
    copyProjectTruth(repo);
    const run = loadProject(repo).runs.find((item) => item.id === "run-x0-bootstrap")!;
    writeRun(repo, { ...run, thread_id: "thread-x0-verified" });
    class TrackingGateway extends MockAgentGateway {
      override readonly kind = "codex-app-server" as const;
      statuses: Array<{ threadId: string; status: string }> = [];
      override async setGoalStatus(threadId: string, status: "paused" | "blocked" | "usageLimited" | "complete") { this.statuses.push({ threadId, status }); }
    }
    const gateway = new TrackingGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway, false);
    expect(await orchestrator.reconcileThreadGoalStatuses()).toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(gateway.statuses).toEqual([{ threadId: "thread-x0-verified", status: "complete" }]);
    orchestrator.close();
  });

  it("executes three independent goals concurrently and persists verified state", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-parallel-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const goals = ["a", "b", "c"].map((suffix): GoalContract => ({ schema_version: 1, id: `goal-parallel-${suffix}`, change_set_id: "change-parallel", title: `并行 ${suffix}`, outcome: `完成 ${suffix}`, status: "compiled", ownership_modules: [suffix], write_globs: [`apps/${suffix}/**`], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 }));
    for (const goal of goals) atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", "change-parallel.yaml"), { schema_version: 1, id: "change-parallel", title: "并行演练", status: "compiled", start_sha: startSha, goal_ids: goals.map((goal) => goal.id), dependency_dag: Object.fromEntries(goals.map((goal) => [goal.id, []])), design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class GoalStatusGateway extends MockAgentGateway {
      readonly statuses: Array<{ threadId: string; status: "paused" | "blocked" | "usageLimited" | "complete" }> = [];
      override async setGoalStatus(threadId: string, status: "paused" | "blocked" | "usageLimited" | "complete") {
        this.statuses.push({ threadId, status });
      }
    }
    const gateway = new GoalStatusGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway);
    const dispatched = orchestrator.dispatch("change-parallel");
    expect(dispatched.active).toHaveLength(3);
    await Promise.all([...orchestrator.active.values()]);
    expect(loadProject(repo).goals.filter((goal) => goal.change_set_id === "change-parallel").map((goal) => goal.status)).toEqual(["verified", "verified", "verified"]);
    expect(loadProject(repo).changes.find((change) => change.id === "change-parallel")?.status).toBe("verified");
    expect(gateway.statuses).toEqual(expect.arrayContaining(goals.map((goal) => ({ threadId: `mock-thread-${goal.id}`, status: "complete" }))));
    const git = new GitController(repo);
    expect(goals.every((goal) => !existsSync(git.goalWorktreePath(goal.id)))).toBe(true);
    expect(git.head("codex/checkpoint/change-parallel")).toBe(startSha);
    orchestrator.runtime?.close();
  }, 60_000);

  it("rechecks the Worker Plan and allows at most two automatic convergence rounds", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-plan-converge-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-plan-converge", change_set_id: "change-plan-converge", title: "计划收敛", outcome: "只实现受控功能", status: "compiled", ownership_modules: ["feature"], write_globs: ["apps/feature/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-plan-converge.yaml"), { schema_version: 1, id: "change-plan-converge", title: "计划收敛演练", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class ConvergingGateway extends MockAgentGateway {
      planCalls = 0;
      override async plan(goal: GoalContract, context?: GoalExecutionContext, feedback: string[] = []) {
        this.planCalls++;
        const base = await super.plan(goal, context, feedback);
        if (this.planCalls < 3) return { ...base, primaryOutcomes: [goal.outcome, "顺便重构"], plannedWriteGlobs: ["apps/**"] };
        return base;
      }
    }
    const gateway = new ConvergingGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway);
    orchestrator.dispatch("change-plan-converge");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(gateway.planCalls).toBe(3);
    expect(run.status).toBe("verified");
    expect(run.events.filter((event) => event.startsWith("plan_finding:"))).toHaveLength(4);
    orchestrator.runtime?.close();
  }, 30_000);

  it("turns a still-invalid third Plan into a ChangeProposal before implementation", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-plan-proposal-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-plan-proposal", change_set_id: "change-plan-proposal", title: "计划越界", outcome: "只实现受控功能", status: "compiled", ownership_modules: ["feature"], write_globs: ["apps/feature/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-plan-proposal.yaml"), { schema_version: 1, id: "change-plan-proposal", title: "计划越界演练", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class InvalidPlanGateway extends MockAgentGateway {
      planCalls = 0; implemented = false;
      override async plan(goal: GoalContract, context?: GoalExecutionContext, feedback: string[] = []) {
        this.planCalls++;
        const base = await super.plan(goal, context, feedback);
        return { ...base, primaryOutcomes: [goal.outcome, "新增未授权结果"], ownershipModules: ["feature", "auth"], plannedWriteGlobs: ["apps/auth/**"], unresolvedQuestions: ["是否更换认证架构"] };
      }
      override async implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext) { this.implemented = true; return super.implement(goal, events, context); }
    }
    const gateway = new InvalidPlanGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway);
    orchestrator.dispatch("change-plan-proposal");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(gateway.planCalls).toBe(3);
    expect(gateway.implemented).toBe(false);
    expect(run.status).toBe("blocked");
    expect(loadProject(repo).proposals).toEqual(expect.arrayContaining([expect.objectContaining({ goal_id: contract.id, status: "proposed", requested_globs: ["apps/auth/**"] })]));
    if (run.worktree_path) new GitController(repo).removeGoalWorktree(run.worktree_path);
    orchestrator.runtime?.close();
  }, 30_000);

  it("interrupts a timed-out Goal and preserves its worktree for recovery", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-timeout-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-timeout", change_set_id: "change-timeout", title: "超时门禁", outcome: "超时后中断", status: "compiled", ownership_modules: ["timeout"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-timeout.yaml"), { schema_version: 1, id: "change-timeout", title: "超时演练", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    let enteredPlan!: () => void;
    const planEntered = new Promise<void>((resolve) => { enteredPlan = resolve; });
    class HangingGateway extends MockAgentGateway {
      interrupted = false;
      override async plan() { enteredPlan(); return await new Promise<never>(() => undefined); }
      override async interrupt() { this.interrupted = true; }
    }
    const { vi } = await import("vitest");
    // Keep real Git fixtures while advancing only the logical Goal deadline.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const gateway = new HangingGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway, true, 700);
    try {
      orchestrator.dispatch("change-timeout");
      const execution = Promise.all([...orchestrator.active.values()]);
      await Promise.race([planEntered, execution.then(() => { throw new Error("Goal ended before reaching the timed Plan"); })]);
      await vi.advanceTimersByTimeAsync(699);
      expect(gateway.interrupted).toBe(false);
      expect(orchestrator.active.has(contract.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const [run] = await execution;
      expect(run).toMatchObject({ status: "failed", thread_id: `mock-thread-${contract.id}` });
      expect(run.events).toContain("goal_timeout");
      expect(gateway.interrupted).toBe(true);
      expect(Date.parse(run.finished_at!) - Date.parse(run.started_at)).toBe(700);
      expect(run.worktree_path && existsSync(run.worktree_path)).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      const worktreePath = loadProject(repo).runs.find((run) => run.goal_id === contract.id)?.worktree_path;
      if (worktreePath) new GitController(repo).removeGoalWorktree(worktreePath);
      orchestrator.close();
    }
  }, 30_000);

  it("shares one hard deadline across Plan, implementation, Review, and resume", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-total-deadline-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-total-deadline", change_set_id: "change-total-deadline", title: "总时限门禁", outcome: "所有阶段共享一个截止时间", status: "compiled", ownership_modules: ["deadline"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-total-deadline.yaml"), { schema_version: 1, id: "change-total-deadline", title: "总时限演练", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    function latch() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    }
    const planEntered = latch();
    const releasePlan = latch();
    const implementationEntered = latch();
    const releaseImplementation = latch();
    const reviewEntered = latch();
    class CumulativeSlowGateway extends MockAgentGateway {
      interrupted = false;
      phases: string[] = [];
      override async plan(goal: GoalContract, context?: GoalExecutionContext, feedback?: string[]) {
        this.phases.push("plan");
        planEntered.release();
        await releasePlan.promise;
        return super.plan(goal, context, feedback);
      }
      override async implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext) {
        this.phases.push("implementation");
        implementationEntered.release();
        await releaseImplementation.promise;
        return super.implement(goal, events, context);
      }
      override async review() {
        this.phases.push("review");
        reviewEntered.release();
        return await new Promise<never>(() => undefined);
      }
      override async interrupt() { this.interrupted = true; }
    }
    const { vi } = await import("vitest");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const gateway = new CumulativeSlowGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway, true, 1000);
    try {
      orchestrator.dispatch("change-total-deadline");
      const execution = Promise.all([...orchestrator.active.values()]);
      const reached = (gate: Promise<void>) => Promise.race([gate, execution.then(() => { throw new Error("Goal ended before the expected deadline phase"); })]);
      await reached(planEntered.promise);
      await vi.advanceTimersByTimeAsync(300);
      releasePlan.release();
      await reached(implementationEntered.promise);
      await vi.advanceTimersByTimeAsync(300);
      releaseImplementation.release();
      await reached(reviewEntered.promise);
      expect(gateway.phases).toEqual(["plan", "implementation", "review"]);
      // Review gets the remaining 400 ms, not a fresh phase budget.
      await vi.advanceTimersByTimeAsync(399);
      expect(gateway.interrupted).toBe(false);
      expect(orchestrator.active.has(contract.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const [run] = await execution;
      expect(run.status).toBe("failed");
      expect(run.events).toContain("goal_timeout");
      for (const phase of gateway.phases) expect(run.events.some((event) => event.endsWith(":" + phase))).toBe(true);
      expect(gateway.interrupted).toBe(true);
      expect(Date.parse(run.finished_at!) - Date.parse(run.started_at)).toBe(1000);
      expect(() => orchestrator.resume(run.id)).not.toThrow();
      const [resumed] = await Promise.all([...orchestrator.active.values()]);
      expect(resumed.started_at).toBe(run.started_at);
      expect(resumed.events.filter((event) => event === "goal_timeout")).toHaveLength(2);
      expect(gateway.phases).toEqual(["plan", "implementation", "review"]);
      expect(resumed.worktree_path && existsSync(resumed.worktree_path)).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      const worktreePath = loadProject(repo).runs.find((run) => run.goal_id === contract.id)?.worktree_path;
      if (worktreePath) new GitController(repo).removeGoalWorktree(worktreePath);
      orchestrator.close();
    }
  }, 30_000);

  it("turns ghost workers into recoverable runs after restart and resumes the saved thread", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-restart-run-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const goal: GoalContract = { schema_version: 1, id: "goal-restart-run", change_set_id: "change-restart-run", title: "服务重启恢复", outcome: "从保存的 thread 恢复", status: "implementing", ownership_modules: ["restart"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", `${goal.change_set_id}.yaml`), { schema_version: 1, id: goal.change_set_id, title: "服务重启恢复", status: "running", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    const startedAt = new Date().toISOString();
    writeRun(repo, { schema_version: 1, id: "run-restart-run", goal_id: goal.id, gateway: "mock", status: "implementing", thread_id: "mock-thread-persisted", attempt: 1, started_at: startedAt, finished_at: null, events: ["turn_budget:1/8:plan"], capability_contract_ids: [], agent_evidence: [], agent_checks: [] });
    const oldRuntime = new RuntimeStore(repo); expect(oldRuntime.acquireGoalLocks(goal.write_globs, [], "run-restart-run")).toBe(true); oldRuntime.close();
    const observer = new GoalOrchestrator(repo, new MockAgentGateway());
    expect(loadProject(repo).runs.find((item) => item.id === "run-restart-run")?.status).toBe("implementing");
    expect(observer.status().locks).toHaveLength(1);
    observer.close();
    const orchestrator = new GoalOrchestrator(repo, new MockAgentGateway(), true, undefined, true);
    const recovered = loadProject(repo);
    expect(recovered.runs.find((item) => item.id === "run-restart-run")).toMatchObject({ status: "stopped", thread_id: "mock-thread-persisted" });
    expect(recovered.goals.find((item) => item.id === goal.id)?.status).toBe("stopped");
    expect(orchestrator.status().locks).toEqual([]);
    expect(orchestrator.resume("run-restart-run")).toMatchObject({ resumed: true, goalId: goal.id, phase: "implementing" });
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run).toMatchObject({ status: "verified", thread_id: "mock-thread-persisted" });
    expect(run.events).toEqual(expect.arrayContaining(["service_restart_interrupted:implementing", "resumed", "integrated"]));
    orchestrator.close();
  }, 30_000);

  it("keeps observer CLIs read-only and rejects a second scheduler while the service lease is live", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-service-lease-"));
    copyProjectTruth(repo);
    const ownerPid = process.ppid;
    const owner = new RuntimeStore(repo);
    owner.setState("orchestrator_owner", `${ownerPid}:external-service`);
    owner.close();

    const observer = new GoalOrchestrator(repo, new MockAgentGateway());
    expect(() => observer.status()).not.toThrow();
    expect(() => observer.dispatch("change-y1-live-gateway")).toThrow(`orchestrator_already_running:${ownerPid}`);
    observer.close();
    expect(() => new GoalOrchestrator(repo, new MockAgentGateway(), true, undefined, true)).toThrow(`orchestrator_already_running:${ownerPid}`);

    const cleanup = new RuntimeStore(repo);
    cleanup.clearState("orchestrator_owner");
    cleanup.close();
  });

  it("resumes an interrupted integration from the saved candidate without rerunning the Worker", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-restart-integration-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const git = new GitController(repo); const startSha = git.head();
    const goal: GoalContract = { schema_version: 1, id: "goal-restart-integration", change_set_id: "change-restart-integration", title: "集成恢复", outcome: "从候选提交恢复集成", status: "integrating", ownership_modules: ["integration"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", `${goal.change_set_id}.yaml`), { schema_version: 1, id: goal.change_set_id, title: "集成恢复", status: "integrating", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    const worktree = git.createGoalWorktree(goal.id, startSha); mkdirSync(join(worktree.path, "allowed"), { recursive: true }); writeFileSync(join(worktree.path, "allowed", "result.txt"), "candidate\n", "utf8");
    const candidateSha = new GitController(worktree.path).commitAll("candidate");
    writeRun(repo, { schema_version: 1, id: "run-restart-integration", goal_id: goal.id, gateway: "mock", status: "integrating", thread_id: "mock-thread-integrating", attempt: 1, started_at: new Date().toISOString(), finished_at: null, worktree_path: worktree.path, branch: worktree.branch, candidate_sha: candidateSha, events: ["review:approved"], capability_contract_ids: [], agent_evidence: ["candidate"], agent_checks: [] });
    const orchestrator = new GoalOrchestrator(repo, new MockAgentGateway(), true, undefined, true);
    expect(loadProject(repo).runs.find((item) => item.id === "run-restart-integration")?.status).toBe("stopped");
    expect(orchestrator.resume("run-restart-integration")).toMatchObject({ resumed: true, phase: "integration", status: "verified" });
    const recovered = loadProject(repo);
    expect(recovered.runs.find((item) => item.id === "run-restart-integration")?.status).toBe("verified");
    expect(recovered.goals.find((item) => item.id === goal.id)?.status).toBe("verified");
    expect(new GitController(repo).head("master")).not.toBe(startSha);
    expect(new GitController(repo).head(`codex/checkpoint/${goal.change_set_id}`)).toBe(startSha);
    orchestrator.close();
  }, 30_000);

  it("does not reset the original Goal deadline when integration resumes after restart", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-expired-integration-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const goal: GoalContract = { schema_version: 1, id: "goal-expired-integration", change_set_id: "change-expired-integration", title: "过期集成恢复", outcome: "集成不能重置截止时间", status: "integrating", ownership_modules: ["integration"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", `${goal.change_set_id}.yaml`), { schema_version: 1, id: goal.change_set_id, title: "过期集成恢复", status: "integrating", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    writeRun(repo, { schema_version: 1, id: "run-expired-integration", goal_id: goal.id, gateway: "mock", status: "integrating", thread_id: "mock-thread-expired", attempt: 1, started_at: new Date(Date.now() - 2_000).toISOString(), finished_at: null, candidate_sha: startSha, events: ["review:approved"], capability_contract_ids: [], agent_evidence: ["candidate"], agent_checks: [] });
    const orchestrator = new GoalOrchestrator(repo, new MockAgentGateway(), true, 500, true);
    expect(orchestrator.resume("run-expired-integration")).toMatchObject({ resumed: true, phase: "integration", status: "blocked" });
    const recovered = loadProject(repo);
    expect(recovered.runs.find((item) => item.id === "run-expired-integration")).toMatchObject({ status: "blocked", events: expect.arrayContaining(["integration_blocked:goal_timeout"]) });
    expect(new GitController(repo).head("master")).toBe(startSha);
    expect(() => new GitController(repo).head(`codex/checkpoint/${goal.change_set_id}`)).toThrow();
    orchestrator.close();
  }, 30_000);

  it("rejects an approving Reviewer when the requirement-diff-test mapping is incomplete", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-review-map-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const goal: GoalContract = { schema_version: 1, id: "goal-review-map", change_set_id: "change-review-map", title: "审查映射门禁", outcome: "每条要求都有差异与测试证据", status: "compiled", ownership_modules: ["review"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", `${goal.change_set_id}.yaml`), { schema_version: 1, id: goal.change_set_id, title: "审查映射门禁", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class EmptyMapGateway extends MockAgentGateway {
      override async review() { return { approved: true, requirementDiffTestMap: [], findings: [] }; }
    }
    const orchestrator = new GoalOrchestrator(repo, new EmptyMapGateway());
    orchestrator.dispatch(goal.change_set_id);
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("blocked");
    expect(loadProject(repo).reviews.filter((review) => review.change_set_id === goal.change_set_id)).toHaveLength(3);
    expect(loadProject(repo).reviews.filter((review) => review.change_set_id === goal.change_set_id).every((review) => review.requirements_diff_tests === "incomplete" && review.evidence_complete === false)).toBe(true);
    expect(new GitController(repo).head("master")).toBe(startSha);
    orchestrator.close();
  }, 30_000);

  it("blocks supervision integration when Agent checks do not cover every design acceptance item", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-supervision-checks-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const acceptance = ["设计结果可逐项检查", "不得改变禁止范围"];
    const goal: GoalContract = {
      schema_version: 1, id: "goal-supervision-checks", change_set_id: "change-supervision-checks", title: "设计检查回挂门禁", outcome: "Agent 逐条回挂设计证据", status: "compiled",
      ownership_modules: ["supervision"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8,
      supervision_context: { detail_id: "detail-test", category: "function", detail_version: "v1", prompt_snapshot: { version: "p1", base: "基础", local: "局部", resources: [], allowed_changes: ["功能"], forbidden_changes: ["视觉"] }, acceptance, capability_contract_ids: [] }
    };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", `${goal.change_set_id}.yaml`), { schema_version: 1, id: goal.change_set_id, title: "设计检查回挂门禁", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class MissingChecksGateway extends MockAgentGateway {
      override async review() { return { approved: true, requirementDiffTestMap: acceptance.map((requirement) => ({ requirement, evidence: "allowed/result.ts；exit 0 passed" })), findings: [] }; }
    }
    const orchestrator = new GoalOrchestrator(repo, new MissingChecksGateway());
    orchestrator.dispatch(goal.change_set_id);
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("blocked");
    expect(run.agent_checks.every((check) => check.result === "pending")).toBe(true);
    expect(loadProject(repo).reviews.filter((review) => review.change_set_id === goal.change_set_id).every((review) => review.orphan_code.includes("Agent 未逐条返回"))).toBe(true);
    expect(new GitController(repo).head("master")).toBe(startSha);
    orchestrator.close();
  }, 30_000);

  it("uses the two configured repair retries and integrates only after Reviewer approval", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-retries-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-retries", change_set_id: "change-retries", title: "修复重试", outcome: "通过第三次审查", status: "compiled", ownership_modules: ["allowed"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-retries.yaml"), { schema_version: 1, id: "change-retries", title: "修复重试演练", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class RetryGateway extends MockAgentGateway {
      implementationCalls = 0; reviewCalls = 0;
      override async implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext) {
        this.implementationCalls++;
        mkdirSync(join(context!.cwd, "allowed"), { recursive: true });
        writeFileSync(join(context!.cwd, "allowed", "result.txt"), `attempt ${this.implementationCalls}\n`, "utf8");
        return super.implement(goal, events, context);
      }
      override async review(goal: GoalContract, changedFiles: string[], context?: GoalExecutionContext) {
        this.reviewCalls++;
        if (this.reviewCalls < 3) return { approved: false, requirementDiffTestMap: [{ requirement: goal.outcome, evidence: "needs fix" }], findings: ["需要修复"] };
        return super.review(goal, changedFiles, context);
      }
    }
    const gateway = new RetryGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway);
    orchestrator.dispatch("change-retries");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("verified");
    expect(run.attempt).toBe(3);
    expect(gateway).toMatchObject({ implementationCalls: 3, reviewCalls: 3 });
    const reviews = loadProject(repo).reviews.filter((review) => review.change_set_id === "change-retries");
    expect(reviews.filter((review) => review.reviewer === "mock-reviewer")).toHaveLength(3);
    expect(reviews).toEqual(expect.arrayContaining([expect.objectContaining({ reviewer: "integrator", status: "approved" })]));
    orchestrator.runtime?.close();
  }, 30_000);

  it("counts Plan, implementation, and Review turns against the persistent Goal budget", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-turn-budget-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-turn-budget", change_set_id: "change-turn-budget", title: "执行回合硬上限", outcome: "耗尽预算后保留现场", status: "compiled", ownership_modules: ["budget"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 3 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-turn-budget.yaml"), { schema_version: 1, id: "change-turn-budget", title: "执行回合硬上限", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class BudgetGateway extends MockAgentGateway {
      implementationCalls = 0; reviewCalls = 0;
      override async implement(goal: GoalContract, events: EventBus, context?: GoalExecutionContext) { this.implementationCalls++; return super.implement(goal, events, context); }
      override async review(goal: GoalContract) { this.reviewCalls++; return { approved: false, requirementDiffTestMap: [{ requirement: goal.outcome, evidence: "needs fix" }], findings: ["需要修复"] }; }
    }
    const gateway = new BudgetGateway();
    const orchestrator = new GoalOrchestrator(repo, gateway);
    orchestrator.dispatch("change-turn-budget");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("blocked");
    expect(run.events).toContain("execution_turn_limit");
    expect(run.events.filter((event) => event.startsWith("turn_budget:"))).toHaveLength(3);
    expect(gateway).toMatchObject({ implementationCalls: 1, reviewCalls: 1 });
    expect(run.worktree_path && existsSync(run.worktree_path)).toBe(true);
    orchestrator.runtime?.close();
  }, 30_000);

  it("halts new dispatch after an authentication or usage-limit failure", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-halt-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-usage-halt", change_set_id: "change-usage-halt", title: "用量门禁", outcome: "停止新派发", status: "compiled", ownership_modules: ["usage"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-usage-halt.yaml"), { schema_version: 1, id: "change-usage-halt", title: "用量门禁演练", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class LimitedGateway extends MockAgentGateway { override async start(): Promise<{ threadId: string }> { throw new Error("usage_limit:test"); } }
    const orchestrator = new GoalOrchestrator(repo, new LimitedGateway());
    orchestrator.dispatch("change-usage-halt");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("blocked");
    expect(orchestrator.haltedReason).toBe("usage_limit:test");
    expect(orchestrator.dispatch("change-usage-halt")).toMatchObject({ halted: "usage_limit:test", active: [] });
    orchestrator.runtime?.close();
  }, 30_000);

  it("persists consecutive infrastructure failures and halts on the third failure", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-infra-halt-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const contract: GoalContract = { schema_version: 1, id: "goal-infra-halt", change_set_id: "change-infra-halt", title: "基础设施三连败", outcome: "第三次失败后停派", status: "compiled", ownership_modules: ["infra"], write_globs: ["allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${contract.id}.yaml`), contract);
    atomicWriteYaml(join(repo, ".project", "changes", "change-infra-halt.yaml"), { schema_version: 1, id: "change-infra-halt", title: "基础设施三连败", status: "compiled", start_sha: startSha, goal_ids: [contract.id], dependency_dag: { [contract.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    const beforeRestart = new GoalOrchestrator(repo, new MockAgentGateway());
    beforeRestart.runtime!.setState("infrastructure_failure_count", "2");
    beforeRestart.runtime!.close();
    class BrokenTransportGateway extends MockAgentGateway { override async start(): Promise<{ threadId: string }> { throw new Error("codex_rpc_error:transport_closed"); } }
    const orchestrator = new GoalOrchestrator(repo, new BrokenTransportGateway());
    orchestrator.dispatch("change-infra-halt");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.events).toContain("infrastructure_failure_count:3");
    expect(orchestrator.haltedReason).toBe("infrastructure_failures:3");
    expect(orchestrator.runtime!.getState("infrastructure_failure_count")).toBe("3");
    orchestrator.runtime?.close();
  }, 30_000);

  it("detects an out-of-scope file from the worktree even when the agent reports no changed files", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-real-diff-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const goal: GoalContract = { schema_version: 1, id: "goal-real-diff", change_set_id: "change-real-diff", title: "真实 Diff 门禁", outcome: "只允许修改授权目录", status: "compiled", ownership_modules: ["allowed"], write_globs: ["apps/allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", "change-real-diff.yaml"), { schema_version: 1, id: "change-real-diff", title: "真实 Diff 演练", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class MisreportingGateway extends MockAgentGateway {
      override async implement(_goal: GoalContract, _events: EventBus, context?: GoalExecutionContext) {
        writeFileSync(join(context!.cwd, "forbidden.txt"), "out of scope", "utf8");
        return { changedFiles: [], evidence: ["agent-claimed-clean"] };
      }
    }
    const orchestrator = new GoalOrchestrator(repo, new MisreportingGateway());
    orchestrator.dispatch("change-real-diff");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("blocked");
    expect(run.events).toContain("scope_violation:forbidden.txt");
    expect(new GitController(repo).head("master")).toBe(startSha);
    expect(existsSync(run.worktree_path!)).toBe(true);
    orchestrator.runtime?.close();
  }, 30_000);

  it("blocks even the declared owner when a shared contract changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-shared-contract-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    mkdirSync(join(repo, "allowed"), { recursive: true }); writeFileSync(join(repo, "allowed", "contract.ts"), "export const version = 1;\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const goal: GoalContract = { schema_version: 1, id: "goal-shared-contract", change_set_id: "change-shared-contract", title: "共享契约门禁", outcome: "共享契约修改必须人工确认", status: "compiled", ownership_modules: ["contract"], write_globs: ["allowed/**"], shared_contracts: ["allowed/contract.ts"], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", `${goal.change_set_id}.yaml`), { schema_version: 1, id: goal.change_set_id, title: "共享契约门禁", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: { "allowed/contract.ts": goal.id }, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class ContractChangingGateway extends MockAgentGateway {
      override async implement(contract: GoalContract, events: EventBus, context?: GoalExecutionContext) {
        writeFileSync(join(context!.cwd, "allowed", "contract.ts"), "export const version = 2;\n", "utf8");
        return super.implement(contract, events, context);
      }
    }
    const orchestrator = new GoalOrchestrator(repo, new ContractChangingGateway());
    orchestrator.dispatch(goal.change_set_id);
    const [run] = await Promise.all([...orchestrator.active.values()]);
    expect(run.status).toBe("blocked");
    expect(run.events).toEqual(expect.arrayContaining([expect.stringContaining("shared_contract_changed:allowed/contract.ts")]));
    expect(loadProject(repo).proposals).toEqual(expect.arrayContaining([expect.objectContaining({ goal_id: goal.id, status: "proposed", requested_globs: ["allowed/contract.ts"] })]));
    expect(new GitController(repo).head("master")).toBe(startSha);
    expect(() => new GitController(repo).head(`codex/checkpoint/${goal.change_set_id}`)).toThrow();
    if (run.worktree_path) {
      new GitController(run.worktree_path).commitAll("test: preserve shared contract candidate before cleanup");
      new GitController(repo).removeGoalWorktree(run.worktree_path);
    }
    orchestrator.runtime?.close();
  }, 30_000);

  it("retains the reviewed candidate worktree and does not move main when full regression fails", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-integrator-regression-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const controller = new GitController(repo); const startSha = controller.head();
    const goal: GoalContract = { schema_version: 1, id: "goal-regression-candidate", change_set_id: "change-regression-candidate", title: "候选回归门禁", outcome: "产出可审查候选", status: "compiled", ownership_modules: ["allowed"], write_globs: ["apps/allowed/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", "change-regression-candidate.yaml"), { schema_version: 1, id: "change-regression-candidate", title: "完整回归失败演练", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 1"] });
    class WritingGateway extends MockAgentGateway {
      override async implement(_goal: GoalContract, _events: EventBus, context?: GoalExecutionContext) {
        const directory = join(context!.cwd, "apps", "allowed");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "result.txt"), "candidate", "utf8");
        return { changedFiles: [], evidence: ["candidate-written"] };
      }
    }
    const orchestrator = new GoalOrchestrator(repo, new WritingGateway());
    orchestrator.dispatch("change-regression-candidate");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    const model = loadProject(repo);
    expect(run.status).toBe("blocked");
    expect(model.goals.find((item) => item.id === goal.id)?.status).toBe("blocked");
    expect(model.changes.find((item) => item.id === "change-regression-candidate")?.status).toBe("blocked");
    expect(controller.head("master")).toBe(startSha);
    expect(existsSync(run.worktree_path!)).toBe(true);
    expect(controller.head("codex/integration/change-regression-candidate")).not.toBe(startSha);
    orchestrator.runtime?.close();
  }, 30_000);

  it("keeps a reviewed goal blocked when main moves after the Change Set snapshot", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-stale-main-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const goal: GoalContract = { schema_version: 1, id: "goal-stale-main", change_set_id: "change-stale-main", title: "主分支移动门禁", outcome: "禁止陈旧结果集成", status: "compiled", ownership_modules: ["gate"], write_globs: ["apps/gate/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", "change-stale-main.yaml"), { schema_version: 1, id: "change-stale-main", title: "陈旧主分支演练", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "human moved main"]);
    const orchestrator = new GoalOrchestrator(repo, new MockAgentGateway());
    orchestrator.dispatch("change-stale-main");
    const [run] = await Promise.all([...orchestrator.active.values()]);
    const model = loadProject(repo);
    expect(run.status).toBe("blocked");
    expect(model.goals.find((item) => item.id === goal.id)?.status).toBe("blocked");
    expect(model.reviews.find((review) => review.change_set_id === "change-stale-main")?.status).toBe("stale");
    orchestrator.runtime?.close();
  }, 30_000);

  it("interrupts an active run and preserves its worktree for resume", async () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-stop-active-"));
    copyProjectTruth(repo);
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "add", ".project"]); execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const startSha = new GitController(repo).head();
    const goal: GoalContract = { schema_version: 1, id: "goal-stop-active", change_set_id: "change-stop-active", title: "停止活动执行", outcome: "活动 Worker 可被真实中断", status: "compiled", ownership_modules: ["stop"], write_globs: ["apps/stop/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    atomicWriteYaml(join(repo, ".project", "goals", `${goal.id}.yaml`), goal);
    atomicWriteYaml(join(repo, ".project", "changes", "change-stop-active.yaml"), { schema_version: 1, id: "change-stop-active", title: "停止演练", status: "compiled", start_sha: startSha, goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: ["X0"], acceptance_commands: ["exit 0"] });
    class SlowGateway extends MockAgentGateway {
      override async implement() { return new Promise<{ changedFiles: string[]; evidence: string[] }>(() => undefined); }
    }
    const orchestrator = new GoalOrchestrator(repo, new SlowGateway());
    orchestrator.dispatch("change-stop-active");
    const activePromise = [...orchestrator.active.values()][0];
    let run = loadProject(repo).runs.find((item) => item.goal_id === goal.id);
    for (let retry = 0; !run && retry < 20; retry++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = loadProject(repo).runs.find((item) => item.goal_id === goal.id);
    }
    expect(run).toBeDefined();
    await orchestrator.stop(run!.id);
    const result = await activePromise;
    expect(result.status).toBe("stopped");
    expect(loadProject(repo).goals.find((item) => item.id === goal.id)?.status).toBe("stopped");
    expect(existsSync(result.worktree_path!)).toBe(true);
    orchestrator.runtime?.close();
  }, 30_000);
});

describe("git safety", () => {
  it("blocks every unsafe merge condition", () => {
    expect(mergeGateFailures({ expectedStartSha: "a", currentMainSha: "b", regressionPassed: false, reviewerApproved: false, scopeClean: false, sharedContractsUnchanged: false, hasMergeConflicts: true }))
      .toEqual(["main_sha_changed", "regression_failed", "review_rejected", "scope_violation", "shared_contract_changed", "merge_conflict"]);
  });

  it("detects a moved main SHA in a temporary repository", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-git-"));
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "one"]);
    const controller = new GitController(repo);
    const first = controller.head();
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "two"]);
    expect(() => controller.assertMainUnchanged(first, "master")).toThrow(/main_sha_changed/);
  });

  it("integrates goal branches only after regression and creates a checkpoint", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-integrate-"));
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "checkout", "-b", "codex/goal/a"]);
    writeFileSync(join(repo, "a.txt"), "a", "utf8");
    execFileSync("git", ["-C", repo, "add", "a.txt"]); execFileSync("git", ["-C", repo, "commit", "-m", "goal a"]);
    execFileSync("git", ["-C", repo, "checkout", "master"]);
    const result = new GitController(repo).integrateBranches({ changeSetId: "test", mainBranch: "master", expectedStartSha: base, goalBranches: ["codex/goal/a"], runRegression: (path) => path.endsWith("integration-test") });
    expect(result.checkpoint).toBe("codex/checkpoint/test");
    expect(execFileSync("git", ["-C", repo, "show", "codex/checkpoint/test", "--format=%H", "--no-patch"], { encoding: "utf8" }).trim()).toBe(base);
    expect(execFileSync("git", ["-C", repo, "show", "master:a.txt"], { encoding: "utf8" })).toBe("a");
  });

  it("does not move main when integration regression fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-regression-"));
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const controller = new GitController(repo); const base = controller.head();
    execFileSync("git", ["-C", repo, "branch", "codex/goal/empty", base]);
    expect(() => controller.integrateBranches({ changeSetId: "fail", mainBranch: "master", expectedStartSha: base, goalBranches: ["codex/goal/empty"], runRegression: () => false })).toThrow(/regression_failed/);
    expect(controller.head("master")).toBe(base);
    const retried = controller.integrateBranches({ changeSetId: "fail", mainBranch: "master", expectedStartSha: base, goalBranches: ["codex/goal/empty"], runRegression: () => true });
    expect(retried.checkpoint).toBe("codex/checkpoint/fail");
    expect(controller.head("codex/checkpoint/fail")).toBe(base);
  });

  it("keeps main and the checkpoint untouched when goal branches conflict", () => {
    const repo = mkdtempSync(join(tmpdir(), "epm-conflict-"));
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "shared.txt"), "base\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "shared.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const controller = new GitController(repo);
    const base = controller.head();

    for (const [branch, content] of [["codex/goal/conflict-a", "from-a\n"], ["codex/goal/conflict-b", "from-b\n"]] as const) {
      execFileSync("git", ["-C", repo, "checkout", "-b", branch, base]);
      writeFileSync(join(repo, "shared.txt"), content, "utf8");
      execFileSync("git", ["-C", repo, "add", "shared.txt"]);
      execFileSync("git", ["-C", repo, "commit", "-m", branch]);
    }
    execFileSync("git", ["-C", repo, "checkout", "master"]);

    expect(() => controller.integrateBranches({
      changeSetId: "conflict",
      mainBranch: "master",
      expectedStartSha: base,
      goalBranches: ["codex/goal/conflict-a", "codex/goal/conflict-b"],
      runRegression: () => true
    })).toThrow();
    expect(controller.head("master")).toBe(base);
    expect(execFileSync("git", ["-C", repo, "show", "master:shared.txt"], { encoding: "utf8" })).toBe("base\n");
    expect(() => controller.head("codex/checkpoint/conflict")).toThrow();
  });
});
