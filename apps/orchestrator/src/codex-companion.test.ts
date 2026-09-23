import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSupervision, RuntimeStore, writeSupervision, writeSupervisionTask } from "@epm/spec-io";
import { bindCompanionSession, queueCompanionFeedback, readCompanionStatus, receiveCompanionHook, reportCompanionProgress, syncCompanionPlan } from "./codex-companion.ts";
import { EventBus } from "./events.ts";

const fixtures: Array<{ root: string; runtime: RuntimeStore }> = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "epm-companion-contract-"));
  const runtime = new RuntimeStore(root);
  fixtures.push({ root, runtime });
  const events = new EventBus(runtime);
  writeSupervision(root, {
    schema_version: 1, id: "supervision-companion-test", title: "伴随同步测试", design_id: "design-companion-test", version: "v1", updated_at: "2026-01-01T00:00:00.000Z",
    plan: { version: "plan-v1", status: "draft", source: "manual", source_text: "原有设计", imported_at: "2026-01-01T00:00:00.000Z", frozen_at: null },
    tasks: [{ id: "task-existing", title: "保留人工任务", objective: "独立设计", status: "ready", version: "t1", order: 0, dependencies: [] }],
    details: [{ id: "detail-existing", task_id: "task-existing", title: "功能结果", category: "function", intent: "保留人工验收", status: "ready", version: "v1", acceptance: ["人工判断是否通过"], prompt: { version: "p1", base: "测试", local: "当前任务", resources: [], allowed_changes: ["当前任务"], forbidden_changes: ["其他任务"] } }]
  });
  const start = (session_id = "session-a") => receiveCompanionHook(root, runtime, events, { session_id, cwd: root, hook_event_name: "SessionStart" });
  const bind = (session_id: string) => bindCompanionSession(root, runtime, events, { session_id, cwd: root });
  const sync = (step = "执行结构化步骤", session_id?: string) => syncCompanionPlan(root, runtime, events, { cwd: root, session_id, plan: [{ step, status: "in_progress" }] });
  return { root, runtime, events, start, bind, sync };
}

afterEach(() => {
  for (const { runtime, root } of fixtures.splice(0)) {
    runtime.close();
    // Only delete the fixture directory created by mkdtemp above.
    if (resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/")) rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex companion session and Plan contract", () => {
  it("rejects cross-project and relative paths before Plan, progress, binding, or runtime mutation", () => {
    const f = fixture();
    f.start();
    const taskId = f.sync().imported_task_ids[0];
    const before = readFileSync(join(f.root, ".project", "supervision", "specmirror-m1.yaml"), "utf8");
    const state = JSON.stringify(readCompanionStatus(f.root, f.runtime));
    for (const cwd of [join(f.root, "..", "unrelated-project"), f.root + "-sibling", ".", ""]) {
      expect(() => syncCompanionPlan(f.root, f.runtime, f.events, { cwd, session_id: "session-a", plan: [{ step: "不得导入" }] })).toThrow("codex_cwd_outside_project");
      expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { cwd, session_id: "session-a", task_id: taskId, stage: "completed" })).toThrow("codex_cwd_outside_project");
      expect(() => bindCompanionSession(f.root, f.runtime, f.events, { cwd, session_id: "session-a" })).toThrow("codex_cwd_outside_project");
    }
    expect(JSON.stringify(readCompanionStatus(f.root, f.runtime))).toBe(state);
    expect(readFileSync(join(f.root, ".project", "supervision", "specmirror-m1.yaml"), "utf8")).toBe(before);
    expect(receiveCompanionHook(f.root, f.runtime, f.events, { session_id: "foreign", cwd: tmpdir(), hook_event_name: "SessionStart" })).toMatchObject({ accepted: false, ignored: "different_project" });
  });

  it("accepts actual child directories but rejects a junction into a different project", () => {
    const f = fixture();
    const foreign = fixture();
    const nested = join(f.root, "packages", "client");
    mkdirSync(nested, { recursive: true });
    f.start();
    expect(syncCompanionPlan(f.root, f.runtime, f.events, { cwd: nested, plan: [{ step: "项目内步骤" }] }).imported_task_ids).toHaveLength(1);
    const link = join(f.root, "foreign-link");
    symlinkSync(foreign.root, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => syncCompanionPlan(f.root, f.runtime, f.events, { cwd: link, plan: [{ step: "越界步骤" }] })).toThrow("codex_cwd_outside_project");
    expect(() => syncCompanionPlan(f.root, f.runtime, f.events, { cwd: join(link, "not-created"), plan: [{ step: "越界步骤" }] })).toThrow("codex_cwd_outside_project");
  });

  it("never falls back from an unknown explicit session and requires a session before writes", () => {
    const f = fixture();
    expect(() => f.sync()).toThrow("codex_session_not_bound");
    f.start();
    expect(() => f.sync("不得回退", "unknown-session")).toThrow("codex_session_not_found");
    expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { session_id: "unknown-session", task: "task-existing", stage: "testing" })).toThrow("codex_session_not_found");
    expect(() => queueCompanionFeedback(f.root, f.runtime, f.events, { session_id: "unknown-session", task_id: "task-existing", text: "不得回退" })).toThrow("codex_session_not_found");
  });

  it("requires explicit selection for multiple candidates and persists the selected session", () => {
    const f = fixture();
    f.start();
    const taskId = f.sync().imported_task_ids[0];
    f.start("session-b");
    expect(readCompanionStatus(f.root, f.runtime)).toMatchObject({ selected_session_id: null, selection_required: true, latest_session: null, connected: false });
    expect(() => f.sync()).toThrow("codex_session_selection_required");
    expect(() => f.sync("显式 session 不能替代选择", "session-a")).toThrow("codex_session_selection_required");
    expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { task_id: taskId, stage: "testing" })).toThrow("codex_session_selection_required");
    expect(() => queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskId, text: "必须先选择" })).toThrow("codex_session_selection_required");
    expect(f.bind("session-a")).toMatchObject({ selected_session_id: "session-a", selection_required: false });
    f.start("session-b");
    expect(readCompanionStatus(f.root, f.runtime).latest_session?.session_id).toBe("session-a");
    const secondStore = new RuntimeStore(f.root);
    try { expect(readCompanionStatus(f.root, secondStore).selected_session_id).toBe("session-a"); } finally { secondStore.close(); }
    expect(() => f.sync("非选定 session", "session-b")).toThrow("codex_session_not_selected");
  });

  it("records unselected hook candidates without importing their Plans", () => {
    const f = fixture();
    f.start();
    f.start("session-b");
    const result = receiveCompanionHook(f.root, f.runtime, f.events, { session_id: "session-b", cwd: f.root, hook_event_name: "PostToolUse", tool_name: "update_plan", tool_input: { plan: [{ step: "不能猜选" }] } });
    expect(result.imported_task_ids).toEqual([]);
    expect(loadSupervision(f.root).tasks.map((task) => task.title)).not.toContain("不能猜选");
  });

  it("imports structured steps exactly once, preserves multiline steps, and excludes explanation", () => {
    const f = fixture();
    f.start();
    const input = { cwd: f.root, explanation: "解释说明\n1. 这也不是任务", plan: [{ step: "甲", status: "completed" }, { step: "多行步骤\n仍属于同一任务", status: "in_progress" }] };
    const first = syncCompanionPlan(f.root, f.runtime, f.events, input);
    expect(first.unchanged).toBe(false);
    expect(first.document.tasks).toHaveLength(3);
    expect(first.document.tasks.slice(1).map((item) => item.title)).toEqual(input.plan.map((item) => item.step));
    const before = readFileSync(join(f.root, ".project", "supervision", "specmirror-m1.yaml"), "utf8");
    const eventCount = f.events.history.length;
    const repeated = syncCompanionPlan(f.root, f.runtime, f.events, input);
    expect(repeated).toMatchObject({ unchanged: true, imported_task_ids: first.imported_task_ids, document: { version: first.document.version, plan: { version: first.document.plan.version } } });
    expect(readFileSync(join(f.root, ".project", "supervision", "specmirror-m1.yaml"), "utf8")).toBe(before);
    expect(f.events.history).toHaveLength(eventCount);
    const changedStatus = syncCompanionPlan(f.root, f.runtime, f.events, { ...input, explanation: "新的解释", plan: input.plan.map((item) => ({ ...item, status: "completed" })) });
    expect(changedStatus.unchanged).toBe(true);
    expect(f.events.history).toHaveLength(eventCount + 1);
    expect(f.events.history.at(-1)).toMatchObject({ type: "plan", data: { kind: "codex-companion-plan-status", sessionId: "session-a", planVersion: first.document.plan.version } });
    expect(readCompanionStatus(f.root, f.runtime).latest_session).toMatchObject({ plan_explanation: "新的解释", plan_steps: input.plan.map((item, index) => ({ step: item.step, status: "completed", task_id: first.imported_task_ids[index] })) });
    expect(loadSupervision(f.root).tasks.slice(1).every((item) => item.status === "draft")).toBe(true);
    expect(loadSupervision(f.root).details.slice(1).every((item) => item.status === "draft")).toBe(true);
  });

  it("preserves task identity and human edits when a structured step is reported again", () => {
    const f = fixture();
    f.start();
    const first = f.sync("最初的步骤");
    const task = first.document.tasks.find((item) => item.id === first.imported_task_ids[0])!;
    writeSupervisionTask(f.root, { ...task, title: "监督者修订的任务名", version: "t2" });
    const documentBefore = loadSupervision(f.root);
    const result = f.sync("最初的步骤");
    expect(result.imported_task_ids).toEqual(first.imported_task_ids);
    expect(result.document).toEqual(documentBefore);
    expect(result.unchanged).toBe(true);
  });

  it("keeps same-title tasks separate across sessions and from unmapped human tasks", () => {
    const f = fixture();
    f.start();
    const taskA = f.sync("运行测试").imported_task_ids[0];
    f.start("session-b");
    f.bind("session-b");
    const resultB = f.sync("运行测试");
    const taskB = resultB.imported_task_ids[0];
    expect(taskB).not.toBe(taskA);
    expect(resultB.document.tasks.filter((item) => item.title === "运行测试")).toHaveLength(2);
    expect(f.sync("运行测试")).toMatchObject({ unchanged: true, imported_task_ids: [taskB] });
    expect(() => queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskA, text: "B 不能继承 A 的反馈权限" })).toThrow("codex_task_not_owned_by_session");
    expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { task_id: taskA, stage: "testing" })).toThrow("codex_task_not_owned_by_session");
    f.bind("session-a");
    expect(f.sync("运行测试")).toMatchObject({ unchanged: true, imported_task_ids: [taskA] });
    const humanTitle = f.sync("保留人工任务");
    expect(humanTitle.imported_task_ids).not.toContain("task-existing");
    expect(humanTitle.document.tasks.find((item) => item.id === "task-existing")).toMatchObject({ status: "ready", objective: "独立设计" });
  });

  it("keeps repeated same-title steps mapped idempotently within one session", () => {
    const f = fixture();
    f.start();
    const input = { cwd: f.root, plan: [{ step: "运行测试", status: "completed" }, { step: "运行测试", status: "in_progress" }] };
    const first = syncCompanionPlan(f.root, f.runtime, f.events, input);
    expect(new Set(first.imported_task_ids).size).toBe(2);
    expect(syncCompanionPlan(f.root, f.runtime, f.events, input)).toMatchObject({ unchanged: true, imported_task_ids: first.imported_task_ids });
  });

  it("rejects ambiguous legacy ownership until a Plan sync creates a separate mapping", () => {
    const f = fixture();
    f.start();
    const taskA = f.sync("旧版本曾共用的步骤").imported_task_ids[0];
    f.start("session-b");
    const sessions = readCompanionStatus(f.root, f.runtime).sessions;
    const sessionA = sessions.find((item) => item.session_id === "session-a")!;
    f.runtime.setState("codex-companion:sessions", JSON.stringify(sessions.map((item) => item.session_id === "session-b" ? { ...item, synced_task_ids: [...sessionA.synced_task_ids], plan_steps: [...sessionA.plan_steps] } : item)));
    f.bind("session-b");
    expect(() => queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskA, text: "归属歧义时拒绝投递" })).toThrow("codex_task_not_owned_by_session");
    expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { task_id: taskA, stage: "testing" })).toThrow("codex_task_not_owned_by_session");
    const repaired = f.sync("旧版本曾共用的步骤");
    expect(repaired.imported_task_ids[0]).not.toBe(taskA);
    expect(queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: repaired.imported_task_ids[0], text: "单独归属后可投递" }).feedback.task_id).toBe(repaired.imported_task_ids[0]);
  });

  it("reconciles changed Plan statuses and Stop without erasing precise unchanged progress", () => {
    const f = fixture();
    f.start();
    const taskId = f.sync("阶段流转步骤").imported_task_ids[0];
    const testing = reportCompanionProgress(f.root, f.runtime, f.events, { task_id: taskId, stage: "testing", summary: "正在执行定向测试" }).latest_session!;
    f.sync("阶段流转步骤");
    const unchanged = readCompanionStatus(f.root, f.runtime).latest_session!;
    expect(unchanged.stage).toBe("testing");
    expect(unchanged.task_progress).toEqual(testing.task_progress);
    const before = loadSupervision(f.root);
    const plan = (status: string) => syncCompanionPlan(f.root, f.runtime, f.events, { cwd: f.root, plan: [{ step: "阶段流转步骤", status }] });
    expect(plan("completed").unchanged).toBe(true);
    expect(readCompanionStatus(f.root, f.runtime).latest_session).toMatchObject({ stage: "completed", task_progress: [{ task_id: taskId, stage: "completed", source: "agent" }] });
    const stop = { session_id: "session-a", cwd: f.root, hook_event_name: "Stop", turn_id: "first-stop" };
    const completedStop = receiveCompanionHook(f.root, f.runtime, f.events, stop).session!;
    expect(completedStop).toMatchObject({ stage: "idle", task_progress: [{ task_id: taskId, stage: "completed" }] });
    expect(loadSupervision(f.root)).toEqual(before);
    plan("in_progress");
    expect(readCompanionStatus(f.root, f.runtime).latest_session?.task_progress[0].stage).toBe("implementing");
    reportCompanionProgress(f.root, f.runtime, f.events, { task_id: taskId, stage: "reviewing", summary: "等待本轮审查" });
    const activeStop = receiveCompanionHook(f.root, f.runtime, f.events, { ...stop, turn_id: "second-stop" }).session!;
    expect(activeStop).toMatchObject({ stage: "idle", task_progress: [{ task_id: taskId, stage: "idle", source: "agent" }] });
    f.sync("阶段流转步骤");
    expect(readCompanionStatus(f.root, f.runtime).latest_session?.task_progress[0].stage).toBe("idle");
    expect(loadSupervision(f.root)).toEqual(before);
  });

  it("binds progress to owned tasks, rejects unknown stages, and leaves acceptance to humans", () => {
    const f = fixture();
    f.start();
    const taskId = f.sync("需要测试的步骤").imported_task_ids[0];
    for (const task of ["unknown", "task-existing"]) expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { task, stage: "testing" })).toThrow("codex_task_not_owned_by_session");
    expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { stage: "testing" })).toThrow("codex_progress_task_required");
    for (const stage of ["nonsense", "", undefined]) expect(() => reportCompanionProgress(f.root, f.runtime, f.events, { task_id: taskId, stage })).toThrow("codex_progress_stage_invalid");
    const before = loadSupervision(f.root);
    const status = reportCompanionProgress(f.root, f.runtime, f.events, { task: "需要测试的步骤", stage: "completed", summary: "Agent 自报通过" });
    expect(status.latest_session).toMatchObject({ current_task_id: taskId, stage: "completed", task_progress: [{ task_id: taskId, stage: "completed", source: "agent", summary: "Agent 自报通过" }] });
    expect(loadSupervision(f.root)).toEqual(before);
    expect(f.events.history.at(-1)?.message).toContain("Agent 报告完成");
  });

  it("routes feedback only to the selected owner and prevents duplicate Stop deliveries", () => {
    const f = fixture();
    f.start();
    const taskA = f.sync("属于 A 的步骤").imported_task_ids[0];
    f.start("session-b");
    f.bind("session-b");
    const taskB = f.sync("属于 B 的步骤").imported_task_ids[0];
    expect(() => queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskA, text: "不能串到 B" })).toThrow("codex_task_not_owned_by_session");
    expect(() => queueCompanionFeedback(f.root, f.runtime, f.events, { session_id: "session-a", task_id: taskA, text: "不能指定非选定任务" })).toThrow("codex_session_not_selected");
    const queued = queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskB, text: "B 的第一条反馈" });
    f.bind("session-a");
    const stop = { session_id: "session-b", cwd: f.root, hook_event_name: "Stop", turn_id: "turn-1", last_assistant_message: "完成本轮" };
    expect(receiveCompanionHook(f.root, f.runtime, f.events, stop).hook_response).toEqual({ continue: true });
    expect(readCompanionStatus(f.root, f.runtime).feedback.find((item) => item.id === queued.feedback.id)?.status).toBe("pending");
    f.bind("session-b");
    const nextStop = { ...stop, turn_id: "turn-2" };
    expect(receiveCompanionHook(f.root, f.runtime, f.events, nextStop).hook_response).toMatchObject({ decision: "block", reason: expect.stringContaining("B 的第一条反馈") });
    const second = queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskB, text: "B 的第二条反馈" });
    expect(receiveCompanionHook(f.root, f.runtime, f.events, nextStop).hook_response).toEqual({ continue: true });
    expect(receiveCompanionHook(f.root, f.runtime, f.events, { ...nextStop, last_assistant_message: "同一回合的重复事件" }).hook_response).toEqual({ continue: true });
    expect(readCompanionStatus(f.root, f.runtime).feedback.find((item) => item.id === second.feedback.id)?.status).toBe("pending");
    expect(receiveCompanionHook(f.root, f.runtime, f.events, { ...stop, turn_id: "turn-3", stop_hook_active: true }).hook_response).toEqual({ continue: true });
    expect(readCompanionStatus(f.root, f.runtime).feedback.find((item) => item.id === second.feedback.id)?.status).toBe("pending");
    expect(receiveCompanionHook(f.root, f.runtime, f.events, { ...stop, turn_id: "turn-4" }).hook_response).toMatchObject({ decision: "block", reason: expect.stringContaining("B 的第二条反馈") });
  });

  it("delivers queued feedback in order and distinguishes new prompt cycles without turn IDs", () => {
    const f = fixture();
    f.start();
    const taskId = f.sync().imported_task_ids[0];
    queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskId, text: "较早反馈" });
    queueCompanionFeedback(f.root, f.runtime, f.events, { task_id: taskId, text: "较晚反馈" });
    const stop = { session_id: "session-a", cwd: f.root, hook_event_name: "Stop", last_assistant_message: "相同的完成摘要" };
    expect(receiveCompanionHook(f.root, f.runtime, f.events, stop).hook_response).toMatchObject({ decision: "block", reason: expect.stringContaining("较早反馈") });
    expect(receiveCompanionHook(f.root, f.runtime, f.events, stop).hook_response).toEqual({ continue: true });
    receiveCompanionHook(f.root, f.runtime, f.events, { session_id: "session-a", cwd: f.root, hook_event_name: "UserPromptSubmit" });
    expect(receiveCompanionHook(f.root, f.runtime, f.events, stop).hook_response).toMatchObject({ decision: "block", reason: expect.stringContaining("较晚反馈") });
  });
});
