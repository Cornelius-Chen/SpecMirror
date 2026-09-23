import { describe, expect, it } from "vitest";
import { deriveEngineeringView, type EngineeringView } from "@epm/domain";
import { projectNodeInspector } from "./inspector-selectors.ts";
import { projectProcessMotion } from "./process-motion.ts";
import { inspectorCheck, inspectorDocument, inspectorNode, inspectorRun, inspectorScenario, inspectorSourceProof, inspectorSourceScope } from "../../../../../tests/fixtures/project-inspector.ts";

const motion = (view: EngineeringView, id = "step") => projectProcessMotion(view, id, projectNodeInspector(view, id)!);
const action = (type: "write_file" | "check_file", id = "work") => ({ id, type, title: "当前动作", path: "output/result.md", content: "", criterion_id: "step-manual", capability_id: "" });

describe("current engineering process motion", () => {
  it("stops external activity animation when observation is stale and resumes only with current evidence", () => {
    const { view } = inspectorScenario("running"), run = view.document.runs[0];
    view.observation = { captured_at: "2026-09-06T10:00:00Z", source: "local-engineering-service", runs: { [run.id]: { state: "stale", last_observed_at: "2026-09-06T08:00:00Z", message: "状态待更新" } } };
    expect(motion(view)).toMatchObject({ state: "waiting", label: "状态待更新" });
    view.observation.runs[run.id].state = "current";
    expect(motion(view).state).toBe("running");
    expect(run.status).toBe("running");
  });
  it.each([
    ["draft", "idle", "plan"], ["queued", "waiting", "handoff"],
    ["claimed", "waiting", "execution"], ["running", "running", "execution"],
    ["review", "waiting", "review"], ["rejected", "blocked", "review"],
    ["stale", "blocked", "plan"]
  ])("keeps %s distinct from real execution", (scenario, state, stageId) => {
    const { view, nodeId } = inspectorScenario(scenario);
    expect(motion(view, nodeId)).toMatchObject({ state, stageId });
  });

  it("does not use current tones, scheduler counts, or model running arrays as proof", () => {
    const { view, nodeId } = inspectorScenario("draft"), before = JSON.stringify(view);
    const model = projectNodeInspector(view, nodeId)!;
    model.stages.forEach(stage => { stage.tone = "current"; });
    model.running = [{ nodeId: "invented", title: "not a current run" }];
    expect(projectProcessMotion(view, nodeId, model)).toMatchObject({ state: "idle", stageId: "plan" });
    expect(JSON.stringify(view)).toBe(before);
  });

  it.each([undefined, "awaiting_claim"] as const)("keeps external running without claimed handoff stationary (%s)", state => {
    const { view } = inspectorScenario("running");
    if (state) view.document.runs[0].handoff!.state = state; else delete view.document.runs[0].handoff;
    expect(motion(view)).toMatchObject({ state: state ? "waiting" : "blocked", stageId: "handoff" });
    expect(motion(view).label).toContain("领取");
  });

  it("requires both matching derived state and matching current run identity", () => {
    const { view } = inspectorScenario("running");
    view.derived.step.status = "ready";
    expect(motion(view).state).not.toBe("running");
    view.derived.step.status = "running"; view.derived.step.latest_run_id = "missing";
    expect(motion(view).state).not.toBe("running");
    view.document.runs.push(inspectorRun(view.document, "root", "running"));
    view.derived.step.latest_run_id = view.document.runs.at(-1)!.id;
    expect(motion(view).state).not.toBe("running");
  });

  it("does not animate a stale model or a stale contract even before derived data refreshes", () => {
    const { view } = inspectorScenario("running"), model = projectNodeInspector(view, "step")!;
    expect(projectProcessMotion(view, "step", { ...model, currentRun: undefined }).state).toBe("blocked");
    view.document.nodes[1].revision++;
    expect(projectProcessMotion(view, "step", model)).toMatchObject({ state: "blocked", stageId: "plan" });
  });

  it("checks inherited accepted dependency references recursively without trusting old derived pointers", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("upstream", "root"), inspectorNode("middle", "root", { dependencies: ["upstream"] }), inspectorNode("step", "root", { dependencies: ["middle"] })]);
    doc.runs.push(inspectorRun(doc, "upstream", "accepted"));
    doc.runs.push(inspectorRun(doc, "middle", "accepted"));
    doc.runs.push(inspectorRun(doc, "step", "running"));
    const view = deriveEngineeringView(doc);
    expect(motion(view).state).toBe("running");
    doc.nodes.find(node => node.id === "upstream")!.revision++;
    expect(motion(view)).toMatchObject({ state: "blocked", stageId: "plan" });
  });

  it("rejects malformed frozen references without crashing or falling back to a historical run", () => {
    const { view } = inspectorScenario("running");
    view.document.runs[0].snapshot.contract_key = JSON.stringify({ lineage: [["root", 1], ["step", 1]], dependencies: [null], children: [] });
    expect(motion(view)).toMatchObject({ state: "blocked", stageId: "plan" });
  });

  it("uses the frozen current action to distinguish execution from file checks", () => {
    const doc = inspectorDocument(); doc.nodes[1].actions = [action("write_file", "make"), action("check_file", "check")];
    const run = inspectorRun(doc, "step", "running"); run.current_action = "make"; doc.runs.push(run);
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "running", stageId: "execution" });
    run.current_action = "check"; run.completed_action_ids = ["make"];
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "running", stageId: "checks" });
    // An editable action with the same id cannot redefine the frozen runtime action.
    run.snapshot.node.actions.find(item => item.id === "check")!.type = "write_file";
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "running", stageId: "execution" });
  });

  it("animates source verification with no prewritten actions, then stops at review or failure", () => {
    const doc = inspectorDocument(); doc.nodes[1].source_scope = inspectorSourceScope;
    const run = inspectorRun(doc, "step", "running", "external"); run.source_scope = inspectorSourceScope; run.current_action = "source-verification"; doc.runs.push(run);
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "running", stageId: "checks" });
    run.status = "blocked";
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "blocked", stageId: "checks" });
    run.status = "review";
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "waiting", stageId: "review" });
    run.status = "accepted";
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "complete", stageId: "review" });
  });

  it.each(["paused", "blocked", "rejected", "stale"] as const)("stops when the current running run becomes %s", status => {
    const { view } = inspectorScenario("running"); view.document.runs[0].status = status;
    expect(motion(deriveEngineeringView(view.document)).state).not.toBe("running");
  });

  it.each(["source", "file"] as const)("keeps a failed %s check at checks after the service clears current_action", kind => {
    const doc = inspectorDocument(), run = inspectorRun(doc, "step", "blocked");
    run.current_action = "";
    if (kind === "source") {
      run.source_scope = inspectorSourceScope; run.source_proof = inspectorSourceProof();
      run.source_proof.passed = false; run.source_proof.checks[0].status = "failed"; run.source_proof.checks[0].exit_code = 1;
    } else run.evidence.push(inspectorCheck("step-manual", false));
    doc.runs.push(run);
    expect(motion(deriveEngineeringView(doc))).toMatchObject({ state: "blocked", stageId: "checks" });
  });

  it.each(["paused", "archived"] as const)("suppresses motion for selected and ancestor %s", status => {
    for (const target of ["step", "root"]) {
      const { view } = inspectorScenario("running"); view.document.nodes.find(node => node.id === target)!.status = status;
      expect(motion(deriveEngineeringView(view.document))).toMatchObject({ state: status === "paused" ? "blocked" : "idle", stageId: null });
    }
  });

  it("counts only real active descendants at the children stage", () => {
    const { view } = inspectorScenario("parent"), doc = view.document;
    for (const id of ["queued", "unclaimed", "stale", "archived", "paused"]) {
      doc.nodes.push(inspectorNode(id, "root"));
      const run = inspectorRun(doc, id, id === "queued" ? "queued" : "running", "external");
      if (id === "unclaimed") delete run.handoff;
      doc.runs.push(run);
    }
    doc.nodes.find(node => node.id === "stale")!.revision++;
    doc.nodes.find(node => node.id === "archived")!.status = "archived";
    doc.nodes.find(node => node.id === "paused")!.status = "paused";
    const result = motion(deriveEngineeringView(doc), "root");
    expect(result).toMatchObject({ state: "running", stageId: "children" });
    expect(result.runningNodeIds?.sort()).toEqual(["nested", "step"]);
    expect(result.label).toContain("2 项下级正在执行");
    doc.nodes.find(node => node.id === "branch")!.status = "paused";
    expect(motion(deriveEngineeringView(doc), "root").label).toContain("1 项下级正在执行");
    expect(motion(deriveEngineeringView(doc), "root").runningNodeIds).toEqual(["step"]);
  });

  it("shows actual child activity while the parent's integration remains queued", () => {
    const { view: original } = inspectorScenario("parent"), doc = original.document;
    doc.runs.push(inspectorRun(doc, "root", "queued", "integration"));
    let view = deriveEngineeringView(doc);
    expect(projectNodeInspector(view, "root")!.currentRun?.status).toBe("queued");
    expect(motion(view, "root")).toMatchObject({ state: "running", stageId: "children", runningNodeIds: ["step", "nested"] });
    for (const run of doc.runs.filter(run => run.node_id !== "root")) run.status = "review";
    view = deriveEngineeringView(doc);
    expect(motion(view, "root")).toMatchObject({ state: "waiting", stageId: "children" });
    expect(motion(view, "root").runningNodeIds).toBeUndefined();
    expect(motion(view, "step").state).toBe("waiting");
  });

  it("shows new child activity without reviving an obsolete parent integration", () => {
    const doc = inspectorDocument(); doc.runs.push(inspectorRun(doc, "step", "accepted"));
    doc.runs.push(inspectorRun(doc, "root", "accepted", "integration"));
    doc.nodes[1].revision++; doc.runs.push(inspectorRun(doc, "step", "running", "external"));
    const view = deriveEngineeringView(doc);
    expect(projectNodeInspector(view, "root")!.historicalOnly).toBe(true);
    expect(motion(view, "root")).toMatchObject({ state: "running", stageId: "children" });
    doc.nodes[0].status = "paused";
    expect(motion(deriveEngineeringView(doc), "root").state).toBe("blocked");
  });

  it("keeps eight current review descendants stationary", () => {
    const doc = inspectorDocument([inspectorNode("root", null), ...Array.from({ length: 8 }, (_, index) => inspectorNode(`review-${index}`, "root"))]);
    for (const node of doc.nodes.slice(1)) doc.runs.push(inspectorRun(doc, node.id, "review", "external"));
    const view = deriveEngineeringView(doc);
    expect(motion(view, "root")).toMatchObject({ state: "waiting", stageId: "children" });
    expect(motion(view, "root").label).toContain("8 项下级等待人工验收");
    for (const node of doc.nodes.slice(1)) expect(motion(view, node.id)).toMatchObject({ state: "waiting", stageId: "review" });
  });

  it("waits for middle-layer review and never substitutes child acceptance for parent completion", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("middle", "root"), inspectorNode("leaf", "middle")]);
    doc.runs.push(inspectorRun(doc, "leaf", "accepted"));
    doc.runs.push(inspectorRun(doc, "middle", "review", "integration"));
    expect(motion(deriveEngineeringView(doc), "root")).toMatchObject({ state: "waiting", stageId: "children" });
    doc.runs[1].status = "accepted";
    expect(motion(deriveEngineeringView(doc), "root")).toMatchObject({ state: "waiting", stageId: "integration" });
    const run = inspectorRun(doc, "root", "running", "integration"); run.current_action = "source-verification"; doc.runs.push(run);
    expect(motion(deriveEngineeringView(doc), "root")).toMatchObject({ state: "running", stageId: "integration" });
    for (const [status, state] of [["review", "waiting"], ["accepted", "complete"]] as const) {
      run.status = status;
      expect(motion(deriveEngineeringView(doc), "root")).toMatchObject({ state, stageId: "review" });
    }
  });

  it("rejects an invalid parent execution mode and a missing stage instead of moving an unrelated stage", () => {
    const doc = inspectorDocument(); doc.runs.push(inspectorRun(doc, "step", "accepted"));
    doc.runs.push(inspectorRun(doc, "root", "running", "controlled"));
    expect(motion(deriveEngineeringView(doc), "root")).toMatchObject({ state: "blocked", stageId: "integration" });
    const { view } = inspectorScenario("running"), model = projectNodeInspector(view, "step")!;
    model.stages = model.stages.filter(stage => stage.id !== "execution");
    expect(projectProcessMotion(view, "step", model)).toMatchObject({ state: "blocked", stageId: null });
    expect(projectProcessMotion(view, "missing", model)).toMatchObject({ state: "idle", stageId: null });
  });

  it("keeps failed parent source checks at integration after clearing the current action", () => {
    const doc = inspectorDocument(); doc.runs.push(inspectorRun(doc, "step", "accepted"));
    const run = inspectorRun(doc, "root", "blocked", "integration"), proof = inspectorSourceProof();
    proof.passed = false; proof.checks[0].status = "failed"; proof.checks[0].exit_code = 1;
    run.source_integration_scopes = [inspectorSourceScope]; run.source_integration_proofs = [proof];
    run.current_action = ""; doc.runs.push(run);
    expect(motion(deriveEngineeringView(doc), "root")).toMatchObject({ state: "blocked", stageId: "integration" });
  });

  it("is read-only for a parent with real activity and explanatory stage tones", () => {
    const { view } = inspectorScenario("parent"), model = projectNodeInspector(view, "root")!;
    const before = JSON.stringify({ view, model });
    expect(projectProcessMotion(view, "root", model).state).toBe("running");
    expect(JSON.stringify({ view, model })).toBe(before);
  });
});
