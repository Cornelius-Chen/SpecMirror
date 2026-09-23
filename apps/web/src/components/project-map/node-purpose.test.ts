import { describe, expect, it } from "vitest";
import { inspectorNode } from "../../../../../tests/fixtures/project-inspector.ts";
import { projectNodePurpose } from "./node-purpose.ts";

describe("project node purpose", () => {
  it("explains what a node does from its objective instead of repeating its output title", () => {
    const node = inspectorNode("plan", "root", { title: "工程方案", objective: "把工程拆成边界明确、能独立交付验收的子项目，并看清各成果之间的关系。", delivery: { included: [], excluded: [], inputs: [], outputs: [{ id: "result", title: "工程方案", criterion_ids: [] }] } });
    expect(projectNodePurpose(node)).toMatchObject({ source: "objective", text: "把工程拆成边界明确、能独立交付验收的子项目。" });
  });

  it("uses only stored contribution or output facts when the objective is a placeholder", () => {
    const contribution = inspectorNode("a", "root", { title: "图上关系", objective: "请说明这条设计为什么要做。", contribution: { summary: "让用户看清成果怎样流向下一项" } });
    expect(projectNodePurpose(contribution)).toMatchObject({ source: "contribution", text: "让用户看清成果怎样流向下一项。" });
    const output = inspectorNode("b", "root", { title: "证据管理", objective: "等待监督者补充任务目标和验收标准", delivery: { included: [], excluded: [], inputs: [], outputs: [{ id: "report", title: "可打开的成果报告", criterion_ids: [] }] } });
    expect(projectNodePurpose(output)).toMatchObject({ source: "output", text: "产出可打开的成果报告。" });
  });

  it("keeps one compact sentence and reports missing purpose honestly", () => {
    const long = inspectorNode("root", null, { objective: "将工程项目、任务和步骤逐层展开、约束、分配与验收；用真实执行证据发现偏移，并组织多 Agent 并行。" });
    expect(projectNodePurpose(long).text).toBe("将工程项目、任务和步骤逐层展开、约束、分配与验收。" );
    const colon = inspectorNode("colon", null, { objective: "让用户用一张成果结构图管理所有 Codex 工程：每个子项目有边界、可验收并可反馈。" });
    expect(projectNodePurpose(colon).text).toBe("让用户用一张成果结构图管理所有 Codex 工程。" );
    const missing = inspectorNode("empty", "root", { title: "未知部分", objective: "", method: "不要把做法当作用", contribution: undefined, delivery: { included: ["未知部分"], excluded: [], inputs: [], outputs: [{ id: "same", title: "可冻结的未知部分", criterion_ids: [] }] } });
    expect(projectNodePurpose(missing)).toEqual({ source: "missing", text: "用途尚待说明。", fullText: "用途尚待说明。" });
  });
});
