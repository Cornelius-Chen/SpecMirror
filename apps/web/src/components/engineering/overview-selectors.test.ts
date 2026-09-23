import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView, effectiveEngineeringConstraints, engineeringContractKey, engineeringLineage, type EngineeringDocument, type EngineeringNode, type EngineeringRun } from "@epm/domain";
import { acceptanceRows, currentReadingPhase, localDependencyView, nodeReadState, overviewIndex, readingIssues, subtreeProgress, OVERVIEW_EDGE_LIMIT, OVERVIEW_GRAPH_LIMIT } from "./overview-selectors.ts";

const stamp = "2026-09-05T00:00:00Z";
function node(id: string, parent: string | null, extra: Partial<EngineeringNode> = {}): EngineeringNode {
  return EngineeringNodeSchema.parse({ id, parent_id: parent, title: "可完整阅读的中文任务 " + id, kind: parent ? "task" : "project", objective: "形成真实可核对结果", owner: "未分配", order: 0, revision: 1, status: "draft", constraints: { allow: parent ? [] : ["output/**"], deny: [], rules: [], resources: [] }, criteria: [{ id: id + "-criterion", text: id + "验收条件", kind: "manual" }], created_at: stamp, updated_at: stamp, ...extra });
}
function document(nodes: EngineeringNode[]): EngineeringDocument { return { schema_version: 1, id: "fixture", root_id: "root", revision: 1, created_at: stamp, updated_at: stamp, nodes, runs: [], events: [], changes: [], capability_uses: [] }; }
function run(doc: EngineeringDocument, id: string, status: EngineeringRun["status"] = "review"): EngineeringRun {
  const target = doc.nodes.find(item => item.id === id)!;
  return { id: "run-" + id + "-" + doc.runs.length, node_id: id, mode: "external", status, actor: "fixture", snapshot: { node: structuredClone(target), lineage: engineeringLineage(doc, id).map(item => ({ id: item.id, revision: item.revision })), effective: effectiveEngineeringConstraints(doc, id), contract_key: engineeringContractKey(doc, id), dependencies: [], children: [] }, started_at: stamp, finished_at: stamp, current_action: "", completed_action_ids: [], evidence: [], output_dir: "fixture", reason: "", review_note: "", reviewed_at: null };
}
const artifact = (criterion = "") => ({ id: "artifact", criterion_id: criterion, kind: "artifact" as const, path: "output/result.txt", sha256: "a".repeat(64), summary: "真实文件摘要", passed: true, created_at: stamp });
const check = (id: string) => ({ id: "check-" + id, criterion_id: id, kind: "check" as const, summary: "实际检查", passed: true, created_at: stamp });

describe("read-only engineering overview semantics", () => {
  it("suggests the newest active root phase without changing the plan, and respects explicit choices", () => {
    const doc = document([node("root", null), node("old", "root"), node("new", "root", { created_at: "2026-09-06T00:00:00Z", order: 1 }), node("archived", "root", { created_at: "2026-09-07T00:00:00Z", status: "archived" })]);
    const before = JSON.stringify(doc), index = overviewIndex(deriveEngineeringView(doc));
    expect(currentReadingPhase(index)).toMatchObject({ suggested: true, phase: { id: "new" } });
    expect(currentReadingPhase(index, "old")).toMatchObject({ suggested: false, phase: { id: "old" } });
    expect(currentReadingPhase(index, "archived").phase?.id).toBe("new");
    localDependencyView(index, "new"); acceptanceRows(index, "new"); readingIssues(index); subtreeProgress(index, "new");
    expect(JSON.stringify(doc)).toBe(before);
  });
  it("keeps actual output, completed checks and human acceptance as separate states", () => {
    const doc = document([node("root", null), node("phase", "root"), node("step", "phase", { criteria: [{ id: "a", text: "自动条件 A", kind: "file_exists", path: "output/a.txt", expected: "" }, { id: "b", text: "自动条件 B", kind: "file_exists", path: "output/b.txt", expected: "" }] })]);
    const current = run(doc, "step"); current.evidence.push(artifact("a"), check("a")); doc.runs.push(current);
    expect(nodeReadState(overviewIndex(deriveEngineeringView(doc)), "step")).toMatchObject({ produced: true, checked: false, accepted: false });
    current.evidence.push(check("b"));
    expect(subtreeProgress(overviewIndex(deriveEngineeringView(doc)), "phase")).toMatchObject({ total: 1, produced: 1, checked: 1, accepted: 0 });
    current.status = "running";
    expect(nodeReadState(overviewIndex(deriveEngineeringView(doc)), "step").checked).toBe(false);
    current.status = "accepted"; current.reviewed_at = stamp;
    expect(nodeReadState(overviewIndex(deriveEngineeringView(doc)), "step")).toMatchObject({ produced: true, checked: true, accepted: true });
    expect(subtreeProgress(overviewIndex(deriveEngineeringView(doc)), "phase")).toMatchObject({ total: 1, accepted: 1, unresolved: 1 });
  });
  it("does not reuse stale accepted output or checks for a changed current contract", () => {
    const doc = document([node("root", null), node("phase", "root"), node("step", "phase")]), previous = run(doc, "step", "accepted");
    previous.evidence.push(artifact(), check("step-criterion")); doc.runs.push(previous); doc.nodes[2].revision++;
    const index = overviewIndex(deriveEngineeringView(doc));
    expect(nodeReadState(index, "step")).toMatchObject({ produced: false, checked: false, accepted: false, historicalOnly: true, evidenceCount: 0 });
    expect(acceptanceRows(index, "step")[0]).toMatchObject({ historicalOnly: true, evidence: [] });
  });
  it("shows inherited and cross-phase prerequisites without turning parent-child membership into a dependency", () => {
    const doc = document([node("root", null), node("phase", "root", { dependencies: ["external"] }), node("step", "phase"), node("external", "root"), node("downstream", "root", { dependencies: ["step"] })]);
    const graph = localDependencyView(overviewIndex(deriveEngineeringView(doc)), "phase");
    expect(graph.links).toEqual(expect.arrayContaining([expect.objectContaining({ from: "external", to: "step", inherited: true, origin: "phase", crossPhase: true }), expect.objectContaining({ from: "step", to: "downstream", crossPhase: true })]));
    expect(graph.links.some(link => link.from === "phase" && link.to === "step")).toBe(false);
    expect(graph.externalIds).toEqual(new Set(["external", "downstream"]));
    expect(graph.nodes.every(item => doc.nodes.some(source => source.id === item.id))).toBe(true);
  });
  it("bounds large graphs and explicitly accounts for hidden tasks and dependency edges", () => {
    const nodes = [node("root", null), node("phase", "root")];
    for (let i = 0; i < 18; i++) nodes.push(node("external-" + i, "root"));
    for (let i = 0; i < 160; i++) nodes.push(node("step-" + i, "phase", { order: i, dependencies: Array.from({ length: 18 }, (_, j) => "external-" + j) }));
    const graph = localDependencyView(overviewIndex(deriveEngineeringView(document(nodes))), "phase");
    expect(graph.nodes.length).toBeLessThanOrEqual(OVERVIEW_GRAPH_LIMIT); expect(graph.links.length).toBeLessThanOrEqual(OVERVIEW_EDGE_LIMIT);
    expect(graph.hiddenNodes + graph.nodes.filter(item => !graph.externalIds.has(item.id)).length).toBe(160);
    expect(graph.hiddenExternalNodes + graph.externalIds.size).toBe(18); expect(graph.hiddenLinks).toBeGreaterThan(0);
  });
  it("keeps one direct-child level visible and unfolds only the selected task's steps", () => {
    const nodes = [node("root", null), node("phase", "root", { dependencies: ["external"] }), node("external", "root")];
    for (let task = 0; task < 7; task++) {
      nodes.push(node("task-" + task, "phase", { order: task, dependencies: task ? ["task-" + (task - 1)] : [] }));
      for (let step = 0; step < 3; step++) nodes.push(node(`task-${task}-step-${step}`, "task-" + task, { order: step, dependencies: step ? [`task-${task}-step-${step - 1}`] : [] }));
    }
    const index = overviewIndex(deriveEngineeringView(document(nodes))), phase = localDependencyView(index, "phase");
    expect(phase.nodes.filter(item => !phase.externalIds.has(item.id)).map(item => item.id)).toEqual(Array.from({ length: 7 }, (_, i) => "task-" + i));
    expect(phase.nodes.some(item => item.id === "phase" || item.id.includes("-step-"))).toBe(false);
    expect(phase).toMatchObject({ levelTotal: 7, hiddenPeers: 0, hiddenDescendants: 21, hiddenNodes: 21 });
    const task = localDependencyView(index, "task-1");
    expect(task.nodes.filter(item => !task.externalIds.has(item.id)).map(item => item.id)).toEqual(["task-1-step-0", "task-1-step-1", "task-1-step-2"]);
    expect(task.links).toEqual(expect.arrayContaining([expect.objectContaining({ from: "external", to: "task-1-step-0", inherited: true, crossPhase: true }), expect.objectContaining({ from: "task-0", to: "task-1-step-0", inherited: true, crossPhase: false })]));
    expect(task).toMatchObject({ hiddenDescendants: 0, hiddenPeers: 0 });
  });
  it("accounts exactly for a lower-level prerequisite when it must be shown alongside the current level", () => {
    const index = overviewIndex(deriveEngineeringView(document([node("root", null), node("phase", "root"), node("a", "phase", { dependencies: ["b-step"] }), node("b", "phase"), node("b-step", "b"), node("b-folded", "b")])));
    const graph = localDependencyView(index, "phase");
    expect(graph.externalIds).toEqual(new Set(["b-step"]));
    expect(graph).toMatchObject({ levelTotal: 2, totalPhaseNodes: 4, hiddenNodes: 1, hiddenDescendants: 1, hiddenPeers: 0 });
    expect(graph.links).toEqual([expect.objectContaining({ from: "b-step", to: "a", crossPhase: false })]);
  });
  it("maps parent criteria only through declared contributions and retains the true owner of evidence", () => {
    const doc = document([node("root", null, { criteria: [{ id: "overall", kind: "manual", text: "工程整体验收", path: "", expected: "" }, { id: "unrelated", kind: "manual", text: "其他分支负责", path: "", expected: "" }] }), node("phase", "root", { contributes_to: ["overall"], criteria: [{ id: "p1", kind: "manual", text: "有人承接", path: "", expected: "" }, { id: "p2", kind: "manual", text: "无人承接", path: "", expected: "" }] }), node("child", "phase", { contributes_to: ["p1"] })]);
    const childRun = run(doc, "child", "accepted"); childRun.evidence.push(artifact("child-criterion"), check("child-criterion")); doc.runs.push(childRun);
    const rows = acceptanceRows(overviewIndex(deriveEngineeringView(doc)), "phase");
    expect(rows.map(row => row.id)).toEqual(["phase/p1", "phase/p2", "root/overall"]);
    expect(rows[0]).toMatchObject({ evidence: [], uncovered: false, contributors: [{ node: { id: "child" }, state: { accepted: true } }], ownerState: { accepted: false } });
    expect(rows[1]).toMatchObject({ uncovered: true, contributors: [] });
    expect(rows[2]).toMatchObject({ inherited: true, owner: { id: "root" }, contributors: [{ node: { id: "phase" } }] });
  });
  it("keeps missing criteria and unassigned work visible across other phases", () => {
    const doc = document([node("root", null), node("selected", "root"), node("other", "root"), node("missing", "other", { criteria: [] }), node("unassigned", "other")]), index = overviewIndex(deriveEngineeringView(doc));
    const issues = readingIssues(index);
    expect(issues.find(issue => issue.node.id === "missing")).toMatchObject({ tab: "criteria", priority: 2 });
    expect(issues.find(issue => issue.node.id === "unassigned")?.reason).toContain("负责人");
    expect(subtreeProgress(index, "other").unresolved).toBe(3);
  });
  it("has truthful empty states for a leaf without dependencies or criteria", () => {
    const index = overviewIndex(deriveEngineeringView(document([node("root", null, { criteria: [] })])));
    expect(currentReadingPhase(index)).toMatchObject({ phases: [], suggested: false, phase: { id: "root" } });
    expect(localDependencyView(index, "root")).toMatchObject({ links: [], hiddenNodes: 0, hiddenLinks: 0, missingIds: [] });
    expect(acceptanceRows(index, "root")).toEqual([]);
  });
});
