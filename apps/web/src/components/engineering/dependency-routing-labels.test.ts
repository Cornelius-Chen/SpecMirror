import { describe, expect, it } from "vitest";
import { dependencySegmentCrossesRect, routeDependencyLinks, type DependencyRect, type DependencyRoute, type RouteLink } from "./dependency-routing.ts";

const rect = (id: string, left: number, top: number, width: number, height: number): DependencyRect => ({ id, left, top, right: left + width, bottom: top + height });
const link = (from: string, to: string): RouteLink => ({ id: `${from}>${to}`, from, to, inherited: false });
function expectClear(routes: readonly DependencyRoute[], cards: readonly DependencyRect[], labels: readonly DependencyRect[]) {
  for (const route of routes) for (let i = 1; i < route.points.length; i++) for (const obstacle of [...cards, ...labels]) {
    expect(dependencySegmentCrossesRect(route.points[i - 1]!, route.points[i]!, obstacle), `${route.id} crosses ${obstacle.id} in segment ${i}`).toBe(false);
  }
}

describe("dependency routes around actual label obstacles", () => {
  it("retains both phone directions when titles end only three pixels above adjacent cards", () => {
    const cards = [rect("alpha", 71, 204, 208, 120), rect("beta", 71, 380, 208, 120)];
    const labels = cards.map(card => rect(`zone:${card.id}`, card.left, card.top - 25, 190, 22));
    const boundaries = cards.map(card => ({ ...card, id: `boundary:${card.id}`, left: card.left - 8, right: card.right + 8, top: card.top - 28, bottom: card.bottom + 10 }));
    const edges = [link("alpha", "beta"), link("beta", "alpha")];
    const routes = routeDependencyLinks(cards, edges, {
      labelObstacles: labels, boundaries, boundaryClearance: 10, edgeSeparation: 8, strictReadability: true,
      bounds: { left: 4, right: 346, top: 4, bottom: 536 }
    });
    expect(routes.map(route => route.id)).toEqual(edges.map(edge => edge.id));
    expectClear(routes, cards, labels);
    for (const route of routes) {
      const target = cards.find(card => card.id === route.to)!;
      expect(route.points.at(-1)!.y).not.toBe(target.top - 3);
    }
  });

  it("treats a caption as solid without replacing a same-ID source card in the port dictionary", () => {
    const cards = [rect("source", 20, 200, 180, 100), rect("target", 500, 200, 180, 100)];
    const caption = rect("source", 230, 230, 240, 30), edge = link("source", "target");
    const baseline = routeDependencyLinks(cards, [edge]);
    expect(baseline.some(route => route.points.slice(1).some((point, i) => dependencySegmentCrossesRect(route.points[i]!, point, caption)))).toBe(true);
    const routes = routeDependencyLinks(cards, [edge], { labelObstacles: [caption] });
    expect(routes).toHaveLength(1);
    expectClear(routes, cards, [caption]);
    expect(routes[0]!.points[0]!.x).toBe(cards[0]!.right);
    expect(routes[0]!.d).not.toBe(baseline[0]!.d);
  });

  it.each(["source", "target"])("checks the short %s port connector that lies outside obstacleRoute's search", side => {
    const cards = [rect("source", 20, 20, 180, 100), rect("target", 300, 20, 180, 100)], edge = link("source", "target");
    // The grid starts/ends six pixels outside cards. These tiny labels cross
    // only the otherwise-unchecked connector, not the middle search path.
    const label = side === "source" ? rect("caption", 201.5, 62, 2, 16) : rect("caption", 295.5, 62, .5, 16);
    const routes = routeDependencyLinks(cards, [edge], { labelObstacles: [label] });
    expect(routes).toHaveLength(1);
    expectClear(routes, cards, [label]);
    // A different position on the same side is as valid as changing sides.
    // The complete path above includes both short port connectors.
    if (side === "source") expect(routes[0]!.points[0]!).not.toEqual({ x: cards[0]!.right, y: 70 });
    else expect(routes[0]!.points.at(-1)!).not.toEqual({ x: cards[1]!.left - 3, y: 70 });
  });

  it("omits only a trapped relation and leaves an unrelated clear lane unchanged", () => {
    const cards = [rect("blocked", 20, 20, 100, 80), rect("near", 220, 20, 100, 80), rect("safe", 20, 300, 100, 80), rect("end", 220, 300, 100, 80)];
    const edges = [link("blocked", "near"), link("safe", "end")];
    const baseline = routeDependencyLinks(cards, edges);
    const label = rect("opaque-caption", 10, 10, 120, 100);
    const routes = routeDependencyLinks(cards, edges, { labelObstacles: [label] });
    expect(routes.map(route => route.id)).toEqual(["safe>end"]);
    expect(routes[0]!.d).toBe(baseline.find(route => route.id === "safe>end")!.d);
    expectClear(routes, cards, [label]);
  });
});
