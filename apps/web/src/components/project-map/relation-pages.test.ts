import { describe, expect, it } from "vitest";
import { MAP_RELATIONS_PER_PAGE, projectRelationPages } from "./relation-pages.ts";

const make = (id: string, sourceNodeId = `source-${id}`, targetNodeId = `target-${id}`) => ({ id, from: `zone-${sourceNodeId}`, to: `zone-${targetNodeId}`, renderable: true, members: [{ sourceNodeId, targetNodeId }] });

describe("graph relationship review pages", () => {
  it("keeps every contact reachable once even beyond the first sixteen", () => {
    const input = Array.from({ length: 41 }, (_, i) => make(String(i)));
    const result = projectRelationPages(input, "root", "root");
    const pages = Array.from({ length: result.count }, (_, i) => result.items.slice(i * MAP_RELATIONS_PER_PAGE, (i + 1) * MAP_RELATIONS_PER_PAGE));
    expect(pages.map(page => page.length)).toEqual([16, 16, 9]);
    expect(pages.flat()).toEqual(input);
    expect(new Set(pages.flat().map(item => item.id)).size).toBe(41);
  });

  it("brings a selected hidden member's contacts onto the graph without replacing their actual targets", () => {
    const input = Array.from({ length: 35 }, (_, i) => make(String(i), i >= 30 ? "chosen-leaf" : `source-${i}`));
    const before = structuredClone(input);
    const result = projectRelationPages(input, "chosen-leaf", "root");
    expect(result.items.slice(0, 5)).toEqual(input.slice(30));
    expect(result.items[0]).toBe(input[30]);
    expect(result.items.map(item => item.id).sort()).toEqual(input.map(item => item.id).sort());
    expect(input).toEqual(before);
    expect(result.key).not.toBe(projectRelationPages(input, "root", "root").key);
  });

  it("retains the route order of a small overview when selecting a node or opening an opinion", () => {
    const input = [make("a"), make("b"), make("c", "chosen")];
    expect(projectRelationPages(input, "chosen", "root").items).toEqual(input);
    expect(projectRelationPages(input, "missing", "root").items).toEqual(input);
  });

  it("does not create drawable endpoints for a relation folded wholly inside a collapsed branch", () => {
    const input = [make("visible"), { ...make("inside"), from: "branch", to: "branch", renderable: false }];
    const result = projectRelationPages(input, "root", "root");
    expect(result.items).toEqual([input[0]]);
    expect(result.count).toBe(1);
    expect(projectRelationPages([], "root", "root").items).toEqual([]);
  });
});
