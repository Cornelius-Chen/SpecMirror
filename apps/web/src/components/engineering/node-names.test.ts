import { describe, expect, it } from "vitest";
import { engineeringNodeName } from "./node-names.ts";

describe("engineering display names", () => {
  it("uses the actual node kind without rewriting its source identity or title", () => {
    const node = Object.freeze({ id: "same-id", kind: "task" as const, title: "完整任务标题与交付目标" });
    const names = Object.freeze({ "same-id": "  协同推进  " });
    expect(engineeringNodeName(node, names)).toBe("任务：协同推进");
    expect(node.title).toBe("完整任务标题与交付目标");
    expect(names["same-id"]).toBe("  协同推进  ");
  });
  it("retains legacy titles for absent or empty presentation metadata", () => {
    const node = { id: "legacy", kind: "project" as const, title: "原有工程名称" };
    expect(engineeringNodeName(node)).toBe(node.title);
    expect(engineeringNodeName(node, { legacy: "  " })).toBe(node.title);
    expect(engineeringNodeName({ ...node, id: "toString" }, {})).toBe(node.title);
  });
  it("keeps workspace name maps independent even when nodes share an id", () => {
    const node = { id: "root", kind: "step" as const, title: "源标题" };
    expect(engineeringNodeName(node, { root: "检查结果" })).toBe("步骤：检查结果");
    expect(engineeringNodeName(node, { root: "准备方案" })).toBe("步骤：准备方案");
  });
});
