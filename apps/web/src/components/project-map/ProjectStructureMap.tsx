import { Check, ChevronDown, ChevronRight, MessageSquare, Search, Scan, X, Home, LocateFixed, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { deriveEngineeringCollaborationPlan } from "@epm/domain";
import { overviewIndex, subtreeNodes } from "../engineering/overview-selectors.ts";
import { nodeStatusLabel } from "../engineering/shared.ts";
import { engineeringNodeName } from "../engineering/node-names.ts";
import { routeDependencyLinks, uniqueRoutingSegments } from "../engineering/dependency-routing.ts";
import { selectDescendantRunAttention } from "./inspector-selectors.ts";
import { deliveryRelationLabel, deliveryRelationTouchesNode, projectDeliveryRelations, projectDeliverySummary, projectZoneDeliveryRelations, retainCollapsedDeliveryRelations, rollupProjectDeliveryRelations, type DeliveryMapRelationRollup } from "./delivery-selectors.ts";
import { boundedBranchGroups, boundedCompositionEdges, boundedCompositionSegments } from "./bounded-tree-layout.ts";
import { animatedComposition } from "./animated-composition.ts";
import { useAnimatedMapRegions } from "./use-animated-map-regions.ts";
import { useAnimatedDependencyRoutes } from "./use-animated-dependency-routes.ts";
import { useInlineTreeMotion } from "./use-inline-tree-motion.ts";
import { selectGraphAttention, selectGraphMatches, type GraphAttentionFilter } from "./attention-selectors.ts";
import { graphSelectionAnchor, graphSelectionInRect } from "./graph-selection.ts";
import { projectFeedbackArtifacts, projectFeedbackComparison } from "./feedback-comparison.ts";
import { projectNodePurpose } from "./node-purpose.ts";
import { ProjectMapCardContent, type ProjectMapCardPresentation } from "./ProjectMapCardContent.tsx";
import { projectResultHeadline } from "./result-headline.ts";
import { agentZoneRegions } from "./agent-zone-layout.ts";
import { AgentZoneCard, agentZoneOwnerPresentations, agentZoneStatus, collaborationParallelStatus } from "./AgentZoneCard.tsx";
import { projectReadingContext, projectWorldRect, scaleForSemanticDensity, semanticDensityForScale, type MapCamera } from "./map-camera.ts";
import { useProjectMapCamera } from "./use-project-map-camera.ts";
import { projectMapRoutingClearance } from "./map-routing-clearance.ts";
import { MAP_RELATIONS_PER_PAGE, projectRelationPages } from "./relation-pages.ts";
import type { ProjectMapDensity, ProjectStructureMapProps } from "./types.ts";
import "./project-map.css";
import "./map-reading-layout.css";

type RelationScope = "overview" | "focus" | "all";

export function dependencyMarkerGeometry(emphasized: boolean) {
  const size = emphasized ? 8 : 7;
  return { size, refX: size - 1, refY: size / 2, markerUnits: "userSpaceOnUse" as const, d: `M 0 0 L ${size} ${size / 2} L 0 ${size} z` };
}

export function ProjectStructureMap({ view, nodeNames, workspaceId, canvasMode = "embedded", onCanvasModeChange, density, onDensityChange, runPlanActivityByNode, focusNodeId, selectedNodeId, expandedNodeIds, showDependencies, disabled = false, observationUnavailable = false, onRequestNavigation, onDependenciesChange, onFeedback, feedbackTarget, feedbackScopeNodeIds, feedbackId, contextPanel, onOpenDetail, onDismissFeedback }: ProjectStructureMapProps) {
  const index = useMemo(() => overviewIndex(view), [view]);
  const viewport = useRef<HTMLDivElement>(null);
  const requestedFocus = focusNodeId && index.nodes.get(focusNodeId)?.status !== "archived" ? focusNodeId : view.document.root_id;
  const { layout, frame } = useInlineTreeMotion(view, expandedNodeIds, workspaceId, selectedNodeId, viewport, requestedFocus, true);
  const mapCamera = useProjectMapCamera(viewport, workspaceId, layout.rootId, layout);
  const [internalDensity, setInternalDensity] = useState<ProjectMapDensity>("auto");
  const [agentZonesVisible, setAgentZonesVisible] = useState(true), [selectedZoneId, setSelectedZoneId] = useState<string | null>(null), [relationScope, setRelationScope] = useState<RelationScope>("overview");
  const densityPreference = density ?? internalDensity;
  const semanticDensity = densityPreference === "auto" ? semanticDensityForScale(mapCamera.camera.scale) : densityPreference;
  const routingClearance = useMemo(() => projectMapRoutingClearance(mapCamera.camera.scale), [mapCamera.camera.scale]);
  const targetNodes = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout]);
  const geometryNodes = useMemo(() => layout.nodes.map(node => ({ ...node, opacity: 1 })), [layout.nodes]);
  const collaboration = useMemo(() => deriveEngineeringCollaborationPlan(view.document, layout.rootId), [view.document, layout.rootId]);
  const settledZoneRegions = useMemo(() => agentZoneRegions(geometryNodes, collaboration.zones, layout.width, layout.height), [geometryNodes, collaboration.zones, layout.width, layout.height]);
  // Ordinary collapsed nodes remain in the index and retain exit geometry;
  // removed document nodes must never leave cards, labels or line endpoints.
  const drawableFrame = useMemo(() => ({ ...frame, nodes: frame.nodes.filter(node => index.nodes.has(node.id)) }), [frame, index]);
  const regionFrame = useAnimatedMapRegions({ frame: drawableFrame, layout, zones: collaboration.zones, workspaceKey: `${workspaceId}:${layout.rootId}` });
  // Read-only diagnostics count evaluations; they are not a browser FPS measurement.
  const regionVersion = useRef({ snapshot: regionFrame, version: 1 });
  if (regionVersion.current.snapshot !== regionFrame) regionVersion.current = { snapshot: regionFrame, version: regionVersion.current.version + 1 };
  const compositionRouteCount = useRef(0), relationRouteCount = useRef(0);
  // Last final-planning call only; these exclude RAF sampling, React and paint.
  const routePlanningMs = useRef({ dependencies: 0, feedback: 0 });
  const groups = useMemo(() => regionFrame.groups.map(group => ({ ...group, nested: (targetNodes.get(group.id)?.depth ?? 0) > 1, childCount: group.childIds.length })), [regionFrame.groups, targetNodes]);
  const zoneRegions = regionFrame.zones;
  const compositionOptions = useMemo(() => ({
    laneClearance: routingClearance.compositionLane,
    rootCorridorClearance: routingClearance.rootCorridor,
    wrappedRootSideEntry: true,
    alignedLaneSide: "left" as const,
    labelObstacles: agentZonesVisible ? settledZoneRegions.map(region => ({ left: region.labelX, right: region.labelX + region.labelWidth, top: region.labelY, bottom: region.labelY + 22 })) : []
  }), [routingClearance.compositionLane, routingClearance.rootCorridor, agentZonesVisible, settledZoneRegions]);
  const settledCompositionEdges = useMemo(() => boundedCompositionEdges(layout.nodes, layout.width, layout.nodes, compositionOptions), [layout.nodes, layout.width, compositionOptions]);
  const settledCompositionSegments = useMemo(() => boundedCompositionSegments(settledCompositionEdges), [settledCompositionEdges]);
  const movingComposition = useMemo(() => { compositionRouteCount.current++; return animatedComposition(regionFrame.nodes, layout.nodes, frame.width, { ...compositionOptions,
    groups: regionFrame.groups.filter(group => group.opacity > 0),
    labelObstacles: regionFrame.labels.filter(label => label.opacity > 0 && (label.kind !== "zone" || agentZonesVisible))
  }); }, [regionFrame, layout.nodes, frame.width, compositionOptions, agentZonesVisible]);
  const routedCompositionEdges = movingComposition.edges;
  const compositionSegments = movingComposition.segments;
  // Plan final corridors once. Frame sampling only attaches cached candidates
  // to actual cards and checks visible obstacles; it never runs the grid router.
  const reservedCompositionSegments = useMemo(() => uniqueRoutingSegments(settledCompositionSegments.map(segment => ({ id: segment.id, a: segment.a, b: segment.b }))), [settledCompositionSegments]);
  const settledGroups = useMemo(() => {
    return boundedBranchGroups(layout.nodes, layout.width).map(group => ({ ...group,
      nested: (targetNodes.get(group.id)?.depth ?? 0) > 1,
      childCount: group.childIds.length, opacity: 1 }));
  }, [layout.nodes, layout.width, targetNodes]);
  const [query, setQuery] = useState(""), [indexPage, setIndexPage] = useState(0), [relationPage, setRelationPage] = useState(0);
  const [relationBatch, setRelationBatch] = useState({ key: "", index: 0 });
  const relationPageEpoch = useRef(0);
  const [internalDependencies, setInternalDependencies] = useState(true), dependenciesVisible = showDependencies ?? internalDependencies;
  const [filter, setFilter] = useState<GraphAttentionFilter>("all");
  const [toolsOpen, setToolsOpen] = useState(false), [legendOpen, setLegendOpen] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [selecting, setSelecting] = useState(false), [scope, setScope] = useState<string[]>([]);
  const [drag, setDrag] = useState<{a: {x: number; y: number}; b: {x: number; y: number}} | null>(null);
  const dragRef = useRef<typeof drag>(null);
  const lastRevealKey = useRef("");
  const previousLayout = useRef({ workspaceId, rootId: layout.rootId, signature: layout.signature, nodes: layout.nodes });
  const localCameraReturns = useRef(new Map<string, { camera: MapCamera; manualEpoch: number; viewportWidth: number; viewportHeight: number }>());
  const pendingCameraReturn = useRef<{ nodeId: string; signature: string; camera: MapCamera; manualEpoch: number } | null>(null);
  const [geometrySettling, setGeometrySettling] = useState(false);
  const attention = useMemo(() => selectGraphAttention(view, {observationUnavailable}), [view, observationUnavailable]);
  const matches = useMemo(() => selectGraphMatches(attention, view, {filter, query, nodeNames}), [attention, view, filter, query, nodeNames]);
  const hasFilter = filter !== "all" || Boolean(query.trim());
  const matchPage = indexPage % Math.max(1, Math.ceil(matches.matchingNodeIds.size / 5));
  const root = index.nodes.get(layout.rootId), marker = useId().replaceAll(":", "");
  const focusPath = view.derived[layout.rootId]?.path ?? [layout.rootId];
  const parentFocusId = root?.parent_id ?? null;
  const zoneOwnerPresentations = useMemo(() => agentZoneOwnerPresentations(collaboration.zones), [collaboration.zones]);
  const selectedZone = collaboration.zones.find(zone => zone.id === selectedZoneId);
  const selectedZoneRegion = zoneRegions.find(region => region.id === selectedZoneId);
  const selectedZoneNodeIds = useMemo(() => new Set(selectedZone?.node_ids ?? []), [selectedZone]);
  const selectedZoneHandoffs = useMemo(() => selectedZone ? collaboration.handoffs.filter(item => item.from_zone_id === selectedZone.id || item.to_zone_id === selectedZone.id) : [], [selectedZone, collaboration.handoffs]);
  const selectedZoneConflicts = useMemo(() => selectedZone ? collaboration.conflicts.filter(item => item.left_zone_id === selectedZone.id || item.right_zone_id === selectedZone.id) : [], [selectedZone, collaboration.conflicts]);
  const relations = useMemo(() => projectDeliveryRelations(view, layout.nodes.map(node => node.id)), [view, layout]);
  const routeRelations = useMemo(() => rollupProjectDeliveryRelations(relations), [relations]);
  const zoneByNodeId = useMemo(() => new Map(collaboration.zones.flatMap(zone => zone.node_ids.map(nodeId => [nodeId, zone] as const))), [collaboration.zones]);
  const overviewRelations = useMemo(() => projectZoneDeliveryRelations(relations, zoneByNodeId, new Set(targetNodes.keys())), [relations, zoneByNodeId, targetNodes]);
  const focusedRelations = useMemo(() => selectedZone ? rollupProjectDeliveryRelations(relations.filter(relation => selectedZoneNodeIds.has(relation.sourceNodeId) || selectedZoneNodeIds.has(relation.targetNodeId))) : [], [relations, selectedZone, selectedZoneNodeIds]);
  const effectiveRelationScope: RelationScope = relationScope === "focus" && !selectedZone ? "overview" : relationScope;
  const visibleRelations = effectiveRelationScope === "all" ? routeRelations : effectiveRelationScope === "focus" ? focusedRelations : overviewRelations;
  const selectedId = selectedNodeId && targetNodes.has(selectedNodeId) ? selectedNodeId : layout.rootId;
  const selectedPosition = targetNodes.get(selectedId);
  const firstReadingChild = selectedPosition?.expanded ? layout.nodes.filter(node => node.parentId === selectedId).sort((a, b) => a.y - b.y || Math.abs(a.x + a.width / 2 - selectedPosition.x - selectedPosition.width / 2) - Math.abs(b.x + b.width / 2 - selectedPosition.x - selectedPosition.width / 2) || a.x - b.x)[0] : undefined;
  const readingContext = selectedPosition ? projectReadingContext(selectedPosition, firstReadingChild, mapCamera.viewport, mapCamera.camera.scale) : undefined;
  const fitCurrentRegion = () => {
    if (!selectedPosition) return;
    const branchIds = new Set(subtreeNodes(index, selectedId).map(node => node.id));
    mapCamera.fitReading(layout.nodes.filter(node => branchIds.has(node.id)), selectedPosition, firstReadingChild);
  };
  const nodeName = (id: string) => { const node = index.nodes.get(id); return node ? engineeringNodeName(node, nodeNames) : "未找到的任务"; };
  const requestFocus = (nodeId: string, reason: "enter" | "back" | "root" | "locate", source?: HTMLElement) => {
    if (reason === "enter" && source && viewport.current) {
      const card = source.getBoundingClientRect(), canvas = viewport.current.getBoundingClientRect();
      mapCamera.markEntry(nodeId, { x: card.left - canvas.left, y: card.top - canvas.top, width: card.width, height: card.height });
    }
    onRequestNavigation({ type: "focus", nodeId, reason });
  };
  const chooseDensity = (next: ProjectMapDensity) => {
    if (density === undefined) {
      setInternalDensity(next);
      try { sessionStorage.setItem(`mirror:project-map-density:${workspaceId}`, next); } catch { /* Storage can be unavailable in an isolated webview. */ }
    }
    onDensityChange?.(next);
    if (next !== "auto") mapCamera.zoomTo(scaleForSemanticDensity(next));
  };
  const delivery = useMemo(() => projectDeliverySummary(view, selectedId), [view, selectedId]);
  const rectangles = useMemo(() => layout.nodes.map(node => ({ id: node.id, left: node.x, top: node.y, right: node.x + node.width, bottom: node.y + node.height })), [layout.nodes]);
  const zoneRootIds = useMemo(() => new Set(collaboration.zones.map(zone => zone.root_node_id)), [collaboration.zones]);
  const routeBoundaries = useMemo(() => [
    ...settledGroups.filter(group => group.opacity > 0 && !(agentZonesVisible && zoneRootIds.has(group.id))).map(group => ({ id: `branch:${group.id}`, left: group.x, top: group.y, right: group.x + group.width, bottom: group.y + group.height })),
    ...(agentZonesVisible ? settledZoneRegions.filter(region => region.opacity > 0).map(region => ({ id: `agent:${region.id}`, left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height })) : [])
  ], [settledGroups, agentZonesVisible, zoneRootIds, settledZoneRegions]);
  const settledLabelObstacles = useMemo(() => [
    ...settledGroups.map(group => ({ id: `branch-title:${group.id}`, left: group.x + 20, right: group.x + group.width - 20, top: group.y - 11, bottom: group.y + 11 })),
    ...(agentZonesVisible ? settledZoneRegions.map(region => ({ id: `agent-title:${region.id}`, left: region.labelX, right: region.labelX + region.labelWidth, top: region.labelY, bottom: region.labelY + 22 })) : [])
  ], [settledGroups, agentZonesVisible, settledZoneRegions]);
  const focusedFeedback = useMemo(() => feedbackId ? view.document.feedbacks?.find(item => item.id === feedbackId) : undefined, [feedbackId, view.document.feedbacks]);
  const feedbackComparison = useMemo(() => focusedFeedback ? projectFeedbackComparison(view, focusedFeedback) : undefined, [view, focusedFeedback]);
  const feedbackResult = useMemo(() => focusedFeedback ? projectFeedbackArtifacts(view, focusedFeedback) : undefined, [view, focusedFeedback]);
  const feedbackOrigins = useMemo(() => new Set(focusedFeedback?.scope_node_ids?.length ? focusedFeedback.scope_node_ids : focusedFeedback ? [focusedFeedback.target.node_id] : []), [focusedFeedback]);
  const feedbackImpacts = useMemo(() => new Set(feedbackComparison?.affected.map(item => item.id) ?? []), [feedbackComparison]);
  const visibleRenderableRelations = useMemo(() => visibleRelations.filter(edge => edge.renderable), [visibleRelations]);
  const relationPages = useMemo(() => projectRelationPages(visibleRenderableRelations, selectedId, layout.rootId), [visibleRenderableRelations, selectedId, layout.rootId]);
  const relationBatchKey = `${workspaceId}:${effectiveRelationScope}:${relationPages.key}`;
  const relationBatchIndex = relationBatch.key === relationBatchKey ? Math.min(relationBatch.index, relationPages.count - 1) : 0;
  const changeRelationBatch = (delta: number) => { relationPageEpoch.current++; setRelationBatch({ key: relationBatchKey, index: Math.max(0, Math.min(relationPages.count - 1, relationBatchIndex + delta)) }); };
  const admittedRelations = useMemo(() => dependenciesVisible ? relationPages.items.slice(relationBatchIndex * MAP_RELATIONS_PER_PAGE, (relationBatchIndex + 1) * MAP_RELATIONS_PER_PAGE) : [], [dependenciesVisible, relationPages.items, relationBatchIndex]);
  const relationScopeKey = `${workspaceId}:${layout.rootId}:${effectiveRelationScope}:${effectiveRelationScope === "focus" ? selectedZoneId ?? "" : ""}:${relationPageEpoch.current}`;
  const committedRelationPage = useRef<{ key: string; links: readonly DeliveryMapRelationRollup[] } | undefined>(undefined);
  const previousRelationPage = committedRelationPage.current;
  const retainedRelations = useMemo(() => dependenciesVisible && previousRelationPage?.key === relationScopeKey
    ? retainCollapsedDeliveryRelations(previousRelationPage.links, relations, new Set(targetNodes.keys())) : [], [dependenciesVisible, previousRelationPage, relationScopeKey, relations, targetNodes]);
  const relationById = useMemo(() => new Map([...retainedRelations, ...visibleRelations].map(edge => [edge.id, edge])), [visibleRelations, retainedRelations]);
  useLayoutEffect(() => {
    const previous = committedRelationPage.current;
    // Keep the actual previous page through a layout transition. An explicit
    // scope/page change or hidden relation layer ends that permission at once.
    if (!dependenciesVisible || previous?.key !== relationScopeKey || !frame.moving && frame.layoutSignature === layout.signature) {
      if (previous?.key !== relationScopeKey || previous.links !== admittedRelations) committedRelationPage.current = { key: relationScopeKey, links: admittedRelations };
    }
  }, [relationScopeKey, admittedRelations, dependenciesVisible, frame.moving, frame.layoutSignature, layout.signature]);
  const targetRoutes = useMemo(() => { if (!admittedRelations.length) { routePlanningMs.current.dependencies = 0; return []; } relationRouteCount.current++; const started = performance.now(); const result = routeDependencyLinks(rectangles, admittedRelations, {
    boundaries: routeBoundaries, labelObstacles: settledLabelObstacles, boundaryClearance: routingClearance.dependencyBoundary, edgeSeparation: routingClearance.dependencyLane, reservedSegments: reservedCompositionSegments,
    bounds: { left: 4, top: 4, right: layout.width - 4, bottom: layout.height - 4 }, strictReadability: true
  }); routePlanningMs.current.dependencies = performance.now() - started; return result; }, [admittedRelations, layout.width, layout.height, rectangles, routeBoundaries, settledLabelObstacles, reservedCompositionSegments, routingClearance.dependencyBoundary, routingClearance.dependencyLane]);
  const feedbackLinks = useMemo(() => {
    if (!focusedFeedback || feedbackComparison?.state === "none" || feedbackComparison?.state === "missing") return [];
    const origin = rectangles.some(rect => rect.id === focusedFeedback.target.node_id) ? focusedFeedback.target.node_id : [...feedbackOrigins].find(id => rectangles.some(rect => rect.id === id));
    if (!origin) return [];
    return [...feedbackImpacts].filter(id => id !== origin && rectangles.some(rect => rect.id === id)).map(id => ({ id: `feedback-impact:${origin}:${id}`, from: origin, to: id, inherited: false }));
  }, [focusedFeedback, feedbackComparison?.state, feedbackOrigins, feedbackImpacts, rectangles]);
  const targetFeedbackRoutes = useMemo(() => {
    if (!feedbackLinks.length) { routePlanningMs.current.feedback = 0; return []; }
    const reserved = uniqueRoutingSegments([...reservedCompositionSegments, ...targetRoutes.flatMap(route => route.points.slice(1).map((b, index) => ({ id: route.id, a: route.points[index]!, b })))]);
    relationRouteCount.current++;
    const started = performance.now(); const result = routeDependencyLinks(rectangles, feedbackLinks, {
      boundaries: routeBoundaries, labelObstacles: settledLabelObstacles, boundaryClearance: routingClearance.dependencyBoundary, edgeSeparation: routingClearance.dependencyLane, reservedSegments: reserved,
      bounds: { left: 4, top: 4, right: layout.width - 4, bottom: layout.height - 4 }, strictReadability: true
    });
    routePlanningMs.current.feedback = performance.now() - started;
    return result;
  }, [feedbackLinks, rectangles, reservedCompositionSegments, targetRoutes, routeBoundaries, settledLabelObstacles, layout.width, layout.height, routingClearance.dependencyBoundary, routingClearance.dependencyLane]);
  const frameRouteOptions = useMemo(() => ({
    frameNodes: regionFrame.nodes,
    boundaries: [
      ...regionFrame.groups.filter(group => group.opacity > 0 && !(agentZonesVisible && zoneRootIds.has(group.id))).map(group => ({ id: `branch:${group.id}`, left: group.x, top: group.y, right: group.x + group.width, bottom: group.y + group.height })),
      ...(agentZonesVisible ? regionFrame.zones.filter(region => region.opacity > 0).map(region => ({ id: `agent:${region.id}`, left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height })) : [])
    ],
    labelObstacles: regionFrame.labels.filter(label => label.opacity > 0 && (label.kind !== "zone" || agentZonesVisible)),
    reservedSegments: uniqueRoutingSegments(compositionSegments.filter(segment => segment.opacity > 0)),
    bounds: { left: 4, top: 4, right: frame.width - 4, bottom: frame.height - 4 },
    boundaryClearance: routingClearance.dependencyBoundary, edgeSeparation: routingClearance.dependencyLane, arrowSize: 8
  }), [regionFrame, agentZonesVisible, zoneRootIds, compositionSegments, frame.width, frame.height, routingClearance.dependencyBoundary, routingClearance.dependencyLane]);
  const movingRelations = useAnimatedDependencyRoutes({ workspaceKey: relationScopeKey, layoutSignature: layout.signature, frame,
    targetNodes: layout.nodes, links: admittedRelations, retainedLinks: retainedRelations, targetRoutes, sample: frameRouteOptions });
  const routes = movingRelations.routes;
  const frameFeedbackOptions = useMemo(() => ({ ...frameRouteOptions, arrowSize: 7,
    reservedSegments: uniqueRoutingSegments([...frameRouteOptions.reservedSegments, ...routes.filter(route => route.opacity > 0).flatMap(route => route.points.slice(1).map((b, i) => ({ id: route.id, a: route.points[i]!, b })))])
  }), [frameRouteOptions, routes]);
  const movingFeedback = useAnimatedDependencyRoutes({ workspaceKey: `${workspaceId}:${layout.rootId}`, layoutSignature: layout.signature, frame,
    targetNodes: layout.nodes, links: feedbackLinks, targetRoutes: targetFeedbackRoutes, sample: frameFeedbackOptions });
  const feedbackRoutes = movingFeedback.routes;
  const relationColor = (id: string) => { const relation = relationById.get(id); return relation?.problem ? "#a74635" : relation?.kind === "interaction" ? "#755e8d" : ["prerequisite", "dependency"].includes(relation?.kind ?? "") ? "#8f682f" : "#2f78bd"; };
  const relationOpacity = (id: string) => effectiveRelationScope !== "all" ? 1 : (() => { const relation = relationById.get(id); return relation && deliveryRelationTouchesNode(relation, selectedId, layout.rootId) ? 1 : .7; })();
  const relationTooltip = (id: string) => relationById.get(id)?.members.map(member => `${nodeName(member.sourceNodeId)} → ${member.label} → ${nodeName(member.targetNodeId)}${member.detail ? `。${member.detail}` : ""}`).join("\n") ?? "";
  const relationFeedbackSelected = (id: string) => relationById.get(id)?.members.some(member => feedbackTarget?.id === member.relationId && feedbackTarget?.node_id === member.ownerNodeId) ?? false;
  const relationEmphasized = (id: string) => { const relation = relationById.get(id); return Boolean(relation && (relationFeedbackSelected(id) || effectiveRelationScope === "focus" || deliveryRelationTouchesNode(relation, selectedId, layout.rootId))); };
  const openRelation = (id: string) => {
    const relation = relationById.get(id); if (!relation) return;
    if (relation.members.length > 1) requestFocus(relation.to, "locate");
    else { const member = relation.members[0]!; onFeedback?.({kind: "relation", node_id: member.ownerNodeId, id: member.relationId}); }
  };
  const routeLabels = useMemo(() => {
    // On a narrow canvas, labels consume the same gutters needed by the arrows.
    // The complete wording remains in each SVG title and the relationship list.
    if (frame.width < 720) return [];
    const occupied: typeof rectangles = [];
    const cardObstacles = regionFrame.nodes.filter(node => node.opacity > 0).map(node => ({ id: node.id, left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + node.height }));
    const obstacles = [...cardObstacles, ...frameRouteOptions.labelObstacles];
    const lineObstacles = [...routes, ...feedbackRoutes].filter(route => route.opacity > .05).flatMap(route => route.points.slice(1).map((b, i) => {
      const a = route.points[i]!;
      return { id: route.id, left: Math.min(a.x, b.x) - 2, right: Math.max(a.x, b.x) + 2, top: Math.min(a.y, b.y) - 2, bottom: Math.max(a.y, b.y) + 2 };
    })).concat(compositionSegments.filter(segment => segment.opacity > 0).map(({ id, a, b }) => ({
      id: `composition:${id}`, left: Math.min(a.x, b.x) - 2, right: Math.max(a.x, b.x) + 2, top: Math.min(a.y, b.y) - 2, bottom: Math.max(a.y, b.y) + 2
    })));
    return routes.flatMap(edge => {
      const relation = relationById.get(edge.id); if (!relation || edge.opacity <= 0) return [];
      const label = deliveryRelationLabel(edge.points, relation.label, [...obstacles, ...lineObstacles.filter(line => line.id !== edge.id)], frame.width, frame.height, occupied);
      if (!label) return [];
      occupied.push(label.rect); return [{ ...label, id: edge.id, opacity: edge.opacity, fullText: relationTooltip(edge.id) }];
    });
  }, [routes, feedbackRoutes, compositionSegments, relationById, regionFrame.nodes, frameRouteOptions.labelObstacles, frame.width, frame.height, index, nodeNames]);
  const summaries = useMemo(() => new Map(layout.nodes.filter(node => node.childCount).map(node => {
    const attention = selectDescendantRunAttention(view, node.id);
    return [node.id, attention.review.length ? `下级 ${attention.review.length} 项待验收` : attention.running.length ? `下级 ${attention.running.length} 项执行中` : ""];
  })), [view, layout]);
  const cardPresentationCount = useRef(0);
  // Presentation depends on observations, feedback and naming, never on a RAF
  // position or camera. Include exiting cards still present in the document.
  const cardPresentations = useMemo(() => {
    cardPresentationCount.current++;
    const runs = new Map(view.document.runs.map(run => [run.id, run]));
    return new Map([...index.nodes.values()].map(node => {
      const id = node.id, status = view.derived[id]?.status ?? node.status;
      const run = runs.get(view.derived[id]?.latest_run_id ?? "");
      const unknown = status === "running" && (observationUnavailable || Boolean(view.observation && run?.mode === "external" && !["current", "local"].includes(view.observation.runs[run.id]?.state ?? "unobserved")));
      const ownStatus = unknown ? "状态待更新" : nodeStatusLabel(view, node);
      const facts = attention.byNode.get(id), own = facts?.ownItems.find(fact => fact.tags.length || fact.tone === "unknown");
      const summary = summaries.get(id);
      const visibleStatus = own?.label || summary || (unknown || ["running", "review", "blocked", "needs_revision", "paused"].includes(status) ? ownStatus : "");
      const runPlanActivity = runPlanActivityByNode?.[id];
      const presentation: ProjectMapCardPresentation = {
        id, name: engineeringNodeName(node, nodeNames), title: node.title, status, unknown,
        purpose: projectNodePurpose(node), ownStatus, summary, visibleStatus,
        statusTone: own?.tone ?? (unknown ? "unknown" : ["blocked", "needs_revision"].includes(status) ? "problem" : status === "review" || status === "paused" || summary ? "review" : "suggestion"),
        statusDetail: own?.detail || visibleStatus,
        opinionCount: Math.max(facts?.subtreeCounts.attention ?? 0, facts?.subtreeCounts.feedback ?? 0),
        runPlanActivity,
        runPlanDescription: runPlanActivity ? `Codex 本轮：${runPlanActivity.completedSteps}/${runPlanActivity.totalSteps} 步已报告${runPlanActivity.phase === "running" ? "，执行中" : runPlanActivity.phase === "waiting" ? "，等待领取" : runPlanActivity.phase === "reported" ? "，步骤已报告完成，运行结果与工程验收另行核对" : runPlanActivity.phase === "idle" ? "，等待步骤更新" : "，仅作计划投影"}${runPlanActivity.currentStepTitle ? `，当前步骤：${runPlanActivity.currentStepTitle}` : ""}` : "",
        runPlanLabel: runPlanActivity?.phase === "running" ? "执行中" : runPlanActivity?.phase === "waiting" ? "等待领取" : runPlanActivity?.phase === "reported" ? "已报告" : runPlanActivity?.phase === "idle" ? "待更新" : "计划"
      };
      return [id, presentation];
    }));
  }, [view, index, observationUnavailable, attention, summaries, runPlanActivityByNode, nodeNames]);
  const allNodes = useMemo(() => subtreeNodes(index, layout.rootId), [index, layout.rootId]);
  const resultHeadline = useMemo(() => projectResultHeadline(view, layout.rootId), [view, layout.rootId]);
  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return allNodes.filter(node => [node.title, engineeringNodeName(node, nodeNames)].some(title => title.toLocaleLowerCase().includes(needle)));
  }, [allNodes, nodeNames, query]);
  const currentPage = Math.min(indexPage, Math.max(0, Math.ceil(candidates.length / 20) - 1));
  const currentRelationPage = Math.min(relationPage, Math.max(0, Math.ceil(relations.length / 12) - 1));

  const minimapVisible = mapCamera.viewport.width > 0 && (frame.nodes.length > 12 || frame.width * mapCamera.camera.scale > mapCamera.viewport.width * 1.18 || frame.height * mapCamera.camera.scale > mapCamera.viewport.height * 1.18);
  const minimapScale = minimapVisible ? Math.min(170 / Math.max(frame.width, 1), 80 / Math.max(frame.height, 1)) : 0;
  const minimapWidth = Math.max(120, frame.width * minimapScale), minimapHeight = Math.max(48, frame.height * minimapScale);
  const visibleWorld = projectWorldRect(mapCamera.camera, mapCamera.viewport);
  const geometryMoving = frame.moving || mapCamera.moving;
  const relationStatusLabel = !dependenciesVisible ? "联系已收起" : frame.moving ? "连线随展开调整" : visibleRenderableRelations.length ? `图上 ${routes.length}/${visibleRenderableRelations.length} 条联系` : "当前层无跨项联系";

  useEffect(() => {
    if (geometryMoving) { setGeometrySettling(true); return; }
    if (!geometrySettling) return;
    const timer = window.setTimeout(() => setGeometrySettling(false), 150);
    return () => window.clearTimeout(timer);
  }, [geometryMoving, geometrySettling]);

  useLayoutEffect(() => {
    const before = previousLayout.current;
    if (before.workspaceId === workspaceId && before.rootId === layout.rootId && before.signature !== layout.signature) {
      const anchorId = selectedNodeId ?? layout.rootId;
      const oldAnchor = before.nodes.find(node => node.id === anchorId), nextAnchor = layout.nodes.find(node => node.id === anchorId);
      // A responsive width measurement or background data refresh can also
      // change the layout signature. Preserve the screen anchor only for a
      // real inline open/close; compensating ordinary reflow overrides the
      // camera's crisp initial fit and makes the whole scene jump.
      if (oldAnchor && nextAnchor && oldAnchor.expanded !== nextAnchor.expanded) {
        if (!oldAnchor.expanded && nextAnchor.expanded) {
          const scale = mapCamera.camera.scale;
          const screen = {
            left: oldAnchor.x * scale + mapCamera.camera.x,
            top: oldAnchor.y * scale + mapCamera.camera.y,
            right: (oldAnchor.x + oldAnchor.width) * scale + mapCamera.camera.x,
            bottom: (oldAnchor.y + oldAnchor.height) * scale + mapCamera.camera.y
          };
          const fullyVisible = screen.left >= 0 && screen.top >= 0 && screen.right <= mapCamera.viewport.width && screen.bottom <= mapCamera.viewport.height;
          if (fullyVisible && !localCameraReturns.current.has(anchorId)) localCameraReturns.current.set(anchorId, {
              camera: mapCamera.camera,
              manualEpoch: mapCamera.manualEpoch,
              viewportWidth: mapCamera.viewport.width,
              viewportHeight: mapCamera.viewport.height
            });
          pendingCameraReturn.current = null;
        } else if (oldAnchor.expanded && !nextAnchor.expanded) {
          const saved = localCameraReturns.current.get(anchorId);
          const unchangedView = saved && saved.manualEpoch === mapCamera.manualEpoch && saved.viewportWidth === mapCamera.viewport.width && saved.viewportHeight === mapCamera.viewport.height;
          pendingCameraReturn.current = unchangedView ? { nodeId: anchorId, signature: layout.signature, camera: saved.camera, manualEpoch: saved.manualEpoch } : null;
          localCameraReturns.current.delete(anchorId);
        }
        mapCamera.preserveWorldAnchor(
          { x: oldAnchor.x + oldAnchor.width / 2, y: oldAnchor.y + oldAnchor.height / 2 },
          { x: nextAnchor.x + nextAnchor.width / 2, y: nextAnchor.y + nextAnchor.height / 2 }
        );
      }
    }
    previousLayout.current = { workspaceId, rootId: layout.rootId, signature: layout.signature, nodes: layout.nodes };
  }, [workspaceId, layout.rootId, layout.signature, layout.nodes, selectedNodeId, mapCamera.preserveWorldAnchor]);

  useLayoutEffect(() => {
    if (frame.moving || frame.layoutSignature !== layout.signature) return;
    const active = targetNodes.get(selectedNodeId ?? layout.rootId);
    if (!active || !mapCamera.viewport.width || !mapCamera.viewport.height) return;
    const revealKey = [workspaceId, layout.rootId, selectedNodeId ?? layout.rootId, layout.signature, mapCamera.viewport.width, mapCamera.viewport.height].join(":");
    const pending = pendingCameraReturn.current;
    if (pending?.signature === layout.signature && pending.nodeId === active.id && pending.manualEpoch === mapCamera.manualEpoch) {
      pendingCameraReturn.current = null;
      lastRevealKey.current = revealKey;
      mapCamera.moveTo(pending.camera);
      return;
    }
    if (lastRevealKey.current === revealKey) return;
    lastRevealKey.current = revealKey;
    const context = projectReadingContext(active, firstReadingChild, mapCamera.viewport, mapCamera.camera.scale);
    mapCamera.revealRect(context.rect, context.padding);
  }, [workspaceId, layout.signature, layout.rootId, layout.nodes, selectedNodeId, targetNodes, frame.moving, frame.layoutSignature, mapCamera.viewport.width, mapCamera.viewport.height, mapCamera.manualEpoch, mapCamera.revealRect, mapCamera.moveTo]);

  useLayoutEffect(() => {
    localCameraReturns.current.clear();
    pendingCameraReturn.current = null;
  }, [workspaceId, layout.rootId]);

  useLayoutEffect(() => { setQuery(""); setIndexPage(0); setRelationPage(0); setFilter("all"); setToolsOpen(false); setLegendOpen(false); setSelecting(false); setScope([]); setDrag(null); setAgentZonesVisible(true); setSelectedZoneId(null); setRelationScope("overview"); dragRef.current = null; }, [workspaceId]);
  useLayoutEffect(() => {
    if (density) return;
    try {
      const saved = sessionStorage.getItem(`mirror:project-map-density:${workspaceId}`);
      setInternalDensity(["auto", "overview", "structure", "detail"].includes(saved ?? "") ? saved as ProjectMapDensity : "auto");
    } catch { setInternalDensity("auto"); }
  }, [workspaceId, density]);
  const openAttention = (id: string) => {
    const item = matches.itemsByNode.get(id)?.[0];
    if (item && onFeedback) onFeedback(item.target, item.nodeIds, item.feedbackId);
    else requestFocus(id, "locate");
  };
  const toggleScope = (id: string) => setScope(current => current.includes(id) ? current.filter(value => value !== id) : current.length < 80 ? [...current, id] : current);
  const pointAt = (event: {clientX: number; clientY: number}) => {
    const box = viewport.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left - mapCamera.camera.x) / mapCamera.camera.scale, y: (event.clientY - box.top - mapCamera.camera.y) / mapCamera.camera.scale };
  };
  const submitScope = () => { const anchor = graphSelectionAnchor(view, scope); if (anchor && scope.length >= 2) onFeedback?.({kind: "node", node_id: anchor}, scope); };
  const openZone = (id: string) => {
    const open = () => { const closing = selectedZoneId === id; setSelectedZoneId(closing ? null : id); setRelationScope(closing ? "overview" : "focus"); };
    // Only replace the opinion after its owner's draft/busy guard succeeds.
    if (contextPanel) onDismissFeedback?.(open); else open();
  };
  useEffect(() => { if (feedbackTarget) { setSelectedZoneId(null); setRelationScope("overview"); } }, [feedbackTarget]);

  if (!root || !layout.nodes.length) return <section className="project-structure-map" aria-label="工程结构地图"><p>当前工程没有可读取的根节点。</p></section>;
  return <section className="project-structure-map" aria-label="工程结构地图" data-root-node-id={view.document.root_id} data-focus-node-id={layout.rootId} data-selected-node-id={selectedNodeId ?? layout.rootId} data-relation-scope={effectiveRelationScope} data-canvas-mode={canvasMode} data-density-preference={densityPreference} data-semantic-density={semanticDensity}>
    <header className="psm-heading execution-story-header">
      <div><span className="psm-eyebrow">{layout.rootId === view.document.root_id ? "工程全景" : `当前区域 · 第 ${focusPath.length} 层`}</span><h2 title={root.title}>{engineeringNodeName(root, nodeNames)}</h2><p>{index.children.get(layout.rootId)?.length ?? 0} 项直属成果 · 点击有下级的节点在原图展开</p></div>
      <div className="psm-legend"><span><i className="is-running" />执行中</span><span><i className="is-accepted" />已验收</span><span><i className="is-review" />待验收</span><span><i />未开始</span></div>
    </header>
    <nav className="psm-breadcrumbs" aria-label="工程层级">
      {focusPath.map((id, position) => <Fragment key={id}><button type="button" aria-current={id === layout.rootId ? "page" : undefined} title={index.nodes.get(id)?.title} disabled={disabled || id === layout.rootId} onClick={() => requestFocus(id, id === view.document.root_id ? "root" : position === focusPath.length - 2 ? "back" : "locate")}>{position === 0 && <Home size={12}/>}<span>{nodeName(id)}</span></button>{position < focusPath.length - 1 && <ChevronRight size={12} aria-hidden="true"/>}</Fragment>)}
    </nav>
    <div className="psm-map-tools">
      <div className="psm-map-tools-row">
        <button type="button" className="psm-map-tools-toggle" aria-expanded={toolsOpen} aria-controls={`psm-map-tools-${marker}`} onClick={() => setToolsOpen(value => !value)}><ChevronDown size={14} aria-hidden="true"/>查找、状态与关系</button>
        <span className="psm-result-headline" data-result-state={resultHeadline.state}><strong>{attention.totals.attention ? `${attention.totals.attention} 处反馈需处理` : resultHeadline.label}</strong><span className="psm-result-relations"> · {relationStatusLabel}</span></span>
        {dependenciesVisible && relationPages.count > 1 && <div className="psm-relation-pages" role="group" aria-label="分组查看图上联系" title="分组查看当前范围的全部联系；选中节点后，先显示与它有关的联系。"><button type="button" disabled={disabled || relationBatchIndex === 0} aria-label="上一组联系" onClick={() => changeRelationBatch(-1)}><ChevronRight className="psm-back-icon" size={12}/></button><span aria-live="polite">联系 {relationBatchIndex * MAP_RELATIONS_PER_PAGE + 1}–{Math.min((relationBatchIndex + 1) * MAP_RELATIONS_PER_PAGE, relationPages.items.length)} / {relationPages.items.length}</span><button type="button" disabled={disabled || relationBatchIndex === relationPages.count - 1} aria-label="下一组联系" onClick={() => changeRelationBatch(1)}><ChevronRight size={12}/></button></div>}
        {onCanvasModeChange && <button type="button" className="psm-focus-mode" aria-pressed={canvasMode === "focus"} onClick={() => onCanvasModeChange(canvasMode === "focus" ? "embedded" : "focus")}>{canvasMode === "focus" ? <Minimize2 size={14}/> : <Maximize2 size={14}/>} {canvasMode === "focus" ? "退出专注" : "专注看图"}</button>}
      </div>
      <div className="psm-map-tools-panel" id={`psm-map-tools-${marker}`} hidden={!toolsOpen}>
    <div className="psm-scanbar" aria-label="查找与关注">
      <label className="psm-search"><Search size={15}/><input aria-label="搜索成果或反馈" placeholder="搜索成果或反馈" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="清除搜索" onClick={() => setQuery("")}><X size={14}/></button>}</label>
      <div className="psm-filters" aria-label="关注筛选">{([["all", "全部"], ["attention", "需处理"], ["improvement", "待改进"], ["feedback", "我的反馈"]] as const).map(([key, text]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{text}{key !== "all" && <b>{attention.totals[key]}</b>}</button>)}</div>
    </div>
    {hasFilter && <div className="psm-match-strip" aria-live="polite"><span>{matches.matchingNodeIds.size ? `找到 ${matches.matchingNodeIds.size} 个位置` : "暂没有匹配的记录"}</span>{[...matches.matchingNodeIds].slice(matchPage * 5, matchPage * 5 + 5).map(id => <button key={id} disabled={disabled} onClick={() => openAttention(id)}>{nodeName(id)}</button>)}{matches.matchingNodeIds.size > 5 && <button onClick={() => setIndexPage(page => page + 1)}>更多位置</button>}<button onClick={() => {setFilter("all"); setQuery("");}}>显示全部</button></div>}
    {!!collaboration.zones.length && <div className="psm-agent-strip" aria-label="Agent 协作分区">
      <label><input type="checkbox" checked={agentZonesVisible} onChange={event => { setAgentZonesVisible(event.target.checked); if (!event.target.checked) setSelectedZoneId(null); }} />Agent 分区</label>
      <span>{collaboration.zones.length} 个区域</span><strong>{collaborationParallelStatus(collaboration.zones, view, collaboration.conflicts)}</strong>
    </div>}
    <div className="psm-toolbar"><div className="psm-line-legend" data-open={legendOpen}><button type="button" className="psm-line-legend-toggle" aria-expanded={legendOpen} aria-controls={`psm-line-legend-${marker}`} onClick={() => setLegendOpen(value => !value)}>图例</button><div className="psm-line-legend-content" id={`psm-line-legend-${marker}`}><span title="灰框表示未分配；斜纹表示负责人边界待拆"><i className="psm-key zone"/>同色边界：同一 Agent</span><span><i className="psm-key composition"/>灰线：父子组成</span><span><i className="psm-key input"/>蓝色箭头：成果交接</span><span><i className="psm-key input projected"/>虚线：未展开节点的交接</span><span><i className="psm-key prerequisite"/>棕线：开工前提</span><span><i className="psm-key interaction"/>紫线：使用配合</span></div></div><label><input type="checkbox" disabled={disabled} checked={dependenciesVisible} onChange={event => onDependenciesChange ? onDependenciesChange(event.target.checked) : setInternalDependencies(event.target.checked)} />显示成果联系</label><div className="psm-relation-modes" role="group" aria-label="成果联系范围"><button type="button" aria-pressed={effectiveRelationScope === "overview"} disabled={disabled || !dependenciesVisible} onClick={() => setRelationScope("overview")}>区域交接</button><button type="button" aria-pressed={effectiveRelationScope === "focus"} disabled={disabled || !dependenciesVisible || !selectedZone} onClick={() => setRelationScope("focus")}>当前区域</button><button type="button" aria-pressed={effectiveRelationScope === "all"} disabled={disabled || !dependenciesVisible} onClick={() => setRelationScope("all")}>全部关系</button><span className="psm-relation-count" title={!dependenciesVisible ? "成果联系已收起。" : movingRelations.deferred.length ? "部分连线当前没有清晰通路，暂缓绘制；全部联系仍可查。" : admittedRelations.length < visibleRenderableRelations.length ? `第 ${relationBatchIndex + 1}/${relationPages.count} 组联系；使用上方按钮查看其余联系。` : "当前范围内的关系均已显示。"}>{relationStatusLabel}</span></div>{onFeedback && <button type="button" disabled={disabled} aria-pressed={selecting} onClick={() => {setSelecting(value => !value); setScope([]);}}><Scan size={14}/>框选范围</button>}</div>
      </div>
    </div>
    {selecting && <div className="psm-scopebar"><span>拖动空白处，或逐个点击节点 · 已选 {scope.length} 项</span><button disabled={disabled || scope.length < 2} onClick={submitScope}>对所选范围提意见</button><button onClick={() => {setSelecting(false); setScope([]);}}>结束选择</button></div>}
    {focusedFeedback && <div className="psm-feedback-trace" aria-label="这条意见在图上的处理结果">
      <span><i className="origin"/>意见位置</span>
      <span><i className="impact"/>{feedbackComparison?.state === "recorded" || feedbackComparison?.state === "historical" ? `记录影响 ${feedbackComparison.affected.length} 项` : feedbackComparison?.state === "missing" ? "修改记录需核对" : "尚无关联修改"}</span>
      <span><i className={`result ${feedbackResult?.state ?? "none"}`}/>{feedbackResult?.label ?? "尚无关联交付"}</span>
    </div>}
    <div className={`psm-stage${contextPanel || selectedZone ? " has-context" : ""}`}>
    <div className="psm-map-pane">
      <div className="psm-navigation-row">
        <div className="psm-canvas-controls" aria-label="地图导航">
          <button type="button" aria-label="返回工程全景" title="返回工程全景" disabled={disabled} onClick={() => layout.rootId === view.document.root_id ? mapCamera.fitAll() : requestFocus(view.document.root_id, "root")}><Home size={15}/><span>全图</span></button>
          {parentFocusId && <button type="button" aria-label="返回上层" title="返回上层" disabled={disabled} onClick={() => requestFocus(parentFocusId, "back")}><ChevronRight className="psm-back-icon" size={15}/><span>上一级</span></button>}
          <button type="button" aria-label="适应当前区域" title="适应当前区域" disabled={disabled} onClick={fitCurrentRegion}><LocateFixed size={15}/><span>适应区域</span></button>
          {firstReadingChild && readingContext && !readingContext.includesChild && <button type="button" aria-label="继续查看下级内容" title="当前高度无法同时容纳两项，继续查看下级" disabled={disabled} onClick={() => mapCamera.revealRect(firstReadingChild, 12)}><ChevronDown size={15}/><span>看下级</span></button>}
          <span className="psm-control-separator" aria-hidden="true"/>
          <div className="psm-zoom-controls">
            <button type="button" aria-label="缩小地图" title="缩小地图" disabled={disabled} onClick={() => mapCamera.zoomTo(mapCamera.camera.scale / 1.22)}><ZoomOut size={15}/></button>
            <output aria-label="地图缩放比例">{Math.round(mapCamera.camera.scale * 100)}%</output>
            <button type="button" aria-label="放大地图" title="放大地图" disabled={disabled} onClick={() => mapCamera.zoomTo(mapCamera.camera.scale * 1.22)}><ZoomIn size={15}/></button>
          </div>
          <label><span>信息</span><select aria-label="地图信息层级" disabled={disabled} value={densityPreference} onChange={event => chooseDensity(event.target.value as ProjectMapDensity)}><option value="auto">自动</option><option value="overview">总览</option><option value="structure">结构</option><option value="detail">细节</option></select></label>
        </div>
        {minimapVisible && <button type="button" className="psm-minimap-toggle" aria-label={minimapOpen ? "收起工程缩略图" : "显示工程缩略图"} aria-expanded={minimapOpen} aria-controls={`psm-minimap-${marker}`} onClick={() => setMinimapOpen(value => !value)}><Scan size={14}/><span>缩略图</span><ChevronDown size={12}/></button>}
      </div>
    <div className={`psm-viewport${selecting ? " is-selecting" : ""}${mapCamera.panning ? " is-panning" : ""}`} ref={viewport} role="region" aria-label="工程地图画布" tabIndex={0} data-visible-node-count={layout.nodes.length} data-columns={layout.columns} data-transition-state={geometryMoving || geometrySettling ? "moving" : "idle"} data-geometry-state={frame.moving ? "layout-moving" : mapCamera.moving ? "camera-moving" : geometrySettling ? "revealing" : "settled"} data-transition-progress={frame.progress} data-transition-id={frame.transitionId} data-camera-x={mapCamera.camera.x.toFixed(3)} data-camera-y={mapCamera.camera.y.toFixed(3)} data-camera-scale={mapCamera.camera.scale.toFixed(4)}
      data-region-frame-version={regionVersion.current.version} data-composition-route-count={compositionRouteCount.current} data-relation-route-count={relationRouteCount.current} data-card-presentation-count={cardPresentationCount.current}
      data-relation-batch={relationBatchIndex + 1} data-relation-batches={relationPages.count} data-admitted-relations={admittedRelations.map(relation => relation.id).join(" ")}
      data-dependency-planning-ms={routePlanningMs.current.dependencies.toFixed(3)} data-feedback-planning-ms={routePlanningMs.current.feedback.toFixed(3)}
      data-relation-deferred={movingRelations.deferred.map(link => link.id).join(" ")} data-feedback-deferred={movingFeedback.deferred.map(link => link.id).join(" ")}
      onFocusCapture={event => {
        const element = event.target as HTMLElement | SVGElement;
        if (frame.moving || !element.matches(":focus-visible")) return;
        if (element.matches(".psm-branch-caption button")) {
          // Captions sit outside their parent's card. Reveal the focused control
          // itself, without introducing a native scroll offset inside the canvas.
          const control = element.getBoundingClientRect(), canvas = event.currentTarget.getBoundingClientRect();
          const { x, y, scale } = mapCamera.camera;
          mapCamera.revealRect({ x: (control.left - canvas.left - x) / scale, y: (control.top - canvas.top - y) / scale, width: control.width / scale, height: control.height / scale });
          return;
        }
        const card = element.closest<HTMLElement>(".psm-card[data-node-id]")
          ?? (element.matches(".psm-opinion") ? element.previousElementSibling as HTMLElement | null : null);
        const zoneId = element.dataset.agentZoneLabel;
        // A long SVG relation cannot fit in one reading viewport. Its actual
        // target card is a meaningful, stable point from which to inspect it.
        const relation = element.matches(".psm-edge-hit") ? element : undefined;
        const relationTarget = relation?.dataset.to ?? relation?.parentElement?.querySelector<SVGPathElement>("path[data-map-dependency]")?.dataset.to;
        const nodeId = card?.dataset.nodeId ?? collaboration.zones.find(zone => zone.id === zoneId)?.root_node_id ?? relationTarget;
        const focused = nodeId ? targetNodes.get(nodeId) : undefined;
        if (focused) mapCamera.revealRect(focused);
      }}
      onPointerDown={event => {
        if (disabled || frame.moving || (event.target as Element).closest("button,input,select,summary")) return;
        if (selecting && event.button === 0) { const point = pointAt(event); dragRef.current = {a: point, b: point}; setDrag(dragRef.current); event.currentTarget.setPointerCapture(event.pointerId); return; }
        if (!selecting && (event.button === 0 || event.button === 1)) { event.preventDefault(); mapCamera.startPan(event); }
      }}
      onPointerMove={event => {if (dragRef.current) { dragRef.current = {...dragRef.current, b: pointAt(event)}; setDrag(dragRef.current); } else mapCamera.movePan(event);}}
      onPointerUp={event => {const selected = dragRef.current; if (selected) { setScope(graphSelectionInRect(frame.nodes, selected.a, pointAt(event)).slice(0,80)); dragRef.current = null; setDrag(null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } else mapCamera.endPan(event);}}
      onPointerCancel={event => {dragRef.current = null; setDrag(null); mapCamera.endPan(event);}} onKeyDown={event => {
        if (event.key === "Escape") {
          if (selecting) { event.preventDefault(); event.stopPropagation(); setSelecting(false); setScope([]); setDrag(null); dragRef.current = null; }
          else if (parentFocusId) { event.preventDefault(); event.stopPropagation(); requestFocus(parentFocusId, "back"); }
          return;
        }
        if (["+", "="].includes(event.key)) { event.preventDefault(); mapCamera.zoomTo(mapCamera.camera.scale * 1.2); }
        else if (event.key === "-") { event.preventDefault(); mapCamera.zoomTo(mapCamera.camera.scale / 1.2); }
        else if (event.key === "0") { event.preventDefault(); mapCamera.fitAll(); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); mapCamera.panBy(70, 0); }
        else if (event.key === "ArrowRight") { event.preventDefault(); mapCamera.panBy(-70, 0); }
        else if (event.key === "ArrowUp") { event.preventDefault(); mapCamera.panBy(0, 70); }
        else if (event.key === "ArrowDown") { event.preventDefault(); mapCamera.panBy(0, -70); }
      }}>
      <div className="psm-camera-world" style={{ width: frame.width, height: frame.height, transform: `translate3d(${mapCamera.camera.x}px,${mapCamera.camera.y}px,0) scale(${mapCamera.camera.scale})` }}>
      <div className="psm-tree" style={{ width: frame.width, height: frame.height }}>
        {agentZonesVisible && zoneRegions.map(region => {
          const zone = collaboration.zones.find(item => item.id === region.id);
          if (!zone) return null;
          const active = selectedZoneId === zone.id;
          const owner = zoneOwnerPresentations.get(zone.id)!;
          const ownerStyle = owner.hue === null ? {} : { "--zone-owner-hue": owner.hue, "--zone-owner-saturation": `${owner.saturation}%`, "--zone-owner-lightness": `${owner.lightness}%` } as CSSProperties;
          const status = agentZoneStatus(zone, view);
          return <Fragment key={zone.id}>
            <div className={`psm-agent-zone${active ? " is-selected" : ""}`} data-agent-zone={zone.id} data-zone-tone={owner.tone} data-zone-owner-state={owner.ownerState} aria-hidden="true" style={{ ...ownerStyle, left: region.x, top: region.y, width: region.width, height: region.height, opacity: region.opacity }}/>
            <button type="button" className={`psm-agent-zone-label${active ? " is-selected" : ""}`} data-agent-zone-label={zone.id} data-zone-tone={owner.tone} data-zone-owner-state={owner.ownerState} data-zone-status={status} aria-pressed={active} aria-label={`${zone.title}，负责人 ${owner.accessibleLabel}，${status}`} title={`${zone.title} · ${owner.accessibleLabel} · ${status}`} disabled={disabled || geometryMoving || region.labelOpacity < .05} style={{ ...ownerStyle, left: region.labelX, top: region.labelY, width: region.labelWidth, opacity: region.labelOpacity }} onClick={() => openZone(zone.id)}><span>{zone.title}</span><b className="psm-agent-owner-badge" title={owner.accessibleLabel}>{owner.shortLabel}</b>{active && <Check className="psm-zone-selected-indicator" size={11} aria-hidden="true"/>}<small>{status}</small></button>
          </Fragment>;
        })}
        {groups.map(group => <div key={group.id} className={`psm-branch-group${group.nested ? " is-nested" : ""}${agentZonesVisible && collaboration.zones.some(zone => zone.root_node_id === group.id) ? " is-zone-root" : ""}`} data-group-node-id={group.id} aria-hidden={geometryMoving || undefined} style={{ left: group.x, top: group.y, width: group.width, height: group.height, opacity: group.opacity, pointerEvents: geometryMoving ? "none" : undefined }}>
          <div className="psm-branch-caption" style={{ opacity: group.labelOpacity }}><span title={nodeName(group.id)}>{agentZonesVisible && collaboration.zones.some(zone => zone.root_node_id === group.id) ? `下级 ${group.childCount} 项` : `${nodeName(group.id)} · 下级 ${group.childCount} 项`}</span><button type="button" aria-label={"收起 " + nodeName(group.id)} disabled={disabled || geometryMoving || group.labelOpacity < .05 || !targetNodes.get(group.id)?.expanded} tabIndex={!geometryMoving && group.labelOpacity >= .05 && targetNodes.get(group.id)?.expanded ? undefined : -1} onClick={() => onRequestNavigation({ type: "toggle", nodeId: group.id })}><ChevronDown size={12} />收起</button></div>
        </div>)}
        <svg className="psm-composition-lines psm-geometry-layer" width={frame.width} height={frame.height} data-composition-suppressed={movingComposition.suppressedEdgeIds.join(" ")} data-composition-segment-count={compositionSegments.length} data-composition-segment-ids={compositionSegments.map(segment => segment.id).join(" ")}>
          {compositionSegments.map(segment => <path key={segment.id} aria-hidden="true" opacity={segment.opacity} data-composition-segment={segment.id} data-bus-id={segment.kind === "bus" ? segment.id : undefined} data-composition-members={segment.edgeIds.join(" ")} data-composition-contributors={segment.contributors.join(" ")} data-composition-kind={segment.kind} data-composition-level={segment.level} data-composition-route={segment.route} d={segment.d} />)}
          {routedCompositionEdges.map(edge => {
            const interactive = Boolean(onFeedback && !disabled && !selecting && !frame.moving && edge.opacity > .05);
            return <path key={edge.id} className={`psm-composition-geometry${onFeedback ? " psm-edge-hit" : ""}`} opacity={edge.opacity} style={{pointerEvents: interactive ? undefined : "none"}} data-composition-path={edge.id} data-composition-level={edge.level} data-composition-route={edge.route} data-from={edge.from} data-to={edge.to} d={edge.d} role={onFeedback ? "button" : undefined} tabIndex={onFeedback ? interactive ? 0 : -1 : undefined} aria-hidden={onFeedback && !interactive || undefined} aria-label={onFeedback ? `反馈组成 ${nodeName(edge.to)} 属于 ${nodeName(edge.from)}` : undefined} onClick={onFeedback ? () => interactive && onFeedback({kind: "relation", node_id: edge.to, id: "parent"}) : undefined} onKeyDown={onFeedback ? event => {if (interactive && ["Enter", " "].includes(event.key)) {event.preventDefault(); onFeedback({kind: "relation", node_id: edge.to, id: "parent"});}} : undefined}/>;
          })}
        </svg>
        {!!feedbackRoutes.length && <svg className="psm-feedback-impact-lines psm-geometry-layer psm-following-relations" width={frame.width} height={frame.height} aria-hidden="true"><defs><marker id={`${marker}-feedback-impact`} data-feedback-marker="true" data-marker-size="7" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" /></marker></defs>{feedbackRoutes.map(edge => <path key={edge.id} opacity={edge.opacity} data-feedback-impact={edge.to} data-from={edge.from} data-to={edge.to} d={edge.d} markerEnd={`url(#${marker}-feedback-impact)`}/>)}</svg>}
        {dependenciesVisible && <svg className="psm-dependency-lines psm-geometry-layer psm-following-relations" width={frame.width} height={frame.height}><defs>{routes.map((edge, i) => { const geometry = dependencyMarkerGeometry(relationEmphasized(edge.id)); return <marker key={edge.id} id={`${marker}-${i}`} data-dependency-marker={edge.id} data-marker-size={geometry.size} markerUnits={geometry.markerUnits} markerWidth={geometry.size} markerHeight={geometry.size} refX={geometry.refX} refY={geometry.refY} orient="auto"><path d={geometry.d} fill={relationColor(edge.id)} /></marker>; })}</defs>{routes.map((edge, i) => {
          const relation = relationById.get(edge.id); if (!relation) return null;
          const hint = [
            effectiveRelationScope === "overview" ? "区域间汇总交接；点击区域可查看实际节点之间的连接。" : "",
            edge.inherited ? "虚线表示实际交接节点收在未展开分支中，当前先连到图上可见的上级节点；展开分支可查看原连接。" : ""
          ].filter(Boolean).join("\n");
          const aggregated = relation.members.length > 1;
          const feedbackSelected = relationFeedbackSelected(edge.id);
          const relationInteractive = !disabled && !selecting && !frame.moving && edge.opacity > .05;
          const ariaLabel = aggregated ? `查看汇总成果联系 ${nodeName(relation.from)} 到 ${nodeName(relation.to)}：${relation.label}` : `反馈成果联系 ${nodeName(relation.members[0]!.sourceNodeId)} 到 ${nodeName(relation.members[0]!.targetNodeId)}：${relation.label}`;
          return <g key={edge.id} data-projected={edge.inherited || undefined} data-relation-count={relation.members.length} opacity={edge.opacity * relationOpacity(edge.id)}><title>{relationTooltip(edge.id)}{hint ? `\n${hint}` : ""}</title><path d={edge.d} fill="none" stroke="#f9f7f2" strokeWidth="6" /><path data-map-dependency={edge.id} data-from={edge.from} data-to={edge.to} d={edge.d} fill="none" stroke={relationColor(edge.id)} strokeWidth={feedbackSelected ? 3.4 : effectiveRelationScope === "focus" ? 2.8 : deliveryRelationTouchesNode(relation, selectedId, layout.rootId) ? 2.8 : 2.05} strokeDasharray={edge.inherited || relation.problem ? "5 4" : undefined} markerEnd={`url(#${marker}-${i})`} />{(aggregated || onFeedback) && <path className="psm-edge-hit" d={edge.d} role="button" style={{pointerEvents: relationInteractive ? undefined : "none"}} aria-hidden={!relationInteractive || undefined} tabIndex={relationInteractive ? 0 : -1} aria-label={`${ariaLabel}${hint ? `。${hint}` : ""}`} onClick={() => relationInteractive && openRelation(edge.id)} onKeyDown={event => {if (relationInteractive && ["Enter", " "].includes(event.key)) {event.preventDefault(); openRelation(edge.id);}}}/>}</g>;
        })}</svg>}
        {dependenciesVisible && <svg className="psm-dependency-connectors psm-geometry-layer psm-following-relations" width={frame.width} height={frame.height} aria-hidden="true">{routeLabels.flatMap(label => label.connector ? [<path key={label.id} data-delivery-label-connector={label.id} d={label.connector} opacity={label.opacity * relationOpacity(label.id)}/>] : [])}</svg>}
        {dependenciesVisible && <svg className="psm-dependency-labels psm-geometry-layer psm-following-relations" width={frame.width} height={frame.height} aria-hidden="true">{routeLabels.map(label => <g key={label.id} data-delivery-label={label.id} opacity={label.opacity * relationOpacity(label.id)}><title>{label.fullText}</title><rect x={label.x} y={label.y} width={label.width} height={label.height} rx="4" /><text x={label.x + label.width / 2} y={label.y + 15} textAnchor="middle">{label.text}</text></g>)}{routes.map(route => <g key={`port:${route.id}`} data-relation-port={route.id} opacity={route.opacity * relationOpacity(route.id)}><circle cx={route.points[0]!.x} cy={route.points[0]!.y} r="4" fill={relationColor(route.id)}/><circle cx={route.points[0]!.x} cy={route.points[0]!.y} r="1.4" fill="#fffdf8"/></g>)}</svg>}
        {regionFrame.nodes.map(position => {
          const target = targetNodes.get(position.id);
          const item = { ...position, childCount: target?.childCount ?? position.childCount, expanded: target?.expanded ?? false };
          const presentation = cardPresentations.get(item.id); if (!presentation) return null;
          const { name, title, status, summary, unknown, ownStatus, purpose, runPlanActivity, runPlanDescription, opinionCount } = presentation;
          const dim = hasFilter && !matches.matchingNodeIds.has(item.id) && !matches.ancestorNodeIds.has(item.id);
          const selectedScope = selecting ? scope.includes(item.id) : feedbackScopeNodeIds?.includes(item.id);
          return <div key={position.renderKey ?? item.id} className="psm-node-wrap">
          <button type="button" className={`psm-card state-${status} ${position.ghost ? "is-motion-ghost" : ""} ${runPlanActivity ? `has-run-plan run-plan-${runPlanActivity.phase}` : ""} ${unknown ? "is-observation-unknown" : ""} ${selectedNodeId === item.id && !position.ghost ? "is-selected" : ""} ${selectedScope ? "is-scoped" : ""} ${feedbackOrigins.has(item.id) ? "is-feedback-origin" : ""} ${feedbackImpacts.has(item.id) ? "is-feedback-impact" : ""} ${dim ? "is-dim" : ""}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height, opacity: item.opacity, pointerEvents: item.exiting || frame.moving ? "none" : undefined }} data-exiting={String(item.exiting)} data-motion-role={position.motionRole} data-motion-node-id={item.id} data-node-ghost={position.ghost || undefined} aria-hidden={item.exiting || item.opacity <= .05 || undefined} tabIndex={item.exiting || item.opacity <= .05 ? -1 : undefined} data-node-id={position.ghost ? undefined : item.id} data-parent-id={item.parentId ?? ""} data-depth={item.depth} data-expanded={String(item.expanded)} data-world-x={item.x} data-world-y={item.y} data-run-plan-state={runPlanActivity ? "active" : undefined} data-run-plan-phase={runPlanActivity?.phase} data-run-plan-authorized={runPlanActivity ? String(runPlanActivity.executionAuthorized) : undefined} aria-haspopup={!position.ghost && item.childCount ? "tree" : undefined} aria-expanded={!position.ghost && item.childCount ? item.expanded : undefined} aria-pressed={!position.ghost && selecting ? scope.includes(item.id) : undefined} aria-label={name} aria-description={[item.parentId ? "属于 " + nodeName(item.parentId) : "当前区域", ownStatus, `作用：${purpose.text}`, runPlanDescription, feedbackOrigins.has(item.id) ? "当前意见位置" : feedbackImpacts.has(item.id) ? "本次记录的影响位置" : "", summary, item.childCount ? `${item.childCount} 项下级，点击${item.expanded ? "收起" : "在原图展开"}` : "点击选中并查看本项结果"].filter(Boolean).join("，")} title={title} disabled={disabled} onClick={position.ghost ? undefined : () => selecting ? toggleScope(item.id) : item.childCount ? onRequestNavigation({ type: "toggle", nodeId: item.id }) : onRequestNavigation({ type: "select", nodeId: item.id })}>
            <ProjectMapCardContent presentation={presentation} root={item.id === layout.rootId} childCount={item.childCount} expanded={item.expanded} selecting={selecting} selectedScope={Boolean(selectedScope)} feedbackMark={feedbackOrigins.has(item.id) ? "origin" : feedbackImpacts.has(item.id) ? "impact" : undefined}/>
          </button>
          {onFeedback && !selecting && !item.exiting && !position.ghost && <button type="button" className={`psm-opinion${opinionCount ? " has-attention" : ""}`} style={{left: item.x + item.width - 38, top: item.y + item.height - 36}} title={opinionCount ? `${opinionCount} 项待看 · 提意见` : "提意见"} aria-label={`提意见 ${name}`} disabled={disabled} onClick={() => onFeedback({kind: "node", node_id: item.id})}><MessageSquare size={14} aria-hidden="true"/>{opinionCount > 0 && <span className="psm-opinion-count" aria-hidden="true">{opinionCount > 9 ? "9+" : opinionCount}</span>}</button>}
          </div>;
        })}
        {drag && <div className="psm-selection-rect" style={{left: Math.min(drag.a.x,drag.b.x), top: Math.min(drag.a.y,drag.b.y), width: Math.abs(drag.a.x-drag.b.x), height: Math.abs(drag.a.y-drag.b.y)}}/>}
      </div>
      </div>
    </div>
    <div className="psm-minimap-panel" id={`psm-minimap-${marker}`} hidden={!minimapOpen || !minimapVisible}>
      <p className="psm-navigation-hint">点击有下级的节点展开或收起 · Ctrl + 滚轮缩放 · 拖动空白处移动</p>
      {minimapVisible && <button type="button" className="psm-minimap" aria-label="工程缩略图，点击移动视野" title="点击缩略图移动视野" style={{width: minimapWidth + 12, height: minimapHeight + 12}} onClick={event => {
        if (event.detail === 0) { mapCamera.fitAll(); return; }
        const box = event.currentTarget.querySelector("svg")!.getBoundingClientRect();
        mapCamera.centerWorldPoint({ x: (event.clientX - box.left) / box.width * frame.width, y: (event.clientY - box.top) / box.height * frame.height });
      }}><svg aria-hidden="true" viewBox={`0 0 ${frame.width} ${frame.height}`} width={minimapWidth} height={minimapHeight} preserveAspectRatio="none">
        {zoneRegions.map(region => <rect key={region.id} className="psm-minimap-zone" x={region.x} y={region.y} width={region.width} height={region.height} rx="8"/>)}
        {layout.nodes.map(node => <rect key={node.id} className={node.id === selectedId ? "is-selected" : ""} x={node.x} y={node.y} width={node.width} height={node.height} rx="4"/>)}
        <rect className="psm-minimap-window" x={visibleWorld.x} y={visibleWorld.y} width={visibleWorld.width} height={visibleWorld.height} rx="4"/>
      </svg></button>}
    </div>
    </div>
    {(selectedZone || contextPanel) && <aside className="psm-context" aria-label="图上所选内容">{selectedZone ? <AgentZoneCard zone={selectedZone} view={view} responsibility={projectNodePurpose(index.nodes.get(selectedZone.root_node_id)!).text} handoffs={selectedZoneHandoffs} conflicts={selectedZoneConflicts} disabled={disabled} onClose={() => {setSelectedZoneId(null); setRelationScope("overview");}} onOpenOwner={onOpenDetail ? () => onOpenDetail(selectedZone.root_node_id, "edit") : undefined}/> : contextPanel}</aside>}
    </div>
    <div className="psm-utility-tray" aria-label="地图辅助内容">
    {delivery && <details className="psm-optional-detail" name="project-map-utility"><summary>本项交接</summary><section className="psm-handoff" aria-label="本项成果关系" data-delivery-node-id={selectedId}>
      <header><strong title={nodeName(selectedId)}>{nodeName(selectedId)}</strong><span>{delivery.contractComplete ? "交付约定已补齐 · 验收另行确认" : "交付约定待补充"}</span></header>
      <div className="psm-handoff-columns">
        <section aria-label="需要什么"><h3>需要什么 <span aria-hidden="true">→</span></h3><div className="psm-handoff-items">
          {delivery.inputs.map(input => <p key={input.id}><strong>{input.title || "未命名输入"}</strong>{input.sourceNodeId ? <button type="button" disabled={disabled} onClick={() => onRequestNavigation({ type: "focus", nodeId: input.sourceNodeId!, reason: "locate" })}>{nodeName(input.sourceNodeId)}{input.outputTitle ? ` · ${input.outputTitle}` : ""}</button> : <small>{input.externalSource ? `外部：${input.externalSource}` : "来源待补充"}</small>}{input.problem && <small className="psm-delivery-issue">{input.problem}</small>}</p>)}
          {!delivery.inputs.length && <p className="psm-muted">{delivery.configured ? "本项未声明输入。" : "输入与来源待说明。"}</p>}
          {delivery.declaredDependencies.map(id => <p key={id}><button type="button" disabled={disabled || !index.nodes.has(id)} onClick={() => onRequestNavigation({ type: "focus", nodeId: id, reason: "locate" })}>{nodeName(id)}</button><small>已声明前置，交接成果待说明。</small></p>)}
        </div></section>
        <section aria-label="本项交付"><h3>本项交付 <span aria-hidden="true">→</span></h3><div className="psm-handoff-items">{delivery.outputs.length ? delivery.outputs.map(output => <p key={output.id}><strong>{output.title || "未命名成果"}</strong><small>{output.criteria.length ? `关联 ${output.criteria.length} 条完成条件` : "完成条件待关联"}{output.missingCriteria.length ? " · 含失效条件" : ""}</small></p>) : <p className="psm-muted">可独立交付的成果待说明。</p>}</div></section>
        <section aria-label="交给谁"><h3>交给谁</h3><div className="psm-handoff-items">{delivery.consumers.length ? delivery.consumers.map(consumer => <p key={consumer.id}><button type="button" disabled={disabled} onClick={() => onRequestNavigation({ type: "focus", nodeId: consumer.nodeId, reason: "locate" })}>{nodeName(consumer.nodeId)}</button><small>{consumer.outputTitle || consumer.inputTitle}</small>{consumer.problem && <small className="psm-delivery-issue">{consumer.problem}</small>}</p>) : <p className="psm-muted">尚无其他节点声明使用本项成果。</p>}</div></section>
      </div>
    </section></details>}
    {dependenciesVisible && <details className="psm-relations" name="project-map-utility"><summary>全部联系 {relations.length}</summary><div><p>细线表示组成；箭头按类型说明交接、开工前提或使用配合。选中节点后，画布只突出它的相关联系。虚线表示真实节点收在分支内。</p>{relations.length === 0 && <p>工程尚未声明节点之间的联系。</p>}{relations.slice(currentRelationPage * 12, (currentRelationPage + 1) * 12).map(edge => <p key={edge.id} data-delivery-relation={edge.id}><button type="button" title={index.nodes.get(edge.sourceNodeId)?.title} disabled={disabled || !index.nodes.has(edge.sourceNodeId)} onClick={() => requestFocus(edge.sourceNodeId, "locate")}>{nodeName(edge.sourceNodeId)}</button><span> → {edge.label} → </span><button type="button" title={index.nodes.get(edge.targetNodeId)?.title} disabled={disabled} onClick={() => requestFocus(edge.targetNodeId, "locate")}>{nodeName(edge.targetNodeId)}</button>{edge.problem && <small className="psm-delivery-issue">{edge.problem}</small>}{edge.projected && <small>{edge.from === edge.to ? `关系位于「${nodeName(edge.to)}」分支内，展开后可查看。` : `图上汇总到「${nodeName(edge.from)} → ${nodeName(edge.to)}」，交接仍属于上方原节点。`}</small>}</p>)}<p className="psm-muted">图中显示 {routes.length} 条相关箭头；全部关系在此逐条可查。</p>{relations.length > 12 && <div className="psm-index-pager"><button disabled={!currentRelationPage} onClick={() => setRelationPage(currentRelationPage - 1)}>上一页关系</button><span>{currentRelationPage + 1} / {Math.ceil(relations.length / 12)}</span><button disabled={(currentRelationPage + 1) * 12 >= relations.length} onClick={() => setRelationPage(currentRelationPage + 1)}>下一页关系</button></div>}</div></details>}
    <details className="psm-node-index" name="project-map-utility"><summary>定位节点 {allNodes.length}</summary><div><label>按名称查找<input aria-label="查找工程节点" value={query} onChange={event => { setQuery(event.target.value); setIndexPage(0); }} placeholder="输入任务或成果名称" /></label><ul>{candidates.slice(currentPage * 20, (currentPage + 1) * 20).map(node => <li key={node.id}><button type="button" title={node.title} disabled={disabled} aria-label={"定位 " + engineeringNodeName(node, nodeNames)} onClick={() => requestFocus(node.id, "locate")}><strong>{engineeringNodeName(node, nodeNames)}</strong><small>{view.derived[node.id]?.path.slice(0, -1).map(nodeName).join(" / ") || "工程根"}</small></button></li>)}</ul>{!candidates.length && <p>没有匹配的工程节点。</p>}<div className="psm-index-pager"><span>共 {candidates.length} 项{candidates.length > 20 ? ` · 第 ${currentPage + 1} 页` : ""}</span>{candidates.length > 20 && <><button type="button" disabled={!currentPage} onClick={() => setIndexPage(currentPage - 1)}>上一页节点</button><button type="button" disabled={(currentPage + 1) * 20 >= candidates.length} onClick={() => setIndexPage(currentPage + 1)}>下一页节点</button></>}</div></div></details>
    <footer className="psm-reading-status" aria-live="polite"><span title={nodeName(selectedId)}>当前查看：{nodeName(selectedId)}</span>{onOpenDetail && <button type="button" disabled={disabled} onClick={() => onOpenDetail(selectedId, "read")}>查看本项说明与结果</button>}</footer>
    </div>
  </section>;
}
