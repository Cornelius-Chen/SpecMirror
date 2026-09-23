import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { currentEngineeringRun, engineeringFeedbackScopeState, type EngineeringFeedback, type EngineeringNode, type EngineeringRun, type EngineeringView } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering } from "@epm/spec-io";
import { receiveCompanionHook } from "./codex-companion.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { EventBus } from "./events.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";

const fixtures: Array<{ root: string; close: () => Promise<void> }> = [];
let isolatedApproval = 0;
const isolatedHumanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
  kind: "authenticated_human_approval", principalId: "isolated-feedback-scope-test-owner",
  approvalId: `feedback-scope-test-approval-${++isolatedApproval}`,
  requestDigest: requirement.requestDigest, expiresAt: Date.now() + 60_000
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-feedback-scope-fixture-")), doc = loadEngineering(root);
  for (const node of doc.nodes) delete node.delivery;
  atomicWriteYaml(engineeringDocumentPath(root), doc);
  const app = Fastify(), events = new EventBus();
  registerHumanApprovalGuard(app, isolatedHumanApproval);
  const service = registerEngineeringRoutes(app, root, events);
  fixtures.push({ root, close: () => app.close() }); await app.ready();
  const view = () => service.view(), projectId = view().document.root_id;
  const patch = (id: string, change: Partial<EngineeringNode>) => {
    const current = view(), node = { ...current.document.nodes.find(item => item.id === id)!, ...change };
    const input = { node, expected_revision: current.document.revision, reason: "隔离范围反馈测试" };
    service.preview(id, input); return service.updateNode(id, input);
  };
  const createNode = (title: string, parent_id = projectId) => {
    const next = service.createNode({ parent_id, title, expected_revision: view().document.revision });
    return next.document.nodes.find(item => item.title === title)!.id;
  };
  const first = createNode("因子生成"), second = createNode("因子评估"), outside = createNode("组合回测");
  const payload = (ids = [first, second], targetId = projectId) => ({ expected_revision: view().document.revision,
    base_node_revision: view().document.nodes.find(item => item.id === targetId)!.revision,
    target: { kind: "node", node_id: targetId }, scope_node_ids: ids, kind: "requirement_change", note: "这两块职责重复，请重新划分" });
  const request = async (path: string, body: object, status = 200, headers?: Record<string, string>) => {
    const result = await app.inject({ method: "POST", url: "/api/engineering" + path, payload: body, headers });
    expect(result.statusCode, result.body).toBe(status); return result.json();
  };
  const create = async () => (await request("/feedback-items", payload(), 201) as EngineeringView).document.feedbacks!.at(-1)!;
  const handle = (id: string, action: string, extra = {}, status = 200, headers?: Record<string, string>) => request(`/feedback-items/${id}/update`, {
    expected_revision: view().document.revision, action, note: "隔离测试逐项核对", ...extra
  }, status, headers);
  const displayFix = async (child: EngineeringFeedback, title: string) => {
    patch(child.target.node_id, { title });
    await handle(child.id, "adopt", { change_id: view().document.changes.at(-1)!.id });
    await handle(child.id, "submit"); await handle(child.id, "resolve");
  };
  return { root, app, events, service, view, projectId, first, second, outside, patch, createNode, payload, request, create, handle, displayFix };
}

afterEach(async () => {
  for (const item of fixtures.splice(0).reverse()) {
    await item.close();
    const absolute = resolve(item.root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes("mirror-feedback-scope-fixture-")) throw new Error("unsafe_fixture_cleanup");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("atomic range feedback with independent member evidence", () => {
  it("saves exact selection and per-member bases atomically without engineering nodes or execution changes", async () => {
    const f = await fixture(), before = f.view(), group = await f.create(), next = f.view();
    expect(next.document.revision).toBe(before.document.revision + 1);
    expect(next.document.nodes).toEqual(before.document.nodes);
    expect(next.document.runs).toEqual(before.document.runs);
    expect(group).toMatchObject({ target: { kind: "node", node_id: f.projectId }, status: "open", scope_node_ids: [f.first, f.second] });
    expect(next.document.feedbacks).toHaveLength(3);
    expect(group.scope_snapshot!.map(item => item.title)).toEqual(["因子生成", "因子评估"]);
    expect(group.history[0].basis!.scope_snapshot).toEqual(group.scope_snapshot);
    expect(group.scope_feedback_ids!.map(id => next.document.feedbacks!.find(item => item.id === id))).toEqual(group.scope_snapshot!.map(snapshot => expect.objectContaining({
      target: { kind: "node", node_id: snapshot.node_id }, scope_group_id: group.id, note: group.note,
      base_node_revision: snapshot.node_revision, base_contract_key: snapshot.contract_key, target_snapshot: snapshot.target_snapshot, status: "open"
    })));
    expect(loadEngineering(f.root).feedbacks).toEqual(next.document.feedbacks);
    expect(f.service.history(f.first).feedbacks.map(item => item.id)).toEqual([group.scope_feedback_ids![0], group.id]);
    expect(engineeringFeedbackScopeState(next.document, group)).toBe("active");
  });

  it("rejects stale, duplicated, foreign, archived and non-node scopes with no partial member records", async () => {
    const f = await fixture(), stale = f.payload();
    f.patch(f.first, { title: "新的因子生成" });
    await f.request("/feedback-items", stale, 409);
    await f.request("/feedback-items", f.payload([f.first, f.first]), 400);
    await f.request("/feedback-items", f.payload([f.first, "missing"]), 400);
    await f.request("/feedback-items", f.payload([f.first, f.second], f.first), 400);
    await f.request("/feedback-items", { ...f.payload(), target: { kind: "criterion", node_id: f.projectId, id: "project-outcome" } }, 400);
    f.service.archive(f.second, { expected_revision: f.view().document.revision, reason: "隔离测试归档范围成员" });
    await f.request("/feedback-items", f.payload(), 400);
    expect(f.view().document.feedbacks ?? []).toHaveLength(0);
  });

  it("checks Agent ownership of both the common target and every member and disallows lifecycle self-approval", async () => {
    const f = await fixture();
    receiveCompanionHook(f.root, f.service.runtime, f.events, { session_id: "scope-worker", cwd: f.root, hook_event_name: "SessionStart" });
    const headers = { "x-engineering-agent-session-id": "scope-worker", "x-engineering-cwd": encodeURIComponent(f.root) };
    f.patch(f.first, { owner: "codex:scope-worker" }); f.patch(f.second, { owner: "codex:scope-worker" });
    await f.request("/feedback-items", f.payload(), 403, headers);
    f.patch(f.projectId, { owner: "codex:scope-worker" });
    // An unassigned descendant now inherits the zone owner. Use an explicit
    // second owner to keep this a real cross-boundary rejection case.
    f.patch(f.outside, { owner: "codex:other-worker" });
    await f.request("/feedback-items", f.payload([f.first, f.outside]), 403, headers);
    const next = await f.request("/feedback-items", f.payload(), 201, headers) as EngineeringView, group = next.document.feedbacks!.at(-1)!;
    await f.handle(group.scope_feedback_ids![0], "dismiss", {}, 403, headers);
    expect(f.view().document.feedbacks).toHaveLength(3);
  });

  it("closes a range only after all member corrections independently pass the original plan gates", async () => {
    const f = await fixture(), group = await f.create();
    const children = group.scope_feedback_ids!.map(id => f.view().document.feedbacks!.find(item => item.id === id)!);
    for (const action of ["adopt", "working", "submit", "resolve", "dismiss", "reopen"]) {
      expect(await f.handle(group.id, action, {}, 409)).toMatchObject({ code: "engineering_feedback_scope_review_required" });
    }
    await f.handle(children[0].id, "resolve", {}, 409);
    await f.displayFix(children[0], "候选因子");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("open");
    await f.displayFix(children[1], "有效性评估");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("resolved");
    expect(f.view().document.feedbacks!.find(item => item.id === children[0].id)!.history.at(-1)!.basis!.target_snapshot).toContain("候选因子");
    expect(f.view().document.runs).toHaveLength(0);
    expect(f.view().derived[f.projectId].status).not.toBe("accepted");
    const storedRevision = loadEngineering(f.root).revision;
    f.patch(f.first, { title: "验收后再次调整的名称" });
    const documentAfterChange = loadEngineering(f.root);
    expect(documentAfterChange.revision).toBe(storedRevision + 1);
    expect(documentAfterChange.feedbacks!.find(item => item.id === group.id)!.status).toBe("resolved");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("open");
    expect(f.service.history(f.first).feedbacks.find(item => item.id === group.id)!.status).toBe("open");
    expect(loadEngineering(f.root)).toEqual(documentAfterChange);
  });

  it("preserves original scope history when a member reopens and derives mixed resolution without duplicate approval", async () => {
    const f = await fixture(), group = await f.create(), ids = group.scope_feedback_ids!;
    await f.handle(ids[0], "dismiss"); await f.handle(ids[1], "dismiss");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("dismissed");
    f.patch(f.first, { title: "更明确的因子生成" }); await f.handle(ids[0], "reopen");
    const next = f.view().document, child = next.feedbacks!.find(item => item.id === ids[0])!;
    expect(next.feedbacks!.find(item => item.id === group.id)).toMatchObject({ status: "open", scope_snapshot: group.scope_snapshot });
    expect(child.history[0].basis!.target_snapshot).toContain("因子生成");
    expect(child.history.at(-1)!.basis!.target_snapshot).toContain("更明确的因子生成");
    await f.displayFix(child, "生成候选因子");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("resolved");
  });

  it("requires fresh accepted deliveries for every member and rechecks earlier artifacts before closing the group", async () => {
    const f = await fixture();
    for (const id of [f.first, f.second]) f.patch(id, {
      objective: "形成可用的因子报告", contributes_to: ["project-outcome"],
      criteria: [{ id: "file", text: "报告包含实际成果", kind: "file_contains", path: "artifacts/report.txt", expected: "delivered" },
        { id: "manual", text: "报告满足本节点用途", kind: "manual", path: "", expected: "" }],
      actions: [{ id: "write", title: "形成报告", type: "write_file", path: "artifacts/report.txt", content: "delivered", criterion_id: "file", capability_id: "" }]
    });
    const execute = async (id: string) => {
      f.service.ready(id, f.view().document.revision);
      f.service.dispatch({ node_ids: [id], mode: "controlled", expected_revision: f.view().document.revision });
      await f.service.settled(); return currentEngineeringRun(f.view().document, id)!;
    };
    const approve = (run: EngineeringRun) => f.service.review(run.id, { verdict: "accepted", note: "隔离测试人工角色逐项核对", checks: [{ criterion_id: "manual", passed: true, note: "此节点成果已对应检查" }] });
    const originalFirst = await execute(f.first); approve(originalFirst);
    const originalSecond = await execute(f.second); approve(originalSecond);
    const created = await f.request("/feedback-items", { ...f.payload(), kind: "defect" }, 201) as EngineeringView;
    const group = created.document.feedbacks!.at(-1)!, [firstId, secondId] = group.scope_feedback_ids!;
    await f.handle(firstId, "adopt"); await f.handle(firstId, "submit", { run_id: originalFirst.id }, 409);
    const repairedFirst = await execute(f.first); await f.handle(firstId, "submit", { run_id: repairedFirst.id });
    await f.handle(firstId, "resolve", {}, 409); approve(repairedFirst); await f.handle(firstId, "resolve");
    await f.handle(secondId, "adopt");
    const repairedSecond = await execute(f.second); approve(repairedSecond); await f.handle(secondId, "submit", { run_id: repairedSecond.id });
    writeFileSync(join(repairedFirst.output_dir, "artifacts/report.txt"), "changed after its independent review");
    await f.handle(secondId, "resolve", {}, 409);
    expect(f.view().document.feedbacks!.find(item => item.id === secondId)!.status).toBe("review");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).not.toBe("resolved");
    writeFileSync(join(repairedFirst.output_dir, "artifacts/report.txt"), "delivered");
    await f.handle(secondId, "resolve");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("resolved");
    expect(f.view().derived[f.projectId].status).not.toBe("accepted");
  });

  it("does not reuse an obsolete closed member or submit against an archived scope", async () => {
    const f = await fixture(), group = await f.create(), children = group.scope_feedback_ids!.map(id => f.view().document.feedbacks!.find(item => item.id === id)!);
    await f.displayFix(children[0], "候选因子");
    f.patch(f.first, { title: "后来再次变化的范围" });
    await f.displayFix(children[1], "有效性评估");
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.status).toBe("open");
    expect(engineeringFeedbackScopeState(f.view().document, group)).toBe("changed");
    f.service.archive(f.first, { expected_revision: f.view().document.revision, reason: "隔离测试归档范围成员" });
    expect(engineeringFeedbackScopeState(f.view().document, group)).toBe("missing");
    expect(await f.handle(children[1].id, "reopen", {}, 409)).toMatchObject({ code: "engineering_feedback_scope_invalid" });
    expect(f.view().document.feedbacks!.find(item => item.id === group.id)!.scope_snapshot).toEqual(group.scope_snapshot);
  });
});
