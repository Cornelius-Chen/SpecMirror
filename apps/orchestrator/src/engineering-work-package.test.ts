import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineeringNodeSchema, engineeringContractKey, effectiveEngineeringConstraints, type EngineeringDocument, type EngineeringRun } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering, RuntimeStore } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { EngineeringExecutionService, type EngineeringWorkPackageRequest } from "./engineering-service.ts";
import { registerEngineeringWorkPackageRoutes } from "./engineering-work-package-routes.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import type { CompanionSession } from "./codex-companion.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";

const fixtures: Array<{ root: string; app: FastifyInstance; service: EngineeringExecutionService; closeExtra?: () => Promise<void> }> = [];
const criterion = (id: string) => ({ id, text: id + " 的真实成果", kind: "manual" as const, path: "", expected: "" });
const composition = { summary: "接口数据和原节点页面共同构成查收结果。", scenario: "选中真实节点、查看问题并下载该次结果。", integration_criterion_ids: ["whole"] };
const smallDocument = (root: string): EngineeringDocument => {
  const stamp = new Date().toISOString();
  const make = (id: string, parent: string | null, order: number) => EngineeringNodeSchema.parse({
    id, parent_id: parent, kind: parent ? "task" : "project", title: id, objective: "完成 " + id, order, revision: 1,
    status: "draft", constraints: { allow: parent ? [`artifacts/${id}/**`] : ["artifacts/**"], deny: [".project/**"] },
    criteria: parent ? [criterion("result")] : [criterion("a"), criterion("b"), criterion("whole")],
    delivery: { included: ["交付 " + id], excluded: ["其他功能"], inputs: [], outputs: [{ id: "out", title: id + " 成果", criterion_ids: parent ? ["result"] : ["a", "b", "whole"] }] },
    ...(parent ? { contributes_to: [id], contribution: { summary: "交付 " + id + " 部分" },
      source_scope: { root: join(root, "source-" + id), allow: ["entry.txt"], deny: ["private/**"], checks: [{ id: "verify", title: "只在未来运行执行的检查", program: "node", args: ["-e", "process.exit(99)"] }] },
      actions: [{ id: "report", title: "提交实际报告", type: "agent_artifact", path: `artifacts/${id}/report.md`, criterion_id: "result" }]
    } : {}), created_at: stamp, updated_at: stamp
  });
  const nodes = [make("root", null, 0), make("a", "root", 0), make("b", "root", 1)];
  nodes[1].interactions = [{ id: "read-result", target_node_id: "b", source_output_id: "out", target_input_id: "", purpose: "界面读取结果", scenario: "打开该次成果" }];
  return { schema_version: 1, id: "isolated-work-package", revision: 1, root_id: "root", nodes, runs: [], events: [], changes: [], capability_uses: [], created_at: stamp, updated_at: stamp };
};

async function fixture(withGuard = true) {
  const root = mkdtempSync(join(tmpdir(), "mirror-work-package-"));
  for (const id of ["a", "b"]) { mkdirSync(join(root, "source-" + id)); writeFileSync(join(root, "source-" + id, "entry.txt"), "preexisting"); }
  atomicWriteYaml(engineeringDocumentPath(root), smallDocument(root));
  const sessions = ["owner-a", "owner-b"].map(session_id => ({ session_id, cwd: root, last_seen_at: new Date().toISOString() } as CompanionSession));
  let identityAllowed = true;
  const service = new EngineeringExecutionService(root, new EventBus(), undefined, {
    workspaceId: "isolated-workspace", approvedSourceRoots: () => [root], agentSessions: () => sessions,
    authorizeIdentity: (id, cwd) => identityAllowed && sessions.some(session => session.session_id === id && cwd === root) ? "current" : false
  });
  const app = Fastify();
  let approval = 0;
  // Explicit test-only proof provider, never used by the production application.
  const verifier: HumanApprovalVerifier = async (request, required) => request.headers["x-isolated-human"] === "yes" ? {
    kind: "authenticated_human_approval", principalId: "isolated-owner", approvalId: "isolated-proof-" + ++approval,
    requestDigest: required.requestDigest, expiresAt: Date.now() + 60_000
  } : null;
  if (withGuard) registerHumanApprovalGuard(app, verifier);
  registerEngineeringWorkPackageRoutes(app, request => {
    if (request.headers["x-mirror-workspace-id"] !== "isolated-workspace") throw new Error("wrong_test_workspace");
    return service;
  });
  await app.ready();
  fixtures.push({ root, app, service });
  const input = (): EngineeringWorkPackageRequest => ({ root_id: "root", expected_revision: loadEngineering(root).revision, composition: structuredClone(composition), assignments: [{ node_id: "a", owner: "codex:owner-a" }, { node_id: "b", owner: "codex:owner-b" }], reason: "一次明确两个真实负责人与整体验收。" });
  const call = (action: "preview" | "commit", payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/engineering/work-package/" + action, headers: { "x-mirror-workspace-id": "isolated-workspace", ...headers }, payload: payload as object });
  const preview = async (value = input()) => { const reply = await call("preview", value); expect(reply.statusCode, reply.body).toBe(200); return reply.json(); };
  const commit = (prepared: { token: string; request: EngineeringWorkPackageRequest }, headers: Record<string, string> = { "x-isolated-human": "yes" }) => call("commit", { token: prepared.token, request: prepared.request }, headers);
  const bytes = () => readFileSync(engineeringDocumentPath(root), "utf8");
  return { root, app, service, sessions, input, call, preview, commit, bytes, revokeIdentity: () => { identityAllowed = false; } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of fixtures.splice(0)) {
    await item.app.close(); await item.service.close(); await item.closeExtra?.();
    const path = resolve(item.root);
    if (!path.startsWith(resolve(tmpdir()) + sep) || !path.split(sep).at(-1)?.startsWith("mirror-work-package-")) throw new Error("unsafe_fixture_cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("one authenticated work-package confirmation", () => {
  it("previews without writes, then assigns both owners and readies them in one revision with exact audit and no execution", async () => {
    const f = await fixture(), before = f.bytes(), prior = loadEngineering(f.root), p = await f.preview();
    expect(f.bytes()).toBe(before);
    expect(p).toMatchObject({ expected_revision: 1, root_id: "root", ready_node_ids: ["a", "b"], creates_runs: false });
    expect(p.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    const result = await f.commit(p); expect(result.statusCode, result.body).toBe(200);
    const doc = loadEngineering(f.root);
    expect(doc.revision).toBe(2); expect(doc.runs).toEqual([]); expect(doc.nodes[0].composition).toEqual(composition);
    expect(doc.nodes.slice(1).map(n => ({ owner: n.owner, status: n.status }))).toEqual([{ owner: "codex:owner-a", status: "ready" }, { owner: "codex:owner-b", status: "ready" }]);
    expect(doc.nodes.slice(1).map(n => ({ id: n.id, parent: n.parent_id, constraints: n.constraints, source: n.source_scope, criteria: n.criteria, actions: n.actions }))).toEqual(prior.nodes.slice(1).map(n => ({ id: n.id, parent: n.parent_id, constraints: n.constraints, source: n.source_scope, criteria: n.criteria, actions: n.actions })));
    expect(doc.changes).toHaveLength(3);
    const readiness = doc.events.filter(event => event.readiness_contract_key);
    expect(readiness).toHaveLength(2);
    for (const event of readiness) {
      expect(event.readiness_contract_key).toBe(engineeringContractKey(doc, event.node_id));
      expect(JSON.parse(event.detail!)).toMatchObject({ actor: "human:isolated-owner", work_package_id: p.token, approval_id: "isolated-proof-1", manifest_digest: p.manifest_digest, pre_revision: 1, post_revision: 2 });
      expect(JSON.parse(event.detail!).request_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(readdirSync(join(f.root, ".project/engineering/recursive/history"))).toEqual(["revision-1.yaml"]);
    expect(existsSync(join(f.root, ".project/engineering/recursive/outputs"))).toBe(false);
    const repeat = await f.commit(p); expect(repeat.statusCode).toBe(409); expect(repeat.json().code).toBe("engineering_work_package_preview_required");
  });

  it("rejects a missing positive proof and either Agent header without consuming a valid candidate", async () => {
    const f = await fixture(), p = await f.preview(), before = f.bytes();
    const attempts: Array<Record<string, string>> = [{}, { "x-isolated-human": "yes", "x-engineering-agent-session-id": "owner-a" }, { "x-isolated-human": "yes", "x-engineering-cwd": f.root }];
    for (const headers of attempts) {
      const reply = await f.commit(p, headers); expect(reply.statusCode).toBe(403); expect(f.bytes()).toBe(before);
    }
    expect((await f.commit(p)).statusCode).toBe(200);
  });

  it("does not leave the first leaf assigned when a later leaf or source scope fails", async () => {
    const f = await fixture(), before = f.bytes();
    const badOwner = f.input(); badOwner.assignments[1].owner = "codex:never-observed";
    const rejected = await f.call("preview", badOwner);
    expect(rejected.statusCode).toBe(409); expect(rejected.json().code).toBe("engineering_external_session_unknown"); expect(f.bytes()).toBe(before);
    const doc = loadEngineering(f.root); doc.nodes[2].source_scope!.allow = ["../outside/**"]; atomicWriteYaml(engineeringDocumentPath(f.root), doc);
    const invalidScope = f.bytes(), reply = await f.call("preview", f.input());
    expect(reply.statusCode).not.toBe(200); expect(f.bytes()).toBe(invalidScope);
    expect(loadEngineering(f.root).nodes.slice(1).every(n => n.owner === "未分配" && n.status === "draft")).toBe(true);
  });

  it("rechecks exact request, document revision, and same-revision contract contents before a single save", async () => {
    const f = await fixture(), p = await f.preview(), before = f.bytes();
    const edited = structuredClone(p); edited.request.reason += "额外内容";
    const mismatch = await f.commit(edited); expect(mismatch.statusCode).toBe(409); expect(mismatch.json().code).toBe("engineering_work_package_preview_mismatch"); expect(f.bytes()).toBe(before);
    const tampered = loadEngineering(f.root); tampered.nodes[1].objective += " 同版本改变"; atomicWriteYaml(engineeringDocumentPath(f.root), tampered);
    const altered = f.bytes(), stale = await f.commit(p); expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("engineering_work_package_manifest_changed"); expect(f.bytes()).toBe(altered);
    const p2 = await f.preview(); const newer = loadEngineering(f.root); newer.revision++; atomicWriteYaml(engineeringDocumentPath(f.root), newer);
    const advanced = f.bytes(), conflict = await f.commit(p2); expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe("engineering_revision_conflict"); expect(f.bytes()).toBe(advanced);
  });

  it("fails atomically when a real owner expires, changes cwd, or loses workspace identity after preview", async () => {
    const f = await fixture(), before = f.bytes(), p = await f.preview();
    f.sessions[1].last_seen_at = new Date(Date.now() - 31 * 60_000).toISOString();
    const expired = await f.commit(p); expect(expired.statusCode).toBe(409); expect(expired.json().code).toBe("engineering_external_session_stale"); expect(f.bytes()).toBe(before);
    f.sessions[1].last_seen_at = new Date().toISOString(); const p2 = await f.preview(); f.sessions[1].cwd = join(f.root, "source-b");
    const cwd = await f.commit(p2); expect(cwd.statusCode).toBe(403); expect(f.bytes()).toBe(before);
    f.sessions[1].cwd = f.root; const p3 = await f.preview(); f.revokeIdentity();
    expect((await f.commit(p3)).statusCode).toBe(403); expect(f.bytes()).toBe(before);
  });

  it("rejects any historical run in the affected subtree without rewriting or invalidating it", async () => {
    const f = await fixture(), doc = loadEngineering(f.root), node = doc.nodes[1];
    const historical = { id: "engineering-run-aaaa", node_id: node.id, status: "accepted", mode: "controlled", actor: "isolated-old-owner", started_at: doc.created_at, finished_at: doc.created_at,
      output_dir: join(f.root, "not-read"), evidence: [], completed_action_ids: [], current_action: "", reason: "preserved test history", reviewed_at: doc.created_at, review_note: "isolated historical record",
      snapshot: { node: structuredClone(node), lineage: [], effective: effectiveEngineeringConstraints(doc, node.id), contract_key: engineeringContractKey(doc, node.id), dependencies: [], children: [] }
    } as EngineeringRun;
    doc.runs.push(historical); atomicWriteYaml(engineeringDocumentPath(f.root), doc); const before = f.bytes();
    const reply = await f.call("preview", f.input()); expect(reply.statusCode).toBe(409); expect(reply.json().code).toBe("engineering_work_package_has_history"); expect(f.bytes()).toBe(before); expect(loadEngineering(f.root).runs).toEqual([historical]);
  });

  it("rejects unsupported fields, duplicate assignments, roots as leaves, incomplete composition and non-draft targets", async () => {
    const f = await fixture(), before = f.bytes();
    const payloads = [
      { ...f.input(), status: "ready" },
      { ...f.input(), assignments: [...f.input().assignments, f.input().assignments[0]] },
      { ...f.input(), assignments: [{ node_id: "root", owner: "codex:owner-a" }] },
      { ...f.input(), composition: { ...composition, integration_criterion_ids: [] } },
      { ...f.input(), assignments: [{ ...f.input().assignments[0], source_scope: {} }] }
    ];
    for (const value of payloads) { expect((await f.call("preview", value)).statusCode).toBe(400); expect(f.bytes()).toBe(before); }
    const doc = loadEngineering(f.root); doc.nodes[2].status = "ready"; atomicWriteYaml(engineeringDocumentPath(f.root), doc); const ready = f.bytes();
    expect((await f.call("preview", f.input())).statusCode).toBe(409); expect(f.bytes()).toBe(ready);
  });

  it("binds tokens to their originating service and host lifecycle", async () => {
    const one = await fixture(), two = await fixture(), p = await one.preview(), before = two.bytes();
    const reply = await two.commit(p); expect(reply.statusCode).toBe(409); expect(reply.json().code).toBe("engineering_work_package_preview_required"); expect(two.bytes()).toBe(before);
  });

  it("keeps commit closed even if the host forgets to install its human guard", async () => {
    const f = await fixture(false), p = await f.preview(), before = f.bytes();
    const reply = await f.commit(p); expect(reply.statusCode).toBe(403); expect(reply.json().code).toBe("engineering_human_action_required"); expect(f.bytes()).toBe(before);
  });

  it("expires a candidate without changing the document or allowing its reuse", async () => {
    const f = await fixture(), p = await f.preview(), before = f.bytes(), at = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(at + 11 * 60_000);
    const reply = await f.commit(p); expect(reply.statusCode).toBe(409); expect(reply.json().code).toBe("engineering_work_package_preview_required"); expect(f.bytes()).toBe(before);
  });

  it("prepares a discovered secondary owner in a real managed workspace resolver without granting execution before confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirror-work-package-")), source = join(root, "actual-source"), events = new EventBus();
    for (const id of ["a", "b"]) { mkdirSync(join(source, "source-" + id), { recursive: true }); writeFileSync(join(source, "source-" + id, "entry.txt"), "existing"); }
    const runtime = new RuntimeStore(root), companion = new WorkspaceCompanion(root, runtime, events, { readonlyLegacy: true });
    const workspaces = new TaskWorkspaces(root, events, { source: async id => ({ id, title: "Managed candidate fixture", cwd: source, version: "v1", preview: "明确结果", updatedAt: 1, pinned: false, received: false, receivedAt: null }) }, {
      sessions: record => companion.sessions(record), observations: record => companion.lifecycleObservations(record)
    });
    const workspace = await workspaces.connect({ thread_id: "owner-a", source_version: "v1", mode: "create" });
    const context = workspaces.resolve(workspace.id), service = context.service;
    atomicWriteYaml(engineeringDocumentPath(context.root), smallDocument(source));
    // Fixture-only lifecycle receipts. No production Hook or approval is forged.
    companion.receiveHook({ session_id: "owner-a", cwd: source, hook_event_name: "SessionStart" }, workspaces);
    companion.receiveHook({ session_id: "owner-b", cwd: source, hook_event_name: "SessionStart" }, workspaces);
    expect(workspaces.contextForAgent("owner-b", source, workspace.id)).toBeUndefined();
    expect(() => service.authorizeAgent("owner-b", source, { nodeId: "b" })).toThrow();
    const app = Fastify(); let proofNumber = 0;
    registerHumanApprovalGuard(app, async (request, required) => request.headers["x-isolated-human"] === "yes" ? {
      kind: "authenticated_human_approval", principalId: "isolated-owner", approvalId: "managed-proof-" + ++proofNumber, requestDigest: required.requestDigest, expiresAt: Date.now() + 60_000
    } : null);
    registerEngineeringRoutes(app, root, events, undefined, workspaces);
    await app.ready();
    fixtures.push({ root, app, service, closeExtra: async () => { await workspaces.close(); runtime.close(); } });
    const headers = { "x-mirror-workspace-id": workspace.id };
    const request: EngineeringWorkPackageRequest = { root_id: "root", expected_revision: 1, composition, assignments: [{ node_id: "a", owner: "codex:owner-a" }, { node_id: "b", owner: "codex:owner-b" }], reason: "由真实发现的两个候选负责各自的部分。" };
    const before = readFileSync(engineeringDocumentPath(context.root), "utf8");
    const preview = await app.inject({ method: "POST", url: "/api/engineering/work-package/preview", headers, payload: request });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(readFileSync(engineeringDocumentPath(context.root), "utf8")).toBe(before);
    expect(workspaces.contextForAgent("owner-b", source, workspace.id)).toBeUndefined();
    expect(() => service.authorizeAgent("owner-b", source, { nodeId: "b" })).toThrow();
    const packet = preview.json();
    const committed = await app.inject({ method: "POST", url: "/api/engineering/work-package/commit", headers: { ...headers, "x-isolated-human": "yes" }, payload: { token: packet.token, request: packet.request } });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(workspaces.contextForAgent("owner-b", source, workspace.id)?.record.id).toBe(workspace.id);
    expect(service.authorizeAgent("owner-b", source, { nodeId: "b" })).toBe("codex:owner-b");
    expect(() => service.authorizeAgent("owner-b", source, { nodeId: "a" })).toThrow();
    expect(() => service.authorizeAgent("owner-a", source, { nodeId: "b" })).toThrow();
    expect(service.view().document.runs).toEqual([]);
    const restored = await app.inject({ method: "GET", url: "/api/engineering", headers });
    expect(restored.statusCode).toBe(200);
    const receipts = restored.json().document.events.flatMap((event: { detail?: string }) => { try { const detail = JSON.parse(event.detail ?? "null"); return detail?.work_package_id === packet.token ? [detail] : []; } catch { return []; } });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt: { manifest_digest: string; pre_revision: number; post_revision: number }) => receipt.manifest_digest === packet.manifest_digest && receipt.pre_revision === 1 && receipt.post_revision === 2)).toBe(true);
  });
});
