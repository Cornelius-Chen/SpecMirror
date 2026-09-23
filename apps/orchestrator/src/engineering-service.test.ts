import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringNode, EngineeringRun, EngineeringView } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering, readYaml, writeSupervision } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { receiveCompanionHook } from "./codex-companion.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { createEngineeringJervisBridge, type EngineeringJervisBridge } from "./engineering-jervis.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import type { EngineeringServiceOptions } from "./engineering-service.ts";

const fixtures: Array<{ root: string; app?: FastifyInstance }> = [];
async function fixture(setup?: (root: string) => void, bridgeFactory?: (root: string) => EngineeringJervisBridge, serviceOptions?: EngineeringServiceOptions) {
  const root = mkdtempSync(join(tmpdir(), "mirror-engineering-api-"));
  setup?.(root);
  // These existing execution cases intentionally cover compatibility with saved pre-delivery projects.
  const legacy = loadEngineering(root);
  for (const node of legacy.nodes) delete node.delivery;
  atomicWriteYaml(engineeringDocumentPath(root), legacy);
  const app = Fastify();
  fixtures.push({ root, app });
  const events = new EventBus();
  let approval = 0;
  const humanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
    kind: "authenticated_human_approval", principalId: "isolated-engineering-test-owner",
    approvalId: "engineering-approval-" + ++approval, requestDigest: requirement.requestDigest, expiresAt: Date.now() + 60_000
  });
  registerHumanApprovalGuard(app, humanApproval);
  const service = registerEngineeringRoutes(app, root, events, bridgeFactory?.(root), undefined, serviceOptions);
  // Isolated test-only Hook: legacy execution cases exercise an actual assigned caller.
  receiveCompanionHook(root, service.runtime, events, { session_id: "fixture-worker", cwd: root, hook_event_name: "SessionStart" });
  await app.ready();
  const view = async () => (await app.inject({ method: "GET", url: "/api/engineering" })).json<EngineeringView>();
  const call = async (method: "POST" | "PUT", url: string, payload: unknown, expected = 200, headers?: Record<string, string>) => {
    if (!headers && ((url === "/dispatch" && (payload as {mode?: string}).mode === "external") || /^\/runs\/[^/]+\/(actions\/|finish$)/.test(url))) headers = { "x-engineering-agent-session-id": "fixture-worker", "x-engineering-cwd": encodeURIComponent(root) };
    const response = await app.inject({ method, url: "/api/engineering" + url, payload: payload as object, headers });
    expect(response.statusCode, response.body).toBe(expected);
    return response;
  };
  const create = async (title: string, parentId = "engineering-project") => {
    const current = await view();
    const result = (await call("POST", "/nodes", { parent_id: parentId, title, expected_revision: current.document.revision }, 201)).json<EngineeringView>();
    return result.document.nodes.find((node) => node.title === title)!;
  };
  const update = async (id: string, patch: Partial<EngineeringNode>, headers?: Record<string, string>) => {
    const current = await view();
    const node = { ...current.document.nodes.find((item) => item.id === id)!, ...patch };
    const payload = { node, expected_revision: current.document.revision, reason: "测试中明确修订执行合同" };
    await call("POST", "/nodes/" + id + "/preview", payload, 200, headers);
    return (await call("PUT", "/nodes/" + id, payload, 200, headers)).json<EngineeringView>();
  };
  const configure = async (node: EngineeringNode, path: string, extra: Partial<EngineeringNode> = {}) => update(node.id, {
    owner: "codex:fixture-worker",
    objective: "生成可以实际核对的文件", method: "执行冻结动作并逐项检查",
    contributes_to: ["project-outcome"],
    criteria: [{ id: "file", text: "文件存在且包含交付结果", kind: "file_contains", path, expected: "delivered" }, { id: "manual", text: "人工核对结果符合目标", kind: "manual", path: "", expected: "" }],
    actions: [{ id: "write", title: "生成实际文件", type: "write_file", path, content: "delivered", criterion_id: "file", capability_id: "" }],
    ...extra
  });
  const ready = async (id: string) => call("POST", "/nodes/" + id + "/ready", { expected_revision: (await view()).document.revision });
  const runFor = async (id: string) => (await view()).document.runs.filter((run) => run.node_id === id).at(-1)!;
  const approve = async (run: EngineeringRun) => call("POST", "/runs/" + run.id + "/review", { verdict: "accepted", note: "逐项核对实际产物和任务目标", checks: run.snapshot.node.criteria.filter((item) => item.kind === "manual").map((item) => ({ criterion_id: item.id, passed: true, note: "已打开实际文件并核对本条要求" })) });
  return { root, app, service, events, view, call, create, update, configure, ready, runFor, approve };
}

afterEach(async () => {
  for (const item of fixtures.splice(0).reverse()) {
    await item.app?.close();
    const absolute = resolve(item.root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_test_cleanup");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("recursive engineering real API and execution", () => {
  it("records the assigned Codex task token window and finalizes it only at human review", async () => {
    let usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120, observed_at: "2026-09-11T10:00:00.000Z" };
    const f = await fixture(undefined, undefined, { usageObserver: { snapshot: () => ({ ...usage }) } });
    const node = await f.create("可量测的真实交付");
    await f.configure(node, "artifacts/measured.txt"); await f.ready(node.id);
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external", expected_revision: (await f.view()).document.revision }, 202);
    await f.service.settled();
    let run = await f.runFor(node.id);
    expect(run.metrics).toMatchObject({ state: "measuring", token_usage: { total_tokens: 0 } });
    usage = { input_tokens: 130, cached_input_tokens: 80, output_tokens: 25, reasoning_output_tokens: 8, total_tokens: 155, observed_at: "2026-09-11T10:01:00.000Z" };
    await f.call("POST", `/runs/${run.id}/actions/write`, {});
    await f.call("POST", `/runs/${run.id}/finish`, {});
    run = await f.runFor(node.id);
    expect(run.metrics).toMatchObject({ source: "codex_rollout", attribution: "assigned_task_window", state: "observed", token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 3, total_tokens: 35 } });
    usage = { input_tokens: 140, cached_input_tokens: 90, output_tokens: 30, reasoning_output_tokens: 9, total_tokens: 170, observed_at: "2026-09-11T10:02:00.000Z" };
    await f.approve(run);
    expect((await f.runFor(node.id)).metrics).toMatchObject({ state: "final", token_usage: { input_tokens: 40, cached_input_tokens: 30, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 50 } });
  });

  it("projects legacy tasks into an archived branch without rewriting their history or claiming acceptance", async () => {
    const f = await fixture((root) => writeSupervision(root, {
      schema_version: 1, id: "legacy-supervision", title: "历史分类监督", design_id: "legacy-design", version: "v1", updated_at: "2026-01-01T00:00:00.000Z",
      tasks: [{ id: "old-task", title: "旧任务", objective: "旧目标", status: "frozen", version: "t1", order: 0, dependencies: [] }],
      details: [{ id: "old-detail", task_id: "old-task", title: "旧功能分项", category: "function", intent: "旧设计", status: "accepted", version: "v1", acceptance: ["原验收"], prompt: { version: "p1", base: "", local: "", resources: [], allowed_changes: [], forbidden_changes: [] } }]
    }));
    const source = readFileSync(join(f.root, ".project", "supervision", "specmirror-m1.yaml"), "utf8");
    const view = await f.view();
    expect(view.document.nodes.filter((node) => node.status !== "archived")).toHaveLength(1);
    expect(view.document.nodes.find((node) => node.id === "legacy:old-detail")).toMatchObject({ status: "archived", legacy_ref: expect.stringContaining("old-detail") });
    expect(view.document.runs).toEqual([]);
    await f.create("当前工程任务");
    expect(readFileSync(join(f.root, ".project", "supervision", "specmirror-m1.yaml"), "utf8")).toBe(source);
    expect(existsSync(join(f.root, ".project", "engineering", "recursive", "history", "revision-1.yaml"))).toBe(true);
  });

  it("executes real immutable file actions, stores hashes, serves isolated artifacts, and requires human acceptance", async () => {
    const f = await fixture();
    const node = await f.create("真实交付");
    await f.configure(node, "artifacts/report.txt");
    await f.ready(node.id);
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "controlled" }, 202);
    await f.service.settled();
    const run = await f.runFor(node.id);
    expect(run).toMatchObject({ mode: "controlled", status: "review", actor: "human:isolated-engineering-test-owner", completed_action_ids: ["write"] });
    const bytes = readFileSync(join(run.output_dir, "artifacts", "report.txt"));
    expect(bytes.toString()).toBe("delivered");
    expect(run.evidence.find((item) => item.kind === "artifact")?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const artifact = await f.app.inject({ method: "GET", url: "/api/engineering/runs/" + run.id + "/artifact?path=artifacts%2Freport.txt" });
    expect(artifact.statusCode).toBe(200); expect(artifact.body).toBe("delivered"); expect(artifact.headers["content-security-policy"]).toContain("sandbox");
    await f.call("POST", "/runs/" + run.id + "/review", { verdict: "accepted", note: "缺少人工逐条确认", checks: [] }, 409);
    await f.approve(run);
    expect((await f.view()).derived[node.id].status).toBe("accepted");
    expect((await f.view()).derived["engineering-project"].status).not.toBe("accepted");
  });

  it("rejects ancestor scope widening before dispatch and refuses arbitrary action payloads", async () => {
    const f = await fixture();
    const node = await f.create("受限文件操作");
    await f.configure(node, "outside.txt", { constraints: { allow: ["**"], deny: [], rules: [], resources: [] } });
    const refused = await f.call("POST", "/nodes/" + node.id + "/ready", { expected_revision: (await f.view()).document.revision }, 409);
    expect(refused.json().code).toBe("engineering_scope_violation");
    expect(existsSync(join(f.root, "outside.txt"))).toBe(false);
    await f.configure(node, "artifacts/allowed.txt");
    await f.ready(node.id);
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external" }, 202);
    await f.service.settled();
    const run = await f.runFor(node.id);
    await f.call("POST", "/runs/" + run.id + "/actions/write", { path: "../outside.txt", content: "replaced" }, 400);
    expect(existsSync(join(run.output_dir, "artifacts", "allowed.txt"))).toBe(false);
    await f.call("POST", "/runs/" + run.id + "/actions/unknown", {}, 409);
    await f.call("POST", "/runs/" + run.id + "/actions/write", {});
    await f.call("POST", "/runs/" + run.id + "/actions/write", {});
    await f.call("POST", "/runs/" + run.id + "/finish", {});
    expect((await f.runFor(node.id)).completed_action_ids).toEqual(["write"]);
    const escaped = await f.app.inject({ method: "GET", url: "/api/engineering/runs/" + run.id + "/artifact?path=..%2Fdocument.yaml" });
    expect(escaped.statusCode).toBe(400);
  });

  it("rejects a junction escape before creating any file outside the run directory", async () => {
    const f = await fixture();
    const outside = mkdtempSync(join(tmpdir(), "mirror-engineering-outside-"));
    fixtures.push({ root: outside });
    const node = await f.create("路径实化检查");
    await f.configure(node, "artifacts/redirect/result.txt");
    await f.ready(node.id); await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external" }, 202); await f.service.settled();
    const run = await f.runFor(node.id);
    mkdirSync(join(run.output_dir, "artifacts"), { recursive: true });
    symlinkSync(outside, join(run.output_dir, "artifacts", "redirect"), process.platform === "win32" ? "junction" : "dir");
    const response = await f.call("POST", "/runs/" + run.id + "/actions/write", {}, 409);
    expect(response.json().code).toBe("engineering_path_escape");
    expect(existsSync(join(outside, "result.txt"))).toBe(false);
    expect((await f.runFor(node.id)).status).toBe("blocked");
  });

  it("accepts Agent-generated content only at the frozen external artifact action and never replaces its path", async () => {
    const f = await fixture();
    const node = await f.create("先方案后生成产物");
    await f.configure(node, "artifacts/generated.txt", { actions: [{ id: "generate", title: "由 Agent 根据方案生成结果", type: "agent_artifact", path: "artifacts/generated.txt", content: "", criterion_id: "file", capability_id: "" }] });
    await f.ready(node.id);
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "controlled" }, 409);
    expect((await f.view()).document.runs).toHaveLength(0);
    const current = await f.view();
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external", expected_revision: current.document.revision - 1 }, 409);
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external", expected_revision: current.document.revision }, 202); await f.service.settled();
    const run = await f.runFor(node.id);
    expect(run.snapshot.node.actions[0].content).toBe("");
    await f.call("POST", "/runs/" + run.id + "/actions/generate", { content: "delivered", path: "artifacts/other.txt" }, 400);
    await f.call("POST", "/runs/" + run.id + "/actions/generate", {}, 400);
    await f.call("POST", "/runs/" + run.id + "/actions/generate", { content: "delivered after the Plan was frozen" });
    await f.call("POST", "/runs/" + run.id + "/actions/generate", { content: "different replacement" }, 409);
    expect(readFileSync(join(run.output_dir, "artifacts", "generated.txt"), "utf8")).toBe("delivered after the Plan was frozen");
    expect(existsSync(join(run.output_dir, "artifacts", "other.txt"))).toBe(false);
    await f.call("POST", "/runs/" + run.id + "/finish", {});
    expect((await f.runFor(node.id)).status).toBe("review");
  });

  it("blocks actual failed checks and detects artifact tampering instead of trusting submitted pass claims", async () => {
    const f = await fixture();
    const node = await f.create("验证真实检查");
    await f.configure(node, "artifacts/result.txt", { criteria: [{ id: "file", text: "必须包含指定结果", kind: "file_contains", path: "artifacts/result.txt", expected: "not-present" }] });
    await f.ready(node.id); await f.call("POST", "/dispatch", { node_ids: [node.id] }, 202); await f.service.settled();
    let run = await f.runFor(node.id);
    expect(run.status).toBe("blocked"); expect(run.evidence.find((item) => item.kind === "check")?.passed).toBe(false);
    await f.call("POST", "/runs/" + run.id + "/review", { verdict: "accepted", note: "伪造通过", checks: [{ criterion_id: "file", passed: true, note: "自报" }] }, 409);
    await f.configure(node, "artifacts/result.txt"); await f.ready(node.id); await f.call("POST", "/dispatch", { node_ids: [node.id] }, 202); await f.service.settled();
    run = await f.runFor(node.id); expect(run.status).toBe("review");
    writeFileSync(join(run.output_dir, "artifacts", "result.txt"), "tampered");
    const changed = await f.call("POST", "/runs/" + run.id + "/review", { verdict: "accepted", note: "声称通过", checks: [{ criterion_id: "manual", passed: true, note: "声称核对" }] }, 409);
    expect(changed.json().code).toBe("engineering_artifact_changed");
  });

  it("runs independent leaves in parallel, queues conflicting outputs, and waits for accepted dependency evidence", async () => {
    const f = await fixture();
    const nodes: EngineeringNode[] = [];
    for (const [index, name] of ["并行甲", "并行乙", "并行丙", "同域等待", "依赖等待"].entries()) {
      const node = await f.create(name); nodes.push(node);
      await f.configure(node, "artifacts/" + (index === 3 ? "0" : index) + ".txt", index === 4 ? { dependencies: [nodes[1].id] } : {});
      await f.ready(node.id);
    }
    await f.call("POST", "/dispatch", { node_ids: nodes.map((node) => node.id), mode: "external" }, 202); await f.service.settled();
    expect((await f.view()).scheduler).toMatchObject({ active: 3, queued: 2 });
    expect((await f.runFor(nodes[3].id)).status).toBe("queued");
    await f.call("POST", "/nodes/" + nodes[0].id + "/pause", { reason: "暂停甲，释放其写域" }); await f.service.settled();
    expect((await f.runFor(nodes[3].id)).status).toBe("running");
    expect((await f.runFor(nodes[4].id)).status).toBe("queued");
    const upstream = await f.runFor(nodes[1].id);
    await f.call("POST", "/runs/" + upstream.id + "/actions/write", {});
    await f.call("POST", "/runs/" + upstream.id + "/finish", {});
    expect((await f.runFor(nodes[4].id)).status).toBe("queued");
    await f.approve(await f.runFor(nodes[1].id)); await f.service.settled();
    const downstream = await f.runFor(nodes[4].id);
    expect(downstream.status).toBe("running");
    expect(downstream.snapshot.dependencies).toContainEqual(expect.objectContaining({ node_id: nodes[1].id, run_id: upstream.id }));
  });

  it("never silently replaces an already referenced dependency acceptance while a run is queued", async () => {
    const f = await fixture();
    const upstream = await f.create("可重跑的上游"), downstream = await f.create("已冻结上游验收的下游"), blocker = await f.create("占用下游写域");
    await f.configure(upstream, "artifacts/upstream.txt");
    await f.configure(downstream, "artifacts/shared.txt", { dependencies: [upstream.id] });
    await f.configure(blocker, "artifacts/shared.txt");
    await f.ready(upstream.id); await f.call("POST", "/dispatch", { node_ids: [upstream.id] }, 202); await f.service.settled();
    const first = await f.runFor(upstream.id); await f.approve(first);
    await f.ready(blocker.id); await f.ready(downstream.id);
    await f.call("POST", "/dispatch", { node_ids: [blocker.id, downstream.id], mode: "external" }, 202); await f.service.settled();
    const queued = await f.runFor(downstream.id);
    expect(queued.status).toBe("queued");
    expect(queued.snapshot.dependencies[0].run_id).toBe(first.id);
    await f.ready(upstream.id); await f.call("POST", "/dispatch", { node_ids: [upstream.id] }, 202); await f.service.settled();
    const replacement = await f.runFor(upstream.id);
    expect(replacement.id).not.toBe(first.id);
    await f.approve(replacement); await f.service.settled();
    const stale = await f.runFor(downstream.id);
    expect(stale).toMatchObject({ id: queued.id, status: "stale" });
    expect(stale.snapshot).toEqual(queued.snapshot);
    expect(existsSync(stale.output_dir)).toBe(false);
    expect(f.service.runtime.listLocks().some((lock) => lock.owner === queued.id)).toBe(false);
    await f.call("POST", "/nodes/" + blocker.id + "/pause", { reason: "释放资源也不能悄悄替换冻结依赖" }); await f.service.settled();
    expect((await f.runFor(downstream.id)).status).toBe("stale");
    await f.ready(downstream.id); await f.call("POST", "/dispatch", { node_ids: [downstream.id], mode: "external" }, 202); await f.service.settled();
    const restarted = await f.runFor(downstream.id);
    expect(restarted.id).not.toBe(queued.id);
    expect(restarted.status).toBe("running");
    expect(restarted.snapshot.dependencies[0].run_id).toBe(replacement.id);
  });

  it.each(["running", "review"] as const)("invalidates a %s consumer immediately when its upstream acceptance is replaced", async (status) => {
    const f = await fixture();
    const upstream = await f.create("重复验收的上游"), downstream = await f.create("持有旧验收引用的消费者"), independent = await f.create("独立运行不失效");
    await f.configure(upstream, "artifacts/upstream.txt");
    await f.configure(downstream, "artifacts/downstream.txt", { dependencies: [upstream.id] });
    await f.configure(independent, "artifacts/independent.txt");
    await f.ready(upstream.id); await f.call("POST", "/dispatch", { node_ids: [upstream.id] }, 202); await f.service.settled();
    const oldAccepted = await f.runFor(upstream.id); await f.approve(oldAccepted);
    await f.ready(downstream.id); await f.ready(independent.id);
    await f.call("POST", "/dispatch", { node_ids: [downstream.id, independent.id], mode: "external" }, 202); await f.service.settled();
    const consumer = await f.runFor(downstream.id);
    if (status === "review") { await f.call("POST", "/runs/" + consumer.id + "/actions/write", {}); await f.call("POST", "/runs/" + consumer.id + "/finish", {}); }
    expect((await f.runFor(downstream.id)).status).toBe(status);
    await f.ready(upstream.id); await f.call("POST", "/dispatch", { node_ids: [upstream.id] }, 202); await f.service.settled();
    const replacement = await f.runFor(upstream.id); await f.approve(replacement);
    const after = await f.view();
    expect(after.document.runs.find((run) => run.id === consumer.id)).toMatchObject({ status: "stale", snapshot: consumer.snapshot });
    expect(f.service.runtime.listLocks().some((lock) => lock.owner === consumer.id)).toBe(false);
    expect((await f.runFor(independent.id)).status).toBe("running");
    expect(after.document.runs.find((run) => run.id === oldAccepted.id)?.status).toBe("accepted");
    expect(after.document.events.some((event) => event.run_id === consumer.id && event.kind === "change")).toBe(true);
  });

  it("invalidates active consumers through an accepted intermediate result when an upstream acceptance changes", async () => {
    const f = await fixture();
    const first = await f.create("证据链首项"), middle = await f.create("已验收中间结果"), last = await f.create("跨两层引用运行");
    await f.configure(first, "artifacts/first.txt");
    await f.configure(middle, "artifacts/middle.txt", { dependencies: [first.id] });
    await f.configure(last, "artifacts/last.txt", { dependencies: [middle.id] });
    for (const node of [first, middle]) {
      await f.ready(node.id); await f.call("POST", "/dispatch", { node_ids: [node.id] }, 202); await f.service.settled(); await f.approve(await f.runFor(node.id));
    }
    const acceptedMiddle = await f.runFor(middle.id);
    await f.ready(last.id); await f.call("POST", "/dispatch", { node_ids: [last.id], mode: "external" }, 202); await f.service.settled();
    const running = await f.runFor(last.id);
    await f.ready(first.id); await f.call("POST", "/dispatch", { node_ids: [first.id] }, 202); await f.service.settled(); await f.approve(await f.runFor(first.id));
    const after = await f.view();
    expect(after.document.runs.find((run) => run.id === running.id)).toMatchObject({ status: "stale", snapshot: running.snapshot });
    expect(after.derived[middle.id].status).toBe("needs_revision");
    expect(after.derived[last.id].status).toBe("needs_revision");
    expect(after.document.runs.find((run) => run.id === acceptedMiddle.id)?.status).toBe("accepted");
    expect(f.service.runtime.listLocks().some((lock) => lock.owner === running.id)).toBe(false);
  });

  it("requires parent integration and invalidates affected acceptance when a child contract changes", async () => {
    const f = await fixture();
    const child = await f.create("整体目标的子交付");
    await f.configure(child, "artifacts/child.txt"); await f.ready(child.id); await f.ready("engineering-project");
    await f.call("POST", "/dispatch", { node_ids: ["engineering-project", child.id] }, 202); await f.service.settled();
    expect((await f.runFor("engineering-project")).status).toBe("queued");
    const childRun = await f.runFor(child.id); await f.approve(childRun); await f.service.settled();
    const parentRun = await f.runFor("engineering-project");
    expect(parentRun).toMatchObject({ mode: "integration", status: "review", snapshot: { children: [expect.objectContaining({ node_id: child.id, run_id: childRun.id })] } });
    expect((await f.view()).derived["engineering-project"].status).toBe("review");
    writeFileSync(join(childRun.output_dir, "artifacts", "child.txt"), "changed after integration finish");
    const refusedParent = await f.call("POST", "/runs/" + parentRun.id + "/review", { verdict: "accepted", note: "子文件已被篡改，必须拒绝", checks: [{ criterion_id: "project-outcome", passed: true, note: "声称通过" }] }, 409);
    expect(refusedParent.json().code).toBe("engineering_artifact_changed");
    writeFileSync(join(childRun.output_dir, "artifacts", "child.txt"), "delivered");
    await f.approve(parentRun);
    expect((await f.view()).derived["engineering-project"].status).toBe("accepted");
    const before = (await f.view()).document;
    const node = before.nodes.find((item) => item.id === child.id)!;
    const proposed = { ...node, objective: "重新定义子交付结果" };
    const preview = (await f.call("POST", "/nodes/" + child.id + "/preview", { node: proposed, expected_revision: before.revision })).json();
    expect(preview.affected_ids).toContain("engineering-project");
    await f.call("PUT", "/nodes/" + child.id, { node: proposed, expected_revision: before.revision, reason: "验收目标变化" });
    const revised = await f.view();
    expect(revised.derived["engineering-project"].status).toBe("needs_revision");
    expect(revised.document.runs.find((run) => run.id === parentRun.id)?.status).toBe("accepted");
    expect(readFileSync(join(childRun.output_dir, "artifacts", "child.txt"), "utf8")).toBe("delivered");
    await f.call("POST", "/runs/" + parentRun.id + "/review", { verdict: "accepted", note: "不能重复采用旧版本", checks: [] }, 409);
  });

  it("enforces preview/version concurrency and inserts a moved sibling at its requested order", async () => {
    const f = await fixture();
    const a = await f.create("顺序甲"), b = await f.create("顺序乙"), c = await f.create("顺序丙");
    const before = await f.view();
    const node = { ...before.document.nodes.find((item) => item.id === c.id)!, order: 0 };
    await f.call("PUT", "/nodes/" + c.id, { node, expected_revision: before.document.revision, reason: "未预览" }, 409);
    await f.update(c.id, { order: 0 });
    expect((await f.view()).document.nodes.filter((item) => item.parent_id === "engineering-project").sort((left, right) => left.order - right.order).map((item) => item.id)).toEqual([c.id, a.id, b.id]);
    await f.call("POST", "/nodes/" + c.id + "/ready", { expected_revision: before.document.revision }, 409);
  });

  it.each(["subdivide", "archive"] as const)("invalidates downstream runs and releases their locks after %s while preserving unrelated siblings", async (change) => {
    const f = await fixture();
    const upstream = await f.create("已验收上游"), downstream = await f.create("依赖上游的运行"), independent = await f.create("无关并行任务"), waiting = await f.create("等待同写域释放");
    await f.configure(upstream, "artifacts/upstream.txt");
    let child: EngineeringNode | undefined;
    if (change === "archive") {
      child = await f.create("即将归档的旧分项", upstream.id);
      await f.configure(child, "artifacts/child.txt", { contributes_to: ["file", "manual"] });
      await f.ready(child.id); await f.call("POST", "/dispatch", { node_ids: [child.id] }, 202); await f.service.settled();
      await f.approve(await f.runFor(child.id));
    }
    await f.ready(upstream.id); await f.call("POST", "/dispatch", { node_ids: [upstream.id] }, 202); await f.service.settled();
    const accepted = await f.runFor(upstream.id); await f.approve(accepted);
    await f.configure(downstream, "artifacts/shared.txt", { dependencies: [upstream.id] }); await f.ready(downstream.id);
    await f.configure(independent, "artifacts/independent.txt"); await f.ready(independent.id);
    await f.configure(waiting, "artifacts/shared.txt"); await f.ready(waiting.id);
    await f.call("POST", "/dispatch", { node_ids: [downstream.id, independent.id, waiting.id], mode: "external" }, 202); await f.service.settled();
    const affectedRun = await f.runFor(downstream.id);
    expect(affectedRun.status).toBe("running");
    expect((await f.runFor(waiting.id)).status).toBe("queued");
    expect(f.service.runtime.listLocks().some((lock) => lock.owner === affectedRun.id)).toBe(true);
    if (change === "subdivide") await f.create("新增分项改变上游组合", upstream.id);
    else await f.call("POST", "/nodes/" + child!.id + "/archive", { expected_revision: (await f.view()).document.revision, reason: "撤销旧分项，必须重验组合及下游" });
    await f.service.settled();
    expect((await f.runFor(downstream.id)).status).toBe("stale");
    expect(f.service.runtime.listLocks().some((lock) => lock.owner === affectedRun.id)).toBe(false);
    expect((await f.runFor(independent.id)).status).toBe("running");
    expect((await f.runFor(waiting.id)).status).toBe("running");
    expect((await f.view()).document.runs.find((run) => run.id === accepted.id)?.status).toBe("accepted");
    await f.call("POST", "/runs/" + affectedRun.id + "/actions/write", {}, 409);
    expect(existsSync(join(affectedRun.output_dir, "artifacts", "shared.txt"))).toBe(false);
  });

  it("checks real Hook sessions, assigned owners, and immutable run actors for Agent calls", async () => {
    const f = await fixture();
    receiveCompanionHook(f.root, f.service.runtime, f.events, { session_id: "agent-a", cwd: f.root, hook_event_name: "SessionStart" });
    receiveCompanionHook(f.root, f.service.runtime, f.events, { session_id: "agent-b", cwd: f.root, hook_event_name: "SessionStart" });
    const headers = (id: string) => ({ "x-engineering-agent-session-id": id, "x-engineering-cwd": encodeURIComponent(f.root) });
    const node = await f.create("明确交给 Agent A");
    await f.configure(node, "artifacts/agent.txt", { owner: "codex:agent-a" }); await f.ready(node.id);
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external" }, 403, headers("agent-b"));
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external" }, 403, headers("unknown"));
    await f.call("POST", "/dispatch", { node_ids: [node.id], mode: "external" }, 202, headers("agent-a")); await f.service.settled();
    const run = await f.runFor(node.id); expect(run.actor).toBe("codex:agent-a");
    await f.call("POST", "/runs/" + run.id + "/actions/write", {}, 403, headers("agent-b"));
    await f.call("POST", "/runs/" + run.id + "/actions/write", {}, 200, headers("agent-a"));
    await f.call("POST", "/runs/" + run.id + "/finish", {}, 200, headers("agent-a"));
    await f.call("POST", "/runs/" + run.id + "/review", { verdict: "accepted", note: "Agent 不可自验收", checks: [] }, 403, headers("agent-a"));
    expect((await f.runFor(node.id)).status).toBe("review");
  });

  it("applies the actual Jervis candidate through HTTP, verifies its artifact and writes feedback only after review", async () => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const source = resolve(process.env.MIRROR_JERVIS_ROOT ?? join(repository, "../Jervis/IRONMAN_Codex_Implementation_Pack_v1_1"));
    const f = await fixture((root) => {
      const jervis = join(root, "jervis"), designer = join(root, "designer");
      for (const path of ["registry/designer/p1_s0c", "legacy", "domains/designer/adapters"]) mkdirSync(join(jervis, path), { recursive: true });
      for (const name of ["projection_manifest.json", "objects.jsonl", "object_index.jsonl", "relations.jsonl", "intake_contract.json"]) copyFileSync(join(source, "registry/designer/p1_s0c", name), join(jervis, "registry/designer/p1_s0c", name));
      const declaration = readYaml<{ source_root: string }>(join(source, "legacy/SOURCE_ROOTS_DECLARATION.yaml"));
      const relativeSource = "visual_language/accepted_advisory/quantified_advanced_view_effect_ontology_v1.yaml";
      mkdirSync(dirname(join(designer, relativeSource)), { recursive: true });
      copyFileSync(join(declaration.source_root, relativeSource), join(designer, relativeSource));
      writeFileSync(join(jervis, "legacy/SOURCE_ROOTS_DECLARATION.yaml"), JSON.stringify({ ...declaration, source_root: designer }));
      copyFileSync(join(source, "domains/designer/adapters/mirror_bridge.py"), join(jervis, "domains/designer/adapters/mirror_bridge.py"));
    }, (root) => createEngineeringJervisBridge(root, { jervisRoot: join(root, "jervis") }));
    const catalog = (await f.app.inject({ method: "GET", url: "/api/engineering/capabilities" })).json();
    const capabilityId = "capability:designer:view.comparison_decision_matrix";
    expect(catalog.capabilities.find((item: { id: string }) => item.id === capabilityId)).toMatchObject({ usable: true, lifecycle: "candidate" });
    const node = await f.create("真实能力应用与证据反馈");
    await f.configure(node, "artifacts/comparison.html", {
      capabilities: [{ id: capabilityId, version: "0.1.0", purpose: "比较交付方案", input: { title: "真实方案比较", fit_context: "option_tradeoff", dimensions: [{ id: "days", label: "交付周期", unit: "天", source: "测试排期" }], options: [{ id: "a", label: "方案甲", values: { days: 4 } }, { id: "b", label: "方案乙", values: { days: 2 } }] } }],
      criteria: [{ id: "file", text: "比较结果包含来源", kind: "file_contains", path: "artifacts/comparison.html", expected: "测试排期" }, { id: "manual", text: "人工检查方案和周期可比较", kind: "manual", path: "", expected: "" }],
      actions: [{ id: "apply", title: "执行比较能力", type: "use_capability", path: "artifacts/comparison.html", content: "", criterion_id: "file", capability_id: capabilityId }]
    });
    await f.ready(node.id); await f.call("POST", "/dispatch", { node_ids: [node.id] }, 202); await f.service.settled();
    const run = await f.runFor(node.id);
    expect(run.status, run.reason).toBe("review");
    const use = (await f.view()).document.capability_uses.find((item) => item.run_id === run.id)!;
    expect(use).toMatchObject({ state: "used", evidence_ids: [expect.any(String)] });
    const artifact = run.evidence.find((item) => item.id === use.evidence_ids[0])!;
    expect(artifact.kind).toBe("capability");
    expect(readFileSync(join(run.output_dir, artifact.path!), "utf8")).toContain("方案甲");
    await f.call("POST", "/runs/" + run.id + "/feedback", { capability_use_id: use.id, note: "尚未人工验收" }, 409);
    await f.approve(run);
    await f.call("POST", "/runs/" + run.id + "/feedback", { capability_use_id: use.id, note: "实际使用后逐项验收通过，保留候选生命周期" });
    const recorded = (await f.view()).document.capability_uses.find((item) => item.id === use.id)!;
    expect(recorded.state).toBe("feedback_recorded");
    expect(recorded.feedback_receipt!.startsWith(join(f.root, "jervis", "audit"))).toBe(true);
    expect(JSON.parse(readFileSync(recorded.feedback_receipt!, "utf8"))).toMatchObject({ authority: "project_evidence_only", promotion: "none", lifecycle_unchanged: true });
  });
});
