import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { currentEngineeringRun, type EngineeringFeedbackTarget, type EngineeringNode, type EngineeringRun, type EngineeringView } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { receiveCompanionHook } from "./codex-companion.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";

const fixtures: Array<{ root: string; close: () => Promise<void> }> = [];
let isolatedApproval = 0;
const isolatedHumanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
  kind: "authenticated_human_approval", principalId: "isolated-feedback-test-owner",
  approvalId: `feedback-test-approval-${++isolatedApproval}`,
  requestDigest: requirement.requestDigest, expiresAt: Date.now() + 60_000
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-feedback-fixture-"));
  const doc = loadEngineering(root);
  for (const node of doc.nodes) delete node.delivery;
  atomicWriteYaml(engineeringDocumentPath(root), doc);
  const app = Fastify(), events = new EventBus();
  registerHumanApprovalGuard(app, isolatedHumanApproval);
  const service = registerEngineeringRoutes(app, root, events);
  fixtures.push({ root, close: () => app.close() });
  await app.ready();
  const view = () => service.view();
  const request = async (method: "POST" | "PUT", path: string, body: unknown, status = 200, headers?: Record<string, string>) => {
    const result = await app.inject({ method, url: "/api/engineering" + path, payload: body as object, headers });
    expect(result.statusCode, result.body).toBe(status);
    return result.json();
  };
  const patch = (id: string, change: Partial<EngineeringNode>) => {
    const current = view(), node = { ...current.document.nodes.find(item => item.id === id)!, ...change };
    const input = { node, expected_revision: current.document.revision, reason: "隔离案例的明确修订" };
    service.preview(id, input); return service.updateNode(id, input);
  };
  const create = (title: string) => {
    const next = service.createNode({ parent_id: "engineering-project", title, expected_revision: view().document.revision });
    const node = next.document.nodes.find(item => item.title === title)!;
    patch(node.id, {
      objective: "交付可核对的报告", contributes_to: ["project-outcome"],
      criteria: [{ id: "file", text: "实际报告内容正确", kind: "file_contains", path: "artifacts/report.txt", expected: "delivered" },
        { id: "manual", text: "报告满足本项用途", kind: "manual", path: "", expected: "" }],
      actions: [{ id: "write", title: "形成报告", type: "write_file", path: "artifacts/report.txt", content: "delivered", criterion_id: "file", capability_id: "" }]
    });
    return node.id;
  };
  const execute = async (id: string) => {
    service.ready(id, view().document.revision);
    service.dispatch({ node_ids: [id], mode: "controlled", expected_revision: view().document.revision });
    await service.settled();
    return currentEngineeringRun(view().document, id)!;
  };
  const approve = (run: EngineeringRun) => service.review(run.id, { verdict: "accepted", note: "隔离测试人工审查角色：实际打开结果核对", checks: run.snapshot.node.criteria.filter(item => item.kind === "manual").map(item => ({ criterion_id: item.id, passed: true, note: "本条条件已对应检查" })) });
  const feedback = async (id: string, kind: "defect" | "requirement_change" = "defect", target?: EngineeringFeedbackTarget) => {
    const current = view();
    const next = await request("POST", "/feedback-items", { expected_revision: current.document.revision, base_node_revision: current.document.nodes.find(item => item.id === id)!.revision,
      target: target ?? { kind: "criterion", node_id: id, id: "manual" }, kind, note: "报告需要补足已约定的结果" }, 201) as EngineeringView;
    return next.document.feedbacks!.at(-1)!;
  };
  const handle = (id: string, action: string, extra: object = {}, status = 200) => request("POST", `/feedback-items/${id}/update`, { expected_revision: view().document.revision, action, note: "隔离测试核对本次处理依据", ...extra }, status);
  return { root, app, service, events, view, request, patch, create, execute, approve, feedback, handle };
}

afterEach(async () => {
  for (const item of fixtures.splice(0).reverse()) {
    await item.close();
    const absolute = resolve(item.root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes("mirror-feedback-fixture-")) throw new Error("unsafe_fixture_cleanup");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("isolated engineering feedback and evidence loop", () => {
  it("records a precise version without changing accepted results, and rejects stale or missing targets", async () => {
    const f = await fixture(), id = f.create("报告"), run = await f.execute(id); f.approve(run);
    const item = await f.feedback(id);
    expect(f.view().derived[id].status).toBe("accepted");
    expect(loadEngineering(f.root).feedbacks?.[0].history[0].basis?.run_id).toBe(run.id);
    await f.request("POST", "/feedback-items", { expected_revision: f.view().document.revision, base_node_revision: item.base_node_revision - 1,
      target: item.target, kind: "defect", note: "过期意见" }, 409);
    await f.request("POST", "/feedback-items", { expected_revision: f.view().document.revision, base_node_revision: item.base_node_revision,
      target: { kind: "relation", node_id: id, id: "input:missing" }, kind: "defect", note: "不存在的关系" }, 400);
    expect(f.view().document.feedbacks).toHaveLength(1);
  });

  it("repairs under the original criteria and resolves only against a fresh accepted result", async () => {
    const f = await fixture(), id = f.create("报告"), independent = f.create("独立说明");
    const original = await f.execute(id); f.approve(original);
    const other = await f.execute(independent); f.approve(other);
    const criteria = f.view().document.nodes.find(node => node.id === id)!.criteria;
    const item = await f.feedback(id);
    await f.handle(item.id, "adopt");
    expect(f.view().derived[id].status).toBe("needs_revision");
    expect(f.view().derived[independent].status).toBe("accepted");
    expect(f.view().document.nodes.find(node => node.id === id)!.criteria).toEqual(criteria);
    await f.handle(item.id, "submit", { run_id: original.id }, 409);
    const repaired = await f.execute(id);
    await f.handle(item.id, "submit", { run_id: repaired.id });
    await f.handle(item.id, "resolve", {}, 409);
    f.approve(repaired);
    await f.handle(item.id, "resolve");
    const resolved = f.view().document.feedbacks![0];
    expect(resolved.status).toBe("resolved");
    expect(resolved.history.at(-1)).toMatchObject({ run_id: repaired.id, evidence_ids: expect.arrayContaining([repaired.evidence[0].id]) });
    expect(f.view().derived["engineering-project"].status).not.toBe("accepted");
    await f.handle(item.id, "reopen");
    expect(f.view().document.feedbacks![0].history[0].basis?.run_id).toBe(original.id);
    expect(f.view().document.feedbacks![0].history.at(-1)?.basis?.run_id).toBe(repaired.id);
  });

  it("requires a matching adopted requirement change instead of an unrelated edit", async () => {
    const f = await fixture(), id = f.create("报告"), item = await f.feedback(id, "requirement_change");
    await f.handle(item.id, "adopt", {}, 409);
    f.patch(id, { objective: "报告和原始依据一起交付" });
    await f.handle(item.id, "adopt", { change_id: f.view().document.changes.at(-1)!.id }, 409);
    f.patch(id, { criteria: f.view().document.nodes.find(node => node.id === id)!.criteria.map(criterion => criterion.id === "manual" ? { ...criterion, text: "报告明确说明依据及其适用范围" } : criterion) });
    const change = f.view().document.changes.at(-1)!;
    await f.handle(item.id, "adopt", { change_id: change.id });
    const run = await f.execute(id); f.approve(run);
    await f.handle(item.id, "submit", { run_id: run.id });
    await f.handle(item.id, "resolve");
    expect(f.view().document.feedbacks![0]).toMatchObject({ status: "resolved", adopted_change_id: change.id });
  });

  it("preserves acceptance after a presentation edit but rejects late results after a contract change", async () => {
    const f = await fixture(), id = f.create("报告"), run = await f.execute(id); f.approve(run);
    const key = run.snapshot.contract_key;
    const renamed = f.patch(id, { title: "成果报告" });
    expect(renamed.derived[id].status).toBe("accepted");
    expect(currentEngineeringRun(renamed.document, id)?.snapshot.contract_key).toBe(key);
    const item = await f.feedback(id); await f.handle(item.id, "adopt");
    const repair = await f.execute(id); await f.handle(item.id, "submit", { run_id: repair.id });
    f.patch(id, { objective: "改变交付目标，不能沿用刚才结果" });
    await f.handle(item.id, "resolve", {}, 409);
    expect(() => f.approve(repair)).toThrow();
  });

  it("allows scoped Agent feedback but reserves adoption and acceptance for the supervisor", async () => {
    const f = await fixture(), owned = f.create("已分配报告"), other = f.create("另一份报告");
    // Test-only lifecycle receipt in an isolated temporary workspace.
    receiveCompanionHook(f.root, f.service.runtime, f.events, { session_id: "isolated-worker", cwd: f.root, hook_event_name: "SessionStart" });
    f.patch(owned, { owner: "codex:isolated-worker" });
    const headers = { "x-engineering-agent-session-id": "isolated-worker", "x-engineering-cwd": encodeURIComponent(f.root) };
    const submit = (nodeId: string, status: number) => f.request("POST", "/feedback-items", { expected_revision: f.view().document.revision,
      base_node_revision: f.view().document.nodes.find(node => node.id === nodeId)!.revision, target: { kind: "node", node_id: nodeId }, kind: "defect", note: "发现本项问题" }, status, headers);
    const next = await submit(owned, 201) as EngineeringView;
    await submit(other, 403);
    await f.request("POST", `/feedback-items/${next.document.feedbacks![0].id}/update`, { expected_revision: f.view().document.revision, action: "adopt", note: "Agent不能自批" }, 403, headers);
    expect(f.view().document.feedbacks![0].status).toBe("open");
  });

  it("closes a display-only correction by reviewing the saved change without creating another run", async () => {
    const f = await fixture(), id = f.create("难懂标题"), run = await f.execute(id); f.approve(run);
    const item = await f.feedback(id, "requirement_change", { kind: "node", node_id: id });
    f.patch(id, { title: "交付报告" });
    await f.handle(item.id, "adopt", { change_id: f.view().document.changes.at(-1)!.id });
    expect(f.view().document.feedbacks![0].resolution_kind).toBe("plan");
    await f.handle(item.id, "submit");
    await f.handle(item.id, "resolve");
    expect(f.view().document.feedbacks![0].status).toBe("resolved");
    expect(f.view().document.runs).toHaveLength(1);
    expect(currentEngineeringRun(f.view().document, id)?.id).toBe(run.id);
    expect(f.view().derived[id].status).toBe("accepted");
  });

  it("keeps distinct manual checks and refuses a parent when the integration condition fails", async () => {
    const f = await fixture(), id = f.create("子成果");
    f.patch(id, { contribution: { summary: "交付父项目需要的报告" } });
    f.patch("engineering-project", {
      criteria: [{ id: "project-outcome", text: "子成果齐全", kind: "manual", path: "", expected: "" }, { id: "integration", text: "组合后的完整使用过程有效", kind: "manual", path: "", expected: "" }],
      composition: { summary: "子成果提供报告，本级核对完整使用结果", integration_criterion_ids: ["integration"], scenario: "从打开报告到找到依据完成核对" }
    });
    const child = await f.execute(id); f.approve(child);
    const rootRun = await f.execute("engineering-project");
    expect(rootRun.status).toBe("review");
    await f.request("POST", `/runs/${rootRun.id}/review`, { verdict: "accepted", note: "不能整体通过",
      checks: [{ criterion_id: "project-outcome", passed: true, note: "子成果已齐全" }, { criterion_id: "integration", passed: false, note: "整合场景仍失败" }] }, 409);
    await f.request("POST", `/runs/${rootRun.id}/review`, { verdict: "needs_revision", note: "退回本级整合",
      checks: [{ criterion_id: "integration", passed: false, note: "找不到对应依据" }] });
    expect(f.view().derived["engineering-project"].status).toBe("needs_revision");
    expect(f.view().derived[id].status).toBe("accepted");
    expect(f.view().document.runs.find(run => run.id === rootRun.id)!.evidence.filter(item => item.kind === "human")).toEqual([expect.objectContaining({ criterion_id: "integration", passed: false, summary: "找不到对应依据" })]);
  });
});
