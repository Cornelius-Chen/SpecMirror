import type { EngineeringView } from "@epm/domain";
import type { ProjectDetailTab } from "./types.ts";

const detailTabs: ProjectDetailTab[] = ["reading", "plan", "bounds", "criteria", "actions", "capabilities", "runs", "history"];
export const detailTab = (value: string | null | undefined): ProjectDetailTab | null => detailTabs.includes(value as ProjectDetailTab) ? value as ProjectDetailTab : null;
export function readProjectRoute(params: URLSearchParams) {
  const legacyDetail = params.get("view") === "engineering" || (params.get("view") !== "map" && params.get("view") !== "overview" && (params.has("node") || params.get("workspace") === "engineering"));
  return {
    taskId: params.get("task") || ((["legacy", "engineering"].includes(params.get("workspace") || "") || params.has("node")) ? "@existing" : ""),
    surface: params.get("view") === "conversation" ? "conversation" as const : "map" as const,
    nodeId: params.get("node"), focusNodeId: params.get("map_node"),
    expandedNodeIds: params.has("expanded") ? (params.get("expanded") || "").split(",").filter(Boolean) : null,
    tab: detailTab(params.get("tab")) ?? (legacyDetail ? "reading" : null),
  };
}
export interface ProjectBrowsingState { scope: string; focusNodeId: string; selectedNodeId: string; expandedNodeIds: string[]; tab: ProjectDetailTab | null; showDependencies: boolean }
export function revealProjectNode(view: EngineeringView, nodeId: string, expanded: readonly string[] = []): string[] {
  const ancestors = view.derived[nodeId]?.path.slice(0, -1) ?? [];
  return [...new Set([...expanded, ...ancestors])].filter(id => view.document.nodes.some(node => node.id === id && node.status !== "archived"));
}
export function restoreProjectBrowsing(view: EngineeringView, scope: string, route?: ReturnType<typeof readProjectRoute>): ProjectBrowsingState {
  const has = (id?: string | null) => !!id && view.document.nodes.some((node) => node.id === id);
  const selectedNodeId = has(route?.nodeId) ? route!.nodeId! : view.document.root_id;
  // The map is one persistent project graph. Older deep links may still carry
  // a child in map_node; reveal that child's path instead of replacing the graph root.
  const focusNodeId = view.document.root_id;
  const expandedNodeIds = revealProjectNode(view, selectedNodeId, route?.expandedNodeIds ?? [view.document.root_id]);
  return { scope, focusNodeId, selectedNodeId, expandedNodeIds, tab: route?.tab ?? null, showDependencies: true };
}
