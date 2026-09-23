import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineeringNodeSchema, type EngineeringDocument, type EngineeringNode, type EngineeringTokenUsageSnapshot } from "@epm/domain";
import { loadEngineering, saveEngineering } from "@epm/spec-io";
import type { CompanionSession } from "./codex-companion.ts";
import { EventBus } from "./events.ts";
import { EngineeringExecutionService } from "./engineering-service.ts";

const roots: string[] = [];
const services: EngineeringExecutionService[] = [];
const wait = (milliseconds: number) => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

function session(id: string, cwd: string): CompanionSession {
  const at = new Date().toISOString();
  return {
    session_id: id, cwd, model: "Codex", permission_mode: null, turn_id: "turn-" + id,
    stage: "implementing", last_event: "PostToolUse", last_seen_at: at, started_at: at,
    plan_version: null, synced_task_ids: [], plan_steps: [], plan_explanation: null,
    current_task_id: null, task_progress: [], output_preview: null
  };
}

function node(input: Partial<EngineeringNode> & Pick<EngineeringNode, "id" | "parent_id" | "kind" | "title">) {
  const at = new Date().toISOString();
  return EngineeringNodeSchema.parse({
    objective: "形成一项可核对成果", method: "按冻结约定提交成果", architecture: "独立成果目录",
    owner: "未分配", order: 0, revision: 1, contract_revision: 1, status: "ready",
    dependencies: [], contributes_to: [], constraints: { allow: [], deny: [], rules: [], resources: [] },
    criteria: [], capabilities: [], actions: [], created_at: at, updated_at: at, ...input
  });
}

function leaf(id: string, parentId: string, owner: string, contribution: string) {
  return node({
    id, parent_id: parentId, kind: "step", title: id === "agent-a-result" ? "任务目录成果" : "方法目录成果",
    owner, contributes_to: [contribution], contribution: { summary: "向本区域交付可核对的独立成果" },
    criteria: [{ id: "artifact", text: "成果文件真实存在", kind: "file_exists", path: `artifacts/${id}.txt`, expected: "" }],
    actions: [{ id: "deliver", title: "提交成果", type: "agent_artifact", path: `artifacts/${id}.txt`, content: "", criterion_id: "artifact", capability_id: "" }],
    delivery: {
      included: ["本区域成果"], excluded: ["其他 Agent 区域"],
      outputs: [{ id: "result", title: "可核对成果", criterion_ids: ["artifact"] }], inputs: []
    }
  });
}

function installDocument(root: string) {
  const original = loadEngineering(root);
  const project = node({
    id: "engineering-project", parent_id: null, kind: "project", title: "双 Agent 闭环",
    objective: "两名 Agent 并行形成两个结果并由人逐项验收", owner: "项目负责人",
    constraints: { allow: ["artifacts/**"], deny: ["**/secrets/**"], rules: ["不得修改其他 Agent 区域"], resources: [] },
    criteria: [{ id: "complete", text: "两个区域成果共同形成完整结果", kind: "manual", path: "", expected: "" }],
    delivery: { included: ["两个区域成果"], excluded: ["未声明工作"], outputs: [{ id: "project", title: "闭环结果", criterion_ids: ["complete"] }], inputs: [] },
    composition: { summary: "两个独立区域成果共同组成完整结果", integration_criterion_ids: ["complete"], scenario: "查看两个成果并核对整体验收条件" }
  });
  const zoneA = node({
    id: "zone-a", parent_id: project.id, kind: "task", title: "任务目录区域", owner: "codex:agent-a", order: 0,
    contributes_to: ["complete"], contribution: { summary: "提供任务目录成果" },
    criteria: [{ id: "zone-a-complete", text: "任务目录成果可用", kind: "manual", path: "", expected: "" }],
    delivery: { included: ["任务目录"], excluded: ["方法目录"], outputs: [{ id: "zone-result", title: "任务目录", criterion_ids: ["zone-a-complete"] }], inputs: [] },
    composition: { summary: "区域叶任务形成任务目录", integration_criterion_ids: ["zone-a-complete"], scenario: "打开任务目录成果并核对" }
  });
  const zoneB = node({
    id: "zone-b", parent_id: project.id, kind: "task", title: "方法目录区域", owner: "codex:agent-b", order: 1,
    contributes_to: ["complete"], contribution: { summary: "提供方法目录成果" },
    criteria: [{ id: "zone-b-complete", text: "方法目录成果可用", kind: "manual", path: "", expected: "" }],
    delivery: { included: ["方法目录"], excluded: ["任务目录"], outputs: [{ id: "zone-result", title: "方法目录", criterion_ids: ["zone-b-complete"] }], inputs: [] },
    composition: { summary: "区域叶任务形成方法目录", integration_criterion_ids: ["zone-b-complete"], scenario: "打开方法目录成果并核对" }
  });
  const document: EngineeringDocument = {
    ...original, root_id: project.id,
    nodes: [project, zoneA, leaf("agent-a-result", zoneA.id, "未分配", "zone-a-complete"), zoneB, leaf("agent-b-result", zoneB.id, "未分配", "zone-b-complete")],
    runs: [], events: [], changes: [], capability_uses: []
  };
  saveEngineering(root, document, original.revision);
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).reverse().map(service => service.close()));
  for (const candidate of roots.splice(0).reverse()) {
    const target = resolve(candidate);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_dual_agent_fixture_cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("result-oriented dual Agent workflow", () => {
  it("persists two isolated Agent results, human acceptance, timing and exact Token attribution across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirror-dual-agent-loop-")); roots.push(root);
    installDocument(root);
    const sessions = [session("agent-a", root), session("agent-b", root)];
    const usage: Record<string, EngineeringTokenUsageSnapshot> = {
      "agent-a": { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1_120, observed_at: "2026-09-11T17:00:00.000Z" },
      "agent-b": { input_tokens: 2_000, cached_input_tokens: 800, output_tokens: 200, reasoning_output_tokens: 40, total_tokens: 2_240, observed_at: "2026-09-11T17:00:00.000Z" }
    };
    const options = {
      workspaceId: "dual-agent-workspace", agentSessions: () => sessions, agentObservations: () => sessions,
      authorizeIdentity: (id: string, cwd: string) => sessions.some(item => item.session_id === id && resolve(item.cwd) === resolve(cwd)) ? "current" as const : false,
      usageObserver: { snapshot: (id: string) => usage[id] ? { ...usage[id] } : undefined }
    };
    const service = new EngineeringExecutionService(root, new EventBus(), undefined, options); services.push(service);
    service.dispatch({ node_ids: ["agent-a-result", "agent-b-result"], mode: "external", expected_revision: service.view().document.revision });
    let runs = service.view().document.runs;
    expect(runs).toHaveLength(2);
    expect(runs.every(run => run.status === "queued" && run.handoff?.state === "awaiting_claim")).toBe(true);

    const runA = runs.find(run => run.node_id === "agent-a-result")!;
    const runB = runs.find(run => run.node_id === "agent-b-result")!;
    service.claim(runA.id, { contract_key: runA.snapshot.contract_key }, "codex:agent-a");
    service.claim(runB.id, { contract_key: runB.snapshot.contract_key }, "codex:agent-b");
    await service.settled();
    runs = service.view().document.runs;
    expect(runs.every(run => run.status === "running" && run.handoff?.state === "claimed")).toBe(true);
    expect(runs.every(run => run.metrics?.state === "measuring" && run.metrics.token_usage.total_tokens === 0)).toBe(true);

    await wait(20);
    usage["agent-a"] = { input_tokens: 1_700, cached_input_tokens: 650, output_tokens: 180, reasoning_output_tokens: 35, total_tokens: 1_915, observed_at: "2026-09-11T17:01:00.000Z" };
    usage["agent-b"] = { input_tokens: 2_900, cached_input_tokens: 1_150, output_tokens: 320, reasoning_output_tokens: 65, total_tokens: 3_285, observed_at: "2026-09-11T17:01:00.000Z" };
    await Promise.all([
      service.executeAction(runA.id, "deliver", false, { content: "TASK_CATALOG_OK" }, "codex:agent-a"),
      service.executeAction(runB.id, "deliver", false, { content: "METHOD_CATALOG_OK" }, "codex:agent-b")
    ]);
    await wait(20);
    await Promise.all([
      service.finish(runA.id, false, "codex:agent-a"),
      service.finish(runB.id, false, "codex:agent-b")
    ]);
    runs = service.view().document.runs;
    expect(runs.every(run => run.status === "review" && run.metrics?.state === "observed")).toBe(true);
    expect(Math.max(...runs.map(run => Date.parse(run.started_at)))).toBeLessThanOrEqual(Math.min(...runs.map(run => Date.parse(run.finished_at!))));

    usage["agent-a"] = { input_tokens: 1_750, cached_input_tokens: 675, output_tokens: 190, reasoning_output_tokens: 37, total_tokens: 1_977, observed_at: "2026-09-11T17:02:00.000Z" };
    usage["agent-b"] = { input_tokens: 2_950, cached_input_tokens: 1_175, output_tokens: 330, reasoning_output_tokens: 67, total_tokens: 3_347, observed_at: "2026-09-11T17:02:00.000Z" };
    service.review(runA.id, { verdict: "accepted", note: "人工已打开并核对任务目录成果。" });
    service.review(runB.id, { verdict: "accepted", note: "人工已打开并核对方法目录成果。" });
    const accepted = service.view().document.runs;
    expect(accepted.every(run => run.status === "accepted" && run.metrics?.state === "final")).toBe(true);
    expect(accepted.find(run => run.id === runA.id)?.metrics?.token_usage.total_tokens).toBe(857);
    expect(accepted.find(run => run.id === runB.id)?.metrics?.token_usage.total_tokens).toBe(1_107);
    expect(existsSync(join(accepted.find(run => run.id === runA.id)!.output_dir, "artifacts", "agent-a-result.txt"))).toBe(true);
    expect(existsSync(join(accepted.find(run => run.id === runB.id)!.output_dir, "artifacts", "agent-b-result.txt"))).toBe(true);

    await service.close();
    const restarted = new EngineeringExecutionService(root, new EventBus(), undefined, options); services.push(restarted);
    const restored = restarted.view().document.runs;
    expect(restored.map(run => run.status)).toEqual(["accepted", "accepted"]);
    expect(restored.map(run => run.metrics?.token_usage.total_tokens)).toEqual([857, 1_107]);
    expect(restored.every(run => run.evidence.some(item => item.kind === "artifact") && run.reviewed_at)).toBe(true);
    await restarted.close();
  });
});
