import type { EngineeringNode } from "@epm/domain";
import { kindNames } from "./shared.ts";

/** A presentation-only name. The source title and frozen engineering contract stay intact. */
export function engineeringNodeName(node: Pick<EngineeringNode, "id" | "kind" | "title">, names?: Record<string, string>): string {
  const value = names && Object.hasOwn(names, node.id) ? names[node.id] : undefined;
  const name = typeof value === "string" ? value.trim() : "";
  return name ? `${kindNames[node.kind]}：${name}` : node.title;
}
