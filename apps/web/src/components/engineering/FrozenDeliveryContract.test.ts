import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveEngineeringView, type EngineeringDeliveryContract, type EngineeringHandoffPacket } from "@epm/domain";
import { createEngineeringApi } from "../../engineering-api.ts";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { FrozenDeliveryContract } from "./FrozenDeliveryContract.tsx";
import { RunPanel } from "./RunPanel.tsx";

const delivery = (label: string): EngineeringDeliveryContract => ({
  included: [`${label}负责范围`], excluded: [`${label}排除范围`],
  outputs: [{ id: "result", title: `${label}报告`, criterion_ids: ["task-manual"] }],
  inputs: [{ id: "source", title: `${label}数据`, source_node_id: "provider", source_output_id: "dataset", external_source: "" }, { id: "external", title: `${label}需求`, source_node_id: null, source_output_id: "", external_source: `${label}用户资料` }]
});

describe("frozen delivery contract presentation", () => {
  it("renders the actual historical RunPanel from the snapshot after current node and parent contracts change", () => {
    const doc = inspectorDocument([
      inspectorNode("root", null, { title: "冻结父项目", delivery: delivery("冻结上级") }),
      inspectorNode("task", "root", { title: "报告功能", delivery: delivery("冻结"), criteria: [{ id: "task-manual", text: "冻结完成条件", kind: "manual", path: "", expected: "" }] }),
      inspectorNode("provider", "root", { delivery: { ...delivery("来源"), outputs: [{ id: "dataset", title: "来源数据", criterion_ids: ["provider-manual"] }] } })
    ]);
    const run = inspectorRun(doc, "task", "review");
    run.snapshot.delivery_lineage = doc.nodes.filter(node => ["root", "task"].includes(node.id)).map(node => ({ node_id: node.id, title: node.title, delivery: structuredClone(node.delivery!) }));
    doc.runs.push(run);
    const frozen = JSON.stringify(run.snapshot);
    const node = doc.nodes.find(item => item.id === "task")!;
    node.delivery = delivery("当前新增"); node.criteria[0].text = "当前新增完成条件"; node.revision++;
    doc.nodes[0].title = "当前新增父项目"; doc.nodes[0].delivery = delivery("当前新增上级"); doc.nodes[0].revision++;
    const view = deriveEngineeringView(doc);
    const html = renderToStaticMarkup(createElement(RunPanel, { api: createEngineeringApi("isolated-test"), node, view, busy: false, onMutation: async () => false, onSelect: () => {} }));
    expect(html).toContain("本次交付约定"); expect(html).toContain("冻结报告"); expect(html).toContain("冻结完成条件");
    expect(html).toContain("冻结父项目"); expect(html).toContain("冻结上级排除范围");
    expect(html).toContain("冻结用户资料"); expect(html).toContain("冻结数据");
    expect(html).not.toContain("当前新增");
    expect(html).toContain('<details class="eng-disclosure"><summary>查看运行身份与冻结方案</summary>');
    expect(html).not.toContain('<details class="eng-disclosure" open=""><summary>查看运行身份与冻结方案</summary>');
    expect(JSON.stringify(run.snapshot)).toBe(frozen);
  });

  it("reads packet-only criteria and lineage, keeping source identifiers in a nested disclosure", () => {
    const packet: Pick<EngineeringHandoffPacket, "node_id" | "delivery" | "criteria" | "delivery_lineage"> = {
      node_id: "task", delivery: delivery("交接冻结"),
      criteria: [{ id: "task-manual", text: "交接时的验收要求", kind: "manual", path: "", expected: "" }],
      delivery_lineage: [{ node_id: "root", title: "交接时的父项目", delivery: delivery("父级冻结") }, { node_id: "task", title: "本任务", delivery: delivery("自身重复") }]
    };
    const before = JSON.stringify(packet);
    const html = renderToStaticMarkup(createElement(FrozenDeliveryContract, { nodeId: packet.node_id, delivery: packet.delivery, criteria: packet.criteria, lineage: packet.delivery_lineage }));
    expect(html).toContain("交接冻结报告"); expect(html).toContain("交接时的验收要求");
    expect(html).toContain("交接时的父项目"); expect(html).not.toContain("自身重复");
    expect(html).toContain("查看冻结来源标识</summary><p>提供方：<code>provider</code>");
    expect(html).toContain("业务范围仍须结合实际产物核对");
    expect(JSON.stringify(packet)).toBe(before);
  });

  it("keeps missing historical contracts and missing criterion text explicit instead of filling from live state", () => {
    const missing = renderToStaticMarkup(createElement(FrozenDeliveryContract, { nodeId: "old", criteria: [] }));
    expect(missing).toContain("不使用当前方案补写历史");
    const partial = renderToStaticMarkup(createElement(FrozenDeliveryContract, { nodeId: "old", delivery: delivery("历史"), criteria: [] }));
    expect(partial).toContain("此冻结记录未保留对应的完成条件");
    expect(partial).toContain("本次冻结记录没有上级业务边界");
  });
});
