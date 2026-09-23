import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringNode, EngineeringRun, EngineeringSourceScope } from "@epm/domain";
import { RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";

const cleanup: Array<{ root: string; app: FastifyInstance; runtime: RuntimeStore }> = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-source-execution-"));
  const paths = { a: join(root, "source-a"), b: join(root, "source-b"), other: join(root, "not-approved") };
  for (const directory of Object.values(paths)) { mkdirSync(join(directory, "src"), { recursive: true }); writeFileSync(join(directory, "src/one.txt"), "initial"); }
  const sourcePath = (id: string) => id === "b" ? paths.b : paths.a;
  const runtime = new RuntimeStore(root), app = Fastify(), events = new EventBus(), companion = new WorkspaceCompanion(root, runtime, events, { readonlyLegacy: true });
  let approval = 0;
  const humanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
    kind: "authenticated_human_approval", principalId: "isolated-source-execution-test-owner",
    approvalId: "source-execution-approval-" + ++approval, requestDigest: requirement.requestDigest, expiresAt: Date.now() + 60_000
  });
  const source = async (id: string) => ({ id, title: "实际源目录任务 " + id, cwd: sourcePath(id), version: "v1", preview: "按冻结边界修改实际代码并核对", updatedAt: 1, pinned: false, received: false, receivedAt: null });
  const workspaces = new TaskWorkspaces(root, events, { source }, { sessions: record => companion.sessions(record), hostSourceRoots: [paths.a, paths.b] });
  registerHumanApprovalGuard(app, humanApproval);
  registerEngineeringRoutes(app, root, events, undefined, workspaces); await app.ready(); cleanup.push({ root, app, runtime });
  const call = async (scope: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown, expected = 200, sid?: string) => {
    const response = await app.inject({ method, url: "/api/engineering" + path, headers: { "x-mirror-workspace-id": scope, ...(sid ? { "x-engineering-agent-session-id": sid, "x-engineering-cwd": encodeURIComponent(sourcePath(sid)) } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    expect(response.statusCode, response.body).toBe(expected); return response;
  };
  const connect = async (id: string) => {
    const w = await workspaces.connect({ thread_id: id, source_version: "v1", mode: "create" });
    // Hook observations exist only in this temporary fixture, not the production account.
    companion.receiveHook({ session_id: id, cwd: sourcePath(id), hook_event_name: "SessionStart" }); return w;
  };
  const view = (id: string) => workspaces.resolve(id).service.view();
  const scope = (directory: string): EngineeringSourceScope => ({ root: directory, allow: ["src/**"], deny: ["src/protected/**"], checks: [{ id: "actual", title: "实际文件应包含交付内容", program: "node", args: ["-e", "require('node:assert').match(require('node:fs').readFileSync('src/one.txt','utf8'),/delivered/)"] }] });
  const configure = async (id: string, sid: string, spec = scope(sourcePath(sid)), readyStatus = 200) => {
    const document = view(id).document, node: EngineeringNode = { ...document.nodes[0], owner: "codex:" + sid, objective: "修改真实源文件并留下检查证据", method: "领取后修改允许范围内的文件，提交时实际运行冻结检查",
      source_scope: spec, actions: [], criteria: [{ id: "goal", kind: "manual", text: "工程结果符合目标", path: "", expected: "" }],
      delivery: { included: ["本项源文件功能"], excluded: ["其他源项目和范围外功能"], outputs: [{ id: "result", title: "已实现的功能", criterion_ids: ["goal"] }], inputs: [] } };
    const input = { node, expected_revision: document.revision, reason: "明确源目录、修改范围和真实检查" };
    await call(id, "POST", "/nodes/engineering-project/preview", input); await call(id, "PUT", "/nodes/engineering-project", input);
    return call(id, "POST", "/nodes/engineering-project/ready", { expected_revision: view(id).document.revision }, readyStatus);
  };
  const dispatch = async (id: string, sid?: string) => { await call(id, "POST", "/dispatch", { node_ids: ["engineering-project"], mode: "external" }, 202, sid); await workspaces.settled(); return view(id).document.runs.at(-1)!; };
  const claim = async (id: string, runId: string, sid: string) => { const packet = (await call(id, "GET", `/runs/${runId}/handoff`)).json(); await call(id, "POST", `/runs/${runId}/claim`, { contract_key: packet.contract_key }, 200, sid); await workspaces.settled(); };
  const review = (id: string, runId: string, verdict = "accepted", expected = 200) => call(id, "POST", `/runs/${runId}/review`, { verdict, note: "监督者核对真实源文件和实际检查", checks: [{ criterion_id: "goal", passed: true, note: "已核对工程结果" }] }, expected);
  return { root, paths, app, runtime, workspaces, call, connect, view, scope, configure, dispatch, claim, review };
}
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) { await f.app.close(); f.runtime.close(); const root = resolve(f.root); if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_cleanup"); rmSync(root, { recursive: true, force: true }); } });

describe("source contracts join real external execution and human acceptance", () => {
  it("permits only approved source roots and external leaf execution", async () => {
    const f = await fixture(), a = await f.connect("a");
    const refused = await f.configure(a.id, "a", f.scope(f.paths.b), 400);
    expect(refused.json().error).toContain("明确授权");
    await f.configure(a.id, "a");
    const controlled = await f.call(a.id, "POST", "/dispatch", { node_ids: ["engineering-project"], mode: "controlled" }, 409);
    expect(controlled.json().code).toBe("engineering_source_external_required");
    await f.configure("host", "a", f.scope(f.paths.other), 400);
    await f.configure("host", "a", f.scope(f.paths.b));
    expect(f.view("host").document.nodes[0].status).toBe("ready");
  });

  it("captures the baseline after real claim, distinguishes preexisting dirty files, and verifies actual source changes", async () => {
    const f = await fixture(), a = await f.connect("a");
    const git = (...args: string[]) => execFileSync("git", ["-C", f.paths.a, ...args], { stdio: "pipe", windowsHide: true });
    git("init"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture baseline");
    writeFileSync(join(f.paths.a, "src/one.txt"), "already changed before dispatch");
    await f.configure(a.id, "a"); const pending = await f.dispatch(a.id);
    expect(pending.source_scope?.contract_sha256).toMatch(/^[a-f0-9]{64}$/); expect(pending.source_baseline).toBeUndefined();
    writeFileSync(join(f.paths.a, "src/one.txt"), "changed while still awaiting claim");
    await f.claim(a.id, pending.id, "a");
    const started = f.view(a.id).document.runs.at(-1)!;
    expect(started.status).toBe("running"); expect(started.source_baseline?.git.preexisting_changes).toContainEqual(expect.objectContaining({ path: "src/one.txt" }));
    writeFileSync(join(f.paths.a, "src/one.txt"), "delivered actual implementation");
    await f.call(a.id, "POST", `/runs/${pending.id}/finish`, {}, 403);
    await f.call(a.id, "POST", `/runs/${pending.id}/finish`, {}, 200, "a");
    const run = f.view(a.id).document.runs.at(-1)!;
    expect(run).toMatchObject({ status: "review", source_proof: { passed: true, status: "passed", changes: [{ path: "src/one.txt", kind: "modified", allowed: true }], checks: [{ status: "passed", exit_code: 0 }] } });
    expect(run.source_proof?.preexisting_changes).toEqual(started.source_baseline?.git.preexisting_changes);
    expect(run.source_proof?.changes[0].before_sha256).toBe(started.source_baseline?.manifest.find(file => file.path === "src/one.txt")?.sha256);
    expect(f.workspaces.resolve(a.id).service.runtime.listLocks().some(lock => lock.owner === run.id)).toBe(true);
    await f.review(a.id, run.id); expect(f.view(a.id).document.runs.at(-1)?.status).toBe("accepted");
    expect(f.workspaces.resolve(a.id).service.runtime.listLocks().some(lock => lock.owner === run.id)).toBe(false);
  });

  it.each(["outside", "check"] as const)("blocks %s failures using server-observed evidence", async kind => {
    const f = await fixture(), a = await f.connect("a"); await f.configure(a.id, "a"); const run = await f.dispatch(a.id, "a");
    if (kind === "outside") { writeFileSync(join(f.paths.a, "src/one.txt"), "delivered"); writeFileSync(join(f.paths.a, "not-allowed.txt"), "unexpected modification"); }
    await f.call(a.id, "POST", `/runs/${run.id}/finish`, { passed: true, status: "accepted" }, 200, "a");
    const failed = f.view(a.id).document.runs.at(-1)!;
    expect(failed).toMatchObject({ status: "blocked", source_proof: { passed: false, status: "failed" } });
    if (kind === "outside") expect(failed.source_proof).toMatchObject({ changes: expect.arrayContaining([expect.objectContaining({ path: "not-allowed.txt", allowed: false })]), checks: [{ status: "not_run" }] });
    else expect(failed.source_proof?.checks[0]).toMatchObject({ status: "failed", exit_code: 1 });
    await f.review(a.id, run.id, "accepted", 409);
  });

  it("holds overlapping source roots through review while allowing independent roots to run", async () => {
    const f = await fixture(), a = await f.connect("a"), sibling = await f.connect("same-source"), independent = await f.connect("b");
    for (const [w, sid] of [[a, "a"], [sibling, "same-source"], [independent, "b"]] as const) await f.configure(w.id, sid);
    const first = await f.dispatch(a.id, "a"), second = await f.dispatch(sibling.id, "same-source"), third = await f.dispatch(independent.id, "b");
    expect(first.status).toBe("running"); expect(second.status).toBe("queued"); expect(third.status).toBe("running");
    expect(second.source_baseline).toBeUndefined();
    writeFileSync(join(f.paths.a, "src/one.txt"), "delivered first task"); await f.call(a.id, "POST", `/runs/${first.id}/finish`, {}, 200, "a"); await f.workspaces.settled();
    expect(f.view(sibling.id).document.runs.at(-1)?.status).toBe("queued");
    expect(f.view(sibling.id).derived["engineering-project"].blockers.join(" ")).toContain("人工验收");
    await f.review(a.id, first.id); await f.workspaces.settled();
    const nowRunning = f.view(sibling.id).document.runs.at(-1)!; expect(nowRunning.status).toBe("running");
    expect(nowRunning.source_baseline?.manifest_sha256).toBe(f.view(a.id).document.runs.at(-1)?.source_proof?.final_manifest_sha256);
  });

  it("refuses acceptance after source files changed since the actual check", async () => {
    const f = await fixture(), a = await f.connect("a"); await f.configure(a.id, "a"); const run = await f.dispatch(a.id, "a");
    writeFileSync(join(f.paths.a, "src/one.txt"), "delivered"); await f.call(a.id, "POST", `/runs/${run.id}/finish`, {}, 200, "a");
    writeFileSync(join(f.paths.a, "src/one.txt"), "changed after check");
    const refused = await f.review(a.id, run.id, "accepted", 409); expect(refused.json().code).toBe("engineering_source_changed_after_check");
    expect(f.view(a.id).document.runs.at(-1)?.status).toBe("review");
    await f.review(a.id, run.id, "needs_revision");
    expect(readFileSync(join(f.paths.a, "src/one.txt"), "utf8")).toBe("changed after check");
  });

  it("refuses to close feedback when source files change after the replacement result was accepted", async () => {
    const f = await fixture(), a = await f.connect("a"); await f.configure(a.id, "a");
    const original = await f.dispatch(a.id, "a");
    writeFileSync(join(f.paths.a, "src/one.txt"), "delivered original");
    await f.call(a.id, "POST", `/runs/${original.id}/finish`, {}, 200, "a"); await f.review(a.id, original.id);
    const service = f.workspaces.resolve(a.id).service, current = service.view();
    service.createFeedback({ expected_revision: current.document.revision, base_node_revision: current.document.nodes[0].revision,
      target: { kind: "criterion", node_id: "engineering-project", id: "goal" }, kind: "defect", note: "隔离案例：原结果需修复" });
    const feedbackId = service.view().document.feedbacks!.at(-1)!.id;
    service.updateFeedback(feedbackId, { expected_revision: service.view().document.revision, action: "adopt", note: "按原标准修复" });
    service.ready("engineering-project", service.view().document.revision);
    const replacement = await f.dispatch(a.id, "a");
    writeFileSync(join(f.paths.a, "src/one.txt"), "delivered corrected result");
    await f.call(a.id, "POST", `/runs/${replacement.id}/finish`, {}, 200, "a"); await f.review(a.id, replacement.id);
    service.updateFeedback(feedbackId, { expected_revision: service.view().document.revision, action: "submit", run_id: replacement.id, note: "关联重新交付" });
    writeFileSync(join(f.paths.a, "src/one.txt"), "changed after acceptance");
    const refused = await f.call(a.id, "POST", `/feedback-items/${feedbackId}/update`, { expected_revision: service.view().document.revision, action: "resolve", note: "尝试关闭" }, 409);
    expect(refused.json().code).toBe("engineering_source_changed_after_check");
    expect(service.view().document.feedbacks![0].status).toBe("review");
  });

  it("does not let pause or duplicate submissions race asynchronous source verification into acceptance", async () => {
    const f = await fixture(), a = await f.connect("a"), spec = f.scope(f.paths.a);
    spec.checks = [{ id: "slow", title: "等待以检查并发边界", program: "node", args: ["-e", "setTimeout(()=>{},300)"], timeout_ms: 5000 }];
    await f.configure(a.id, "a", spec); const run = await f.dispatch(a.id, "a");
    const finishing = f.call(a.id, "POST", `/runs/${run.id}/finish`, {}, 409, "a");
    while (!f.view(a.id).document.runs.at(-1)?.current_action) await new Promise(resolve => setImmediate(resolve));
    const duplicate = await f.call(a.id, "POST", `/runs/${run.id}/finish`, {}, 409, "a"); expect(duplicate.json().code).toBe("engineering_action_busy");
    expect(f.view(a.id).document.runs.at(-1)?.status).toBe("running");
    await f.call(a.id, "POST", "/nodes/engineering-project/pause", { reason: "核验中暂停" });
    await finishing; expect(f.view(a.id).document.runs.at(-1)?.status).toBe("paused");
    expect(f.view(a.id).document.runs.at(-1)?.source_proof).toBeUndefined();
  });

  it("releases a review run's source lock when the human prepares a new run", async () => {
    const f = await fixture(), a = await f.connect("a"); await f.configure(a.id, "a"); const first = await f.dispatch(a.id, "a");
    writeFileSync(join(f.paths.a, "src/one.txt"), "delivered"); await f.call(a.id, "POST", `/runs/${first.id}/finish`, {}, 200, "a");
    await f.call(a.id, "POST", "/nodes/engineering-project/ready", { expected_revision: f.view(a.id).document.revision });
    const second = await f.dispatch(a.id, "a");
    expect(second.status).toBe("running"); expect(second.id).not.toBe(first.id);
    expect(f.view(a.id).document.runs.find(run => run.id === first.id)?.status).toBe("stale");
    expect(f.workspaces.resolve(a.id).service.runtime.listLocks().some(lock => lock.owner === first.id)).toBe(false);
  });

  it.each(["pause", "close"] as const)("kills a real check before %s releases the source reservation", async action => {
    const f = await fixture(), a = await f.connect("a"), other = await f.connect("same-source"), spec = f.scope(f.paths.a);
    spec.checks = [{ id: "late-write", title: "验证取消后不会迟写", program: "node", args: ["-e", "const fs=require('node:fs');fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/started.txt','started');setTimeout(()=>fs.writeFileSync('src/late.txt','must not appear'),1000)"], timeout_ms: 5000 }];
    await f.configure(a.id, "a", spec); await f.configure(other.id, "same-source");
    const first = await f.dispatch(a.id, "a"), waiting = await f.dispatch(other.id, "same-source"); expect(waiting.status).toBe("queued");
    const finishing = f.call(a.id, "POST", `/runs/${first.id}/finish`, {}, action === "close" ? 503 : 409, "a");
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.paths.a, "artifacts/started.txt")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(join(f.paths.a, "artifacts/started.txt"))).toBe(true);
    if (action === "pause") {
      await f.call(a.id, "POST", "/nodes/engineering-project/pause", { reason: "停止实际检查" });
      expect(f.workspaces.resolve(a.id).service.runtime.listLocks().some(lock => lock.owner === first.id)).toBe(true);
      expect(f.workspaces.resolve(a.id).service.sourceReservations()).toContainEqual(expect.objectContaining({ runId: first.id, stopping: true }));
      expect(f.workspaces.scheduler.stats().active).toBe(1);
    } else await f.workspaces.resolve(a.id).service.close();
    await finishing; await f.workspaces.settled();
    expect(f.view(other.id).document.runs.at(-1)?.status).toBe("running");
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(existsSync(join(f.paths.a, "src/late.txt"))).toBe(false);
  });

  it.each(["valid", "changed_after", "regression"] as const)("rechecks sequential source tasks as one final integration: %s", async scenario => {
    const f = await fixture(), workspace = await f.connect("a"), service = f.workspaces.resolve(workspace.id).service;
    const document = service.view().document, parent = { ...document.nodes[0], objective: "两项功能组合后仍可使用", criteria: [{ id: "goal", text: "组合目标完整满足", kind: "manual" as const, path: "", expected: "" }],
      composition: { summary: "两项功能共同组成完整产品，父级复查最终源目录中的组合", scenario: "依次交付两项功能后，在同一最终源目录重新检查两项功能", integration_criterion_ids: ["goal"] },
      delivery: { included: ["两项功能的可用组合"], excluded: ["其他产品功能"], outputs: [{ id: "result", title: "组合功能", criterion_ids: ["goal"] }], inputs: [] } };
    const parentInput = { node: parent, expected_revision: document.revision, reason: "完整组合验收目标" };
    service.preview(parent.id, parentInput); service.updateNode(parent.id, parentInput);
    const children = [];
    for (const name of ["first", "second"]) {
      const child = service.createNode({ parent_id: parent.id, title: name, expected_revision: service.view().document.revision }).document.nodes.at(-1)!;
      children.push(child);
    }
    for (const [index, child] of children.entries()) {
      const spec = f.scope(f.paths.a), path = index === 0 ? "src/one.txt" : "src/two.txt", feature = index === 0 ? "feature-a" : "feature-b";
      spec.checks = [{ id: "feature", title: "实际验证 " + feature, program: "node", args: ["-e", `require('node:assert').match(require('node:fs').readFileSync('${path}','utf8'),/${feature}/)`] }];
      const node: EngineeringNode = { ...child, owner: "codex:a", objective: "实际实现 " + feature, method: "按范围修改源文件后提交检查", source_scope: spec, dependencies: index ? [children[0].id] : [], contributes_to: ["goal"], criteria: [{ id: "goal", text: "本项功能符合目标", kind: "manual", path: "", expected: "" }],
        contribution: { summary: "为整体产品提供经过检查的 " + feature },
        delivery: { included: [feature], excluded: ["其他功能"], outputs: [{ id: "result", title: feature, criterion_ids: ["goal"] }], inputs: index ? [{ id: "prior", title: "已交付的前置功能", source_node_id: children[0].id, source_output_id: "result", external_source: "" }] : [] } };
      const input = { node, expected_revision: service.view().document.revision, reason: "冻结分项实现与检查" };
      service.preview(child.id, input); service.updateNode(child.id, input);
    }
    const accepted: EngineeringRun[] = [];
    for (const [index, child] of children.entries()) {
      service.ready(child.id, service.view().document.revision);
      await f.call(workspace.id, "POST", "/dispatch", { node_ids: [child.id], mode: "external" }, 202, "a"); await f.workspaces.settled();
      const run = service.view().document.runs.at(-1)!; expect(run.status).toBe("running");
      writeFileSync(join(f.paths.a, index ? "src/two.txt" : "src/one.txt"), index ? "feature-b" : "feature-a");
      if (index && scenario === "regression") writeFileSync(join(f.paths.a, "src/one.txt"), "broken earlier feature");
      await f.call(workspace.id, "POST", `/runs/${run.id}/finish`, {}, 200, "a");
      await f.review(workspace.id, run.id); accepted.push(service.view().document.runs.at(-1)!);
    }
    expect(accepted[0].source_proof?.final_manifest_sha256).not.toBe(accepted[1].source_proof?.final_manifest_sha256);
    if (scenario === "changed_after") writeFileSync(join(f.paths.a, "src/two.txt"), "modified without a checked source run");
    service.ready(parent.id, service.view().document.revision);
    await f.call(workspace.id, "POST", "/dispatch", { node_ids: [parent.id], mode: "controlled" }, 202); await f.workspaces.settled();
    const integrated = service.view().document.runs.at(-1)!;
    if (scenario === "valid") {
      expect(integrated.status).toBe("review");
      expect(integrated.source_integration_proofs).toHaveLength(1);
      expect(integrated.source_integration_proofs![0]).toMatchObject({ passed: true, changes: [], checks: [{ status: "passed", exit_code: 0 }, { status: "passed", exit_code: 0 }] });
      await f.review(workspace.id, integrated.id); expect(service.view().derived[parent.id].status).toBe("accepted");
    } else if (scenario === "changed_after") {
      expect(integrated.status).toBe("blocked"); expect(integrated.reason).toContain("最新有效检查后又有变化");
      expect(integrated.source_integration_proofs).toBeUndefined();
    } else {
      expect(integrated.status).toBe("blocked");
      expect(integrated.source_integration_proofs?.[0]).toMatchObject({ passed: false, checks: expect.arrayContaining([expect.objectContaining({ status: "failed", exit_code: 1 })]) });
    }
    expect(service.view().document.runs.find(run => run.id === accepted[0].id)?.status).toBe("accepted");
  }, 10_000);
});
