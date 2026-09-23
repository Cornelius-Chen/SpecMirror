import { describe, expect, it } from "vitest";
import { deriveEngineeringView, engineeringContractKey, engineeringLineageVersions, type EngineeringDocument, type EngineeringNode } from "@epm/domain";
import { engineeringFeedbackTargetValue, type EngineeringFeedback } from "../../../../../packages/domain/src/engineering-feedback.ts";
import { inspectorCheck, inspectorDocument, inspectorNode, inspectorRun, inspectorScenario, stamp } from "../../../../../tests/fixtures/project-inspector.ts";
import { selectGraphAttention, selectGraphContext, selectGraphMatches } from "./attention-selectors.ts";

const feedback = (id: string, nodeId: string, extra: Partial<EngineeringFeedback> = {}): EngineeringFeedback => ({
  id, target: { kind: "node", node_id: nodeId }, kind: "defect", note: "这里没有讲清因子为什么有效", status: "open",
  base_document_revision: 1, base_node_revision: 1, base_contract_key: "fixture", base_lineage: [], base_run_id: null,
  target_snapshot: "{}", created_at: stamp, updated_at: stamp, history: [{ at: stamp, action: "create", actor: "用户", note: "这里没有讲清因子为什么有效" }], ...extra
});
const delivery = (id: string): NonNullable<EngineeringNode["delivery"]> => ({ included: ["本项成果"], excluded: [], no_extra_exclusions: true, inputs: [], outputs: [{ id: "result", title: "历史行情", criterion_ids: [id + "-manual"] }] });

function closedPlan(doc: EngineeringDocument, item: EngineeringFeedback) {
  const node = doc.nodes.find(node => node.id === item.target.node_id)!;
  item.status = "resolved"; item.resolution_kind = "plan";
  item.history.push({ at: stamp, action: "resolve", actor: "isolated-test-owner", note: "仅用于验证已有方案处理结论的显示", basis: {
    document_revision: doc.revision, node_revision: node.revision, contract_key: engineeringContractKey(doc, node.id),
    lineage: engineeringLineageVersions(doc, node.id), run_id: null, target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(node, item.target))
  } });
  return item;
}

describe("graph attention from actual engineering records", () => {
  it("does not turn empty drafts, missing owners or inherited ordinary waits into reported failures", () => {
    const doc = inspectorDocument(); doc.nodes[1].criteria = []; doc.nodes[1].objective = "";
    const view = deriveEngineeringView(doc), before = JSON.stringify(view), model = selectGraphAttention(view);
    expect(view.derived.step.blockers.length).toBeGreaterThan(0);
    expect(model.items).toEqual([]); expect(model.totals).toEqual({ all: 0, attention: 0, improvement: 0, feedback: 0 });
    expect(JSON.stringify(view)).toBe(before);
  });
  it("reads failure and rejection only from the current effective run", () => {
    const doc = inspectorDocument(), old = inspectorRun(doc, "step", "blocked"); old.evidence = [inspectorCheck("step-manual", false)]; doc.runs.push(old);
    expect(selectGraphAttention(deriveEngineeringView(doc)).byNode.get("step")!.ownItems[0]).toMatchObject({ label: "检查未通过", runId: old.id, source: "run" });
    doc.nodes[1].revision++; const current = inspectorRun(doc, "step", "review"); doc.runs.push(current);
    expect(selectGraphAttention(deriveEngineeringView(doc)).byNode.get("step")!.ownItems).toEqual([expect.objectContaining({ label: "成果待查收", runId: current.id })]);
    current.status = "rejected"; current.review_note = "结论缺少比较依据";
    expect(selectGraphAttention(deriveEngineeringView(doc)).byNode.get("step")!.ownItems[0]).toMatchObject({ label: "验收退回", detail: current.review_note });
  });
  it("keeps outdated accepted work historical rather than announcing completion or current review", () => {
    const { view } = inspectorScenario("stale");
    expect(selectGraphAttention(view).byNode.get("step")!.ownItems).toEqual([expect.objectContaining({ label: "当前版本待重新交付", source: "contract" })]);
    expect(selectGraphAttention(view).items.every(item => !item.runId)).toBe(true);
  });
  it("distinguishes unknown observation from failure and does not invent execution claims", () => {
    const { view } = inspectorScenario("running"), run = view.document.runs[0];
    view.observation = { captured_at: stamp, source: "local-engineering-service", runs: { [run.id]: { state: "stale", last_observed_at: stamp, message: "尚未收到新的运行观察" } } };
    let model = selectGraphAttention(view);
    expect(model.byNode.get("step")!.ownItems).toEqual([expect.objectContaining({ label: "状态待更新", tone: "unknown", tags: [], detail: "尚未收到新的运行观察" })]);
    expect(model.totals.attention).toBe(0);
    view.observation.runs[run.id].state = "current";
    expect(selectGraphAttention(view).items).toEqual([]);
    delete run.handoff; model = selectGraphAttention(view);
    expect(model.items[0].source).toBe("observation");
    expect(selectGraphAttention(view, { observationUnavailable: true }).items[0].label).toBe("状态待更新");
  });
  it("reports an explicit coverage gap only on its owning parent, without inherited duplicates", () => {
    const doc = inspectorDocument();
    doc.nodes[0].composition = { summary: "子成果组合", scenario: "整体使用", integration_criterion_ids: [] };
    let model = selectGraphAttention(deriveEngineeringView(doc));
    expect(model.totals.attention).toBe(1);
    expect(model.byNode.get("root")!.ownItems[0]).toMatchObject({ label: "1 项成果无人承接", detail: "成果符合本项要求" });
    expect(model.byNode.get("step")!.ownItems).toEqual([]);
    doc.nodes[0].composition.integration_criterion_ids = ["root-manual"];
    model = selectGraphAttention(deriveEngineeringView(doc)); expect(model.items).toEqual([]);
  });
  it("requires a parent's own integration after children pass", () => {
    const doc = inspectorDocument(); doc.runs.push(inspectorRun(doc, "step", "accepted"));
    expect(selectGraphAttention(deriveEngineeringView(doc)).byNode.get("root")!.ownItems[0].label).toBe("整体仍待验收");
    doc.runs.push(inspectorRun(doc, "root", "accepted"));
    expect(selectGraphAttention(deriveEngineeringView(doc)).items).toEqual([]);
  });
  it("keeps one feedback identity across filter tags and aggregates hidden descendants once", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("branch", "root"), inspectorNode("leaf", "branch")]);
    doc.feedbacks = [feedback("proposal", "leaf", { kind: "requirement_change" }), feedback("problem", "leaf")];
    const view = deriveEngineeringView(doc), before = JSON.stringify(view), model = selectGraphAttention(view);
    expect(model.totals).toEqual({ all: 2, attention: 1, improvement: 1, feedback: 2 });
    expect(model.byNode.get("root")!.subtreeCounts).toEqual(model.totals);
    expect(model.byNode.get("root")!.ownItems).toEqual([]);
    expect(model.byNode.get("branch")!.descendantItems).toHaveLength(2);
    expect(model.byNode.get("leaf")!.ownItems).toHaveLength(2);
    expect(JSON.stringify(view)).toBe(before);
  });
  it("retains resolved and dismissed feedback without presenting it as active improvement or attention", () => {
    const doc = inspectorDocument(); doc.feedbacks = [feedback("resolved", "step", { status: "resolved", kind: "requirement_change" }), feedback("dismissed", "step", { status: "dismissed" }), feedback("review", "step", { status: "review", kind: "requirement_change" })];
    closedPlan(doc, doc.feedbacks[0]);
    const model = selectGraphAttention(deriveEngineeringView(doc));
    expect(model.totals).toEqual({ all: 3, attention: 1, improvement: 1, feedback: 3 });
    expect(model.items.find(item => item.feedbackId === "review")!.tags).toEqual(["feedback", "improvement", "attention"]);
    expect(model.items.find(item => item.feedbackId === "resolved")!.tags).toEqual(["feedback"]);
  });
  it("counts range feedback once globally while local nodes retain their real child handling targets", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("one", "root"), inspectorNode("two", "root"), inspectorNode("three", "root")]);
    const children = ["one", "two", "three"].map((id, i) => ({ ...feedback("child-" + id, id, { kind: "requirement_change", status: i === 0 ? "resolved" : i === 1 ? "review" : "open" }), scope_group_id: "group" }));
    closedPlan(doc, children[0]);
    doc.feedbacks = [...children, { ...feedback("group", "one", { kind: "requirement_change" }), scope_node_ids: ["one", "two", "three"], scope_feedback_ids: children.map(item => item.id) } as EngineeringFeedback];
    const view = deriveEngineeringView(doc), model = selectGraphAttention(view);
    expect(model.totals).toEqual({ all: 1, attention: 1, improvement: 1, feedback: 1 });
    expect(model.items[0]).toMatchObject({ id: "feedback:group", feedbackId: "group", nodeIds: ["one", "two", "three"] });
    expect(model.byNode.get("one")!.ownItems[0]).toMatchObject({ id: "feedback:group", feedbackId: "child-one", scopeGroupId: "group", tags: ["feedback"] });
    expect(model.byNode.get("two")!.ownItems[0].feedbackId).toBe("child-two");
    expect(model.byNode.get("root")!.subtreeCounts).toEqual(model.totals);
    expect([...selectGraphMatches(model, view, { filter: "feedback", query: "因子" }).matchingNodeIds]).toEqual(["one", "two", "three"]);
    expect([...selectGraphMatches(model, view, { filter: "attention" }).matchingNodeIds]).toEqual(["two"]);
    expect(selectGraphMatches(model, view, { filter: "attention" }).itemsByNode.get("two")?.[0]).toMatchObject({ feedbackId: "child-two", target: { kind: "node", node_id: "two" } });
    expect([...selectGraphMatches(model, view, { filter: "improvement" }).matchingNodeIds]).toEqual(["two", "three"]);
    doc.nodes[1].status = "archived";
    const archived = selectGraphAttention(deriveEngineeringView(doc));
    expect(archived.totals.all).toBe(1); expect(archived.items[0].nodeIds).toEqual(["two", "three"]);
  });
  it("shows a previously resolved opinion as needing review when its closure basis changes", () => {
    const doc = inspectorDocument(), item = closedPlan(doc, feedback("closed", "step", { kind: "requirement_change" }));
    doc.feedbacks = [item];
    expect(selectGraphAttention(deriveEngineeringView(doc)).totals.attention).toBe(0);
    doc.nodes[1].objective = "方案目标已更新，需要重新核对原意见";
    const before = JSON.stringify(doc), model = selectGraphAttention(deriveEngineeringView(doc));
    expect(model.items[0]).toMatchObject({ label: expect.stringContaining("需复核"), tone: "review", tags: ["feedback", "improvement", "attention"] });
    expect(model.byNode.get("root")?.subtreeCounts.attention).toBe(1);
    expect(JSON.stringify(doc)).toBe(before); expect(item.status).toBe("resolved");
  });
  it("keeps search navigation on the matching opinion rather than the first opinion at that node", () => {
    const doc = inspectorDocument();
    doc.feedbacks = [feedback("first", "step", { note: "检查配色" }), feedback("second", "step", { note: "补上回测区间" })];
    const view = deriveEngineeringView(doc), model = selectGraphAttention(view);
    expect(selectGraphMatches(model, view, { filter: "feedback", query: "回测区间" }).itemsByNode.get("step")?.map(item => item.feedbackId)).toEqual(["second"]);
    expect(selectGraphMatches(model, view, { filter: "feedback", query: "不存在的意见" }).itemsByNode.size).toBe(0);
  });
  it("anchors broken handoffs and relation feedback to the original owned relation", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("data", "root", { delivery: delivery("data") }), inspectorNode("factor", "root", { delivery: delivery("factor") })]);
    const factor = doc.nodes[2]; factor.delivery!.inputs = [{ id: "bars", title: "行情输入", source_node_id: "data", source_output_id: "missing", external_source: "" }];
    doc.feedbacks = [feedback("edge", "factor", { target: { kind: "relation", node_id: "factor", id: "input:bars" } })];
    let model = selectGraphAttention(deriveEngineeringView(doc));
    expect(model.byRelation.get("factor:input:bars")).toHaveLength(2);
    expect(model.byRelation.get("factor:input:bars")![0]).toMatchObject({ source: "contract", target: { kind: "relation", node_id: "factor", id: "input:bars" } });
    factor.delivery!.inputs[0].source_output_id = ""; // An unfinished draft input is not a broken supplied reference.
    model = selectGraphAttention(deriveEngineeringView(doc)); expect(model.byRelation.get("factor:input:bars")).toHaveLength(1);
  });
  it("keeps feedback on a changed target visible and excludes archived node records", () => {
    const doc = inspectorDocument(); doc.feedbacks = [feedback("missing-condition", "step", { target: { kind: "criterion", node_id: "step", id: "gone" } })];
    expect(selectGraphAttention(deriveEngineeringView(doc)).items[0].detail).toContain("原反馈位置已有变化");
    doc.nodes[1].status = "archived";
    expect(selectGraphAttention(deriveEngineeringView(doc)).items).toEqual([]);
  });
  it("searches real feedback, output names and display names while preserving ancestor context", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("branch", "root"), inspectorNode("leaf", "branch", { delivery: delivery("leaf") }), inspectorNode("other", "root")]);
    doc.feedbacks = [feedback("issue", "leaf")]; const view = deriveEngineeringView(doc), model = selectGraphAttention(view);
    let found = selectGraphMatches(model, view, { filter: "attention", query: "因子" });
    expect([...found.matchingNodeIds]).toEqual(["leaf"]); expect([...found.ancestorNodeIds]).toEqual(["branch", "root"]);
    expect(selectGraphMatches(model, view, { filter: "all", query: "历史行情" }).matchingNodeIds.has("leaf")).toBe(true);
    expect(selectGraphMatches(model, view, { filter: "all", query: "简短名字", nodeNames: { leaf: "简短名字" } }).matchingNodeIds.has("leaf")).toBe(true);
    found = selectGraphMatches(model, view, { filter: "improvement", query: "" }); expect(found.matchingNodeIds.size).toBe(0);
    expect(view.document.nodes).toHaveLength(4);
  });
  it("retains actual relation kinds and collapsed projections without inventing transitive impact", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("data", "root", { delivery: delivery("data") }), inspectorNode("branch", "root"), inspectorNode("factor", "branch", { delivery: delivery("factor") }), inspectorNode("strategy", "root"), inspectorNode("trade", "root", { dependencies: ["strategy"] })]);
    const factor = doc.nodes[3]; factor.delivery!.inputs = [{ id: "bars", title: "行情输入", source_node_id: "data", source_output_id: "result", external_source: "" }];
    factor.interactions = [{ id: "explain", target_node_id: "strategy", source_output_id: "", target_input_id: "", purpose: "解释候选因子", scenario: "选择因子时查看解释" }];
    const view = deriveEngineeringView(doc), before = JSON.stringify(view), context = selectGraphContext(view, "factor", ["root", "data", "branch", "strategy", "trade"]);
    expect([...context.upstreamNodeIds]).toEqual(["data"]); expect([...context.downstreamNodeIds]).toEqual(["strategy"]);
    expect(context.relatedNodeIds.has("trade")).toBe(false);
    expect(context.relations.map(relation => relation.kind)).toEqual(["input", "interaction"]);
    expect(context.relations[0]).toMatchObject({ sourceNodeId: "data", targetNodeId: "factor", from: "data", to: "branch", projected: true });
    expect(context.projectedNodeIds.has("branch")).toBe(true);
    expect(JSON.stringify(view)).toBe(before);
  });
});
