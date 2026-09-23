import { describe, expect, it } from "vitest";
import {
  EngineeringNodeSchema, currentEngineeringRun, deriveEngineeringView, effectiveEngineeringConstraints,
  engineeringChangeClassification, engineeringCompositionCoverage, engineeringCompositionIssues, engineeringContractKey,
  engineeringDirectPrerequisites, engineeringEffectivePrerequisites, engineeringFrozenDeliveryInputs,
  engineeringLineageVersions, engineeringNodeContractRevision, prepareEngineeringNodeRevision,
  previewEngineeringChange, validateEngineeringDocument,
  type EngineeringDocument, type EngineeringNode, type EngineeringRun
} from "./engineering.ts";

const node = (id: string, parent: string | null, patch: Partial<EngineeringNode> = {}) => EngineeringNodeSchema.parse({
  id, parent_id: parent, kind: parent ? "task" : "project", title: id, objective: "交付" + id,
  revision: 1, order: 0, status: "ready", constraints: { allow: ["output/**"] },
  criteria: [{ id: "done", text: "成果满足约定", kind: "manual" }], contributes_to: parent ? ["done"] : [],
  actions: parent ? [{ id: "produce", title: "生成成果", type: "write_file", path: `output/${id}.txt`, content: "verified" }] : [],
  created_at: "before", updated_at: "before", ...patch
});
const document = (nodes: EngineeringNode[]): EngineeringDocument => ({
  schema_version: 1, id: "relations", revision: 1, root_id: "root", created_at: "before", updated_at: "before",
  nodes, runs: [], changes: [], events: [], capability_uses: []
});
const delivery = () => ({ included: ["约定成果"], excluded: ["其他模块"], outputs: [{ id: "result", title: "结果", criterion_ids: ["done"] }], inputs: [] });
function accepted(doc: EngineeringDocument, id: string, status: EngineeringRun["status"] = "accepted") {
  const target = doc.nodes.find(item => item.id === id)!;
  const run: EngineeringRun = {
    id: `run-${id}-${doc.runs.length}`, node_id: id, mode: "controlled", status, actor: "test-executor",
    snapshot: { node: structuredClone(target), lineage: engineeringLineageVersions(doc, id), effective: effectiveEngineeringConstraints(doc, id),
      contract_key: engineeringContractKey(doc, id), dependencies: [], children: [], delivery_inputs: engineeringFrozenDeliveryInputs(doc, id) },
    started_at: "before", finished_at: "before", current_action: "", completed_action_ids: [], output_dir: "isolated-test",
    evidence: [{ id: `e-${id}`, criterion_id: "done", kind: "artifact", summary: "测试夹具的实际结果引用", passed: null, created_at: "before" }],
    reason: "", review_note: "fixture", reviewed_at: status === "accepted" ? "before" : null
  };
  doc.runs.push(run); return run;
}
const interaction = (id: string, target_node_id: string) => ({ id, target_node_id, source_output_id: "", target_input_id: "", purpose: "提交请求并响应结果", scenario: "用户完成一次操作" });

describe("outcome composition and typed engineering relationships", () => {
  it("allows recursive subprojects and keeps parent integration responsibility separate from children", () => {
    const root = node("root", null, { criteria: [{ id: "done", text: "子成果", kind: "manual", path: "", expected: "" }, { id: "integrated", text: "整套可用", kind: "manual", path: "", expected: "" }],
      composition: { summary: "子成果接通后组成整体", integration_criterion_ids: ["integrated"], scenario: "从输入到交付完整使用一次" } });
    const doc = document([root, node("part", "root", { kind: "project", contribution: { summary: "提供基础成果" } })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringCompositionCoverage(doc, "root")).toEqual([
      { criterion_id: "done", child_ids: ["part"], integration: false, covered: true },
      { criterion_id: "integrated", child_ids: [], integration: true, covered: true }
    ]);
    accepted(doc, "part");
    const view = deriveEngineeringView(doc);
    expect(view.derived.root.uncovered_criteria).toEqual([]);
    expect(view.derived.root.can_run).toBe(true);
    expect(view.derived.root.status).not.toBe("accepted");
    expect(view.derived.root.can_accept).toBe(false);
  });

  it("diagnoses incomplete narratives while drafts remain saveable and references stay strict", () => {
    const doc = document([node("root", null, { composition: { summary: "", integration_criterion_ids: [], scenario: "" } }), node("part", "root")]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringCompositionIssues(doc, "root")).toHaveLength(2);
    expect(engineeringCompositionIssues(doc, "part").join(" ")).toContain("具体贡献");
    expect(deriveEngineeringView(doc).derived.part.can_run).toBe(false);
    doc.nodes[0].composition!.integration_criterion_ids = ["nonexistent"];
    expect(validateEngineeringDocument(doc).join(" ")).toContain("不存在的完成条件");
  });

  it("cannot bypass composition by omitting the optional field from a new delivery project", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("part", "root", { delivery: delivery(), contribution: { summary: "提供组成成果" } })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringCompositionIssues(doc, "root")).toHaveLength(3);
    expect(engineeringCompositionCoverage(doc, "root")[0].covered).toBe(true);
    expect(deriveEngineeringView(doc).derived.part.can_run).toBe(false);
    expect(doc.nodes[0].composition).toBeUndefined();
    doc.nodes[0].composition = { summary: "接通各成果组成整体", scenario: "完成一次整体使用", integration_criterion_ids: [] };
    expect(engineeringCompositionIssues(doc, "root")).toEqual(["“root”需要至少一项由本层整合负责的完成条件。"]);
    doc.nodes[0].composition.integration_criterion_ids = ["done"];
    expect(engineeringCompositionIssues(doc, "root")).toEqual([]);
    expect(deriveEngineeringView(doc).derived.part.can_run).toBe(true);
  });

  it("requires inherited delivery composition recursively but not for leaves or archived-only children", () => {
    const doc = document([
      node("root", null, { delivery: delivery(), composition: { summary: "组成", scenario: "使用", integration_criterion_ids: ["done"] } }),
      node("part", "root", { contribution: { summary: "递归子项目" } }),
      node("leaf", "part", { delivery: delivery() })
    ]);
    expect(engineeringCompositionIssues(doc, "part")).toHaveLength(3);
    expect(engineeringCompositionIssues(doc, "leaf")).toEqual([]);
    doc.nodes[2].status = "archived";
    expect(engineeringCompositionIssues(doc, "part")).toEqual([]);
    expect(engineeringCompositionIssues(doc, "leaf")).toEqual([]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
  });

  it("retains historical accepted evidence while blocking a new review without integration responsibility", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("part", "root", { delivery: delivery(), contribution: { summary: "组成成果" } })]);
    accepted(doc, "part");
    const historical = accepted(doc, "root");
    const frozen = structuredClone(historical);
    expect(deriveEngineeringView(doc).derived.root.status).toBe("accepted");
    expect(currentEngineeringRun(doc, "root")).toEqual(frozen);
    const submitted = accepted(doc, "root", "review");
    expect(deriveEngineeringView(doc).derived.root.can_accept).toBe(false);
    expect(deriveEngineeringView(doc).derived.root.blockers.join(" ")).toContain("本层整合");
    expect(historical).toEqual(frozen);
    expect(submitted.status).toBe("review");
  });

  it("keeps undeclared legacy projects readable without assigning integration responsibilities for them", () => {
    const doc = document([node("root", null), node("part", "root")]);
    accepted(doc, "part");
    expect(engineeringCompositionIssues(doc, "root")).toEqual([]);
    expect(deriveEngineeringView(doc).derived.root.can_run).toBe(true);
    expect(doc.nodes.every(item => item.composition === undefined)).toBe(true);
  });

  it("does not treat many-to-many coverage as proof that composition or its scenario passed", () => {
    const doc = document([node("root", null, { composition: { summary: "两部分共同交付", integration_criterion_ids: [], scenario: "组合使用" } }),
      node("a", "root", { contribution: { summary: "负责输入" } }), node("b", "root", { contribution: { summary: "负责展示" } })]);
    expect(engineeringCompositionCoverage(doc, "root")[0].child_ids).toEqual(["a", "b"]);
    accepted(doc, "a"); accepted(doc, "b");
    expect(deriveEngineeringView(doc).derived.root.status).not.toBe("accepted");
    doc.nodes[1].contributes_to = []; doc.nodes[2].contributes_to = [];
    expect(deriveEngineeringView(doc).derived.root.uncovered_criteria).toEqual(["done"]);
  });

  it("separates delivered inputs, legacy waits and explicit no-output prerequisites", () => {
    const source = node("data", "root", { delivery: delivery() });
    const report = node("report", "root", { delivery: { ...delivery(), inputs: [{ id: "dataset", title: "原始数据", source_node_id: "data", source_output_id: "result", external_source: "" }] },
      prerequisites: [{ id: "authorization", node_id: "permission", reason: "获得允许后开始" }] });
    const doc = document([node("root", null), source, node("permission", "root"), report, node("leaf", "report")]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringDirectPrerequisites(report)).toEqual(["data", "permission"]);
    expect(engineeringEffectivePrerequisites(doc, "leaf")).toEqual(["data", "permission"]);
    expect(deriveEngineeringView(doc).derived.report.blockers.join(" ")).toContain("等待“data”");
    expect(deriveEngineeringView(doc).derived.report.blockers.join(" ")).toContain("等待“permission”");
    expect(report.dependencies).toEqual([]);
  });

  it("checks explicit waits together with implicit parent completion and explains the cycle", () => {
    const doc = document([node("root", null), node("A", "root"), node("B", "root"),
      node("a", "A", { prerequisites: [{ id: "wait-b", node_id: "B", reason: "需要对方完成" }] }),
      node("b", "B", { prerequisites: [{ id: "wait-a", node_id: "A", reason: "需要对方完成" }] })]);
    const errors = validateEngineeringDocument(doc).join(" ");
    expect(errors).toContain("循环");
    for (const name of ["“A”", "“a”", "“B”", "“b”"]) expect(errors).toContain(name);
  });

  it("allows bidirectional runtime interactions without execution waits but rechecks both ends on semantic change", () => {
    const doc = document([node("root", null), node("a", "root", { interactions: [interaction("request", "b")] }), node("b", "root", { interactions: [interaction("response", "a")] })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringEffectivePrerequisites(doc, "a")).toEqual([]);
    expect(deriveEngineeringView(doc).derived.a.can_run).toBe(true);
    expect(deriveEngineeringView(doc).derived.b.can_run).toBe(true);
    const first = accepted(doc, "a"), second = accepted(doc, "b");
    const next = prepareEngineeringNodeRevision(doc.nodes[1], { ...doc.nodes[1], objective: "新的接口约定" });
    expect(previewEngineeringChange(doc, next).affected_ids.sort()).toEqual(["a", "b", "root"]);
    doc.nodes[1] = next;
    expect(currentEngineeringRun(doc, "a")).toBeUndefined();
    expect(currentEngineeringRun(doc, "b")).toBeUndefined();
    expect([first.status, second.status]).toEqual(["accepted", "accepted"]);
  });

  it("rejects dangling runtime ports and duplicate identities even in draft state", () => {
    const doc = document([node("root", null), node("a", "root", { interactions: [{ ...interaction("edge", "b"), source_output_id: "missing", target_input_id: "missing" }] }), node("b", "root")]);
    let errors = validateEngineeringDocument(doc).join(" ");
    expect(errors).toContain("不存在的本项输出"); expect(errors).toContain("不存在的接收输入");
    doc.nodes[1].interactions![0] = interaction("edge", "absent");
    expect(validateEngineeringDocument(doc).join(" ")).toContain("配合目标不存在");
    doc.nodes[1].interactions = [interaction("edge", "b"), interaction("edge", "b")];
    errors = validateEngineeringDocument(doc).join(" ");
    expect(errors).toContain("身份重复");
    doc.nodes[1].prerequisites = [{ id: "wait", node_id: "absent", reason: "" }];
    expect(validateEngineeringDocument(doc).join(" ")).toContain("依赖不存在");
  });

  it("rejects runtime wires that contradict the receiving input's pinned source or output", () => {
    const source = node("source", "root", { delivery: { ...delivery(), outputs: [...delivery().outputs, { id: "other", title: "另一成果", criterion_ids: ["done"] }] },
      interactions: [{ ...interaction("provide", "consumer"), source_output_id: "result", target_input_id: "data" }] });
    const consumer = node("consumer", "root", { delivery: { ...delivery(), inputs: [{ id: "data", title: "约定来源", source_node_id: "source", source_output_id: "result", external_source: "" }] } });
    const doc = document([node("root", null), source, consumer, node("alternative", "root", { delivery: delivery() })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    consumer.delivery!.inputs[0].source_node_id = "alternative";
    expect(validateEngineeringDocument(doc).join(" ")).toContain("与接收输入声明的来源任务或成果不一致");
    consumer.delivery!.inputs[0].source_node_id = "source";
    source.interactions![0].source_output_id = "other";
    expect(validateEngineeringDocument(doc).join(" ")).toContain("与接收输入声明的来源任务或成果不一致");
    source.interactions![0].source_output_id = "";
    expect(validateEngineeringDocument(doc).join(" ")).toContain("与接收输入声明的来源任务或成果不一致");
  });

  it("keeps external runtime inputs and feedback cycles separate from completion prerequisites", () => {
    const runtimeDelivery = (title: string) => ({ ...delivery(), inputs: [{ id: "runtime", title, source_node_id: null, source_output_id: "", external_source: "运行期间接收的消息" }] });
    const doc = document([node("root", null),
      node("a", "root", { delivery: runtimeDelivery("响应消息"), interactions: [{ ...interaction("request", "b"), source_output_id: "result", target_input_id: "runtime" }] }),
      node("b", "root", { delivery: runtimeDelivery("请求消息"), interactions: [{ ...interaction("response", "a"), source_output_id: "result", target_input_id: "runtime" }] })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringEffectivePrerequisites(doc, "a")).toEqual([]);
    expect(engineeringEffectivePrerequisites(doc, "b")).toEqual([]);
    expect(deriveEngineeringView(doc).derived.a.can_run).toBe(true);
    expect(deriveEngineeringView(doc).derived.b.can_run).toBe(true);
    expect(engineeringFrozenDeliveryInputs(doc, "a")[0].source_run_id).toBeNull();
    expect(engineeringFrozenDeliveryInputs(doc, "b")[0].source_run_id).toBeNull();
  });

  it("freezes actual accepted source runs per declared input and does not claim pending or external data as accepted", () => {
    const doc = document([node("root", null), node("a", "root", { delivery: delivery() }), node("b", "root", {
      delivery: { ...delivery(), inputs: [{ id: "data", title: "数据", source_node_id: "a", source_output_id: "result", external_source: "" },
        { id: "brief", title: "约定", source_node_id: null, source_output_id: "", external_source: "需求文档 v1" }] }
    })]);
    expect(engineeringFrozenDeliveryInputs(doc, "b")[0].source_run_id).toBeNull();
    const sourceRun = accepted(doc, "a");
    const references = engineeringFrozenDeliveryInputs(doc, "b");
    expect(references[0]).toMatchObject({ consumer_node_id: "b", input_id: "data", source_output_id: "result", source_run_id: sourceRun.id, source_contract_revision: 1, source_contract_key: sourceRun.snapshot.contract_key });
    expect(references[1]).toMatchObject({ external_source: "需求文档 v1", source_run_id: null, source_contract_revision: null });
    doc.nodes[1].revision++;
    expect(engineeringFrozenDeliveryInputs(doc, "b")[0].source_run_id).toBeNull();
    expect(references[0].source_run_id).toBe(sourceRun.id);
  });
});

describe("display revisions and conservative change impact", () => {
  it("keeps the exact legacy contract keys and accepted evidence across a parent display rename", () => {
    const doc = document([node("root", null), node("a", "root"), node("b", "root", { dependencies: ["a"] })]);
    const a = accepted(doc, "a"), b = accepted(doc, "b"), parent = accepted(doc, "root");
    const keys = doc.nodes.map(item => engineeringContractKey(doc, item.id));
    const next = prepareEngineeringNodeRevision(doc.nodes[0], { ...doc.nodes[0], title: "更清楚的展示名称", order: 3 });
    expect(next.revision).toBe(2); expect(next.contract_revision).toBe(1);
    expect(previewEngineeringChange(doc, next)).toMatchObject({ classification: "presentation", affected_ids: [], invalidated_run_ids: [] });
    doc.nodes[0] = next;
    expect(doc.nodes.map(item => engineeringContractKey(doc, item.id))).toEqual(keys);
    expect(currentEngineeringRun(doc, "a")?.id).toBe(a.id);
    expect(currentEngineeringRun(doc, "b")?.id).toBe(b.id);
    expect(currentEngineeringRun(doc, "root")?.id).toBe(parent.id);
    expect(parent.snapshot.node.title).toBe("root");
  });

  it("does not revive stale evidence or accept a rejected result during display migration", () => {
    const doc = document([node("root", null), node("a", "root"), node("b", "root")]);
    accepted(doc, "a", "stale"); accepted(doc, "b", "rejected");
    doc.nodes[0] = prepareEngineeringNodeRevision(doc.nodes[0], { ...doc.nodes[0], title: "修改显示" });
    expect(currentEngineeringRun(doc, "a")).toBeUndefined();
    expect(currentEngineeringRun(doc, "b")?.status).toBe("rejected");
    expect(deriveEngineeringView(doc).derived.root.counts.accepted).toBe(0);
  });

  it("ignores client-supplied contract versions, invalidates owner changes and preserves unaffected branches", () => {
    const doc = document([node("root", null), node("a", "root"), node("b", "root"), node("consumer", "root", { prerequisites: [{ id: "wait-a", node_id: "a", reason: "需要已核对基础" }] })]);
    accepted(doc, "a"); const independent = accepted(doc, "b"); accepted(doc, "consumer");
    const next = prepareEngineeringNodeRevision(doc.nodes[1], { ...doc.nodes[1], owner: "new-owner", contract_revision: 999 });
    expect(engineeringChangeClassification(doc.nodes[1], next)).toBe("permissions");
    expect(next.contract_revision).toBe(2);
    const preview = previewEngineeringChange(doc, next);
    expect(preview.affected_ids.sort()).toEqual(["a", "consumer", "root"]);
    expect(preview.impact?.find(item => item.node_id === "consumer")).toMatchObject({ disposition: "needs_recheck", path: ["a", "consumer"] });
    doc.nodes[1] = next;
    expect(currentEngineeringRun(doc, "a")).toBeUndefined();
    expect(currentEngineeringRun(doc, "consumer")).toBeUndefined();
    expect(currentEngineeringRun(doc, "b")?.id).toBe(independent.id);
  });

  it("retains conservative node-level invalidation when unconsumed output compatibility is not proven", () => {
    const doc = document([node("root", null), node("source", "root", { delivery: { ...delivery(), outputs: [...delivery().outputs, { id: "other", title: "另一成果", criterion_ids: ["done"] }] } }),
      node("consumer", "root", { delivery: { ...delivery(), inputs: [{ id: "in", title: "仅使用首项", source_node_id: "source", source_output_id: "result", external_source: "" }] } })]);
    const next = structuredClone(doc.nodes[1]); next.delivery!.outputs[1].title = "另一成果改变";
    const preview = previewEngineeringChange(doc, next);
    expect(preview.classification).toBe("contract");
    expect(preview.affected_ids).toContain("consumer");
    expect(preview.reasons.join(" ")).toContain("尚未实现独立输出级兼容证明");
  });

  it("keeps semantic contract revision monotonic after several display revisions", () => {
    const original = node("a", "root", { revision: 7 });
    const first = prepareEngineeringNodeRevision(original, { ...original, title: "第一次显示" });
    const second = prepareEngineeringNodeRevision(first, { ...first, order: 4 });
    const third = prepareEngineeringNodeRevision(second, { ...second, objective: "新的结果" });
    expect([first.revision, second.revision, third.revision]).toEqual([8, 9, 10]);
    expect([first, second, third].map(engineeringNodeContractRevision)).toEqual([7, 7, 8]);
    expect(engineeringChangeClassification(third, { ...third, status: "running" })).toBe("none");
  });

  it("does not keep a queued run current if runtime relation contracts changed while waiting", () => {
    const doc = document([node("root", null), node("a", "root", { interactions: [interaction("pair", "b")] }), node("b", "root")]);
    const queued = accepted(doc, "a", "queued");
    expect(currentEngineeringRun(doc, "a")?.id).toBe(queued.id);
    doc.nodes[2] = prepareEngineeringNodeRevision(doc.nodes[2], { ...doc.nodes[2], architecture: "接口结构改变" });
    expect(currentEngineeringRun(doc, "a")).toBeUndefined();
  });
});
