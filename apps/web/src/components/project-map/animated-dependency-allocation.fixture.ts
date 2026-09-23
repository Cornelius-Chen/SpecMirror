import type { DependencyRect, DependencyRoute, DependencyRoutingOptions, RouteLink, RoutingSegment } from "../engineering/dependency-routing.ts";
import type { InlineTreeNode } from "./inline-tree-layout.ts";

type SegmentTuple = readonly [number, number, number, number];
type CardTuple = readonly [string, number, number];
export const allocationLinks: readonly RouteLink[] = [
  { id: "input-a", from: "a", to: "b", inherited: true },
  { id: "input-b", from: "b", to: "c", inherited: true },
  { id: "input-c", from: "c", to: "d", inherited: true },
  { id: "change-b", from: "b", to: "d", inherited: true },
  { id: "input-d", from: "d", to: "e", inherited: true }
];
const nodesFrom = (cards: readonly CardTuple[]): InlineTreeNode[] => cards.map(([id, x, y]) => ({ id, x, y, width: 208, height: 120, parentId: id === "root" ? null : "root", depth: id === "root" ? 0 : 1, childCount: id === "root" ? cards.length - 1 : 0, expanded: id === "root" }));
export const cardRect = (node: InlineTreeNode): DependencyRect => ({ id: node.id, left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + node.height });
const segmentsFrom = (segments: readonly SegmentTuple[]): RoutingSegment[] => segments.map(([x1, y1, x2, y2], index) => ({ id: `composition:${index}`, a: { x: x1, y: y1 }, b: { x: x2, y: y2 } }));
const observedRoute = (index: number, d: string): DependencyRoute => ({ ...allocationLinks[index]!, d, points: [...d.matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) })) });

/** Anonymized read-only DOM captures from Mirror/artifacts/dense-routes-20260913/
 * actual-{three,four}-column-before.json. No document, owner, task URL or runtime
 * state is imported. Exact measured title heights and original failures remain.
 * Positions/reservations are fixed evidence, not rebuilt by production layout. */
const observed = {
  3: {
    width: 986, height: 528,
    cards: [["root", 389, 28], ["a", 125, 204], ["b", 389, 204], ["c", 653, 204], ["d", 257, 380], ["e", 521, 380]] as CardTuple[],
    labelHeights: [22.000014361213236, 22.000014361213236, 22.000014361213236, 21.999942555147054, 21.999942555147054],
    composition: [[97,148,361,148], [361,148,493,148], [493,148,625,148], [97,88,97,148], [97,148,97,264], [97,264,97,440], [97,264,125,264], [361,264,389,264], [625,264,653,264], [361,148,361,264], [625,148,625,264], [97,88,389,88], [597,88,889,88], [97,440,257,440], [729,440,889,440], [889,88,889,440]] as SegmentTuple[],
    routes: [
      observedRoute(0, "M 229 324 L 229 522 L 485 522 L 485 370 L 448 370 L 448 330 L 447 330 L 447 327"),
      observedRoute(1, "M 493 324 L 493 370 L 501 370 L 501 522 L 901 522 L 901 248 L 864 248"),
      observedRoute(2, "M 861 280 L 913 280 L 913 20 L 85 20 L 85 416 L 254 416"),
      observedRoute(4, "M 257 464 L 73 464 L 73 8 L 925 8 L 925 416 L 732 416")
    ], deferredIds: ["change-b"]
  },
  4: {
    width: 1278, height: 528,
    cards: [["root", 535, 28], ["a", 139, 204], ["b", 403, 204], ["c", 667, 204], ["d", 931, 204], ["e", 535, 380]] as CardTuple[],
    labelHeights: [21.99997845818015, 21.99997845818015, 21.99997845818015, 21.99997845818015, 22.000014361213236],
    composition: [[111,148,375,148], [375,148,639,148], [639,148,903,148], [111,148,111,264], [111,264,139,264], [375,264,403,264], [639,264,667,264], [903,264,931,264], [375,88,375,148], [375,148,375,264], [375,264,375,440], [639,148,639,264], [903,148,903,264], [375,88,535,88], [375,440,535,440]] as SegmentTuple[],
    routes: [
      observedRoute(0, "M 243 324 L 243 346 L 461 346 L 461 327"),
      observedRoute(1, "M 507 324 L 507 370 L 501 370 L 501 522 L 901 522 L 901 294 L 878 294"),
      observedRoute(2, "M 801.6666666666666 324 L 801.6666666666666 346 L 989 346 L 989 327")
    ], deferredIds: ["change-b", "input-d"]
  }
};

export function allocationFixture(columns: 3 | 4) {
  const raw = observed[columns], nodes = nodesFrom(raw.cards);
  const options: DependencyRoutingOptions = {
    boundaries: nodes.slice(1).map(node => ({ id: `zone:${node.id}`, left: node.x - 8, right: node.x + 216, top: node.y - 28, bottom: node.y + 130 })),
    labelObstacles: nodes.slice(1).map((node, i) => ({ id: `title:${node.id}`, left: node.x, right: node.x + 190, top: node.y - 25, bottom: node.y - 25 + raw.labelHeights[i]! })),
    reservedSegments: segmentsFrom(raw.composition), bounds: { left: 4, right: raw.width - 4, top: 4, bottom: raw.height - 4 },
    boundaryClearance: 12, edgeSeparation: 12, strictReadability: true
  };
  return { columns, width: raw.width, height: raw.height, scale: .85, nodes, rectangles: nodes.map(cardRect), links: allocationLinks.map(link => ({ ...link })), options,
    observedBefore: { routes: structuredClone(raw.routes), deferredIds: [...raw.deferredIds] } };
}

/** Prior isolated tablet/phone coexistence geometry; not a production run. */
export function narrowFeedbackFixture(width: 457 | 378) {
  const x = width === 457 ? 124.5 : 85, nodes = nodesFrom(["root", "a", "b", "c"].map((id, i) => [id, x, 28 + i * 176]));
  const options: DependencyRoutingOptions = {
    boundaries: nodes.slice(1).map(node => ({ id: `zone:${node.id}`, left: x - 8, right: x + 216, top: node.y - 28, bottom: node.y + 130 })),
    labelObstacles: nodes.slice(1).map(node => ({ id: `title:${node.id}`, left: x, right: x + 190, top: node.y - 25, bottom: node.y - 3 })),
    reservedSegments: segmentsFrom([[x + 104,148,x - 28,148], [x - 28,148,x - 28,264], [x - 28,264,x,264], [x,88,x - 28,88], [x - 28,88,x - 28,440], [x - 28,440,x,440], [x - 28,88,x - 28,616], [x - 28,616,x,616]]),
    bounds: { left: 4, right: width - 4, top: 4, bottom: 700 }, boundaryClearance: 12, edgeSeparation: width === 457 ? 8 : 12, strictReadability: true
  };
  return { width, x, nodes, rectangles: nodes.map(cardRect), options,
    dependencyLinks: [{ id: "dependency:c>b", from: "c", to: "b", inherited: false }],
    feedbackLinks: [{ id: "feedback:a>b", from: "a", to: "b", inherited: false }] };
}
