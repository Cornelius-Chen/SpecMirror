import type { EngineeringView } from "@epm/domain";

export function graphSelectionAnchor(view: EngineeringView, ids: readonly string[]): string | undefined {
  const nodes = new Map(view.document.nodes.filter(node => node.status !== "archived").map(node => [node.id, node]));
  const unique = [...new Set(ids)];
  if (!unique.length || unique.some(id => !nodes.has(id))) return undefined;
  const path = (id: string) => { const result: string[] = [], seen = new Set<string>(); let current: string | null = id;
    while (current && nodes.has(current) && !seen.has(current)) { seen.add(current); result.push(current); current = nodes.get(current)!.parent_id; }
    return result;
  };
  const paths = unique.map(path);
  return paths[0].find(id => paths.every(ancestors => ancestors.includes(id)));
}

export function graphSelectionInRect(nodes: readonly { id: string; x: number; y: number; width: number; height: number; exiting?: boolean }[], a: {x: number; y: number}, b: {x: number; y: number}): string[] {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return nodes.filter(node => !node.exiting && node.x < right && node.x + node.width > left && node.y < bottom && node.y + node.height > top).map(node => node.id);
}
