import { describe, expect, it } from "vitest";
import { deriveEngineeringView, engineeringDeliveryIssues, type EngineeringNode } from "@epm/domain";
import { deliveryRelationLabel, deliveryRelationTouchesNode, projectDeliveryRelations, projectDeliverySummary, projectZoneDeliveryRelations, retainCollapsedDeliveryRelations, rollupProjectDeliveryRelations } from "./delivery-selectors.ts";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";

const delivery = (id: string): NonNullable<EngineeringNode["delivery"]> => ({ included: ["交付本项报告"], excluded: ["不执行交易"], inputs: [], outputs: [{ id: "report", title: "评估报告", criterion_ids: [id + "-manual"] }] });
function scenario() {
  const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("data", "root", { delivery: delivery("data") }), inspectorNode("research", "root"), inspectorNode("factor", "research", { dependencies: ["data"], delivery: delivery("factor") }), inspectorNode("strategy", "root", { dependencies: ["factor"], delivery: delivery("strategy") })]);
  for (const node of doc.nodes) if (node.parent_id && node.delivery) node.contributes_to = [node.parent_id + "-manual"];
  doc.nodes.find(node => node.id === "data")!.delivery!.outputs[0].title = "历史行情";
  doc.nodes.find(node => node.id === "factor")!.delivery!.inputs = [{ id: "bars", title: "研究数据", source_node_id: "data", source_output_id: "report", external_source: "" }];
  doc.nodes.find(node => node.id === "strategy")!.delivery!.inputs = [{ id: "factors", title: "候选因子", source_node_id: "factor", source_output_id: "report", external_source: "" }];
  return doc;
}

describe("visible region handoffs", () => {
  const zones = new Map(["data", "research", "factor", "strategy"].map(id => {
    const root = id === "factor" ? "research" : id;
    return [id, { id: `zone:${root}`, root_node_id: root }] as const;
  }));
  it("closes the visible scope without deleting its declarations and restores them when reopened", () => {
    const view = deriveEngineeringView(scenario());
    const openedIds = new Set(["root", "data", "research", "strategy"]);
    const opened = projectZoneDeliveryRelations(projectDeliveryRelations(view, [...openedIds]), zones, openedIds);
    const closedIds = new Set(["root"]);
    const closed = projectZoneDeliveryRelations(projectDeliveryRelations(view, [...closedIds]), zones, closedIds);
    expect(opened.filter(edge => edge.renderable)).toHaveLength(2);
    expect(closed.filter(edge => edge.renderable)).toEqual([]);
    expect(closed.map(edge => edge.id)).toEqual(opened.map(edge => edge.id));
    expect(closed.flatMap(edge => edge.members.map(member => [member.sourceNodeId, member.targetNodeId]))).toEqual([["data", "factor"], ["factor", "strategy"]]);
    expect(projectZoneDeliveryRelations(projectDeliveryRelations(view, [...openedIds]), zones, openedIds)).toEqual(opened);
  });
  it("does not turn an invalid output into a valid regional arrow", () => {
    const doc = scenario(); doc.nodes.find(node => node.id === "data")!.delivery!.outputs = [];
    const visible = new Set(["root", "data", "research", "strategy"]);
    const overview = projectZoneDeliveryRelations(projectDeliveryRelations(deriveEngineeringView(doc), [...visible]), zones, visible);
    expect(overview[0]).toMatchObject({ renderable: false, problem: "输入未对应有效成果" });
    expect(overview[1].renderable).toBe(true);
  });
  it("keeps collapsed descendants projected to their visible region and excludes internal handoffs", () => {
    const doc = scenario();
    doc.nodes.find(node => node.id === "research")!.dependencies = ["factor"];
    const visible = new Set(["root", "data", "research", "strategy"]);
    const overview = projectZoneDeliveryRelations(projectDeliveryRelations(deriveEngineeringView(doc), [...visible]), zones, visible);
    expect(overview).toHaveLength(2);
    expect(overview[0]).toMatchObject({ from: "data", to: "research", renderable: true });
    expect(overview[0].members[0]).toMatchObject({ sourceNodeId: "data", targetNodeId: "factor" });
  });
  it("retains only the previous page's valid original handoffs while their endpoints close", () => {
    const view = deriveEngineeringView(scenario()), openIds = new Set(view.document.nodes.map(node => node.id)), closedIds = new Set(["root"]);
    const opened = rollupProjectDeliveryRelations(projectDeliveryRelations(view, [...openIds]));
    const closed = projectDeliveryRelations(view, [...closedIds]);
    expect(retainCollapsedDeliveryRelations(opened.slice(0, 1), closed, closedIds)).toEqual([opened[0]]);
    expect(retainCollapsedDeliveryRelations(opened, closed, openIds)).toEqual([]);
    expect(retainCollapsedDeliveryRelations(opened, closed.filter(edge => edge.id !== opened[0].id), closedIds)).toEqual([opened[1]]);
  });
  it("drops retained paths when their original source changes or its output becomes invalid", () => {
    const doc = scenario(), visible = new Set(doc.nodes.map(node => node.id));
    const opened = rollupProjectDeliveryRelations(projectDeliveryRelations(deriveEngineeringView(doc), [...visible]));
    doc.nodes.find(node => node.id === "data")!.delivery!.outputs = [];
    expect(retainCollapsedDeliveryRelations(opened, projectDeliveryRelations(deriveEngineeringView(doc), ["root"]), new Set(["root"]))).toEqual([opened[1]]);
    const fresh = scenario(); fresh.nodes.find(node => node.id === "factor")!.delivery!.inputs[0].source_node_id = "strategy";
    expect(retainCollapsedDeliveryRelations(opened, projectDeliveryRelations(deriveEngineeringView(fresh), ["root"]), new Set(["root"]))).toEqual([opened[1]]);
  });
});

describe("business deliverables and actual handoffs", () => {
  it("preserves separate outputs and distinguishes reciprocal product use from execution waits", () => {
    const doc = scenario(), factor = doc.nodes.find(node => node.id === "factor")!, data = doc.nodes.find(node => node.id === "data")!;
    data.delivery!.outputs.push({ id: "dictionary", title: "数据字典", criterion_ids: ["data-manual"] });
    factor.delivery!.inputs.push({ id: "dictionary", title: "字段含义", source_node_id: "data", source_output_id: "dictionary", external_source: "" });
    factor.dependencies = [];
    factor.interactions = [{ id: "return", target_node_id: "data", source_output_id: "", target_input_id: "", purpose: "反馈缺失字段", scenario: "报告指出缺失字段后返回数据管理" }];
    data.interactions = [{ id: "supply", target_node_id: "factor", source_output_id: "", target_input_id: "", purpose: "提供查询结果", scenario: "报告查询时返回对应数据" }];
    const edges = projectDeliveryRelations(deriveEngineeringView(doc), doc.nodes.map(node => node.id));
    expect(edges.filter(edge => edge.sourceNodeId === "data" && edge.targetNodeId === "factor" && edge.kind === "input").map(edge => edge.relationId)).toEqual(["input:bars", "input:dictionary"]);
    expect(edges.filter(edge => edge.kind === "interaction")).toHaveLength(2);
    expect(new Set(edges.map(edge => edge.id)).size).toBe(edges.length);
    expect(factor.dependencies).toEqual([]);
    const rollups = rollupProjectDeliveryRelations(edges);
    expect(rollups).toHaveLength(4);
    expect(rollups.find(edge => edge.from === "data" && edge.to === "factor" && edge.kind === "input")).toMatchObject({ label: "历史行情 + 数据字典", members: expect.arrayContaining([
      expect.objectContaining({ relationId: "input:bars" }),
      expect.objectContaining({ relationId: "input:dictionary" })
    ]) });
    expect(rollups.filter(edge => edge.from === "data" && edge.to === "factor")).toHaveLength(2);
    expect(rollups.filter(edge => edge.from === "factor" && edge.to === "data")).toHaveLength(1);
    expect(rollups.filter(edge => edge.kind === "interaction")).toHaveLength(2);
  });
  it("resolves output identities and consumers without using node labels or mutating evidence", () => {
    const doc = scenario(), view = deriveEngineeringView(doc), before = JSON.stringify(view), model = projectDeliverySummary(view, "factor")!;
    expect(model.inputs).toEqual([expect.objectContaining({ sourceNodeId: "data", sourceOutputId: "report", outputTitle: "历史行情", problem: "" })]);
    expect(model.outputs[0].criteria.map(item => item.id)).toEqual(["factor-manual"]);
    expect(model.consumers).toEqual([expect.objectContaining({ nodeId: "strategy", outputTitle: "评估报告" })]);
    expect(model.contractComplete).toBe(true);
    expect(JSON.stringify(view)).toBe(before);
  });
  it("never equates a complete delivery contract with accepted work", () => {
    const doc = scenario(), view = deriveEngineeringView(doc), model = projectDeliverySummary(view, "data")!;
    expect(model.contractComplete).toBe(true);
    expect(model.node.status).toBe("draft"); expect(view.document.runs).toEqual([]);
    doc.runs.push(inspectorRun(doc, "data", "accepted"));
    doc.nodes.find(node => node.id === "data")!.delivery!.outputs[0].criterion_ids = ["removed"];
    const changed = projectDeliverySummary(deriveEngineeringView(doc), "data")!;
    expect(changed.contractComplete).toBe(false); expect(changed.outputs[0]).toMatchObject({ criteria: [], missingCriteria: ["removed"] });
  });
  it("shows absent legacy contracts as unspecified and reuses domain diagnostics", () => {
    const doc = inspectorDocument(), view = deriveEngineeringView(doc), model = projectDeliverySummary(view, "step")!;
    expect(model).toMatchObject({ configured: false, contractComplete: false, inputs: [], outputs: [] });
    doc.nodes[0].delivery = delivery("root");
    expect(projectDeliverySummary(deriveEngineeringView(doc), "step")!.issues).toEqual(engineeringDeliveryIssues(doc, "step"));
    expect(projectDeliverySummary(view, "missing")).toBeUndefined();
  });
  it("keeps explicit external sources distinct and exposes broken node/output sources", () => {
    const doc = scenario(), factor = doc.nodes.find(node => node.id === "factor")!;
    factor.delivery!.inputs.push({ id: "scope", title: "研究范围", source_node_id: null, source_output_id: "", external_source: "项目委托说明" });
    let model = projectDeliverySummary(deriveEngineeringView(doc), "factor")!;
    expect(model.inputs[1]).toMatchObject({ sourceNodeId: null, externalSource: "项目委托说明", problem: "" });
    doc.nodes.find(node => node.id === "data")!.delivery!.outputs = [];
    model = projectDeliverySummary(deriveEngineeringView(doc), "factor")!;
    expect(model.inputs[0].problem).toContain("来源成果"); expect(model.contractComplete).toBe(false);
    doc.nodes.find(node => node.id === "data")!.status = "archived";
    model = projectDeliverySummary(deriveEngineeringView(doc), "factor")!;
    expect(model.inputs[0]).toMatchObject({ sourceNodeId: null, problem: "来源节点已归档" });
  });
  it("excludes archived consumers and leaves dependencies without delivery mappings explicit", () => {
    const doc = scenario(), strategy = doc.nodes.find(node => node.id === "strategy")!;
    strategy.status = "archived";
    expect(projectDeliverySummary(deriveEngineeringView(doc), "factor")!.consumers).toEqual([]);
    strategy.status = "draft"; strategy.delivery!.inputs = [];
    expect(projectDeliverySummary(deriveEngineeringView(doc), "strategy")!.declaredDependencies).toEqual(["factor"]);
    expect(projectDeliveryRelations(deriveEngineeringView(doc), ["root", "data", "research", "strategy"]).find(edge => edge.targetNodeId === "strategy")!.label).toBe("旧方案前置");
  });
  it("projects real hidden handoffs to visible branches, preserving original endpoints", () => {
    const view = deriveEngineeringView(scenario()), edges = projectDeliveryRelations(view, ["root", "data", "research", "strategy"]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ sourceNodeId: "data", targetNodeId: "factor", from: "data", to: "research", label: "历史行情", projected: true, renderable: true });
    expect(edges[1]).toMatchObject({ sourceNodeId: "factor", targetNodeId: "strategy", from: "research", to: "strategy", label: "评估报告", projected: true, renderable: true });
    const closed = projectDeliveryRelations(view, ["root"]);
    expect(closed).toHaveLength(2); expect(closed.every(edge => edge.from === "root" && edge.to === "root" && !edge.renderable)).toBe(true);
  });
  it("rolls nine hidden handoffs into six directed branch links while preserving every declaration", () => {
    const branchIds = ["entry", "structure", "improve", "execute", "result"];
    const nodes = [inspectorNode("root", null), ...branchIds.map(id => inspectorNode(id, "root", { delivery: delivery(id) }))];
    const addLeaf = (id: string, parent: string, outputTitle: string) => {
      const node = inspectorNode(id, parent, { delivery: delivery(id) });
      node.delivery!.outputs[0].title = outputTitle;
      nodes.push(node);
      return node;
    };
    const entry = addLeaf("entry-task", "entry", "已恢复的 Codex 任务");
    const structureMap = addLeaf("structure-map", "structure", "版本化工程结构图");
    const structureScope = addLeaf("structure-scope", "structure", "节点边界与交付约定");
    const improveLocate = addLeaf("improve-locate", "improve", "图上问题位置");
    const executeRun = addLeaf("execute-run", "execute", "节点对应的 Codex 运行");
    const executeState = addLeaf("execute-state", "execute", "节点执行状态");
    const resultArtifact = addLeaf("result-artifact", "result", "可打开的节点成果索引");
    const input = (target: EngineeringNode, id: string, source: EngineeringNode) => target.delivery!.inputs.push({ id, title: id, source_node_id: source.id, source_output_id: "report", external_source: "" });
    input(structureMap, "task", entry);
    input(improveLocate, "map-one", structureMap);
    input(nodes.find(node => node.id === "improve")!, "map-two", structureMap);
    input(nodes.find(node => node.id === "execute")!, "map", structureMap);
    input(executeRun, "scope", structureScope);
    input(nodes.find(node => node.id === "result")!, "run", executeRun);
    input(resultArtifact, "state", executeState);
    improveLocate.interactions = [{ id: "send-change", target_node_id: executeRun.id, source_output_id: "", target_input_id: "", purpose: "改动范围", scenario: "修改交给执行" }];
    resultArtifact.interactions = [{ id: "return-result", target_node_id: improveLocate.id, source_output_id: "", target_input_id: "", purpose: "当前成果", scenario: "结果返回改进" }];
    const visible = ["root", ...branchIds];
    const atomic = projectDeliveryRelations(deriveEngineeringView(inspectorDocument(nodes)), visible);
    const rollups = rollupProjectDeliveryRelations(atomic);
    expect(atomic).toHaveLength(9);
    expect(rollups).toHaveLength(6);
    expect(rollups.flatMap(edge => edge.members)).toHaveLength(9);
    expect(new Set(rollups.flatMap(edge => edge.members.map(member => member.id)))).toEqual(new Set(atomic.map(edge => edge.id)));
    expect(rollups.find(edge => edge.from === "structure" && edge.to === "improve" && edge.kind === "input")).toMatchObject({ label: "版本化工程结构图", members: expect.arrayContaining([expect.objectContaining({ sourceNodeId: "structure-map", targetNodeId: "improve-locate" })]) });
    expect(rollups.find(edge => edge.from === "structure" && edge.to === "execute" && edge.kind === "input")).toMatchObject({ label: "版本化工程结构图 + 节点边界与交付约定", members: expect.arrayContaining([expect.objectContaining({ sourceNodeId: "structure-map" }), expect.objectContaining({ sourceNodeId: "structure-scope" })]) });
    expect(rollups.find(edge => edge.from === "execute" && edge.to === "result" && edge.kind === "input")?.label).toBe("节点执行状态 + 节点对应的 Codex 运行");
    expect(rollups.some(edge => edge.from === "improve" && edge.to === "execute" && edge.kind === "interaction")).toBe(true);
    expect(rollups.some(edge => edge.from === "result" && edge.to === "improve" && edge.kind === "interaction")).toBe(true);
    const emphasisStates = rollups.map(edge => deliveryRelationTouchesNode(edge, "improve", "root"));
    expect(emphasisStates).toHaveLength(6);
    expect(emphasisStates.filter(Boolean)).toHaveLength(3);
    expect(rollups.every(edge => deliveryRelationTouchesNode(edge, "root", "root"))).toBe(true);
  });
  it("derives a real input wait without duplicating legacy dependency fields", () => {
    const doc = scenario(), factor = doc.nodes.find(node => node.id === "factor")!;
    factor.dependencies = [];
    const edges = projectDeliveryRelations(deriveEngineeringView(doc), doc.nodes.map(node => node.id));
    expect(edges.find(edge => edge.targetNodeId === "factor")).toMatchObject({ renderable: true, problem: "", kind: "input", relationId: "input:bars" });
    expect(edges.some(edge => edge.sourceNodeId === "root" || edge.targetNodeId === "research")).toBe(false);
  });
  it("explains only declared contributions to real parent completion conditions", () => {
    const doc = scenario(), factor = doc.nodes.find(node => node.id === "factor")!;
    factor.contributes_to = ["research-manual", "removed"];
    const model = projectDeliverySummary(deriveEngineeringView(doc), "factor")!;
    expect(model.parentContribution).toMatchObject({ nodeId: "research", criteria: [expect.objectContaining({ id: "research-manual" })], missingCriteria: ["removed"] });
    expect(projectDeliverySummary(deriveEngineeringView(doc), "root")!.parentContribution).toBeUndefined();
  });
  it("uses the changed source output title, not stale input labels, and marks unmappable references", () => {
    const doc = scenario(); doc.nodes.find(node => node.id === "data")!.delivery!.outputs[0].title = "调整后的行情数据";
    let edge = projectDeliveryRelations(deriveEngineeringView(doc), doc.nodes.map(node => node.id))[0];
    expect(edge.label).toBe("调整后的行情数据");
    doc.nodes.find(node => node.id === "factor")!.delivery!.inputs[0].source_output_id = "missing";
    edge = projectDeliveryRelations(deriveEngineeringView(doc), doc.nodes.map(node => node.id))[0];
    expect(edge).toMatchObject({ label: "交接成果待说明", problem: "输入未对应有效成果" });
  });
  it("does not place arrow labels on cards or existing labels", () => {
    const points = [{ x: 20, y: 40 }, { x: 250, y: 40 }];
    const label = deliveryRelationLabel(points, "行情数据", [], 300, 100)!;
    expect(label).toBeDefined();
    expect(label.rect.left).toBeGreaterThanOrEqual(6); expect(label.rect.right).toBeLessThanOrEqual(294);
    expect(label.rect.top).toBeGreaterThanOrEqual(6); expect(label.rect.bottom).toBeLessThanOrEqual(94);
    const next = deliveryRelationLabel(points, "另一成果", [], 300, 100, [label.rect])!;
    expect(next).toBeDefined();
    expect(next.rect.right <= label.rect.left - 4 || next.rect.left >= label.rect.right + 4 || next.rect.bottom <= label.rect.top - 4 || next.rect.top >= label.rect.bottom + 4).toBe(true);
    const blocked = { id: "full", left: 0, right: 300, top: 0, bottom: 100 };
    expect(deliveryRelationLabel(points, "行情数据", [blocked], 300, 100)).toBeUndefined();
    expect(deliveryRelationLabel(points, "行情数据", [], 300, 100, [blocked])).toBeUndefined();
  });
  it("moves a label beside a short horizontal handoff and connects it back to the route", () => {
    const points = [{ x: 110, y: 80 }, { x: 130, y: 80 }];
    const cards = [
      { id: "left", left: 0, right: 110, top: 20, bottom: 140 },
      { id: "right", left: 130, right: 240, top: 20, bottom: 140 },
      { id: "caption", left: 70, right: 170, top: 0, bottom: 18 }
    ];
    const label = deliveryRelationLabel(points, "把改动范围交给 Codex 执行。", cards, 240, 220)!;
    expect(label).toBeDefined();
    expect(label.text).toBe("把改动范围交给 Codex 执行。");
    expect(label.y).toBeGreaterThanOrEqual(144);
    expect(label.connector).toBe("M 120 80 L 120 144");
    expect(cards.every(card => label.rect.right <= card.left - 4 || label.rect.left >= card.right + 4 || label.rect.bottom <= card.top - 4 || label.rect.top >= card.bottom + 4)).toBe(true);
    expect(label.rect.right).toBeLessThanOrEqual(234); expect(label.rect.bottom).toBeLessThanOrEqual(214);
  });
  it("uses horizontal whitespace when a horizontal handoff is blocked above and below", () => {
    const points = [{ x: 110, y: 80 }, { x: 130, y: 80 }];
    const blockers = [
      { id: "left-card", left: 80, right: 110, top: 20, bottom: 140 },
      { id: "right-card", left: 130, right: 160, top: 20, bottom: 140 },
      { id: "top-boundary", left: 0, right: 240, top: 0, bottom: 18 },
      { id: "bottom-boundary", left: 0, right: 240, top: 142, bottom: 220 }
    ];
    const label = deliveryRelationLabel(points, "交接结果", blockers, 240, 220)!;
    expect(label).toBeDefined();
    expect(label.rect.right <= 76 || label.rect.left >= 164).toBe(true);
    expect(label.connector).toBe("M 120 80 L 76 80");
  });
  it("uses vertical whitespace when a vertical handoff is blocked left and right", () => {
    const points = [{ x: 120, y: 110 }, { x: 120, y: 130 }];
    const blockers = [
      { id: "top-card", left: 60, right: 180, top: 80, bottom: 110 },
      { id: "bottom-card", left: 60, right: 180, top: 130, bottom: 160 },
      { id: "left-boundary", left: 0, right: 58, top: 0, bottom: 240 },
      { id: "right-boundary", left: 182, right: 240, top: 0, bottom: 240 }
    ];
    const label = deliveryRelationLabel(points, "交接结果", blockers, 240, 240)!;
    expect(label).toBeDefined();
    expect(label.rect.bottom <= 76 || label.rect.top >= 164).toBe(true);
    expect(label.connector).toBe("M 120 120 L 120 76");
  });
});
