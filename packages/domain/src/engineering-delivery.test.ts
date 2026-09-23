import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView, engineeringDeliveryIssues, previewEngineeringChange, validateEngineeringDocument, type EngineeringDeliveryContract, type EngineeringDocument, type EngineeringNode } from "./engineering.ts";

const delivery = (criterion = "done"): EngineeringDeliveryContract => ({ included: ["产出本项成果"], excluded: ["不承担交易执行"], outputs: [{ id: "result", title: "可用成果", criterion_ids: [criterion] }], inputs: [] });
const node = (id: string, parent_id: string | null, extra: Partial<EngineeringNode> = {}) => EngineeringNodeSchema.parse({ id, parent_id, kind: parent_id ? "task" : "project", title: id, objective: "完成独立成果", order: 0, revision: 1, status: "draft", contributes_to: parent_id ? ["done"] : [], constraints: { allow: ["artifacts/**"] }, criteria: [{ id: "done", text: "成果满足明确目标", kind: "manual" }], created_at: "now", updated_at: "now", ...extra });
const document = (nodes: EngineeringNode[]): EngineeringDocument => ({ schema_version: 1, id: "doc", revision: 1, root_id: "root", created_at: "now", updated_at: "now", nodes, runs: [], changes: [], events: [], capability_uses: [] });

describe("deliverable boundaries and minimum completion relationships", () => {
  it("requires each enabled child to explain its parent contribution even when another child covers every parent condition", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("covered", "root", { delivery: delivery() }), node("orphan", "root", { contributes_to: [], delivery: delivery(), status: "ready", actions: [{ id: "write", title: "产出报告", type: "write_file", path: "artifacts/result.txt", content: "result", criterion_id: "done", capability_id: "" }] })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    const view = deriveEngineeringView(doc);
    expect(view.derived.root.uncovered_criteria).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "orphan").join(" ")).toContain("至少关联一条上级");
    expect(view.derived.orphan.can_run).toBe(false);
    doc.nodes[2].contributes_to = ["done"];
    expect(engineeringDeliveryIssues(doc, "orphan")).toEqual([]);
    // Coverage alone is insufficient once the project declares delivery contracts.
    doc.nodes[0].composition = { summary: "各项成果组成整体交付", scenario: "按约定完整使用成果", integration_criterion_ids: ["done"] };
    doc.nodes[2].contribution = { summary: "承担原来遗漏的成果部分" };
    expect(deriveEngineeringView(doc).derived.orphan.can_run).toBe(true);
  });

  it("requests parent conditions before a contribution can be defined and preserves old branches without delivery", () => {
    const doc = document([node("root", null, { criteria: [] }), node("child", "root", { contributes_to: [], delivery: delivery() })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "child").join(" ")).toContain("先补充上级");
    delete doc.nodes[1].delivery;
    expect(engineeringDeliveryIssues(doc, "child")).toEqual([]);
    const legacy = document([node("root", null), node("covered", "root"), node("orphan", "root", { contributes_to: [], status: "ready", actions: [{ id: "write", title: "产出报告", type: "write_file", path: "artifacts/result.txt", content: "result", criterion_id: "done", capability_id: "" }] })]);
    expect(engineeringDeliveryIssues(legacy, "orphan")).toEqual([]);
    expect(deriveEngineeringView(legacy).derived.orphan.can_run).toBe(true);
  });

  it("keeps old branches compatible and opts a whole descendant branch into explicit contracts", () => {
    const doc = document([node("root", null), node("a", "root"), node("b", "a")]);
    expect(engineeringDeliveryIssues(doc, "b")).toEqual([]);
    doc.nodes[1].delivery = delivery();
    expect(engineeringDeliveryIssues(doc, "root")).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "a")).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "b").join(" ")).toContain("负责范围");
    expect(deriveEngineeringView(doc).derived.b.blockers.join(" ")).toContain("负责范围");
  });

  it("saves incomplete drafts but names all missing boundaries, results and sources", () => {
    const doc = document([node("root", null, { delivery: { included: [], excluded: [], outputs: [{ id: "r", title: "", criterion_ids: [] }], inputs: [{ id: "i", title: "", source_node_id: null, source_output_id: "", external_source: "" }] } })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    const issues = engineeringDeliveryIssues(doc, "root").join(" ");
    for (const word of ["负责的范围", "不承担的范围", "成果尚未填写名称", "关联完成条件", "说明外部来源"]) expect(issues).toContain(word);
  });

  it("allows an explicit no-extra-exclusions decision without relaxing inherited boundaries", () => {
    const doc = document([node("root", null, { delivery: delivery(), constraints: { allow: ["artifacts/**"], deny: ["artifacts/private/**"], rules: ["保留来源"], resources: [] } }),
      node("child", "root", { delivery: { ...delivery(), excluded: [] } })]);
    expect(engineeringDeliveryIssues(doc, "child").join(" ")).toContain("额外排除项");
    doc.nodes[1].delivery!.no_extra_exclusions = false;
    expect(engineeringDeliveryIssues(doc, "child").join(" ")).toContain("额外排除项");
    doc.nodes[1].delivery!.no_extra_exclusions = true;
    expect(engineeringDeliveryIssues(doc, "child")).toEqual([]);
    const view = deriveEngineeringView(doc);
    expect(view.derived.child.effective.deny).toContainEqual({ node_id: "root", title: "root", pattern: "artifacts/private/**" });
    expect(view.derived.child.effective.rules).toContainEqual({ node_id: "root", title: "root", text: "保留来源" });
  });

  it("requires real referenced outputs and derives delivery waits without a duplicate dependency", () => {
    const input = { id: "in", title: "研究数据", source_node_id: "source", source_output_id: "result", external_source: "" };
    const doc = document([node("root", null, { delivery: delivery() }), node("source", "root", { delivery: delivery() }), node("consumer", "root", { delivery: { ...delivery(), inputs: [input] } })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "consumer")).toEqual([]);
    expect(deriveEngineeringView(doc).derived.consumer.blockers.join(" ")).toContain("等待“source”");
    expect(doc.nodes[2].dependencies).toEqual([]);
    input.source_output_id = "absent";
    doc.nodes[2].delivery!.inputs[0].source_output_id = "absent";
    expect(validateEngineeringDocument(doc).join(" ")).toContain("来源成果不存在");
  });

  it("rejects duplicate identities, invalid criterion maps and conflicting sources while drafting", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("a", "root", { delivery: delivery() }), node("b", "root", { dependencies: ["a"], delivery: { ...delivery(), inputs: [{ id: "in", title: "输入", source_node_id: "a", source_output_id: "result", external_source: "also external" }] } })]);
    doc.nodes[2].delivery!.outputs.push({ id: "result", title: "重复成果", criterion_ids: ["missing"] });
    const issues = validateEngineeringDocument(doc).join(" ");
    expect(issues).toContain("成果身份重复"); expect(issues).toContain("不存在的验收条件"); expect(issues).toContain("来源之一");
  });

  it("preserves legacy completion prerequisites without manufacturing delivered inputs", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("source", "root", { delivery: delivery() }), node("consumer", "root", { dependencies: ["source"], delivery: { ...delivery(), inputs: [{ id: "brief", title: "需求", source_node_id: null, source_output_id: "", external_source: "本工程经确认的需求文件" }] } })]);
    expect(validateEngineeringDocument(doc)).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "source")).toEqual([]);
    expect(engineeringDeliveryIssues(doc, "consumer")).toEqual([]);
    expect(deriveEngineeringView(doc).derived.consumer.blockers.join(" ")).toContain("等待“source”");
  });

  it("uses existing cycle protection for both dependency and containment completion", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("a", "root", { delivery: delivery() }), node("b", "root", { delivery: delivery() })]);
    for (const [index, source] of [[1, "b"], [2, "a"]] as const) {
      doc.nodes[index].dependencies = [source]; doc.nodes[index].delivery!.inputs = [{ id: "in", title: "成果", source_node_id: source, source_output_id: "result", external_source: "" }];
    }
    expect(validateEngineeringDocument(doc).join(" ")).toContain("循环");
  });

  it("makes output changes invalidate downstream and parent evidence through existing version impact", () => {
    const doc = document([node("root", null, { delivery: delivery() }), node("source", "root", { delivery: delivery() }), node("consumer", "root", { dependencies: ["source"], delivery: { ...delivery(), inputs: [{ id: "in", title: "成果", source_node_id: "source", source_output_id: "result", external_source: "" }] } }), node("unrelated", "root")]);
    const changed = structuredClone(doc.nodes[1]); changed.delivery!.outputs[0].title = "修订成果";
    expect(previewEngineeringChange(doc, changed).affected_ids.sort()).toEqual(["consumer", "root", "source"]);
    doc.nodes[1].delivery!.outputs = [];
    expect(validateEngineeringDocument(doc).join(" ")).toContain("悬空关系");
  });
});
