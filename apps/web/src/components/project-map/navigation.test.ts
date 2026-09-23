import { describe, expect, it } from "vitest";
import { deriveEngineeringView } from "@epm/domain";
import { attentionDocument } from "../../../../../tests/fixtures/attention-document.ts";
import { readProjectRoute, restoreProjectBrowsing, revealProjectNode } from "./navigation.ts";

describe("inline project structure route restoration", () => {
  const view = deriveEngineeringView(attentionDocument("parent-review"));
  it("opens a new project at its root with details closed", () => {
    expect(restoreProjectBrowsing(view, "one", readProjectRoute(new URLSearchParams("task=a")))).toMatchObject({ scope: "one", selectedNodeId: view.document.root_id, expandedNodeIds: [view.document.root_id], tab: null });
  });
  it("restores visible ancestors for a selected child and ignores unknown detail tabs", () => {
    const child = view.document.nodes.find((node) => node.parent_id === view.document.root_id)!;
    const route = readProjectRoute(new URLSearchParams({ task: "a", view: "map", node: child.id, map_node: view.document.root_id, tab: "delete" }));
    expect(restoreProjectBrowsing(view, "one", route)).toMatchObject({ selectedNodeId: child.id, expandedNodeIds: [view.document.root_id], tab: null });
  });
  it("maps old engineering and node links to inline reading without treating a new map selection as an open editor", () => {
    expect(readProjectRoute(new URLSearchParams("workspace=engineering"))).toMatchObject({ taskId: "@existing", surface: "map", tab: "reading" });
    expect(readProjectRoute(new URLSearchParams("node=old"))).toMatchObject({ taskId: "@existing", surface: "map", tab: "reading" });
    expect(readProjectRoute(new URLSearchParams("view=map&node=old"))).toMatchObject({ surface: "map", tab: null });
    expect(readProjectRoute(new URLSearchParams("view=map&node=old&tab=runs"))).toMatchObject({ surface: "map", tab: "runs" });
  });
  it("falls back to the new workspace root when a deep link belongs to another workspace", () => {
    expect(restoreProjectBrowsing(view, "two", readProjectRoute(new URLSearchParams("view=map&node=foreign&map_node=foreign-parent&expanded=foreign-parent")))).toMatchObject({ scope: "two", selectedNodeId: view.document.root_id, tab: null });
  });
  it("reveals a deep node while retaining independent expanded branches and dropping unavailable ids", () => {
    const expanded = revealProjectNode(view, "source-check", ["research", "archived", "not-in-this-workspace"]);
    expect(new Set(expanded)).toEqual(new Set(["project", "research"]));
    expect(view.document.nodes.find(node => node.id === "archived")?.status).toBe("archived");
  });
  it("restores explicit expansion and selected detail without requiring a camera route", () => {
    const route = readProjectRoute(new URLSearchParams("task=a&view=map&node=source-check&expanded=project,research&tab=runs"));
    expect(route).toMatchObject({ expandedNodeIds: ["project", "research"], focusNodeId: null });
    expect(restoreProjectBrowsing(view, "one", route)).toMatchObject({ scope: "one", selectedNodeId: "source-check", expandedNodeIds: ["project", "research"], tab: "runs" });
    expect(restoreProjectBrowsing(view, "one", readProjectRoute(new URLSearchParams("view=map&node=project&expanded="))).expandedNodeIds).toEqual([]);
  });
  it("normalizes an old child-root route into one project graph while preserving its visible path", () => {
    const route = readProjectRoute(new URLSearchParams("task=a&view=map&node=source-check&map_node=research&expanded=project,research"));
    expect(restoreProjectBrowsing(view, "one", route)).toMatchObject({
      focusNodeId: view.document.root_id,
      selectedNodeId: "source-check",
      expandedNodeIds: ["project", "research"]
    });
  });
});
