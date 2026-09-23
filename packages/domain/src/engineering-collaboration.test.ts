import { describe, expect, it } from "vitest";
import {
  EngineeringNodeSchema,
  deriveEngineeringCollaborationPlan,
  effectiveEngineeringAgentOwner,
  effectiveEngineeringConstraints,
  engineeringAgentAssignment,
  engineeringContractKey,
  engineeringLineage,
  engineeringZoneContractKey,
  type EngineeringDocument,
  type EngineeringNode,
  type EngineeringRun
} from "./index.ts";

function node(id: string, parentId: string | null, extra: Partial<EngineeringNode> = {}): EngineeringNode {
  return EngineeringNodeSchema.parse({
    id,
    parent_id: parentId,
    kind: parentId ? "task" : "project",
    title: id,
    objective: `完成${id}成果`,
    owner: "未分配",
    order: 0,
    revision: 1,
    status: "ready",
    dependencies: [],
    contributes_to: parentId ? [`${parentId}-done`] : [],
    constraints: { allow: parentId ? [] : ["output/**"], deny: [], rules: [], resources: [] },
    criteria: [{ id: `${id}-done`, text: `${id}成果可用`, kind: "manual" }],
    actions: parentId ? [{ id: `${id}-write`, title: `写出${id}`, type: "write_file", path: `output/${id}.txt`, content: id }] : [],
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T00:00:00Z",
    ...extra
  });
}

function document(nodes: EngineeringNode[]): EngineeringDocument {
  return {
    schema_version: 1,
    id: "engineering",
    revision: 1,
    root_id: "project",
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T00:00:00Z",
    nodes,
    runs: [],
    events: [],
    changes: [],
    capability_uses: []
  };
}

function awaitingRun(doc: EngineeringDocument, nodeId: string, owner: string): EngineeringRun {
  const target = doc.nodes.find(item => item.id === nodeId)!;
  const contractKey = engineeringContractKey(doc, nodeId);
  return {
    id: `run-${nodeId}`,
    node_id: nodeId,
    mode: "external",
    status: "queued",
    actor: owner,
    snapshot: {
      node: structuredClone(target),
      lineage: engineeringLineage(doc, nodeId).map(item => ({ id: item.id, revision: item.revision })),
      effective: effectiveEngineeringConstraints(doc, nodeId),
      contract_key: contractKey,
      dependencies: [],
      children: []
    },
    started_at: "2026-09-07T00:00:00Z",
    finished_at: null,
    current_action: "",
    completed_action_ids: [],
    evidence: [],
    output_dir: "isolated",
    reason: "",
    review_note: "",
    reviewed_at: null,
    handoff: {
      state: "awaiting_claim",
      owner,
      source_cwd: "D:/work/project",
      document_revision: doc.revision,
      contract_key: contractKey,
      created_at: "2026-09-07T00:00:00Z"
    }
  };
}

function acceptedRun(doc: EngineeringDocument, nodeId: string): EngineeringRun {
  const run = awaitingRun(doc, nodeId, "executor");
  run.mode = "controlled";
  run.status = "accepted";
  run.finished_at = "2026-09-07T00:01:00Z";
  delete run.handoff;
  return run;
}

describe("Agent collaboration zone projection", () => {
  it("projects direct child subtrees as stable zones at any requested level", () => {
    const doc = document([
      node("project", null),
      node("platform", "project"),
      node("frontend", "platform"),
      node("backend", "platform"),
      node("research", "project")
    ]);

    const rootPlan = deriveEngineeringCollaborationPlan(doc);
    expect(rootPlan.zones.map(zone => zone.id)).toEqual(["zone:platform", "zone:research"]);
    expect(rootPlan.zones[0]).toMatchObject({ root_node_id: "platform", node_ids: ["platform", "backend", "frontend"], leaf_ids: ["backend", "frontend"] });

    const branchPlan = deriveEngineeringCollaborationPlan(doc, "platform");
    expect(branchPlan.zones.map(zone => zone.id)).toEqual(["zone:backend", "zone:frontend"]);
    expect(branchPlan.scope_root_id).toBe("platform");
  });

  it("inherits only the nearest explicit Codex owner and marks partial or different ownership mixed", () => {
    const doc = document([
      node("project", null, { owner: "项目负责人" }),
      node("build", "project", { owner: "codex:agent-a" }),
      node("build-a", "build"),
      node("build-b", "build", { owner: "codex:agent-b" }),
      node("docs", "project"),
      node("docs-a", "docs")
    ]);

    expect(effectiveEngineeringAgentOwner(doc, "build-a")).toBe("codex:agent-a");
    expect(engineeringAgentAssignment(doc, "build-a")).toMatchObject({ owner_source_node_id: "build", inherited: true });
    expect(effectiveEngineeringAgentOwner(doc, "docs-a")).toBeNull();
    const plan = deriveEngineeringCollaborationPlan(doc);
    expect(plan.zones.find(zone => zone.id === "zone:build")).toMatchObject({
      owner_state: "mixed", effective_agent_owner: null, agent_owners: ["codex:agent-a", "codex:agent-b"], available_leaf_ids: []
    });
    expect(plan.zones.find(zone => zone.id === "zone:docs")).toMatchObject({
      owner_state: "unassigned", effective_agent_owner: null, available_leaf_ids: ["docs-a"]
    });
  });

  it("does not hide an internal ownership boundary behind uniformly assigned leaves", () => {
    const doc = document([
      node("project", null, { owner: "项目负责人" }),
      node("build", "project", { owner: "codex:agent-a" }),
      node("review-gate", "build", { owner: "人工复核" }),
      node("deliverable", "review-gate", { owner: "codex:agent-a" })
    ]);

    const zone = deriveEngineeringCollaborationPlan(doc).zones[0]!;
    expect(zone).toMatchObject({ owner_state: "mixed", effective_agent_owner: null, agent_owners: ["codex:agent-a"] });
    expect(engineeringAgentAssignment(doc, "review-gate").effective_agent_owner).toBeNull();
  });

  it("keeps broad ancestor output permission from serializing independent sibling zones", () => {
    const doc = document([
      node("project", null, { constraints: { allow: ["**"], deny: [], rules: ["保留事实来源"], resources: [] } }),
      node("frontend", "project", { actions: [{ id: "front-write", title: "写界面", type: "write_file", path: "output/front.html", content: "front", criterion_id: "", capability_id: "" }] }),
      node("backend", "project", { actions: [{ id: "back-write", title: "写接口", type: "write_file", path: "output/api.json", content: "api", criterion_id: "", capability_id: "" }] })
    ]);

    const plan = deriveEngineeringCollaborationPlan(doc);
    expect(plan.conflicts).toEqual([]);
    expect(plan.zones.every(zone => zone.covenants.rules.some(rule => rule.text === "保留事实来源"))).toBe(true);
  });

  it("turns delivery and prerequisites into waits while keeping runtime interaction nonblocking", () => {
    const source = node("source", "project", {
      delivery: { included: ["数据集"], excluded: [], outputs: [{ id: "dataset", title: "清洗数据", criterion_ids: ["source-done"] }], inputs: [] },
      interactions: [{ id: "runtime-sync", target_node_id: "consumer", source_output_id: "", target_input_id: "", purpose: "运行状态同步", scenario: "联调" }]
    });
    const consumer = node("consumer", "project", {
      delivery: { included: ["分析结果"], excluded: [], outputs: [], inputs: [{ id: "data-in", title: "研究数据", source_node_id: "source", source_output_id: "dataset", external_source: "" }] }
    });
    const report = node("report", "project", { prerequisites: [{ id: "wait-consumer", node_id: "consumer", reason: "分析结果完成后才能汇总" }] });
    const doc = document([node("project", null), source, consumer, report]);

    const plan = deriveEngineeringCollaborationPlan(doc);
    expect(plan.handoffs.map(item => [item.kind, item.from_zone_id, item.to_zone_id, item.blocking])).toEqual([
      ["delivery", "zone:source", "zone:consumer", true],
      ["interaction", "zone:source", "zone:consumer", false],
      ["prerequisite", "zone:consumer", "zone:report", true]
    ]);
    expect(plan.conflicts.filter(item => item.kind === "hard_dependency")).toHaveLength(2);
    expect(plan.conflicts.find(item => item.waiting_zone_id === "zone:consumer")).toMatchObject({ effect: "wait", required_zone_id: "zone:source" });

    const sourceZoneKey = engineeringZoneContractKey(doc, "source");
    const consumerZoneKey = engineeringZoneContractKey(doc, "consumer");
    doc.runs.push(acceptedRun(doc, "source"));
    const sourceAccepted = deriveEngineeringCollaborationPlan(doc);
    expect(sourceAccepted.handoffs.find(item => item.kind === "delivery")).toMatchObject({ requires_acceptance: true, active_wait: false, blocking: false });
    expect(sourceAccepted.handoffs).toHaveLength(3);
    expect(sourceAccepted.conflicts.filter(item => item.kind === "hard_dependency")).toHaveLength(1);
    expect(engineeringZoneContractKey(doc, "source")).toBe(sourceZoneKey);
    expect(engineeringZoneContractKey(doc, "consumer")).toBe(consumerZoneKey);

    doc.runs.push(acceptedRun(doc, "consumer"));
    const allAccepted = deriveEngineeringCollaborationPlan(doc);
    expect(allAccepted.handoffs).toHaveLength(3);
    expect(allAccepted.conflicts.filter(item => item.kind === "hard_dependency")).toEqual([]);
  });

  it("serializes only explicitly shared resources or provably overlapping direct write scopes", () => {
    const sourceScope = (allow: string[]) => ({
      root: "D:/work/project",
      allow,
      deny: [],
      checks: [{ id: "typecheck", title: "类型检查", program: "node" as const, args: ["scripts/typecheck.mjs"] }]
    });
    const doc = document([
      node("project", null),
      node("web", "project", { source_scope: sourceScope(["packages/shared/**"]), constraints: { allow: [], deny: [], rules: [], resources: ["browser"] } }),
      node("api", "project", { source_scope: sourceScope(["packages/shared/api/**"]), constraints: { allow: [], deny: [], rules: [], resources: ["browser"] } }),
      node("docs", "project", { source_scope: sourceScope(["docs/**"]) })
    ]);

    const plan = deriveEngineeringCollaborationPlan(doc);
    expect(plan.conflicts.filter(item => item.kind === "shared_resource")).toEqual([
      expect.objectContaining({ left_zone_id: "zone:api", right_zone_id: "zone:web", resource: "browser", effect: "serialize" })
    ]);
    expect(plan.conflicts.filter(item => item.kind === "write_path_overlap")).toEqual([
      expect.objectContaining({ left_zone_id: "zone:api", right_zone_id: "zone:web", effect: "serialize" })
    ]);
    expect(plan.conflicts.some(item => item.left_zone_id === "zone:docs" || item.right_zone_id === "zone:docs")).toBe(false);
  });

  it("keeps a zone key stable across unrelated revisions and changes it for member or interface revisions", () => {
    const a = node("a", "project", { delivery: { included: [], excluded: [], outputs: [{ id: "a-output", title: "A输出", criterion_ids: ["a-done"] }], inputs: [] } });
    const b = node("b", "project", { delivery: { included: [], excluded: [], outputs: [], inputs: [{ id: "a-input", title: "A输入", source_node_id: "a", source_output_id: "a-output", external_source: "" }] } });
    const c = node("c", "project");
    const doc = document([node("project", null), a, b, c]);
    const original = engineeringZoneContractKey(doc, "a");

    doc.revision = 99;
    doc.nodes[0]!.title = "只修改项目显示名称";
    doc.nodes[0]!.revision += 1;
    expect(engineeringZoneContractKey(doc, "a")).toBe(original);
    doc.nodes.find(item => item.id === "c")!.contract_revision = 2;
    expect(engineeringZoneContractKey(doc, "a")).toBe(original);
    doc.nodes.find(item => item.id === "a")!.contract_revision = 2;
    const memberChanged = engineeringZoneContractKey(doc, "a");
    expect(memberChanged).not.toBe(original);
    doc.nodes.find(item => item.id === "b")!.contract_revision = 2;
    expect(engineeringZoneContractKey(doc, "a")).not.toBe(memberChanged);
  });

  it("exposes a claim only after an assigned Agent has a current frozen external handoff", () => {
    const doc = document([
      node("project", null),
      node("assigned", "project", { owner: "codex:agent-a" }),
      node("waiting", "project")
    ]);
    expect(deriveEngineeringCollaborationPlan(doc)).toMatchObject({
      claimable_leaf_ids: [], available_leaf_ids: ["waiting"], runnable_leaf_ids: ["assigned", "waiting"], authorized_leaf_ids: ["assigned"]
    });

    doc.runs.push(awaitingRun(doc, "assigned", "codex:agent-a"));
    let plan = deriveEngineeringCollaborationPlan(doc);
    expect(plan.claimable_leaf_ids).toEqual(["assigned"]);
    expect(plan.claimable_run_ids).toEqual(["run-assigned"]);
    expect(plan.available_leaf_ids).toEqual(["waiting"]);

    doc.runs[0]!.handoff!.state = "claimed";
    plan = deriveEngineeringCollaborationPlan(doc);
    expect(plan.claimable_leaf_ids).toEqual([]);
  });
});
