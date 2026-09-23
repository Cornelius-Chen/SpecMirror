import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SupervisionRun } from "@epm/domain";
import { atomicWriteYaml, captureIdea, loadCompletionAudit, loadProject, loadSupervision, loadSupervisionHistory, loadSupervisionRuns, migrateDocument, readIndexEntityIds, readYaml, rebuildIndex, RuntimeStore, validateCompletionEvidence, validateProject, validateSupervisionReferences, writeChangeSet, writeGoal, writeRun, writeSupervision, writeSupervisionDetail, writeSupervisionRun } from "./index.ts";

describe("spec io", () => {
  it("atomically replaces valid yaml without leaving temporary files", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-io-"));
    mkdirSync(join(root, "x"));
    const path = join(root, "x", "value.yaml");
    writeFileSync(path, "value: old\n", "utf8");
    atomicWriteYaml(path, { value: "new", nested: { ok: true } });
    expect(readYaml(path)).toEqual({ value: "new", nested: { ok: true } });
    expect(readFileSync(path, "utf8")).toContain("value: new");
  });

  it("keeps human Chinese titles separate from stable ASCII IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-capture-"));
    mkdirSync(join(root, ".project", "inbox"), { recursive: true });
    const idea = captureIdea(root, "中文想法不会成为机器 ID");
    expect(idea.title).toBe("中文想法不会成为机器 ID");
    expect(idea.id).toMatch(/^idea-[0-9a-f-]{36}$/);
  });

  it("loads the versioned completion checklist and verifies every declared evidence reference", () => {
    const root = process.cwd();
    const audit = loadCompletionAudit(root);
    expect(audit.counting_rule).toBe("atomic_tasks_equal_weight_done_only");
    expect(audit.workstreams.flatMap((item) => item.tasks).length).toBeGreaterThan(30);
    expect(validateCompletionEvidence(root, audit)).toEqual([]);
    const invalid = structuredClone(audit);
    invalid.workstreams[0]!.tasks[0]!.condition = { kind: "supervision_detail_accepted", detail_id: "detail-missing" };
    expect(validateCompletionEvidence(root, invalid)).toContain(`missing completion condition detail: ${invalid.workstreams[0]!.tasks[0]!.id} -> detail-missing`);
  });

  it("versions supervision details and preserves unrelated categories", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-supervision-"));
    const now = new Date().toISOString();
    const detail = {
      id: "detail-a", task_id: "task-legacy-supervision", title: "功能要求", category: "function" as const, intent: "让结果可核对", status: "ready" as const, version: "v1",
      acceptance: ["结果可见"], prompt: { version: "p1", base: "基础", local: "局部", resources: [], allowed_changes: ["文案"], forbidden_changes: ["逻辑"] }
    };
    writeSupervision(root, { schema_version: 1, id: "supervision-test", title: "监督测试", design_id: "design-test", version: "v1", updated_at: now, details: [detail, { ...detail, id: "detail-b", title: "视觉要求", category: "visual" }] });
    writeSupervisionDetail(root, { ...detail, intent: "已经更新", version: "v2" });
    const loaded = loadSupervision(root);
    expect(loaded.version).toBe("v2");
    expect(loadSupervisionHistory(root)).toHaveLength(1);
    expect(loadSupervisionHistory(root)[0].details.find((item) => item.id === "detail-a")?.intent).toBe("让结果可核对");
    expect(loaded.details.find((item) => item.id === "detail-a")).toMatchObject({ intent: "已经更新", version: "v2" });
    expect(loaded.details.find((item) => item.id === "detail-b")).toMatchObject({ title: "视觉要求", version: "v1" });
  });

  it("persists immutable supervision run snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-supervision-run-"));
    const now = new Date().toISOString();
    writeSupervision(root, {
      schema_version: 1, id: "supervision-run-test", title: "运行状态测试", design_id: "design-test", version: "v1", updated_at: now,
      details: [{ id: "detail-a", task_id: "task-legacy-supervision", title: "视觉要求", category: "visual", intent: "只改视觉", status: "assigned", version: "v1", acceptance: ["画面可见"], prompt: { version: "p1", base: "基础", local: "只改视觉", resources: [], allowed_changes: ["颜色"], forbidden_changes: ["逻辑"] } }]
    });
    const run: SupervisionRun = {
      schema_version: 1, id: "supervision-run-a", detail_id: "detail-a", category: "visual", mode: "mock", status: "running", attempt: 1, thread_id: null,
      prompt_snapshot: { version: "p1", base: "基础", local: "只改视觉", resources: [], allowed_changes: ["颜色"], forbidden_changes: ["逻辑"] },
      permission_snapshot: { category_only: true, resource_refs: [], allowed_changes: ["颜色"], forbidden_changes: ["逻辑"] },
      requested_at: now, started_at: now, finished_at: null, events: [{ type: "running", message: "开始", at: now }], capability_contract_ids: []
    };
    writeSupervisionRun(root, run);
    expect(loadSupervisionRuns(root)[0]).toMatchObject({ detail_id: "detail-a", category: "visual", permission_snapshot: { category_only: true, forbidden_changes: ["逻辑"] } });
    expect(() => writeSupervisionRun(root, { ...run, status: "accepted" })).toThrow(/Invalid supervisionRun transition/);
    expect(loadSupervisionRuns(root)[0].status).toBe("running");
  });

  it("validates historical run evidence against its frozen design version", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-supervision-versioned-run-"));
    const before = new Date(Date.now() - 1000).toISOString();
    const requestedAt = new Date().toISOString();
    const originalCriterion = "每个数字说明当时的计算对象";
    const revisedCriterion = "没有真实公式时不得猜测分母";
    const originalPrompt = { version: "p1", base: "保持事实", local: "解释数字", resources: [], allowed_changes: ["文案"], forbidden_changes: ["公式"] };
    const detail = { id: "detail-copy-a", task_id: "task-legacy-supervision", title: "解释进度", category: "copy" as const, intent: "让监督者看懂", status: "ready" as const, version: "v1",
      acceptance: [originalCriterion], prompt: originalPrompt };
    writeSupervision(root, { schema_version: 1, id: "supervision-versioned", title: "版本化监督", design_id: "design-a", version: "v1", updated_at: before, details: [detail] });
    writeSupervisionRun(root, {
      schema_version: 1, id: "supervision-run-versioned", detail_id: detail.id, category: "copy", mode: "mock", status: "reviewing", attempt: 1, thread_id: null,
      prompt_snapshot: originalPrompt, permission_snapshot: { category_only: true, resource_refs: [], allowed_changes: ["文案"], forbidden_changes: ["公式"] },
      output: { source: "mock", agent_label: "Mock", summary: "旧版本回执", artifact_kind: "copy", produced_at: requestedAt,
        checks: [{ criterion: originalCriterion, result: "pending", note: "等待验收" }], reviewer_status: "pending", reviewer_note: "" },
      requested_at: requestedAt, started_at: requestedAt, finished_at: requestedAt, events: [], capability_contract_ids: []
    });
    writeSupervisionDetail(root, { ...detail, version: "v2", acceptance: [revisedCriterion], prompt: { ...originalPrompt, version: "p2", local: "禁止猜测" } });
    const model = { design: [{ id: "design-a" }], goals: [], runs: [], permissionContracts: [] } as unknown as Parameters<typeof validateSupervisionReferences>[1];
    expect(validateSupervisionReferences(root, model)).toEqual([]);
  });

  it("persists recoverable events and enforces runtime locks", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-runtime-"));
    const store = new RuntimeStore(root);
    const seq = store.recordEvent("plan", { goalId: "goal-a" });
    expect(store.eventsSince(0)).toEqual([{ seq, type: "plan", payload: { goalId: "goal-a" }, createdAt: expect.any(String) }]);
    expect(store.acquireLocks(["write:apps/a"], "run-a")).toBe(true);
    expect(store.acquireLocks(["write:apps/a"], "run-b")).toBe(false);
    store.releaseLocks("run-a");
    expect(store.acquireLocks(["write:apps/a"], "run-b")).toBe(true);
    store.setState("halted_reason", "usage_limit");
    expect(store.getState("halted_reason")).toBe("usage_limit");
    store.releaseLocks("run-b");
    expect(store.acquireGoalLocks(["apps/**"], [], "run-wide")).toBe(true);
    expect(store.acquireGoalLocks(["apps/shared/**"], [], "run-narrow")).toBe(false);
    store.releaseLocks("run-wide");
    expect(store.acquireGoalLocks(["apps/a/**"], ["packages/domain/src/schema.ts"], "run-contract-posix")).toBe(true);
    expect(store.acquireGoalLocks(["apps/b/**"], ["packages\\domain\\src\\schema.ts"], "run-contract-windows")).toBe(false);
    store.close();
  });

  it("validates and enforces Goal, Run, and Change Set state transitions at persistence", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-state-write-"));
    const now = new Date().toISOString();
    const goal = { schema_version: 1, id: "goal-a", change_set_id: "change-a", title: "受控 Goal", outcome: "完成一项结果", status: "compiled" as const, ownership_modules: ["a"], write_globs: ["a/**"], shared_contracts: [], dependencies: [], acceptance_commands: ["exit 0"], unresolved_design_questions: [], max_minutes: 60, max_turns: 8 };
    const change = { schema_version: 1, id: "change-a", title: "受控变更", status: "compiled" as const, start_sha: "abc", goal_ids: [goal.id], dependency_dag: { [goal.id]: [] }, design_ids: [], constraint_ids: [], shared_contract_owners: {}, protected_baselines: [], acceptance_commands: ["exit 0"] };
    const run = { schema_version: 1, id: "run-a", goal_id: goal.id, gateway: "mock", status: "compiled" as const, thread_id: null, attempt: 1, started_at: now, finished_at: null, events: [], capability_contract_ids: [], agent_evidence: [], agent_checks: [] };
    writeGoal(root, goal); writeGoal(root, { ...goal, status: "planning" });
    writeChangeSet(root, change); writeChangeSet(root, { ...change, status: "running" });
    writeRun(root, run); writeRun(root, { ...run, status: "planning" });
    expect(() => writeGoal(root, { ...goal, status: "verified" })).toThrow(/Invalid goal transition/);
    expect(() => writeChangeSet(root, { ...change, status: "verified" })).toThrow(/Invalid change transition/);
    expect(() => writeRun(root, { ...run, status: "verified" })).toThrow(/Invalid goal transition/);
    expect(readYaml<{ status: string }>(join(root, ".project", "goals", "goal-a.yaml")).status).toBe("planning");
    expect(readYaml<{ status: string }>(join(root, ".project", "changes", "change-a.yaml")).status).toBe("running");
    expect(readYaml<{ status: string }>(join(root, ".project", "runs", "run-a.yaml")).status).toBe("planning");
  });

  it("rejects dangling stable references and validates formal field-to-code artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-reference-"));
    const now = new Date().toISOString();
    mkdirSync(join(root, ".project", "design"), { recursive: true });
    mkdirSync(join(root, ".project", "engineering"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    atomicWriteYaml(join(root, ".project", "project.yaml"), {
      schema_version: 1, id: "project-reference", title: "引用测试", description: "",
      repository: { main_branch: "master", root: "." }, runtime: { max_workers: 3, goal_timeout_minutes: 60, max_fix_retries: 2, max_execution_turns: 8, gateway: "mock" },
      baselines: [{ id: "X0", title: "基线", status: "guarded", progress: 100, atom_ids: ["design-a"] }], frontier: { id: "Y1", title: "前沿", status: "active", progress: 0 }, next_best_action: { title: "继续", reason: "验证" }
    });
    atomicWriteYaml(join(root, ".project", "design", "design-a.yaml"), { schema_version: 1, id: "design-a", version: "v1", title: "设计", status: "guarded", module: "a", weight: 1, acceptance: ["字段可追踪"], protected_by: [], updated_at: now });
    atomicWriteYaml(join(root, ".project", "engineering", "engineering-a.yaml"), { schema_version: 1, id: "engineering-a", title: "工程", kind: "package", path: "src", status: "verified", owner: "a", design_ids: ["design-a"], test_paths: ["tests/a.test.ts"] });
    writeFileSync(join(root, "src", "a.ts"), "export function Marker() {}\n", "utf8");
    writeFileSync(join(root, "tests", "a.test.ts"), "// verified\n", "utf8");
    atomicWriteYaml(join(root, ".project", "trace.yaml"), { schema_version: 1, edges: [], bindings: [{ id: "binding-a", mark: "A01", design_id: "design-a", field_path: "acceptance[0]", field_label: "字段可追踪", engineering_id: "engineering-a", file_path: "src/a.ts", symbol: "Marker", test_paths: ["tests/a.test.ts"], status: "formal" }] });
    expect(validateProject(root)).toMatchObject({ valid: true, entities: 3, bindings: 1, findings: [] });
    const index = rebuildIndex(root);
    const db = new DatabaseSync(index.path, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM trace_bindings").get() as { count: number }).count).toBe(1);
    db.close();
    writeFileSync(join(root, "src", "a.ts"), "export const Missing = true;\n", "utf8");
    expect(validateProject(root)).toMatchObject({ valid: false, findings: ["missing code symbol: binding-a -> Marker"] });
    atomicWriteYaml(join(root, ".project", "engineering", "engineering-a.yaml"), { schema_version: 1, id: "engineering-a", title: "工程", kind: "package", path: "src", status: "verified", owner: "a", design_ids: ["missing-design"], test_paths: ["tests/a.test.ts"] });
    expect(() => loadProject(root)).toThrow(/missing reference: engineering-a.design_ids -> missing-design/);
  });

  it("rejects unsupported future schema migrations", () => {
    expect(migrateDocument({ id: "x" })).toMatchObject({ schema_version: 1 });
    expect(() => migrateDocument({ schema_version: 2 })).toThrow(/future/);
  });

  it("applies migrations on the real project loading path", () => {
    const root = mkdtempSync(join(tmpdir(), "epm-migration-"));
    mkdirSync(join(root, ".project"), { recursive: true });
    atomicWriteYaml(join(root, ".project", "project.yaml"), {
      id: "project-legacy", title: "旧版项目", description: "缺少显式版本的 v0 文档",
      repository: { main_branch: "master", root: "." },
      runtime: { max_workers: 3, goal_timeout_minutes: 60, max_fix_retries: 2, max_execution_turns: 8, gateway: "mock" },
      baselines: [], frontier: { id: "Y1", title: "迁移验证", status: "active", progress: 0 },
      next_best_action: { title: "继续", reason: "验证迁移" }
    });
    atomicWriteYaml(join(root, ".project", "trace.yaml"), { edges: [], bindings: [] });
    const model = loadProject(root);
    expect(model.project).toMatchObject({ schema_version: 1, id: "project-legacy" });
    expect(model.edges).toEqual([]);

    const before = new RuntimeStore(root);
    const seq = before.recordEvent("system", { message: "keep across rebuild" });
    expect(before.acquireLocks(["write:apps/**"], "run-live")).toBe(true);
    before.setState("orchestrator_owner", "123:service");
    before.close();
    rebuildIndex(root);
    expect(readIndexEntityIds(root)).toEqual(["project-legacy"]);
    const after = new RuntimeStore(root);
    expect(after.eventsSince(0)).toEqual([expect.objectContaining({ seq, payload: { message: "keep across rebuild" } })]);
    expect(after.listLocks()).toEqual([expect.objectContaining({ resource: "write:apps/**", owner: "run-live" })]);
    expect(after.getState("orchestrator_owner")).toBe("123:service");
    after.close();
  });
});
