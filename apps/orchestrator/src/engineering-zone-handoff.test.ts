import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { EngineeringNodeSchema, type EngineeringDocument, type EngineeringNode } from "@epm/domain";
import { loadEngineering, RuntimeStore, saveEngineering } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import type { EngineeringZoneClaimResult, EngineeringZoneHandoffPacket } from "./engineering-service.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";

const fixtures: Array<{ root: string; app: FastifyInstance; runtime: RuntimeStore }> = [];

function taskNode(input: {
  id: string;
  parentId: string;
  title: string;
  order: number;
  owner: string;
  contributesTo: string;
  dependency?: string;
  inputFrom?: string;
}) {
  return EngineeringNodeSchema.parse({
    id: input.id,
    parent_id: input.parentId,
    kind: "step",
    title: input.title,
    objective: `交付${input.title}的可核对成果`,
    method: "按冻结合同生成唯一成果文件",
    architecture: "独立成果目录",
    owner: input.owner,
    order: input.order,
    revision: 1,
    contract_revision: 1,
    status: "ready",
    dependencies: input.dependency ? [input.dependency] : [],
    contributes_to: [input.contributesTo],
    contribution: { summary: `提供${input.title}成果` },
    constraints: { allow: [], deny: [], rules: [], resources: [] },
    criteria: [{ id: "file", text: "形成真实成果文件", kind: "file_exists", path: `artifacts/${input.id}.txt`, expected: "" }],
    actions: [{ id: "deliver", title: "提交成果文件", type: "agent_artifact", path: `artifacts/${input.id}.txt`, content: "", criterion_id: "file", capability_id: "" }],
    delivery: {
      included: [input.title],
      excluded: ["其他协作区域"],
      outputs: [{ id: "result", title: `${input.title}成果`, criterion_ids: ["file"] }],
      inputs: input.inputFrom ? [{ id: "source", title: "上游成果", source_node_id: input.inputFrom, source_output_id: "result", external_source: "" }] : []
    },
    prerequisites: input.dependency ? [{ id: "gate", node_id: input.dependency, reason: "上游成果通过验收后开始" }] : [],
    created_at: "2026-09-07T00:00:00.000Z",
    updated_at: "2026-09-07T00:00:00.000Z"
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-zone-handoff-"));
  const app = Fastify(), events = new EventBus(), runtime = new RuntimeStore(root);
  const companion = new WorkspaceCompanion(root, runtime, events, { readonlyLegacy: true });
  let approval = 0;
  const humanApproval: HumanApprovalVerifier = async (_request, requirement) => ({
    kind: "authenticated_human_approval",
    principalId: "isolated-zone-test-owner",
    approvalId: "zone-dispatch-" + ++approval,
    requestDigest: requirement.requestDigest,
    expiresAt: Date.now() + 60_000
  });
  const source = async (id: string) => ({
    id,
    title: "区域交接测试 " + id,
    cwd: join(root, "source-" + id),
    version: "source-v1",
    preview: "隔离的区域交接测试任务",
    updatedAt: 1,
    pinned: false,
    received: false,
    receivedAt: null
  });
  const workspaces = new TaskWorkspaces(root, events, { source }, { sessions: record => companion.sessions(record) });
  registerHumanApprovalGuard(app, humanApproval);
  registerEngineeringRoutes(app, root, events, undefined, workspaces);
  await app.ready();
  fixtures.push({ root, app, runtime });

  const connect = async (id: string) => {
    mkdirSync(join(root, "source-" + id), { recursive: true });
    const workspace = await workspaces.connect({ thread_id: id, source_version: "source-v1", mode: "create" });
    await workspaces.settled();
    return workspace;
  };
  const hook = (id: string, cwd: string) => companion.receiveHook({ session_id: id, cwd, hook_event_name: "SessionStart" });
  const headers = (id: string, cwd: string) => ({ "x-engineering-agent-session-id": id, "x-engineering-cwd": encodeURIComponent(cwd) });
  const call = async (scope: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown, expected = 200, agent?: Record<string, string>) => {
    const response = await app.inject({ method, url: "/api/engineering" + path, headers: { "x-mirror-workspace-id": scope, ...agent }, ...(payload === undefined ? {} : { payload: payload as object }) });
    expect(response.statusCode, response.body).toBe(expected);
    return response;
  };
  const view = (scope: string) => workspaces.resolve(scope).service.view();

  const installTree = (scope: string, options: { zoneOwner?: string; secondLeafOwner?: string } = {}) => {
    const serviceRoot = workspaces.resolve(scope).root;
    const original = loadEngineering(serviceRoot);
    const at = original.updated_at;
    const base = (input: Partial<EngineeringNode> & Pick<EngineeringNode, "id" | "parent_id" | "kind" | "title">) => EngineeringNodeSchema.parse({
      objective: "形成一项可核对成果",
      method: "按冻结约定执行",
      architecture: "独立成果边界",
      owner: "未分配",
      order: 0,
      revision: 1,
      contract_revision: 1,
      status: "ready",
      dependencies: [],
      contributes_to: [],
      constraints: { allow: [], deny: [], rules: [], resources: [] },
      criteria: [],
      capabilities: [],
      actions: [],
      created_at: at,
      updated_at: at,
      ...input
    });
    const rootNode = base({
      id: "engineering-project",
      parent_id: null,
      kind: "project",
      title: "区域协作工程",
      objective: "由四个成果区域共同形成完整工程",
      constraints: { allow: ["artifacts/**"], deny: [], rules: ["不得修改工程治理记录"], resources: [] },
      criteria: [{ id: "project-result", text: "四个区域共同形成完整工程", kind: "manual", path: "", expected: "" }],
      delivery: { included: ["完整工程"], excluded: ["未声明的额外工作"], outputs: [{ id: "project", title: "完整工程", criterion_ids: ["project-result"] }], inputs: [] },
      composition: { summary: "各区域成果加上本层整合形成完整工程", integration_criterion_ids: ["project-result"], scenario: "核对各区域成果及整体可用性" }
    });
    const workZone = base({
      id: "work-zone",
      parent_id: rootNode.id,
      kind: "task",
      title: "实现区域",
      owner: options.zoneOwner ?? "codex:a",
      order: 0,
      contributes_to: ["project-result"],
      contribution: { summary: "形成工程的主要实现成果" },
      constraints: { allow: [], deny: [], rules: ["只写入本区域成果"], resources: ["zone-tool"] },
      criteria: [{ id: "zone-result", text: "三个子成果完整", kind: "manual", path: "", expected: "" }],
      delivery: { included: ["实现成果"], excluded: ["消费端集成"], outputs: [{ id: "work-result", title: "实现成果", criterion_ids: ["zone-result"] }], inputs: [] },
      composition: { summary: "三个叶任务共同形成实现成果", integration_criterion_ids: ["zone-result"], scenario: "合并三个叶任务并核对区域结果" }
    });
    const gate = taskNode({ id: "gate-zone", parentId: rootNode.id, title: "上游门禁", order: 1, owner: "codex:gate", contributesTo: "project-result" });
    const consumer = taskNode({ id: "consumer-zone", parentId: rootNode.id, title: "消费端", order: 2, owner: "codex:consumer", contributesTo: "project-result", inputFrom: "leaf-one" });
    const unrelated = taskNode({ id: "unrelated-zone", parentId: rootNode.id, title: "无关分支", order: 3, owner: "codex:other", contributesTo: "project-result" });
    const leaves = [
      taskNode({ id: "leaf-one", parentId: workZone.id, title: "成果一", order: 0, owner: "未分配", contributesTo: "zone-result", dependency: gate.id }),
      taskNode({ id: "leaf-two", parentId: workZone.id, title: "成果二", order: 1, owner: options.secondLeafOwner ?? "未分配", contributesTo: "zone-result", dependency: gate.id }),
      taskNode({ id: "leaf-three", parentId: workZone.id, title: "成果三", order: 2, owner: "未分配", contributesTo: "zone-result", dependency: gate.id })
    ];
    const document: EngineeringDocument = { ...original, root_id: rootNode.id, nodes: [rootNode, workZone, ...leaves, gate, consumer, unrelated], runs: [], events: [], changes: [], capability_uses: [] };
    saveEngineering(serviceRoot, document, original.revision);
  };

  const dispatch = async (scope: string, nodeIds: string[]) => {
    await call(scope, "POST", "/dispatch", { node_ids: nodeIds, mode: "external", expected_revision: view(scope).document.revision }, 202);
    await workspaces.settled();
    return view(scope).document.runs.filter(run => nodeIds.includes(run.node_id));
  };
  const packet = async (scope: string) => (await call(scope, "GET", `/zones/${encodeURIComponent("zone:work-zone")}/handoff`)).json<EngineeringZoneHandoffPacket>();
  return { root, app, runtime, companion, workspaces, connect, hook, headers, call, view, installTree, dispatch, packet };
}

afterEach(async () => {
  for (const item of fixtures.splice(0).reverse()) {
    await item.app.close();
    item.runtime.close();
    const root = resolve(item.root);
    if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_zone_fixture_cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent collaboration zone handoff", () => {
  it("returns a read-only frozen zone packet with inherited ownership and only relevant relations", async () => {
    const f = await fixture(), workspace = await f.connect("zone-read");
    f.hook("a", workspace.source_cwd);
    f.installTree(workspace.id);
    await f.dispatch(workspace.id, ["leaf-one", "leaf-two"]);
    const before = f.view(workspace.id).document;
    const packet = await f.packet(workspace.id);

    expect(packet.schema_version).toBe(1);
    expect(packet.workspace_id).toBe(workspace.id);
    expect(packet.scope_root_id).toBe("engineering-project");
    expect(packet.zone).toMatchObject({
      id: "zone:work-zone",
      root_node_id: "work-zone",
      owner_state: "single",
      effective_agent_owner: "codex:a",
      leaf_ids: ["leaf-one", "leaf-two", "leaf-three"],
      authorized_leaf_ids: ["leaf-one", "leaf-two", "leaf-three"]
    });
    expect(packet.node_assignments["leaf-one"]).toMatchObject({ effective_agent_owner: "codex:a", owner_source_node_id: "work-zone", inherited: true });
    expect(packet.nodes.map(node => node.id)).toEqual(["work-zone", "leaf-one", "leaf-two", "leaf-three"]);
    expect(packet.runs.map(run => run.node_id).sort()).toEqual(["leaf-one", "leaf-two"]);
    expect(packet.handoffs.some(item => item.from_zone_id === "zone:gate-zone" && item.to_zone_id === "zone:work-zone")).toBe(true);
    expect(packet.handoffs.some(item => item.from_zone_id === "zone:work-zone" && item.to_zone_id === "zone:consumer-zone")).toBe(true);
    expect(packet.handoffs.every(item => item.from_zone_id === packet.zone.id || item.to_zone_id === packet.zone.id)).toBe(true);
    expect(packet.contract_key).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.contract_key).not.toBe(packet.zone.contract_key);
    expect(packet.claimable).toBe(true);
    expect(f.view(workspace.id).document).toEqual(before);

    const serviceRoot = f.workspaces.resolve(workspace.id).root;
    const edited = loadEngineering(serviceRoot);
    const sibling = edited.nodes.find(node => node.id === "unrelated-zone")!;
    sibling.objective = "无关分支的新目标";
    sibling.revision++;
    sibling.contract_revision = (sibling.contract_revision ?? 1) + 1;
    saveEngineering(serviceRoot, edited, edited.revision);
    const afterUnrelatedEdit = await f.packet(workspace.id);
    expect(afterUnrelatedEdit.zone.contract_key).toBe(packet.zone.contract_key);
    expect(afterUnrelatedEdit.contract_key).toBe(packet.contract_key);
  });

  it("fails closed, binds the exact run set, then claims the whole frozen set with one save", async () => {
    const f = await fixture(), workspace = await f.connect("zone-claim");
    f.hook("a", workspace.source_cwd);
    f.hook("other", workspace.source_cwd);
    f.installTree(workspace.id);
    const firstRuns = await f.dispatch(workspace.id, ["leaf-one", "leaf-two"]);
    const oldPacket = await f.packet(workspace.id);
    await f.dispatch(workspace.id, ["leaf-three"]);
    const beforeStaleClaim = f.view(workspace.id).document;
    const stale = await f.call(workspace.id, "POST", `/zones/${encodeURIComponent(oldPacket.zone.id)}/claim`, { contract_key: oldPacket.contract_key }, 409, f.headers("a", workspace.source_cwd));
    expect(stale.json().code).toBe("engineering_zone_version_conflict");
    expect(f.view(workspace.id).document).toEqual(beforeStaleClaim);

    const packet = await f.packet(workspace.id);
    expect(packet.contract_key).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.contract_key).not.toBe(oldPacket.contract_key);
    expect(packet.runs).toHaveLength(3);
    const beforeMissingIdentity = f.view(workspace.id).document;
    const missing = await f.call(workspace.id, "POST", `/zones/${encodeURIComponent(packet.zone.id)}/claim`, { contract_key: packet.contract_key }, 403);
    expect(missing.json().code).toBe("engineering_external_agent_required");
    expect(f.view(workspace.id).document).toEqual(beforeMissingIdentity);
    const wrong = await f.call(workspace.id, "POST", `/zones/${encodeURIComponent(packet.zone.id)}/claim`, { contract_key: packet.contract_key }, 403, f.headers("other", workspace.source_cwd));
    expect(wrong.json().code).toBe("engineering_agent_zone_owner_mismatch");
    expect(f.view(workspace.id).document).toEqual(beforeMissingIdentity);

    const beforeClaim = f.view(workspace.id).document;
    const claimed = (await f.call(workspace.id, "POST", `/zones/${encodeURIComponent(packet.zone.id)}/claim`, { contract_key: packet.contract_key }, 200, f.headers("a", workspace.source_cwd))).json<EngineeringZoneClaimResult>();
    await f.workspaces.settled();
    const afterClaim = f.view(workspace.id).document;
    expect(claimed.zone_id).toBe(packet.zone.id);
    expect(claimed.claimed_run_ids.sort()).toEqual(packet.runs.map(run => run.run_id).sort());
    expect(afterClaim.revision).toBe(beforeClaim.revision + 1);
    expect(afterClaim.events).toHaveLength(beforeClaim.events.length + 1);
    const claimedRuns = afterClaim.runs.filter(run => claimed.claimed_run_ids.includes(run.id));
    expect(claimedRuns).toHaveLength(3);
    expect(new Set(claimedRuns.map(run => run.handoff?.claimed_at)).size).toBe(1);
    expect(claimedRuns.every(run => run.status === "queued" && run.handoff?.state === "claimed" && run.handoff.claimed_by === "codex:a")).toBe(true);
    expect(firstRuns.every(run => claimed.claimed_run_ids.includes(run.id))).toBe(true);

    const leaf = afterClaim.nodes.find(node => node.id === "leaf-one")!;
    const preview = await f.call(workspace.id, "POST", "/nodes/leaf-one/preview", { node: { ...leaf, title: "成果一（预览）" }, expected_revision: afterClaim.revision }, 200, f.headers("a", workspace.source_cwd));
    expect(preview.json().classification).toBe("presentation");
    const ownerChange = await f.call(workspace.id, "POST", "/nodes/leaf-one/preview", { node: { ...leaf, owner: "codex:b" }, expected_revision: afterClaim.revision }, 403, f.headers("a", workspace.source_cwd));
    expect(ownerChange.json().code).toBe("engineering_agent_owner_immutable");
    const ready = await f.call(workspace.id, "POST", "/nodes/leaf-one/ready", { expected_revision: afterClaim.revision }, 403, f.headers("a", workspace.source_cwd));
    expect(ready.json().code).toBe("human_approval_required");
    const review = await f.call(workspace.id, "POST", `/runs/${claimed.claimed_run_ids[0]}/review`, { verdict: "accepted", checks: [] }, 403, f.headers("a", workspace.source_cwd));
    expect(review.json().code).toBe("human_approval_required");
  });

  it("prevalidates every waiting run before changing any member", async () => {
    const f = await fixture(), workspace = await f.connect("zone-atomic");
    f.hook("a", workspace.source_cwd);
    f.installTree(workspace.id);
    await f.dispatch(workspace.id, ["leaf-one", "leaf-two"]);
    const serviceRoot = f.workspaces.resolve(workspace.id).root;
    const corrupted = loadEngineering(serviceRoot);
    corrupted.runs.find(run => run.node_id === "leaf-two")!.handoff!.contract_key = "corrupted-contract";
    saveEngineering(serviceRoot, corrupted, corrupted.revision);
    const packet = await f.packet(workspace.id);
    expect(packet.claimable).toBe(false);
    expect(packet.blocked_reason).toContain("合同不一致");
    const before = f.view(workspace.id).document;
    const refused = await f.call(workspace.id, "POST", `/zones/${encodeURIComponent(packet.zone.id)}/claim`, { contract_key: packet.contract_key }, 409, f.headers("a", workspace.source_cwd));
    expect(refused.json().code).toBe("engineering_zone_run_contract_mismatch");
    expect(f.view(workspace.id).document).toEqual(before);
    expect(before.runs.every(run => run.handoff?.state === "awaiting_claim" && !run.handoff.claimed_at && !run.handoff.claimed_by)).toBe(true);
  });

  it("rejects unassigned and mixed zones even for authenticated Agents", async () => {
    const f = await fixture();
    const unassigned = await f.connect("zone-unassigned");
    f.hook("zone-unassigned", unassigned.source_cwd);
    f.installTree(unassigned.id, { zoneOwner: "未分配" });
    const unassignedPacket = await f.packet(unassigned.id);
    expect(unassignedPacket.zone.owner_state).toBe("unassigned");
    expect(unassignedPacket.claimable).toBe(false);
    const noOwner = await f.call(unassigned.id, "POST", `/zones/${encodeURIComponent(unassignedPacket.zone.id)}/claim`, { contract_key: unassignedPacket.contract_key }, 409, f.headers("zone-unassigned", unassigned.source_cwd));
    expect(noOwner.json().code).toBe("engineering_zone_owner_required");

    const mixed = await f.connect("zone-mixed");
    f.hook("mixed-a", mixed.source_cwd);
    f.hook("mixed-b", mixed.source_cwd);
    f.installTree(mixed.id, { zoneOwner: "codex:mixed-a", secondLeafOwner: "codex:mixed-b" });
    const mixedPacket = await f.packet(mixed.id);
    expect(mixedPacket.zone.owner_state).toBe("mixed");
    expect(mixedPacket.zone.agent_owners).toEqual(["codex:mixed-a", "codex:mixed-b"]);
    expect(mixedPacket.claimable).toBe(false);
    const mixedOwner = await f.call(mixed.id, "POST", `/zones/${encodeURIComponent(mixedPacket.zone.id)}/claim`, { contract_key: mixedPacket.contract_key }, 409, f.headers("mixed-a", mixed.source_cwd));
    expect(mixedOwner.json().code).toBe("engineering_zone_owner_mixed");
  });
});
