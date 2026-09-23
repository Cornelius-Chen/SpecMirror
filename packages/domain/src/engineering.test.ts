import { describe, expect, it } from "vitest";
import {
  EngineeringNodeSchema, currentEngineeringRun, deriveEngineeringView, effectiveEngineeringConstraints, engineeringContractKey,
  engineeringLineage, engineeringNodesConflict, engineeringPathViolation, previewEngineeringChange, validateEngineeringDocument,
  type EngineeringDocument, type EngineeringNode, type EngineeringRun
} from "./engineering.ts";

function node(id: string, parent: string | null, extra: Partial<EngineeringNode> = {}): EngineeringNode {
  return EngineeringNodeSchema.parse({ id, parent_id: parent, kind: parent ? "step" : "project", title: id,
    objective: id + "的明确成果", order: 0, revision: 1, status: "ready", constraints: { allow: parent ? [] : ["output/**"], deny: [], rules: [], resources: [] },
    criteria: [{ id: id + "-criterion", text: "满足目标", kind: "manual" }], contributes_to: parent ? [parent + "-criterion"] : [],
    actions: parent ? [{ id: id + "-action", title: "写出成果", type: "write_file", path: "output/" + id + ".txt", content: "actual result" }] : [],
    created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z", ...extra });
}
function document(nodes: EngineeringNode[]): EngineeringDocument {
  return { schema_version: 1, id: "engine", root_id: "project", revision: 1, created_at: "now", updated_at: "now", nodes, runs: [], changes: [], events: [], capability_uses: [] };
}
function run(doc: EngineeringDocument, id: string, status: EngineeringRun["status"] = "accepted"): EngineeringRun {
  const target = doc.nodes.find((item) => item.id === id)!;
  return { id: "run-" + id + "-" + doc.runs.length, node_id: id, mode: "controlled", status, actor: "executor",
    snapshot: { node: structuredClone(target), lineage: engineeringLineage(doc, id).map((item) => ({ id: item.id, revision: item.revision })), effective: effectiveEngineeringConstraints(doc, id), contract_key: engineeringContractKey(doc, id), dependencies: [], children: [] },
    started_at: "now", finished_at: "later", current_action: "", completed_action_ids: [], evidence: [{ id: "evidence", criterion_id: "", kind: "artifact", summary: "actual file", path: "output/result.txt", passed: null, created_at: "now" }], output_dir: "isolated", reason: "", review_note: "", reviewed_at: null };
}

describe("recursive engineering contracts", () => {
  it("shows a rechecked plan as ready after rejection without accepting its historical evidence", () => {
    const doc = document([node("project", null), node("step", "project")]);
    const rejected = run(doc, "step", "rejected");doc.runs.push(rejected);
    doc.nodes[1].status = "needs_revision";
    expect(deriveEngineeringView(doc).derived.step.status).toBe("needs_revision");
    doc.nodes[1].revision++;doc.nodes[1].method = "按退回要求修订并重新检查";doc.nodes[1].status = "ready";
    doc.events.push({id:"checked",node_id:"step",kind:"plan",at:"now",message:"已检查当前方案",readiness_contract_key:engineeringContractKey(doc,"step")});
    const checked = deriveEngineeringView(doc);
    expect(checked.derived.step.status).toBe("ready");expect(checked.derived.step.can_run).toBe(true);
    expect(checked.derived.project.counts.accepted).toBe(0);expect(doc.runs[0].status).toBe("rejected");
  });
  it("requires every ancestor allow layer and unions denials with their source", () => {
    const doc = document([node("project", null), node("task", "project", { constraints: { allow: ["output/design/**"], deny: ["**/private.*"], rules: ["保留事实来源"], resources: [] } }), node("step", "task", { constraints: { allow: ["**"], deny: [], rules: [], resources: [] } })]);
    const scope = effectiveEngineeringConstraints(doc, "step");
    expect(engineeringPathViolation(scope, "output/design/page.html")).toBeNull();
    expect(engineeringPathViolation(scope, "output/code/main.ts")).toContain("task");
    expect(engineeringPathViolation(scope, "other/page.html")).toContain("project");
    expect(engineeringPathViolation(scope, "output/design/private.json")).toContain("禁止范围");
    expect(scope.rules).toEqual([{ node_id: "task", title: "task", text: "保留事实来源" }]);
  });

  it("refuses traversal, absolute paths, management files and undeclared output ranges", () => {
    const scope = effectiveEngineeringConstraints(document([node("project", null, { constraints: { allow: ["**"], deny: [], rules: [], resources: [] } })]), "project");
    for (const path of ["../secret", "x/../secret", "D:/secret", "/root/secret", "x\\..\\secret", "out/.git/config", ".project/project.yaml"]) expect(engineeringPathViolation(scope, path)).not.toBeNull();
    expect(engineeringPathViolation({ ...scope, allow_layers: [] }, "output/result.txt")).toContain("尚未声明");
  });

  it("validates arbitrary depth and rejects parent-dependency deadlocks", () => {
    const doc = document([node("project", null), node("a", "project"), node("b", "a"), node("c", "b"), node("d", "c")]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringLineage(doc, "d").map((item) => item.id)).toEqual(["project", "a", "b", "c", "d"]);
    doc.nodes[1].dependencies = ["d"];
    expect(validateEngineeringDocument(doc).join(" ")).toMatch(/不能依赖|循环/);
  });

  it("detects cycles combining group completion and leaf dependencies", () => {
    const doc = document([node("project", null), node("group", "project"), node("leaf", "group"), node("other", "project", { dependencies: ["group"] })]);
    doc.nodes[2].dependencies = ["other"];
    expect(validateEngineeringDocument(doc).join(" ")).toContain("循环");
  });

  it("inherits task dependencies and requires current accepted versions", () => {
    const doc = document([node("project", null), node("source", "project"), node("group", "project", { dependencies: ["source"] }), node("leaf", "group")]);
    expect(deriveEngineeringView(doc).derived.leaf.blockers.join(" ")).toContain("等待“source”");
    doc.runs.push(run(doc, "source"));
    expect(deriveEngineeringView(doc).derived.leaf.can_run).toBe(true);
    doc.nodes[1].revision++;
    expect(deriveEngineeringView(doc).derived.leaf.can_run).toBe(false);
  });

  it("changes only the affected branch, downstream and ancestor acceptance", () => {
    const doc = document([node("project", null), node("left", "project"), node("right", "project"), node("downstream", "project", { dependencies: ["left"] })]);
    doc.runs.push(run(doc, "left", "running"), run(doc, "right", "running"));
    const preview = previewEngineeringChange(doc, { ...doc.nodes[1], method: "先制作对照样例" });
    expect(preview.affected_ids.sort()).toEqual(["downstream", "left", "project"]);
    expect(preview.running_ids).toEqual([doc.runs[0].id]);
    expect(preview.invalidated_run_ids).not.toContain(doc.runs[1].id);
  });

  it("invalidates ancestor acceptance even when a descendant retains its identity", () => {
    const doc = document([node("project", null), node("leaf", "project")]);
    doc.runs.push(run(doc, "leaf")); doc.runs.push(run(doc, "project"));
    expect(deriveEngineeringView(doc).derived.project.status).toBe("accepted");
    doc.nodes[1].revision++;
    expect(deriveEngineeringView(doc).derived.project.status).toBe("needs_revision");
    expect(doc.runs[1].status).toBe("accepted");
  });

  it("does not accept a parent by averaging child completion", () => {
    const doc = document([node("project", null), node("a", "project"), node("b", "project")]);
    doc.runs.push(run(doc, "a"), run(doc, "b"));
    const view = deriveEngineeringView(doc);
    expect(view.derived.project.counts).toMatchObject({ total: 2, accepted: 2 });
    expect(view.derived.project.status).toBe("ready");
    expect(view.derived.project.can_run).toBe(true);
    expect(view.derived.project.can_accept).toBe(false);
  });

  it("requires coverage of every parent criterion before integration", () => {
    const doc = document([node("project", null), node("a", "project", { contributes_to: [] })]);
    doc.runs.push(run(doc, "a"));
    expect(deriveEngineeringView(doc).derived.project.uncovered_criteria).toEqual(["project-criterion"]);
    expect(deriveEngineeringView(doc).derived.project.can_run).toBe(false);
  });

  it("does not let a human verdict replace a failed automatic check", () => {
    const leaf = node("a", "project", { criteria: [{ id: "automatic", text: "包含数据来源", kind: "file_contains", path: "output/a.txt", expected: "来源" }] });
    const doc = document([node("project", null), leaf]);
    const candidate = run(doc, "a", "review");
    candidate.evidence.push({ id: "human-claim", criterion_id: "automatic", kind: "human", summary: "我认为通过", passed: true, created_at: "now" });
    doc.runs.push(candidate);
    expect(deriveEngineeringView(doc).derived.a.can_accept).toBe(false);
    candidate.evidence.push({ id: "executor-check", criterion_id: "automatic", kind: "check", summary: "实际检查通过", passed: true, created_at: "now" });
    expect(deriveEngineeringView(doc).derived.a.can_accept).toBe(true);
  });

  it("locks overlapping output paths and shared resources while allowing independent files", () => {
    const doc = document([node("project", null), node("a", "project"), node("b", "project")]);
    expect(engineeringNodesConflict(doc, "a", "b")).toBe(false);
    doc.nodes[2].actions[0].path = "output/a.txt";
    expect(engineeringNodesConflict(doc, "a", "b")).toBe(true);
    doc.nodes[2].actions[0].path = "output/b.txt";
    doc.nodes[1].constraints.resources = ["shared-schema"]; doc.nodes[2].constraints.resources = ["shared-schema"];
    expect(engineeringNodesConflict(doc, "a", "b")).toBe(true);
  });

  it("keeps a queued task current when an unchanged pending dependency passes", () => {
    const doc = document([node("project", null), node("a", "project"), node("b", "project", { dependencies: ["a"] })]);
    const queued = run(doc, "b", "queued"); doc.runs.push(queued);
    doc.runs.push(run(doc, "a"));
    expect(currentEngineeringRun(doc, "b")?.id).toBe(queued.id);
    doc.nodes[1].revision++;
    expect(currentEngineeringRun(doc, "b")).toBeUndefined();
  });

  it("includes downstream consumers of the new parent when moving a step", () => {
    const doc = document([node("project", null), node("old", "project"), node("next", "project"), node("leaf", "old"), node("consumer", "project", { dependencies: ["next"] }), node("unrelated", "project")]);
    const preview = previewEngineeringChange(doc, { ...doc.nodes[3], parent_id: "next", contributes_to: ["next-criterion"] });
    expect(preview.affected_ids.sort()).toEqual(["consumer", "leaf", "next", "old", "project"]);
  });

  it("keeps agent generated outputs within the same scope and resource locks", () => {
    const doc = document([node("project", null), node("a", "project"), node("b", "project")]);
    doc.nodes[1].actions[0].type = "agent_artifact";
    doc.nodes[1].actions[0].content = "";
    expect(deriveEngineeringView(doc).derived.a.can_run).toBe(true);
    doc.nodes[2].actions[0].path = "output/a.txt";
    expect(engineeringNodesConflict(doc, "a", "b")).toBe(true);
    doc.nodes[1].actions[0].path = "outside/result.md";
    expect(deriveEngineeringView(doc).derived.a.can_run).toBe(false);
  });

  it("keeps historical dependency links but refuses active tasks relying on archives", () => {
    const doc = document([node("project", null), node("a", "project", { status: "archived" }), node("b", "project", { status: "archived", dependencies: ["a"] })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    doc.nodes[2].status = "draft";
    expect(validateEngineeringDocument(doc).join(" ")).toContain("不能依赖已归档");
  });

  it("invalidates transitively accepted evidence when an upstream accepted run is replaced", () => {
    const doc = document([node("project", null), node("a", "project"), node("b", "project", { dependencies: ["a"] }), node("c", "project", { dependencies: ["b"] })]);
    doc.runs.push(run(doc, "a")); doc.runs.push(run(doc, "b")); doc.runs.push(run(doc, "c")); doc.runs.push(run(doc, "project"));
    const frozenC = doc.runs[2].snapshot.contract_key;
    expect(currentEngineeringRun(doc, "c")?.status).toBe("accepted");
    doc.runs.push(run(doc, "a"));
    expect(engineeringContractKey(doc, "c")).toBe(frozenC);
    expect(currentEngineeringRun(doc, "b")).toBeUndefined();
    expect(currentEngineeringRun(doc, "c")).toBeUndefined();
    expect(currentEngineeringRun(doc, "project")).toBeUndefined();
    expect(doc.runs[2].status).toBe("accepted");
  });
});
