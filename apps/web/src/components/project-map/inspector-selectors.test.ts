import { describe, expect, it } from "vitest";
import { deriveEngineeringView } from "@epm/domain";
import { projectNodeInspector, selectDescendantRunAttention } from "./inspector-selectors.ts";
import { inspectorCheck, inspectorDocument, inspectorNode, inspectorRun, inspectorScenario, inspectorSourceProof, inspectorSourceScope } from "../../../../../tests/fixtures/project-inspector.ts";

describe("read-only selected node process", () => {
  it("shows draft intent without inventing execution or modifying the view", () => {
    const { view, nodeId } = inspectorScenario("draft"), before = JSON.stringify(view);
    const model = projectNodeInspector(view, nodeId)!;
    expect(model).toMatchObject({ currentRun: undefined, historicalOnly: false, actionCompleted: 0, evidence: { artifacts: 0, checked: false, hasAutomatic: false } });
    expect(model.stages.find(stage => stage.id === "plan")?.tone).toBe("current");
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("waiting");
    expect(JSON.stringify(view)).toBe(before);
  });
  it("keeps an unclaimed handoff and a claimed but queued run distinct from execution", () => {
    for (const scenario of ["queued", "claimed"]) {
      const { view, nodeId } = inspectorScenario(scenario), model = projectNodeInspector(view, nodeId)!;
      expect(model.summary).toContain(scenario === "queued" ? "尚未开始执行" : "等待执行条件");
      expect(model.stages.find(stage => stage.id === "handoff")?.tone).toBe(scenario === "queued" ? "current" : "done");
      expect(model.stages.find(stage => stage.id === "execution")?.tone).toBe("waiting");
    }
  });
  it("does not present an external running record without a claim as genuine execution", () => {
    const { view, nodeId } = inspectorScenario("running"); delete view.document.runs[0].handoff;
    expect(projectNodeInspector(view, nodeId)).toMatchObject({ status: "交接记录待核对" });
    expect(projectNodeInspector(view, nodeId)!.stages.find(stage => stage.id === "execution")?.tone).toBe("attention");
  });
  it("tracks partial actions while never painting the review step as complete", () => {
    const doc = inspectorDocument(); doc.nodes[1].actions = ["a", "b"].map(id => ({ id, title: `动作 ${id}`, type: "write_file", path: `output/${id}.txt`, content: "", criterion_id: "", capability_id: "" }));
    const run = inspectorRun(doc, "step", "running"); run.current_action = "b"; run.completed_action_ids = ["a", "no-longer-part-of-run"]; doc.runs.push(run);
    const model = projectNodeInspector(deriveEngineeringView(doc), "step")!;
    expect(model).toMatchObject({ actionCompleted: 1, actionTotal: 2, currentAction: "动作 b" });
    expect(model.stages.find(stage => stage.id === "execution")?.tone).toBe("current");
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("waiting");
  });
  it("does not confuse manual evidence with configured automatic checks", () => {
    const doc = inspectorDocument(), run = inspectorRun(doc, "step");
    run.evidence.push({ ...inspectorCheck("step-manual"), kind: "human" }); doc.runs.push(run);
    const model = projectNodeInspector(deriveEngineeringView(doc), "step")!;
    expect(model.evidence).toMatchObject({ manualPassed: 1, hasAutomatic: false, checked: false, checksTotal: 0 });
    expect(model.stages.find(stage => stage.id === "checks")?.tone).toBe("unconfigured");
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("current");
  });
  it("requires every frozen automatic criterion and rejects contradictory failure evidence", () => {
    const doc = inspectorDocument(); doc.nodes[1].criteria = ["a", "b"].map(id => ({ id, kind: "file_exists", text: id, path: `output/${id}`, expected: "" }));
    const run = inspectorRun(doc, "step"); doc.runs.push(run); run.evidence.push(inspectorCheck("a"));
    expect(projectNodeInspector(deriveEngineeringView(doc), "step")!.evidence).toMatchObject({ checksPassed: 1, checksTotal: 2, checked: false });
    run.evidence.push(inspectorCheck("b"));
    expect(projectNodeInspector(deriveEngineeringView(doc), "step")!.evidence.checked).toBe(true);
    run.evidence.push(inspectorCheck("a", false));
    expect(projectNodeInspector(deriveEngineeringView(doc), "step")!.evidence).toMatchObject({ checksPassed: 1, checked: false, failed: true });
  });
  it("renders source-only verification with zero actions honestly, including no-change checks", () => {
    const doc = inspectorDocument(); doc.nodes[1].source_scope = inspectorSourceScope;
    const run = inspectorRun(doc, "step", "running", "external"); run.source_scope = inspectorSourceScope; run.current_action = "source-verification"; doc.runs.push(run);
    let model = projectNodeInspector(deriveEngineeringView(doc), "step")!;
    expect(model).toMatchObject({ actionTotal: 0, evidence: { checksTotal: 1, checked: false } });
    expect(model.stages.find(stage => stage.id === "checks")?.tone).toBe("current");
    expect(model.stages.find(stage => stage.id === "execution")?.tone).toBe("done");
    run.status = "review"; run.current_action = ""; run.source_proof = inspectorSourceProof();
    model = projectNodeInspector(deriveEngineeringView(doc), "step")!;
    expect(model.evidence).toMatchObject({ sourceChanges: 0, checked: true, checksPassed: 1 });
    run.source_proof.contract_sha256 = "wrong-current-scope";
    expect(projectNodeInspector(deriveEngineeringView(doc), "step")!.evidence.checked).toBe(false);
  });
  it("never reuses old accepted output after the contract changes", () => {
    const { view, nodeId } = inspectorScenario("stale"), model = projectNodeInspector(view, nodeId)!;
    expect(model).toMatchObject({ historicalOnly: true, historyCount: 1, currentRun: undefined, evidence: { artifacts: 0, checksPassed: 0, manualPassed: 0 } });
    expect(model.summary).toContain("旧证据不计入当前验收");
    expect(model.stages.some(stage => stage.id !== "plan" && stage.tone === "done")).toBe(false);
  });
  it("returns rejected work to revision, not a fabricated forward-only completion", () => {
    const { view, nodeId } = inspectorScenario("rejected"), model = projectNodeInspector(view, nodeId)!;
    expect(model.summary).toContain("结果缺少关键判断");
    expect(model.next).toEqual({ label: "修订当前方案", tab: "plan" });
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("attention");
  });
  it("counts actual nested running branches without counting queued or stale runs", () => {
    const { view } = inspectorScenario("parent");
    const doc = view.document; doc.nodes.push(inspectorNode("queued", "root"), inspectorNode("old", "root"));
    doc.runs.push(inspectorRun(doc, "queued", "queued", "external"), inspectorRun(doc, "old", "running", "external")); doc.nodes.find(node => node.id === "old")!.revision++;
    const model = projectNodeInspector(deriveEngineeringView(doc), "root")!;
    expect(model.running.map(item => item.nodeId).sort()).toEqual(["nested", "step"]);
    expect(model.summary).toContain("2 项下级运行记录同时处于执行中");
    expect(model.children.find(child => child.node.id === "branch")!.running).toEqual([{ nodeId: "nested", title: "分支内正在推进的步骤" }]);
  });
  it("requires independent parent integration and human review after children pass", () => {
    const doc = inspectorDocument(); doc.nodes.push(inspectorNode("second", "root"));
    for (const id of ["step", "second"]) doc.runs.push(inspectorRun(doc, id, "accepted"));
    let model = projectNodeInspector(deriveEngineeringView(doc), "root")!;
    expect(model).toMatchObject({ acceptedChildren: 2, evidence: { checked: false } });
    expect(model.summary).toContain("本层仍需整合检查和人工验收");
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("waiting");
    const parent = inspectorRun(doc, "root", "review", "integration"); doc.runs.push(parent);
    model = projectNodeInspector(deriveEngineeringView(doc), "root")!;
    expect(model.next.label).toBe("查看证据并验收");
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("current");
    parent.status = "accepted";
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.stages.find(stage => stage.id === "review")?.tone).toBe("done");
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.stages.find(stage => stage.id === "integration")?.note).not.toContain("仍需人工验收");
    doc.nodes.find(node => node.id === "step")!.revision++;
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.historicalOnly).toBe(true);
  });
  it("requires the actual aggregated source proof for parent checks", () => {
    const doc = inspectorDocument(); doc.runs.push(inspectorRun(doc, "step", "accepted"));
    const parent = inspectorRun(doc, "root", "review", "integration"); parent.source_integration_scopes = [inspectorSourceScope]; doc.runs.push(parent);
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.evidence.checked).toBe(false);
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.stages.find(stage => stage.id === "integration")?.tone).toBe("attention");
    parent.source_integration_proofs = [inspectorSourceProof()];
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.evidence).toMatchObject({ checksTotal: 1, checksPassed: 1, checked: true });
    parent.source_integration_proofs[0].checks[0].status = "cancelled";
    expect(projectNodeInspector(deriveEngineeringView(doc), "root")!.stages.find(stage => stage.id === "integration")?.tone).toBe("attention");
  });
  it("excludes archived children, preserves inherited rules and handles a missing selection", () => {
    const doc = inspectorDocument(); doc.nodes.push(inspectorNode("archived", "root", { status: "archived" }));
    const view = deriveEngineeringView(doc);
    expect(projectNodeInspector(view, "root")!.children.map(child => child.node.id)).toEqual(["step"]);
    expect(projectNodeInspector(view, "step")!.inheritedRules).toEqual([{ node_id: "root", title: "工程交付总目标", text: "未经验收不能代表交付完成。" }]);
    expect(projectNodeInspector(view, "absent")).toBeUndefined();
  });
  it("does not turn ordinary accepted or review explanations into blockers", () => {
    for (const status of ["review", "accepted"] as const) {
      const doc = inspectorDocument(); const run = inspectorRun(doc, "step", status);
      run.reason = "任务成果已经生成，等待查阅。"; doc.runs.push(run);
      expect(projectNodeInspector(deriveEngineeringView(doc), "step")!.blockers).not.toContain(run.reason);
    }
  });
  it("surfaces middle-layer review even with zero leaf reviews, excluding stale and archived runs", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("package", "root"), inspectorNode("middle", "package"), inspectorNode("leaf", "middle"), inspectorNode("stale", "package"), inspectorNode("archived", "package")]);
    doc.runs.push(inspectorRun(doc, "leaf", "accepted"));
    doc.runs.push(inspectorRun(doc, "middle", "review", "integration"));
    doc.runs.push(inspectorRun(doc, "stale", "review")); doc.nodes.find(node => node.id === "stale")!.revision++;
    doc.runs.push(inspectorRun(doc, "archived", "review")); doc.nodes.find(node => node.id === "archived")!.status = "archived";
    const view = deriveEngineeringView(doc), before = JSON.stringify(view);
    expect(view.derived.root.counts.review).toBe(0);
    const attention = selectDescendantRunAttention(view, "root");
    expect(attention.review.map(item => item.node.id)).toEqual(["middle"]);
    expect(selectDescendantRunAttention(view, "middle").review).toEqual([]);
    const model = projectNodeInspector(view, "root")!;
    expect(model).toMatchObject({ status: "待完善", reviewChildren: 0, next: { label: "查看待验收结果（1）", action: "review_list" } });
    expect(model.descendantReviews.map(item => item.node.id)).toEqual(["middle"]);
    expect(model.stages.find(stage => stage.id === "review")?.tone).toBe("waiting");
    expect(JSON.stringify(view)).toBe(before);
    // Even a mismatched derived run reference cannot make another node claim its evidence.
    view.derived.stale.latest_run_id = doc.runs[1].id; view.derived.stale.status = "review";
    expect(selectDescendantRunAttention(view, "root").review.map(item => item.node.id)).toEqual(["middle"]);
  });
  it("prioritizes this parent's own current review over descendant navigation", () => {
    const doc = inspectorDocument(); doc.runs.push(inspectorRun(doc, "step", "accepted"));
    doc.runs.push(inspectorRun(doc, "root", "review", "integration"));
    const model = projectNodeInspector(deriveEngineeringView(doc), "root")!;
    expect(model.next).toEqual({ label: "查看证据并验收", tab: "runs" });
    expect(selectDescendantRunAttention(deriveEngineeringView(doc), "root").review).toEqual([]);
  });
  it("shares only current claimed running descendants with the map", () => {
    const doc = inspectorDocument([inspectorNode("root", null), ...["active", "queued", "stale", "unclaimed", "archived"].map(id => inspectorNode(id, "root"))]);
    for (const id of ["active", "queued", "stale", "unclaimed", "archived"]) {
      const run = inspectorRun(doc, id, id === "queued" ? "queued" : "running", "external");
      if (id === "unclaimed") delete run.handoff;
      doc.runs.push(run);
    }
    doc.nodes.find(node => node.id === "stale")!.revision++;
    doc.nodes.find(node => node.id === "archived")!.status = "archived";
    expect(selectDescendantRunAttention(deriveEngineeringView(doc), "root").running.map(item => item.node.id)).toEqual(["active"]);
  });
});
