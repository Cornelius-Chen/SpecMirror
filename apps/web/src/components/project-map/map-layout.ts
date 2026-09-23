import type { EngineeringView } from "@epm/domain";
import { effectiveDependencyLinks, overviewIndex, type DependencyLink } from "../engineering/overview-selectors.ts";

export interface MapRect { x: number; y: number; width: number; height: number }
export interface MapCard extends MapRect { id: string; childCount: number }
export interface ProjectMapLayout { focusId: string; path: string[]; cards: MapCard[]; width: number; height: number; columns: number; signature: string }
export interface MapViewport { width: number; height: number }
export const MAP_CARD_WIDTH = 280;
export const MAP_CARD_HEIGHT = 176;

export function projectMapLayout(view: EngineeringView, requestedId: string | null | undefined, viewport: MapViewport): ProjectMapLayout {
  const index = overviewIndex(view), requested = requestedId ? index.nodes.get(requestedId) : undefined;
  const focusId = requested && requested.status !== "archived" ? requested.id : view.document.root_id;
  const children = index.children.get(focusId) ?? [], columns = Math.min(Math.max(children.length, 1), viewport.width >= 1000 ? 3 : viewport.width >= 650 ? 2 : 1);
  const cards = children.map((node, i) => ({ id: node.id, childCount: index.children.get(node.id)?.length ?? 0, x: 28 + i % columns * 312, y: 146 + Math.floor(i / columns) * 208, width: MAP_CARD_WIDTH, height: MAP_CARD_HEIGHT }));
  const width = columns * 312 + 24, height = children.length ? 146 + Math.ceil(children.length / columns) * 208 - 32 + 28 : 294;
  return { focusId, path: view.derived[focusId]?.path ?? [focusId], cards, width, height, columns, signature: `${focusId}:${columns}:${children.map(node => `${node.id}@${node.order}`).join("|")}` };
}

/** Scope membership determines position. Dependencies are an independent layer. */
export function projectMapRelations(view: EngineeringView, layout: ProjectMapLayout): DependencyLink[] {
  const index = overviewIndex(view), result = new Map<string, DependencyLink>();
  for (const id of layout.cards.length ? layout.cards.map(card => card.id) : [layout.focusId]) for (const edge of effectiveDependencyLinks(index, id)) {
    result.set(edge.id, { ...edge, crossPhase: view.derived[edge.from]?.path[1] !== view.derived[edge.to]?.path[1] });
  }
  return [...result.values()];
}

export function visibleProjectCards(layout: ProjectMapLayout, camera: { x: number; y: number; scale: number }, viewport: MapViewport, selectedId?: string | null, overscan = 160): MapCard[] {
  const left = (-camera.x - overscan) / camera.scale, top = (-camera.y - overscan) / camera.scale, right = (viewport.width - camera.x + overscan) / camera.scale, bottom = (viewport.height - camera.y + overscan) / camera.scale;
  return layout.cards.filter(card => card.id === selectedId || (card.x + card.width >= left && card.x <= right && card.y + card.height >= top && card.y <= bottom));
}
