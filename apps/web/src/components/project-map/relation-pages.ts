interface ReviewableRelation {
  id: string;
  from: string;
  to: string;
  renderable: boolean;
  members: readonly { sourceNodeId: string; targetNodeId: string }[];
}

export const MAP_RELATIONS_PER_PAGE = 16;

/** Bound the displayed relations, not the size of the engineering document.
 * Pages partition the whole selected scope; no relation disappears at node 81.
 * Small scopes preserve the established allocation order and selection only
 * changes emphasis. Larger scopes bring the selected item's contacts first. */
export function projectRelationPages<T extends ReviewableRelation>(relations: readonly T[], selectedId: string, rootId: string) {
  const renderable = relations.filter(relation => relation.renderable);
  const touches = (relation: T) => relation.from === selectedId || relation.to === selectedId || relation.members.some(member => member.sourceNodeId === selectedId || member.targetNodeId === selectedId);
  const items = renderable.length > MAP_RELATIONS_PER_PAGE && selectedId !== rootId
    ? [...renderable.filter(touches), ...renderable.filter(relation => !touches(relation))]
    : renderable;
  return {
    items,
    count: Math.max(1, Math.ceil(items.length / MAP_RELATIONS_PER_PAGE)),
    key: JSON.stringify([rootId, selectedId, ...items.map(item => item.id)])
  };
}
