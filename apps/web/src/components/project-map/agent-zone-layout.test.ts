import { describe, expect, it } from "vitest";
import { agentZoneRegions, type AgentZoneLayoutNode } from "./agent-zone-layout.ts";

const node = (id: string, parentId: string | null, x: number, y: number): AgentZoneLayoutNode => ({ id, parentId, x, y, width: 208, height: 120, depth: parentId === "root" ? 1 : parentId ? 2 : 0, childCount: 0, expanded: false, opacity: 1 });

describe("agent collaboration zone overlay", () => {
  it("covers each visible first-level subtree without moving or overlapping neighbouring zones", () => {
    const nodes = [node("root", null, 260, 28), node("one", "root", 28, 204), node("one-child", "one", 28, 380), node("two", "root", 260, 204)];
    const zones = [
      { id: "zone:one", root_node_id: "one", node_ids: ["one", "one-child"] },
      { id: "zone:two", root_node_id: "two", node_ids: ["two"] }
    ];
    const result = agentZoneRegions(nodes, zones, 524, 538);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ rootNodeId: "one", nodeIds: ["one", "one-child"], x: 20, y: 176, width: 224, height: 334 });
    expect(result[1]).toMatchObject({ rootNodeId: "two", nodeIds: ["two"], x: 252, y: 176, width: 224, height: 158 });
    expect(result[0]!.x + result[0]!.width).toBeLessThan(result[1]!.x);
    expect(nodes.map(item => [item.id, item.x, item.y])).toEqual([["root", 260, 28], ["one", 28, 204], ["one-child", 28, 380], ["two", 260, 204]]);
  });

  it("keeps labels and boundaries inside a narrow canvas and skips invisible zones", () => {
    const nodes = [node("root", null, 4, 28), node("one", "root", 4, 204)];
    const [region] = agentZoneRegions(nodes, [
      { id: "zone:one", root_node_id: "one", node_ids: ["one", "hidden-child"] },
      { id: "zone:missing", root_node_id: "missing", node_ids: ["missing"] }
    ], 220, 360);
    expect(region).toMatchObject({ x: 4, y: 176 });
    expect(region!.labelX).toBeGreaterThanOrEqual(4);
    expect(region!.labelX + region!.labelWidth).toBeLessThanOrEqual(216);
    expect(region!.y + region!.height).toBeLessThanOrEqual(356);
  });

  it("never emits a negative region while target nodes arrive before canvas dimensions", () => {
    const [region] = agentZoneRegions([node("far", "root", 900, 220)], [{ id: "far-zone", root_node_id: "far", node_ids: ["far"] }], 400, 200);
    expect(region!.width).toBeGreaterThanOrEqual(0);
    expect(region!.height).toBeGreaterThanOrEqual(0);
    expect(region!.labelWidth).toBeGreaterThanOrEqual(0);
  });
});
