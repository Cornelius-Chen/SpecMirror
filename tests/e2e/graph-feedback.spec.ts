import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { deriveEngineeringView, engineeringContractKey, engineeringLineageVersions, type EngineeringHandoffPacket, type EngineeringView } from "../../packages/domain/src/engineering.ts";
import { EngineeringFeedbackCreateSchema, EngineeringFeedbackSchema, engineeringFeedbackClosureCurrent, engineeringFeedbackScopeSnapshot, engineeringFeedbackTargetValue, type EngineeringFeedback } from "../../packages/domain/src/engineering-feedback.ts";
import { inspectorDocument, inspectorNode, inspectorRun } from "../fixtures/project-inspector.ts";
import type { EngineeringRunResult } from "../../apps/web/src/components/project-map/node-result-state.ts";

type ResultReply = { json?: unknown; status?: number; hold?: boolean };

/** Every API is intercepted. These fixtures cannot mutate the running Mirror host. */
async function isolatedWorkspace(page: Page) {
  const stamp = "2026-09-06T12:00:00Z";
  const document = inspectorDocument([
    inspectorNode("root", null, { title: "工程反馈隔离测试" }),
    inspectorNode("alpha", "root", { title: "因子发现", order: 1 }),
    inspectorNode("beta", "root", { title: "策略验证", order: 2 })
  ]);
  let count = 0, failNext = false;
  const requests: Array<{ target: unknown; scope_node_ids?: string[]; note: string }> = [];
  const forbidden: string[] = [];
  const resultRequests: Array<{ runId: string; workspace: string | null; workspaceHeader?: string }> = [];
  const resultReplies = new Map<string, ResultReply>();
  const artifactReplies = new Map<string, { body: string; status: number }>();
  const artifactRequests: Array<{ runId: string; path: string | null; workspace: string | null; workspaceHeader?: string }> = [];
  const pendingResults: Array<{ runId: string; release: () => Promise<void> }> = [];
  let observation: EngineeringView["observation"];
  let handlingMode: "reject" | "accept" | undefined;
  const handlingRequests: Array<Record<string, unknown>> = [];
  const view = () => ({ ...deriveEngineeringView(document), ...(observation ? { observation } : {}) });
  // Reuse the existing run snapshot and result contract. Verified files here are simulated API observations only.
  function result(runId: string, patch: Partial<EngineeringRunResult> = {}): EngineeringRunResult {
    const run = document.runs.find(item => item.id === runId);
    if (!run) throw new Error(`Unknown isolated run: ${runId}`);
    return { schema_version: 1, kind: "engineering-run-result", workspace_id: "host", node_id: run.node_id, run_id: run.id,
      observed_at: stamp, contract_key: run.snapshot.contract_key, node_revision: run.snapshot.node.revision,
      run_status: run.status, started_at: run.started_at, finished_at: run.finished_at,
      current_contract: run.snapshot.contract_key === engineeringContractKey(document, run.node_id),
      review: run.reviewed_at || run.review_note ? { reviewed_at: run.reviewed_at, review_note: run.review_note } : null,
      artifacts: run.evidence.filter(item => item.kind === "artifact").map(item => ({ evidence_id: item.id, path: item.path ?? null,
        recorded_sha256: item.sha256 ?? null, actual_sha256: item.sha256 ?? null, status: item.sha256 ? "verified" : "unrecorded" })),
      source_checks: [], metrics: run.metrics ?? null, issues: [], ...patch };
  }
  function record(target: EngineeringFeedback["target"], kind: EngineeringFeedback["kind"], note: string): EngineeringFeedback {
    const node = document.nodes.find(item => item.id === target.node_id)!;
    const basis = { document_revision: document.revision, node_revision: node.revision, contract_key: engineeringContractKey(document, node.id), lineage: engineeringLineageVersions(document, node.id), run_id: null, target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(node, target)) };
    return { id: `fixture-feedback-${++count}`, target, kind, note, status: "open", base_document_revision: basis.document_revision, base_node_revision: basis.node_revision, base_contract_key: basis.contract_key, base_lineage: basis.lineage, base_run_id: null, target_snapshot: basis.target_snapshot, created_at: stamp, updated_at: stamp, history: [{ at: stamp, action: "create", actor: "隔离界面测试", note, basis }] };
  }
  function create(input: unknown) {
    const request = EngineeringFeedbackCreateSchema.parse(input);
    const feedback = record(request.target, request.kind, request.note);
    if (request.scope_node_ids) {
      feedback.scope_node_ids = request.scope_node_ids;
      feedback.scope_snapshot = engineeringFeedbackScopeSnapshot(document, request.scope_node_ids);
      const children = request.scope_node_ids.map(id => ({ ...record({ kind: "node", node_id: id }, request.kind, request.note), scope_group_id: feedback.id }));
      feedback.scope_feedback_ids = children.map(item => item.id);
      (document.feedbacks ??= []).push(feedback, ...children);
    } else (document.feedbacks ??= []).push(feedback);
    document.revision++;
    return feedback;
  }
  const task = { id: "graph-task", title: "图上讨论隔离测试", cwd: "D:/isolated-graph-feedback", updatedAt: 1788696000, pinned: false, version: "fixture-1", received: false, receivedAt: null };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    let json: unknown;
    if (request.method() !== "GET") {
      const handlingMatch = url.pathname.match(/^\/api\/engineering\/feedback-items\/([^/]+)\/update$/);
      if (handlingMode && handlingMatch && request.method() === "POST") {
        const input = request.postDataJSON(); handlingRequests.push(input);
        if (handlingMode === "reject") { await route.fulfill({ status: 403, json: { error: "隔离场景：尚无本次操作的认证", code: "fixture_authorization_rejected" } }); return; }
        // Explicit isolated response only, not a replacement for server authorization/validation.
        const item = document.feedbacks?.find(item => item.id === handlingMatch[1]);
        if (!item || input.action !== "working" || input.expected_revision !== document.revision || request.headers()["x-mirror-workspace-id"] !== "host") throw new Error("Unexpected isolated handling request");
        item.status = "working";
        item.history.push({ at: stamp, action: "working", actor: "隔离认证响应", note: input.note, run_id: input.run_id });
        document.revision++;
        await route.fulfill({ json: view() }); return;
      }
      if (url.pathname === "/api/engineering/feedback-items" && request.method() === "POST") {
        const input = request.postDataJSON(); requests.push(input);
        if (failNext) { failNext = false; await route.fulfill({ status: 409, json: { error: "工程内容已更新，请重新核对", code: "engineering_revision_conflict" } }); return; }
        if (input.expected_revision !== document.revision || request.headers()["x-mirror-workspace-id"] !== "host") { await route.fulfill({ status: 409, json: { error: "隔离测试版本或工作区不符" } }); return; }
        create(input); await route.fulfill({ status: 201, json: view() }); return;
      }
      forbidden.push(`${request.method()} ${url.pathname}`); await route.fulfill({ status: 403, json: { error: "测试禁止其他写入" } }); return;
    }
    if (url.pathname === "/api/events") { await route.fulfill({ contentType: "text/event-stream", body: ": isolated fixture\n\n" }); return; }
    const artifactMatch = url.pathname.match(/^\/api\/engineering\/runs\/([^/]+)\/artifact$/);
    if (artifactMatch) {
      const runId = decodeURIComponent(artifactMatch[1]);
      artifactRequests.push({ runId, path: url.searchParams.get("path"), workspace: url.searchParams.get("workspace"), workspaceHeader: request.headers()["x-mirror-workspace-id"] });
      const reply = artifactReplies.get(JSON.stringify([runId, url.searchParams.get("path")]));
      if (!reply) throw new Error("Unexpected isolated artifact read");
      await route.fulfill({ status: reply.status, contentType: "text/plain; charset=utf-8", body: reply.body }); return;
    }
    const handoffMatch = url.pathname.match(/^\/api\/engineering\/runs\/([^/]+)\/handoff$/);
    if (handoffMatch) {
      const run = document.runs.find(run => run.id === decodeURIComponent(handoffMatch[1]));
      if (!run?.handoff || request.headers()["x-mirror-workspace-id"] !== "host") throw new Error("Unexpected isolated handoff read");
      const node = run.snapshot.node;
      // Existing inspector reads the same frozen packet for an external run.
      const packet: EngineeringHandoffPacket = { schema_version: 1, workspace_id: "host", node_id: node.id, run_id: run.id,
        source_cwd: run.handoff.source_cwd, owner: run.handoff.owner, document_revision: run.handoff.document_revision,
        node_revision: node.revision, contract_key: run.handoff.contract_key, objective: node.objective, method: node.method,
        architecture: node.architecture, constraints: run.snapshot.effective, actions: node.actions, criteria: node.criteria,
        capabilities: node.capabilities, handoff: run.handoff,
        current: view().derived[node.id]?.latest_run_id === run.id && !["paused", "blocked", "stale", "rejected"].includes(run.status) };
      await route.fulfill({ json: packet }); return;
    }
    const resultMatch = url.pathname.match(/^\/api\/engineering\/runs\/([^/]+)\/result$/);
    if (resultMatch) {
      const runId = decodeURIComponent(resultMatch[1]);
      resultRequests.push({ runId, workspace: url.searchParams.get("workspace"), workspaceHeader: request.headers()["x-mirror-workspace-id"] });
      const reply = resultReplies.get(runId);
      const knownRun = document.runs.some(item => item.id === runId);
      const json = structuredClone(reply?.json ?? (knownRun ? result(runId) : { error: "隔离运行不存在" }));
      const release = async () => { await route.fulfill({ status: reply?.status ?? (knownRun ? 200 : 404), json }); };
      if (reply?.hold) pendingResults.push({ runId, release }); else await release();
      return;
    }
    if (url.pathname === "/api/task-workspaces") json = { data: [{ id: "host", thread_id: task.id, title: document.nodes[0].title, source_cwd: task.cwd, kind: "existing", root_node_id: "root", revision: document.revision, status: "draft", counts: view().derived.root.counts, updated_at: stamp }] };
    else if (url.pathname === "/api/task-inbox/connections") json = { data: [], partial: false, observedAt: stamp };
    else if (url.pathname === "/api/task-inbox") json = { data: [task], nextCursor: null, syncedAt: stamp };
    else if (url.pathname === `/api/task-inbox/${task.id}`) json = { ...task, preview: "仅测试图旁反馈交互", token: "fixture", historyUnavailable: false, nextCursor: null, turns: [] };
    else if (url.pathname === "/api/task-presentation") json = { schema_version: 1, revision: 1, collections: [], task_collection_ids: {}, workspace_id: url.searchParams.get("workspace"), workspace: { current_phase_id: null, node_labels: {}, node_names: {} } };
    else if (url.pathname === "/api/engineering") json = view();
    else if (url.pathname === "/api/engineering/structure-proposal") json = { available: false };
    else if (url.pathname === "/api/task-workspaces/host/sessions") json = { sessions: [] };
    else if (url.pathname === "/api/task-workspaces/host/run-plan-projections") json = { schema_version: 1, workspace_id: "host", projections: [] };
    else { forbidden.push(`GET ${url.pathname}`); await route.fulfill({ status: 404, json: { error: "隔离测试没有此接口" } }); return; }
    await route.fulfill({ json });
  });
  return { document, requests, forbidden, create, result, resultRequests, pendingResults, handlingRequests, artifactRequests,
    setArtifact: (runId: string, path: string, body: string, status = 200) => { artifactReplies.set(JSON.stringify([runId, path]), { body, status }); },
    observe: (value: EngineeringView["observation"]) => { observation = value; },
    handle: (value: "reject" | "accept") => { handlingMode = value; },
    setResult: (runId: string, reply: ResultReply) => { resultReplies.set(runId, reply); }, fail: () => { failNext = true; } };
}

type IsolatedWorkspace = Awaited<ReturnType<typeof isolatedWorkspace>>;
function submittedResult(fixture: IsolatedWorkspace, nodeId = "alpha", status: "review" | "accepted" = "review") {
  const item = fixture.create({ expected_revision: fixture.document.revision, base_node_revision: 1,
    target: { kind: "node", node_id: nodeId }, kind: "defect", note: `核对 ${nodeId} 本次提交的成果。` });
  const run = inspectorRun(fixture.document, nodeId, status);
  run.evidence.push({ id: `${nodeId}-report`, criterion_id: `${nodeId}-manual`, kind: "artifact", summary: "隔离结果报告",
    path: `reports/${nodeId}-result.html`, sha256: "a".repeat(64), passed: null, created_at: fixture.document.updated_at });
  fixture.document.runs.push(run);
  Object.assign(item, { status: "review", submitted_run_id: run.id });
  item.history.push({ at: fixture.document.updated_at, action: "submit", actor: "隔离测试", note: "隔离运行已关联，等待核对", run_id: run.id });
  return { item, run };
}

function expectReadOnly(fixture: IsolatedWorkspace, before: string) {
  expect(JSON.stringify(fixture.document)).toBe(before);
  expect(fixture.requests).toHaveLength(0); expect(fixture.forbidden).toEqual([]);
  for (const request of fixture.resultRequests) expect(request).toMatchObject({ workspace: "host", workspaceHeader: "host" });
}
const requestedRuns = (fixture: IsolatedWorkspace) => [...new Set(fixture.resultRequests.map(request => request.runId))];

function workingFeedback(fixture: IsolatedWorkspace, linked = true) {
  fixture.document.nodes.find(node => node.id === "root")!.constraints.allow = ["reports/**"];
  const node = fixture.document.nodes.find(node => node.id === "alpha")!;
  node.owner = "codex:fixture-session";
  node.actions = [{ id: "quality-report", type: "agent_artifact", title: "补齐因子质量报告", path: "reports/alpha-result.html", content: "", criterion_id: "alpha-manual", capability_id: "" }];
  const item = fixture.create({ expected_revision: fixture.document.revision, base_node_revision: node.revision,
    target: { kind: "node", node_id: node.id }, kind: "defect", note: "因子结果缺少质量说明，请补齐。" });
  Object.assign(item, { status: linked ? "working" : "adopted", resolution_kind: "delivery", adopted_lineage: engineeringLineageVersions(fixture.document, node.id) });
  item.history.push({ at: "2026-09-06T12:00:00Z", action: "adopt", actor: "隔离场景", note: "隔离场景按原标准补充说明" });
  const run = inspectorRun(fixture.document, node.id, "running", "external");
  run.actor = node.owner;
  run.started_at = "2026-09-06T12:01:00Z";
  run.current_action = "quality-report";
  fixture.document.runs.push(run);
  if (linked) item.history.push({ at: run.started_at, action: "working", actor: "隔离场景", note: "记录本条意见的处理运行", run_id: run.id });
  const observed = new Date().toISOString();
  fixture.observe({ source: "local-engineering-service", captured_at: observed, runs: { [run.id]: { state: "current", last_observed_at: observed, message: "隔离场景的当前运行观察" } } });
  EngineeringFeedbackSchema.parse(item);
  return { item, run };
}

async function open(page: Page) {
  await page.goto("/?task=graph-task&view=map&node=root&map_node=root&expanded=root");
  await expect(page.locator('.psm-card[data-node-id="alpha"]')).toBeVisible();
}
const card = (page: Page) => page.getByRole("complementary", { name: "图上意见" });
async function setMapTools(page: Page, expanded: boolean) {
  const toggle = page.getByRole("button", { name: "查找、状态与关系", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== String(expanded)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
}
async function locateOnMap(page: Page, id: string) {
  const node = page.locator(`.psm-card[data-node-id="${id}"]`);
  const fullyVisible = () => node.evaluate(element => {
    const card = element.getBoundingClientRect(), viewport = element.closest(".psm-viewport")!.getBoundingClientRect();
    return card.left >= viewport.left - 1 && card.right <= viewport.right + 1 && card.top >= viewport.top - 1 && card.bottom <= viewport.bottom + 1;
  });
  if (await fullyVisible()) return;
  const index = page.locator(".psm-node-index");
  if (await index.getAttribute("open") === null) await index.locator("summary").click();
  const name = await node.getAttribute("aria-label");
  await index.getByRole("button", {name: `定位 ${name}`, exact: true}).click();
  await expect(page.locator(".psm-viewport")).toHaveAttribute("data-transition-state", "idle");
  await index.locator("summary").click();
  await expect.poll(fullyVisible).toBe(true);
}
async function choose(page: Page, id: string) {
  // The narrow dock shares height with the map. Use public close/location
  // controls instead of relying on native scrolling of transformed cards.
  if ((page.viewportSize()?.width ?? 1920) < 600 && await card(page).count()
    && await card(page).getAttribute("data-feedback-node") !== id) {
    await card(page).getByRole("button", { name: "收起图上意见", exact: true }).click();
    await expect(card(page)).toHaveCount(0);
  }
  const node = page.locator(`.psm-card[data-node-id="${id}"]`);
  const opinion = page.locator(`.psm-card[data-node-id="${id}"] + .psm-opinion`);
  if (!await opinion.isVisible()) await page.getByLabel("地图信息层级").selectOption("detail");
  await locateOnMap(page, id);
  await node.hover();
  await expect(opinion).toHaveCSS("opacity", "1");
  await expect(opinion).toHaveCSS("pointer-events", "auto");
  await expect(opinion).toBeVisible(); await opinion.click(); await expect(card(page)).toBeVisible();
}
const originResult = (page: Page) => card(page).getByLabel("原位置成果", { exact: true });
async function expandSubmission(page: Page, item: EngineeringFeedback) {
  await choose(page, item.target.node_id);
  const toggle = card(page).locator(`[data-feedback-id="${item.id}"] .gfc-record-title`);
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function auditFeedbackImpactGeometry(page: Page) {
  await expect(page.locator("path[data-feedback-impact]")).toHaveCount(1);
  const audit = await page.locator(".psm-tree").evaluate(tree => {
    type Point = { x: number; y: number };
    type Segment = { id: string; kind: string; stroke: number; nodes: string[]; a: Point; b: Point };
    const shown = (element: Element) => { const style = getComputedStyle(element); return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > .01; };
    const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)));
    const segments = (path: SVGPathElement, id: string, kind: string): Segment[] => {
      const points = [...(path.getAttribute("d") ?? "").matchAll(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
      const matrix = path.getScreenCTM(); if (!matrix) return [];
      const screen = points.map(point => { const value = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: value.x, y: value.y }; });
      const stroke = Number.parseFloat(getComputedStyle(path).strokeWidth) || 1;
      const nodes = [path.dataset.from, path.dataset.to].filter((value): value is string => Boolean(value));
      return screen.slice(1).flatMap((b, index) => Math.abs(screen[index]!.x - b.x) < .05 || Math.abs(screen[index]!.y - b.y) < .05 ? [{ id, kind, stroke, nodes, a: screen[index]!, b }] : []);
    };
    const feedbackPaths = [...tree.querySelectorAll<SVGPathElement>("path[data-feedback-impact]")].filter(shown);
    const feedbackSegments = feedbackPaths.flatMap(path => segments(path, `feedback:${path.dataset.feedbackImpact}`, "feedback"));
    const otherSegments = [
      ...[...tree.querySelectorAll<SVGPathElement>("path[data-composition-segment]")].filter(shown).flatMap(path => segments(path, path.dataset.compositionSegment!, "composition")),
      ...[...tree.querySelectorAll<SVGPathElement>("path[data-map-dependency]")].filter(shown).flatMap(path => segments(path, path.dataset.mapDependency!, "dependency"))
    ];
    const boundaries = [
      ...tree.querySelectorAll<HTMLElement>(".psm-agent-zone"),
      ...[...tree.querySelectorAll<HTMLElement>(".psm-branch-group")].filter(group => !group.classList.contains("is-zone-root"))
    ].filter(shown).map((element, index) => ({ id: element.dataset.agentZone ?? element.dataset.groupNodeId ?? `boundary:${index}`, rect: element.getBoundingClientRect() }));
    const obstacles = [...tree.querySelectorAll<HTMLElement>(".psm-card")].filter(shown).map(element => ({ id: element.dataset.nodeId!, card: true, rect: element.getBoundingClientRect() }));
    const violations: string[] = [];
    for (const line of feedbackSegments) {
      const vertical = Math.abs(line.a.x - line.b.x) < .05;
      for (const obstacle of obstacles) {
        if (line.nodes.includes(obstacle.id)) continue;
        const inset = obstacle.card ? 4 : .5;
        const crosses = vertical
          ? line.a.x > obstacle.rect.left + inset && line.a.x < obstacle.rect.right - inset && overlap(line.a.y, line.b.y, obstacle.rect.top + inset, obstacle.rect.bottom - inset) > 1
          : line.a.y > obstacle.rect.top + inset && line.a.y < obstacle.rect.bottom - inset && overlap(line.a.x, line.b.x, obstacle.rect.left + inset, obstacle.rect.right - inset) > 1;
        if (crosses) violations.push(`${line.id}:crosses:${obstacle.id}`);
      }
      for (const boundary of boundaries) {
        const projected = vertical ? overlap(line.a.y, line.b.y, boundary.rect.top, boundary.rect.bottom) : overlap(line.a.x, line.b.x, boundary.rect.left, boundary.rect.right);
        const distance = vertical ? Math.min(Math.abs(line.a.x - boundary.rect.left), Math.abs(line.a.x - boundary.rect.right)) : Math.min(Math.abs(line.a.y - boundary.rect.top), Math.abs(line.a.y - boundary.rect.bottom));
        if (projected > 16 && distance < 8 - .05) violations.push(`${line.id}:follows:${boundary.id}:${distance.toFixed(1)}px`);
      }
      for (const other of otherSegments) {
        const otherVertical = Math.abs(other.a.x - other.b.x) < .05; if (vertical !== otherVertical) continue;
        const projected = vertical ? overlap(line.a.y, line.b.y, other.a.y, other.b.y) : overlap(line.a.x, line.b.x, other.a.x, other.b.x);
        const distance = vertical ? Math.abs(line.a.x - other.a.x) : Math.abs(line.a.y - other.a.y);
        const required = Math.max(6, (line.stroke + other.stroke) / 2 + 2);
        if (projected > 16 && distance < required - .05) violations.push(`${line.id}:parallels:${other.id}:${distance.toFixed(1)}px`);
      }
    }
    const markerIds = new Set([...tree.querySelectorAll<SVGMarkerElement>('marker[data-feedback-marker="true"]')].map(marker => marker.id));
    const missingMarkerReferences = feedbackPaths.filter(path => { const id = path.getAttribute("marker-end")?.match(/^url\(#(.+)\)$/)?.[1]; return !id || !markerIds.has(id); }).map(path => path.dataset.feedbackImpact!);
    return { feedbackPathCount: feedbackPaths.length, feedbackSegmentCount: feedbackSegments.length, violations: [...new Set(violations)], missingMarkerReferences };
  });
  expect(audit.feedbackPathCount).toBe(1); expect(audit.feedbackSegmentCount).toBeGreaterThan(0);
  expect(audit.violations).toEqual([]); expect(audit.missingMarkerReferences).toEqual([]);
}

async function stableObservedConnection(page: Page) {
  // Reuse workflow-canvas's persistent synthetic EventSource. A finite SSE
  // body closes immediately and correctly makes the product display offline.
  await page.addInitScript(() => {
    const streams: Array<{ onmessage: ((event: { data: string }) => void) | null; onopen: (() => void) | null; onerror: (() => void) | null }> = [];
    (window as any).__feedbackStreams = streams;
    (window as any).EventSource = class {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      constructor() { streams.push(this); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    };
  });
}

test("read the exact submitted report at the opinion without opening a new page", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page), { item, run } = submittedResult(fixture);
  const report = "# 因子质量报告\n\n结果：新增了样本外比较，结论仍需你查收。\n\n<script>window.invalidReportScript=true</script>\n<img src='https://invalid.example/report.png'>\n\n" + "报告说明：只在当前节点内补齐质量说明，保留原始意见。\n".repeat(35);
  const path = "reports/factor-quality.md", hash = createHash("sha256").update(report).digest("hex");
  Object.assign(run.evidence[0], { path, sha256: hash }); fixture.setArtifact(run.id, path, report);
  const before = JSON.stringify(fixture.document), outsideRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("invalid.example")) outsideRequests.push(request.url()); });
  await open(page); await expandSubmission(page, item);
  const result = originResult(page), reader = result.getByRole("region", { name: "成果原文", exact: true });
  await expect(result.getByRole("button", { name: "打开成果", exact: true })).toBeVisible();
  expect(fixture.artifactRequests).toHaveLength(0);
  await result.getByRole("button", { name: "打开成果", exact: true }).click();
  await expect(reader).toHaveAttribute("data-run-id", run.id);
  await expect(reader.getByLabel("报告内容", { exact: true })).toHaveText(report);
  await expect(reader.locator("script,img,iframe")).toHaveCount(0);
  expect(outsideRequests).toEqual([]); expect(page.context().pages()).toHaveLength(1);
  // StrictMode may issue a cancelled first mount; every read must have the same exact scope.
  expect(fixture.artifactRequests.length).toBeGreaterThan(0); expect(fixture.artifactRequests.length).toBeLessThanOrEqual(2);
  for (const request of fixture.artifactRequests) expect(request).toEqual({ runId: run.id, path, workspace: "host", workspaceHeader: "host" });
  expect(await reader.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await reader.getByLabel("报告内容", { exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
  await expect(reader.getByRole("button", { name: "收起报告", exact: true })).toBeInViewport();
  expect(await reader.getByLabel("报告内容", { exact: true }).evaluate(element => {
    const content = element.getBoundingClientRect(), dock = element.closest(".psm-context")!.getBoundingClientRect();
    return Math.min(content.bottom, dock.bottom, innerHeight) - Math.max(content.top, dock.top, 0);
  })).toBeGreaterThanOrEqual(110);
  await page.screenshot({ path: info.outputPath("report-at-original-opinion.png") });
  await reader.getByRole("button", { name: "收起报告", exact: true }).click();
  await expect(reader).toHaveCount(0);
  await expect(result.getByRole("button", { name: "打开成果", exact: true })).toBeFocused();
  await expect(result.getByRole("button", { name: "打开成果", exact: true })).toBeInViewport();
  fixture.setArtifact(run.id, path, "这是核对后被替换的文件，不能显示旧结论。");
  await result.getByRole("button", { name: "打开成果", exact: true }).click();
  await expect(reader.getByRole("alert")).toBeVisible();
  await expect(reader.getByLabel("报告内容", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("changed-file-refused.png") });
  fixture.setArtifact(run.id, path, report);
  await reader.getByRole("button", { name: "重试读取", exact: true }).click();
  await expect(reader.getByLabel("报告内容", { exact: true })).toHaveText(report);
  await reader.press("Escape"); await expect(reader).toHaveCount(0);
  await expect(result.getByRole("button", { name: "打开成果", exact: true })).toBeFocused();
  await expect(result.getByRole("button", { name: "打开成果", exact: true })).toBeInViewport();
  expectReadOnly(fixture, before);
});

test("working feedback shows its exact executor, stops and waits for an explicit result submission", async ({ page }, info) => {
  await stableObservedConnection(page);
  const fixture = await isolatedWorkspace(page), { item, run } = workingFeedback(fixture);
  const original = JSON.stringify(fixture.document);
  await open(page); await expandSubmission(page, item);
  const execution = card(page).getByRole("region", { name: "这条意见的处理", exact: true });
  await expect(execution).toHaveAttribute("data-run-id", run.id);
  await expect(execution).toHaveAttribute("data-execution-state", "running");
  await expect(execution).toContainText("补齐因子质量报告");
  await expect(execution.locator("header strong")).toHaveAttribute("title", run.actor);
  await expect(execution.locator("header strong")).toContainText("Codex");
  await expect(card(page).locator(".gfc-record-title small")).toHaveText("正在处理");
  expect(fixture.resultRequests).toHaveLength(0);
  expectReadOnly(fixture, original);
  await execution.locator("header").evaluate(e => e.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: info.outputPath("working-at-opinion.png") });

  run.status = "paused"; run.reason = "等待补充样本范围，已保留当前报告。";
  const paused = JSON.stringify(fixture.document);
  await page.reload(); await expandSubmission(page, item);
  await expect(execution).toHaveAttribute("data-execution-state", "stopped");
  await expect(execution).toContainText(run.reason);
  await expect(card(page).locator(".gfc-record-title small")).toHaveText("已暂停");
  expectReadOnly(fixture, paused);
  await execution.locator("header").evaluate(e => e.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: info.outputPath("paused-at-opinion.png") });

  run.status = "running"; run.reason = "";
  fixture.observe({ source: "local-engineering-service", captured_at: new Date().toISOString(), runs: { [run.id]: { state: "stale", last_observed_at: "2026-09-06T12:00:00Z", message: "最后执行观察已过期。" } } });
  await page.reload(); await expandSubmission(page, item);
  await expect(execution).toHaveAttribute("data-execution-state", "unknown");
  await expect(execution).toContainText("最后执行观察已过期。");
  await expect(card(page).locator(".gfc-record-title small")).toHaveText("活动待确认");

  run.status = "review"; run.current_action = ""; run.finished_at = "2026-09-06T12:10:00Z";
  run.evidence = [{ id: "quality-report", criterion_id: "alpha-manual", kind: "artifact", path: "reports/alpha-result.html", sha256: "a".repeat(64), summary: "隔离质量报告", passed: null, created_at: run.finished_at }];
  await page.reload(); await expandSubmission(page, item);
  await expect(execution).toHaveAttribute("data-execution-state", "waiting");
  await expect(execution).toContainText("等待关联提交");
  expect(fixture.resultRequests).toHaveLength(0);
  await expect(card(page).getByRole("link", { name: "打开成果", exact: true })).toHaveCount(0);

  item.status = "review"; item.submitted_run_id = run.id;
  item.history.push({ at: run.finished_at, action: "submit", actor: "隔离场景", note: "明确关联本轮质量报告", run_id: run.id });
  const submitted = JSON.stringify(fixture.document);
  await page.reload(); await expandSubmission(page, item);
  await expect(execution).toHaveAttribute("data-execution-state", "submitted");
  await expect(originResult(page).getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", new RegExp(`/runs/${run.id}/artifact`));
  expect(requestedRuns(fixture)).toEqual([run.id]);
  expectReadOnly(fixture, submitted);
  await originResult(page).locator("header").evaluate(e => e.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: info.outputPath("submitted-at-opinion.png") });
});

test("explicit working link keeps the existing endpoint rejection and exact run selection", async ({ page }) => {
  await stableObservedConnection(page);
  const fixture = await isolatedWorkspace(page), { item, run } = workingFeedback(fixture, false);
  fixture.handle("reject");
  const before = JSON.stringify(fixture.document);
  await open(page); await expandSubmission(page, item);
  await card(page).getByRole("button", { name: "完整处理记录", exact: true }).click();
  const panel = page.locator(".uw-feedback-records .pni-feedback");
  await panel.getByRole("combobox", { name: "本次处理运行", exact: true }).selectOption(run.id);
  await panel.getByRole("textbox", { name: "本次处理说明", exact: true }).fill("这次运行正在补充本条质量报告。");
  await expect(panel.getByRole("button", { name: "关联交付，提交复核", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "关联正在处理的运行", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("尚无本次操作的认证");
  await expect(panel.getByRole("textbox", { name: "本次处理说明", exact: true })).toHaveValue("这次运行正在补充本条质量报告。");
  expect(JSON.stringify(fixture.document)).toBe(before);
  expect(fixture.handlingRequests).toEqual([{ expected_revision: fixture.document.revision, action: "working", note: "这次运行正在补充本条质量报告。", run_id: run.id }]);
  expect(fixture.forbidden).toEqual([]);

  // Change only the isolated endpoint's response. No real approval is produced.
  fixture.handle("accept");
  await panel.getByRole("button", { name: "关联正在处理的运行", exact: true }).click();
  await expect(panel).toContainText("处理记录已更新");
  expect(item.status).toBe("working");
  expect(item.history.at(-1)).toMatchObject({ action: "working", run_id: run.id });
  expect(item.submitted_run_id).toBeUndefined();
  expect(run.status).toBe("running");
  expect(fixture.handlingRequests).toHaveLength(2);
  expect(fixture.requests).toEqual([]); expect(fixture.forbidden).toEqual([]);
});

test("diagram first, precise opinion saving and draft-safe switching", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page); await open(page);
  const alpha = page.locator('.psm-card[data-node-id="alpha"]');
  await expect(alpha.locator('[data-node-purpose="alpha"]')).toHaveText("交付可直接使用并逐项核对的任务成果。");
  await expect(alpha).not.toContainText("待完善");
  await expect(alpha.locator(".psm-card-footer")).toHaveCount(0);
  expect(await alpha.evaluate(node => (node as HTMLElement).offsetHeight)).toBe(120);
  if (info.project.name === "graph-feedback-phone") await page.getByLabel("地图信息层级").selectOption("detail");
  const opinion = page.getByRole("button", { name: "提意见 因子发现", exact: true });
  await expect(opinion).toHaveCSS("opacity", "0");
  await alpha.hover(); await expect(opinion).toHaveCSS("opacity", "1");
  await expect(page.locator(".psm-toolbar")).toContainText("虚线：未展开节点的交接");
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator(".uw-project-detail")).toBeHidden();
  await expect(page.locator(".project-node-inspector")).toHaveCount(0);
  await expect(page.locator(".pni-feedback")).toHaveCount(0);
  await choose(page, "alpha");
  const draft = card(page).getByRole("textbox");
  await draft.fill("这部分结果不太对，帮我检查一下原因。");
  const nodeIndex = page.locator(".psm-node-index");
  if (info.project.name === "graph-feedback-phone") {
    // The node index reaches another branch without requiring it to fit beside the draft.
    await nodeIndex.locator("summary").click();
    await nodeIndex.getByRole("button", { name: "定位 策略验证", exact: true }).click();
  } else await page.locator('.psm-card[data-node-id="beta"]').click();
  await expect(page.getByRole("dialog", { name: "当前方案尚未保存" })).toBeVisible();
  await page.getByRole("button", { name: "返回继续编辑", exact: true }).click();
  await expect(draft).toHaveValue("这部分结果不太对，帮我检查一下原因。");
  await expect(card(page)).toHaveAttribute("data-feedback-node", "alpha");
  if (info.project.name === "graph-feedback-phone") await nodeIndex.locator("summary").click();
  await card(page).getByRole("button", { name: "保存这条意见", exact: true }).click();
  await expect(card(page).getByRole("status")).toContainText("尚未派发给 Agent");
  expect(fixture.requests).toHaveLength(1); expect(fixture.requests[0]).toMatchObject({ target: { kind: "node", node_id: "alpha" }, note: "这部分结果不太对，帮我检查一下原因。" });
  await expect(draft).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "继续提意见", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("saved-opinion.png"), fullPage: false });
  await choose(page, "beta"); await choose(page, "alpha");
  await expect(card(page).getByRole("button", { name: /这部分结果不太对/ })).toBeVisible();
  await page.reload(); await choose(page, "alpha");
  await expect(card(page).getByRole("button", { name: /这部分结果不太对/ })).toBeVisible();
  expect(fixture.forbidden).toEqual([]);
});

test("opinion dock preserves the readable graph and a cancelled region switch preserves the draft", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page); await open(page);
  const baseline = JSON.stringify(fixture.document);
  await choose(page, "alpha");
  const canvas = page.locator(".psm-viewport"), dock = page.getByLabel("图上所选内容", { exact: true });
  const scale = Number(await canvas.getAttribute("data-camera-scale"));
  expect(scale).toBeGreaterThanOrEqual(.85);
  const audit = async () => {
    await expect(canvas).toHaveAttribute("data-transition-state", "idle");
    const map = (await canvas.boundingBox())!, panel = (await dock.boundingBox())!;
    expect(await canvas.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
    const selected = (await page.locator('.psm-card[data-node-id="alpha"]').boundingBox())!;
    expect(Math.min(map.x + map.width, panel.x + panel.width) <= Math.max(map.x, panel.x) + 1
      || Math.min(map.y + map.height, panel.y + panel.height) <= Math.max(map.y, panel.y) + 1).toBe(true);
    expect(selected.x).toBeGreaterThanOrEqual(map.x - 1);
    expect(selected.y).toBeGreaterThanOrEqual(map.y - 1);
    expect(selected.x + selected.width).toBeLessThanOrEqual(map.x + map.width + 1);
    expect(selected.y + selected.height).toBeLessThanOrEqual(map.y + map.height + 1);
    expect(Number(await canvas.getAttribute("data-camera-scale"))).toBeCloseTo(scale, 3);
  };
  await audit();
  const draft = card(page).getByRole("textbox"); await draft.fill("这里需要保留我刚写下的意见。");
  await page.locator(".psm-agent-zone-label").filter({ hasText: "因子发现" }).click();
  await expect(page.getByRole("dialog", { name: "当前方案尚未保存" })).toBeVisible();
  await page.getByRole("button", { name: "返回继续编辑", exact: true }).click();
  await expect(draft).toHaveValue("这里需要保留我刚写下的意见。");
  await page.setViewportSize(info.project.name.includes("phone") ? { width: 390, height: 700 } : { width: 1366, height: 768 });
  await audit();
  await page.screenshot({ path: info.outputPath("readable-graph-and-opinion.png"), fullPage: false });
  expect(JSON.stringify(fixture.document)).toBe(baseline);
  expect(fixture.requests).toEqual([]); expect(fixture.forbidden).toEqual([]);
});

test("failed save keeps the original note and closing requires explicit discard", async ({ page }) => {
  const fixture = await isolatedWorkspace(page); await open(page); await choose(page, "alpha");
  await card(page).getByRole("textbox").fill("这两处概念容易混淆，请重新解释。");
  fixture.fail(); await card(page).getByRole("button", { name: "保存这条意见", exact: true }).click();
  await expect(card(page).getByRole("alert")).toContainText("你的意见仍保留");
  await expect(card(page).getByRole("textbox")).toHaveValue("这两处概念容易混淆，请重新解释。");
  expect(fixture.document.feedbacks ?? []).toHaveLength(0);
  await card(page).getByRole("button", { name: "收起图上意见", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "当前方案尚未保存" })).toBeVisible();
  await page.getByRole("button", { name: "返回继续编辑", exact: true }).click();
  await card(page).getByRole("button", { name: "保存这条意见", exact: true }).click();
  await expect(card(page).getByRole("status")).toContainText("意见已保存");
  await card(page).getByRole("button", { name: "收起图上意见", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  expect(fixture.document.feedbacks).toHaveLength(1); expect(fixture.forbidden).toEqual([]);
});

test("range opinion stays one record and each member leads back to its own node", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page);
  const group = fixture.create({ expected_revision: 1, base_node_revision: 1, target: { kind: "node", node_id: "root" }, scope_node_ids: ["alpha", "beta"], kind: "requirement_change", note: "这两块的职责有重复，帮我重新划分。" });
  await open(page); await choose(page, "alpha");
  await expect(card(page).locator(".gfc-records article")).toHaveCount(1);
  await card(page).getByRole("button", { name: /这两块的职责有重复/ }).click();
  await expect(card(page)).toHaveAttribute("data-feedback-node", "root");
  await expect(card(page).getByRole("heading", { name: "2 个部分一起讨论" })).toBeVisible();
  const members = card(page).locator(".gfc-scope-progress");
  await expect(members.getByRole("button")).toHaveCount(2);
  await members.getByRole("button", { name: /策略验证/ }).click();
  await expect(card(page)).toHaveAttribute("data-feedback-node", "beta");
  await expect(page.locator('.psm-card[data-node-id="beta"]')).toHaveClass(/is-selected/);
  await expect(card(page).locator(`[data-feedback-id="${group.scope_feedback_ids![1]}"] .gfc-record-detail`)).toBeVisible();
  await page.screenshot({ path: info.outputPath("range-member.png"), fullPage: false });
  await card(page).getByRole("button", { name: "完整处理记录", exact: true }).click();
  await expect(page.locator(".uw-feedback-records")).toBeVisible();
  await expect(page.locator(`.uw-feedback-records [data-feedback-id="${group.scope_feedback_ids![1]}"] .pni-feedback-title`)).toHaveAttribute("aria-expanded", "true");
  expect(fixture.requests).toHaveLength(0); expect(fixture.forbidden).toEqual([]);
});

test("selecting two graph parts saves one opinion with the exact range", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page); await open(page);
  await setMapTools(page, true);
  await page.getByRole("button", { name: "框选范围", exact: true }).click();
  await setMapTools(page, false);
  await page.locator('.psm-card[data-node-id="alpha"]').click();
  await locateOnMap(page, "beta");
  await page.locator('.psm-card[data-node-id="beta"]').click();
  await expect(page.locator('.psm-card[data-node-id="alpha"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.psm-card[data-node-id="beta"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "对所选范围提意见", exact: true }).click();
  await expect(card(page).getByRole("heading", { name: "2 个部分一起讨论" })).toBeVisible();
  await card(page).getByRole("button", { name: "提出改进", exact: true }).click();
  await card(page).getByRole("textbox").fill("请把这两部分的交接关系表达清楚。");
  await card(page).getByRole("button", { name: "保存这条意见", exact: true }).click();
  await expect(card(page).getByRole("status")).toContainText("尚未派发给 Agent");
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]).toMatchObject({ target: { kind: "node", node_id: "root" }, kind: "requirement_change", scope_node_ids: ["alpha", "beta"] });
  expect(fixture.document.feedbacks).toHaveLength(3);
  await expect(card(page).locator(".gfc-records article")).toHaveCount(1);
  await expect(card(page).locator(".gfc-scope-progress button")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("range-opinion-saved.png"), fullPage: false });
  expect(fixture.forbidden).toEqual([]);
});

test("search opens the exact older opinion even beyond the first four records", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page);
  const add = (note: string) => fixture.create({ expected_revision: fixture.document.revision, base_node_revision: 1, target: { kind: "node", node_id: "alpha" }, kind: "defect", note });
  const wanted = add("回测区间需要明确说明。");
  for (let i = 0; i < 5; i++) add(`另一个已经保存的意见 ${i + 1}`);
  await open(page);
  await setMapTools(page, true);
  await page.getByRole("textbox", { name: "搜索成果或反馈" }).fill("回测区间");
  await page.locator(".psm-match-strip").getByRole("button", { name: "因子发现", exact: true }).click();
  await setMapTools(page, false);
  const selected = card(page).locator(`[data-feedback-id="${wanted.id}"]`);
  await expect(selected.locator(".gfc-record-title")).toHaveAttribute("aria-expanded", "true");
  await expect(selected.locator(".gfc-record-detail")).toBeVisible();
  await expect(card(page).locator("article").first()).toHaveAttribute("data-feedback-id", wanted.id);
  await page.screenshot({ path: info.outputPath("exact-opinion-search.png"), fullPage: false });
  expect(fixture.requests).toHaveLength(0); expect(fixture.forbidden).toEqual([]);
});

test("changed closure appears in graph attention and card without rewriting its history", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page);
  const item = fixture.create({ expected_revision: 1, base_node_revision: 1, target: { kind: "node", node_id: "alpha" }, kind: "requirement_change", note: "确认因子发现的成果边界。" });
  item.status = "resolved"; item.resolution_kind = "plan";
  item.history.push({ ...item.history[0], action: "resolve", note: "隔离测试的旧版处理结论" });
  fixture.document.nodes[1].objective = "当前成果范围已调整，需要重新核对原结论。";
  const before = JSON.stringify(fixture.document);
  await open(page);
  await setMapTools(page, true);
  const attention = page.locator(".psm-filters").getByRole("button", { name: /需处理/ });
  await expect(attention).toContainText("1"); await attention.click();
  await page.locator(".psm-match-strip").getByRole("button", { name: "因子发现", exact: true }).click();
  await setMapTools(page, false);
  const selected = card(page).locator(`[data-feedback-id="${item.id}"]`);
  await expect(selected).toHaveAttribute("data-feedback-status", "resolved");
  await expect(selected.locator(".gfc-record-title small")).toHaveText("需复核");
  await expect(selected.locator(".gfc-record-detail")).toContainText("历史处理结论保留");
  await page.screenshot({ path: info.outputPath("stale-closure-attention.png"), fullPage: false });
  expect(JSON.stringify(fixture.document)).toBe(before);
  expect(fixture.requests).toHaveLength(0); expect(fixture.forbidden).toEqual([]);
});

test("closed feedback keeps one current interpretation in graph and full records", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page);
  const item = fixture.create({ expected_revision: 1, base_node_revision: 1, target: { kind: "node", node_id: "alpha" }, kind: "defect", note: "核对这项成果是否符合原约定。" });
  const run = inspectorRun(fixture.document, "alpha", "accepted");
  run.started_at = "2026-09-06T12:02:00Z"; run.finished_at = "2026-09-06T12:03:00Z"; run.reviewed_at = "2026-09-06T12:04:00Z";
  fixture.document.runs.push(run);
  const basis = { document_revision: fixture.document.revision, node_revision: 1,
    contract_key: engineeringContractKey(fixture.document, "alpha"), lineage: engineeringLineageVersions(fixture.document, "alpha"),
    run_id: run.id, target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(fixture.document.nodes[1], item.target)) };
  Object.assign(item, { status: "resolved", resolution_kind: "delivery", submitted_run_id: run.id, adopted_lineage: basis.lineage, updated_at: "2026-09-06T12:05:00Z" });
  // Pre-existing isolated records only. The browser is not allowed to execute
  // adoption, reopening, approval or any other feedback mutation in this test.
  item.history.push(
    { at: "2026-09-06T12:01:00Z", action: "adopt", actor: "隔离样例", note: "样例历史：按原约定修订" },
    { at: run.started_at, action: "working", actor: "隔离样例", note: "样例历史：关联实际运行记录", run_id: run.id },
    { at: run.finished_at!, action: "submit", actor: "隔离样例", note: "样例历史：新交付提交复核", run_id: run.id },
    { at: item.updated_at, action: "resolve", actor: "隔离样例", note: "样例历史：原版本复核依据已保存", run_id: run.id, basis }
  );
  EngineeringFeedbackSchema.parse(item);
  expect(engineeringFeedbackClosureCurrent(fixture.document, item)).toBe(true);
  const history = structuredClone(item.history), currentBefore = JSON.stringify(fixture.document);
  await open(page); await expandSubmission(page, item);
  const graphRecord = card(page).locator(`[data-feedback-id="${item.id}"]`);
  await expect(graphRecord.locator(".gfc-record-title small")).toHaveText("已关闭");
  await graphRecord.locator(".gfc-record-title").evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.screenshot({ path: info.outputPath("current-graph-record.png"), fullPage: false });
  await graphRecord.getByRole("button", { name: "完整处理记录", exact: true }).click();
  const panel = page.locator(".uw-feedback-records .pni-feedback"), record = panel.locator(`[data-feedback-id="${item.id}"]`);
  await expect(record.locator(".pni-feedback-title")).toHaveAttribute("aria-expanded", "true");
  await expect(panel.locator("summary")).toContainText("0 项待闭环");
  await expect(record.locator(".pni-feedback-title span")).toHaveText("已关闭");
  await expect(record.locator(".pni-helper").first()).toHaveText("已有复核依据；可打开记录查看。");
  await record.screenshot({ path: info.outputPath("current-full-record.png") });
  expectReadOnly(fixture, currentBefore);

  // Publish changed fixture data through the same intercepted read endpoint.
  // The stored resolved state and history remain untouched.
  fixture.document.nodes[1].objective = "当前成果范围已调整，需要重新核对原结论。";
  fixture.document.nodes[1].revision++; fixture.document.revision++;
  expect(engineeringFeedbackClosureCurrent(fixture.document, item)).toBe(false);
  const changedBefore = JSON.stringify(fixture.document);
  await page.reload(); await expandSubmission(page, item);
  await expect(graphRecord).toHaveAttribute("data-feedback-status", "resolved");
  await expect(graphRecord.locator(".gfc-record-title small")).toHaveText("需复核");
  const detail = await graphRecord.locator(".gfc-record-state").innerText();
  await graphRecord.locator(".gfc-record-title").evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.screenshot({ path: info.outputPath("changed-graph-record.png"), fullPage: false });
  await graphRecord.getByRole("button", { name: "完整处理记录", exact: true }).click();
  await expect(record.locator(".pni-feedback-title")).toHaveAttribute("aria-expanded", "true");
  await expect(panel.locator("summary")).toContainText("1 项待闭环");
  await expect(record.locator(".pni-feedback-title span")).toHaveText("需复核");
  await expect(record.locator(".pni-feedback-title span")).toHaveAttribute("title", detail);
  await expect(record.locator(".pni-helper").first()).toHaveText(detail);
  await expect(record.locator(".pni-feedback-history li")).toHaveCount(history.length);
  for (const entry of history) await expect(record.locator(".pni-feedback-history")).toContainText(entry.note);
  await expect(record.getByRole("button", { name: "重新打开问题", exact: true })).toBeDisabled();
  await expect(record.getByRole("button", { name: "采用这条反馈", exact: true })).toHaveCount(0);
  await expect(record.getByRole("button", { name: "确认本条已解决", exact: true })).toHaveCount(0);
  await record.screenshot({ path: info.outputPath("changed-full-record.png") });
  expect(item.status).toBe("resolved"); expect(item.history).toEqual(history);
  expectReadOnly(fixture, changedBefore);
});

test("recorded changes, exact impact and real artifacts return to the opinion location", async ({ page }, info) => {
  const fixture = await isolatedWorkspace(page);
  const item = fixture.create({ expected_revision: 1, base_node_revision: 1, target: { kind: "node", node_id: "alpha" }, kind: "defect", note: "因子结果缺少质量说明，请补齐。" });
  const index = fixture.document.nodes.findIndex(node => node.id === "alpha"), before = structuredClone(fixture.document.nodes[index]);
  const after = { ...structuredClone(before), revision: before.revision + 1, objective: "交付包含质量说明的因子结果" };
  fixture.document.nodes[index] = after;
  fixture.document.changes.push({ id: "change-quality", at: fixture.document.updated_at, node_id: "alpha", reason: "补齐因子质量说明", before, after: structuredClone(after), affected_ids: ["alpha", "beta"] });
  const run = inspectorRun(fixture.document, "alpha", "review");
  run.evidence.push({ id: "factor-report", criterion_id: "alpha-manual", kind: "artifact", summary: "因子质量报告", path: "reports/factor-quality.html", sha256: "a".repeat(64), passed: null, created_at: fixture.document.updated_at });
  fixture.document.runs.push(run); fixture.document.nodes[index].status = "review"; fixture.document.revision++;
  Object.assign(item, { status: "review", adopted_change_id: "change-quality", submitted_run_id: run.id });
  item.history.push({ at: fixture.document.updated_at, action: "submit", actor: "隔离测试", note: "实际交付已关联，等待查看", run_id: run.id });
  fixture.setResult(run.id, { hold: true });
  const beforeRead = JSON.stringify(fixture.document);

  await open(page); await choose(page, "alpha");
  expect(fixture.resultRequests).toEqual([]);
  await card(page).getByRole("button", { name: /因子结果缺少质量说明/ }).click();
  await expect(originResult(page)).toContainText("正在核对本次结果…");
  await expect(originResult(page).getByRole("link")).toHaveCount(0);
  await expect.poll(() => fixture.pendingResults.length).toBeGreaterThan(0);
  for (const pending of fixture.pendingResults.splice(0)) await pending.release();
  await expect(originResult(page).locator("header strong")).toHaveText("待查收");
  await expect(page.locator('.psm-card[data-node-id="alpha"]')).toHaveClass(/is-feedback-origin/);
  await expect(page.locator('.psm-card[data-node-id="beta"]')).toHaveClass(/is-feedback-impact/);
  await expect(page.locator('[data-feedback-impact="beta"]')).toHaveCount(1);
  const feedbackMarker = page.locator('marker[data-feedback-marker="true"]');
  await expect(feedbackMarker).toHaveAttribute("markerUnits", "userSpaceOnUse");
  await expect(feedbackMarker).toHaveAttribute("markerWidth", "7"); await expect(feedbackMarker).toHaveAttribute("markerHeight", "7");
  await auditFeedbackImpactGeometry(page);
  await expect(page.getByLabel("这条意见在图上的处理结果")).toContainText("记录影响 2 项");
  const record = card(page).locator(`[data-feedback-id="${item.id}"]`);
  await expect(record.locator(".gfc-loop")).toContainText("改动已标图");
  await expect(record.locator(".gfc-change header small")).toContainText("补齐因子质量说明");
  await record.getByText("查看前后", { exact: true }).click();
  await expect(record.locator(".gfc-before-after")).toContainText(before.objective);
  await expect(record.locator(".gfc-before-after")).toContainText(after.objective);
  await expect(record.getByRole("link", { name: /打开成果/ })).toHaveAttribute("href", /factor-quality\.html/);
  if (info.project.name === "graph-feedback-desktop") await page.setViewportSize({ width: 1920, height: 1200 });
  await originResult(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("change-impact-result-at-origin.png"), fullPage: false });
  expect(requestedRuns(fixture)).toEqual([run.id]);
  expectReadOnly(fixture, beforeRead);
});

for (const problem of ["missing", "changed", "missing-review"] as const) {
  test(`recorded acceptance with ${problem} needs attention at the opinion location`, async ({ page }) => {
    const fixture = await isolatedWorkspace(page), { item, run } = submittedResult(fixture, "alpha", "accepted");
    if (problem === "missing-review") run.reviewed_at = null;
    const response = fixture.result(run.id);
    if (problem !== "missing-review") Object.assign(response.artifacts[0], { status: problem, actual_sha256: problem === "missing" ? null : "b".repeat(64) });
    fixture.setResult(run.id, { json: response });
    const before = JSON.stringify(fixture.document);
    await open(page); await expandSubmission(page, item);
    const result = originResult(page);
    await expect(result.locator("header strong")).toHaveText("需要处理");
    await expect(result.getByText("已验收", { exact: true })).toHaveCount(0);
    await result.getByText(/^需核对 \d+ 处$/).click();
    await expect(result).toContainText(problem === "missing" ? "文件缺失" : problem === "changed" ? "内容已变化" : "缺少有效的人工复核时间");
    if (problem === "missing") await expect(result.getByRole("link")).toHaveCount(0);
    else {
      const link = result.getByRole("link", { name: problem === "changed" ? "查看现有文件 · 内容已变化" : "打开成果", exact: true });
      await expect(link).toHaveAttribute("href", new RegExp(`/runs/${run.id}/artifact\\?.*alpha-result\\.html`));
    }
    expect(requestedRuns(fixture)).toEqual([run.id]);
    expectReadOnly(fixture, before);
  });
}

test("a failed result read hides unverified links and refresh recovers without writes", async ({ page }) => {
  const fixture = await isolatedWorkspace(page), { item, run } = submittedResult(fixture);
  fixture.setResult(run.id, { status: 503, json: { error: "隔离结果读取暂不可用" } });
  const before = JSON.stringify(fixture.document);
  await open(page); await expandSubmission(page, item);
  const result = originResult(page);
  await expect(result.locator("header strong")).toHaveText("成果暂未核对");
  await expect(result.getByRole("alert")).toContainText("暂时无法核对这次结果");
  await expect(result.getByRole("link")).toHaveCount(0);
  const readsBeforeRefresh = fixture.resultRequests.length;
  fixture.setResult(run.id, {});
  await result.getByRole("button", { name: "刷新核对", exact: true }).click();
  await expect(result.locator("header strong")).toHaveText("待查收");
  await expect(result.getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /alpha-result\.html/);
  expect(fixture.resultRequests.length).toBeGreaterThan(readsBeforeRefresh);
  expect(requestedRuns(fixture)).toEqual([run.id]);
  expectReadOnly(fixture, before);
});

test("result responses must match every workspace, run, node and frozen contract identity field", async ({ page }) => {
  const fixture = await isolatedWorkspace(page), { item, run } = submittedResult(fixture);
  const before = JSON.stringify(fixture.document);
  const foreign: Partial<EngineeringRunResult>[] = [
    { workspace_id: "foreign-workspace" }, { run_id: "foreign-run" }, { node_id: "beta" },
    { contract_key: "foreign-contract" }, { node_revision: run.snapshot.node.revision + 1 }
  ];
  fixture.setResult(run.id, { json: fixture.result(run.id, foreign[0]) });
  await open(page); await expandSubmission(page, item);
  const result = originResult(page);
  for (let index = 0; index < foreign.length; index++) {
    if (index) {
      fixture.setResult(run.id, { json: fixture.result(run.id, foreign[index]) });
      await result.getByRole("button", { name: "刷新核对", exact: true }).click();
    }
    await expect(result.getByRole("alert")).toBeVisible();
    await expect(result.locator("header strong")).toHaveText("成果暂未核对");
    await expect(result.getByRole("link")).toHaveCount(0);
    fixture.setResult(run.id, {});
    await result.getByRole("button", { name: "刷新核对", exact: true }).click();
    await expect(result.locator("header strong")).toHaveText("待查收");
    await expect(result.getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /alpha-result\.html/);
  }
  expect(fixture.resultRequests.length).toBeGreaterThanOrEqual(foreign.length * 2);
  expect(requestedRuns(fixture)).toEqual([run.id]);
  expectReadOnly(fixture, before);
});

test("a submitted run from another node cannot be replaced with that node's latest result", async ({ page }) => {
  const fixture = await isolatedWorkspace(page), alpha = submittedResult(fixture), beta = submittedResult(fixture, "beta");
  alpha.item.submitted_run_id = beta.run.id;
  const before = JSON.stringify(fixture.document);
  await open(page); await expandSubmission(page, alpha.item);
  await expect(originResult(page)).toContainText("原交付记录已变化");
  await expect(originResult(page).getByRole("link")).toHaveCount(0);
  expect(fixture.resultRequests).toEqual([]);
  expectReadOnly(fixture, before);
});

for (const changedContract of [false, true]) {
  test(`historical submitted results stay historical with ${changedContract ? "changed" : "unchanged"} contract`, async ({ page }) => {
    const fixture = await isolatedWorkspace(page), { item, run } = submittedResult(fixture, "alpha", "accepted");
    if (changedContract) fixture.document.nodes.find(node => node.id === "alpha")!.revision++;
    const latest = inspectorRun(fixture.document, "alpha", "accepted");
    fixture.document.runs.push(latest);
    const before = JSON.stringify(fixture.document);
    await open(page); await expandSubmission(page, item);
    const result = originResult(page);
    await expect(result.locator("header strong")).toHaveText("历史交付 · 不代表当前完成");
    await expect(result).toHaveAttribute("data-run-id", run.id);
    await expect(result.getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", new RegExp(`/runs/${run.id}/artifact\\?`));
    expect(requestedRuns(fixture)).toEqual([run.id]);
    expectReadOnly(fixture, before);
  });
}

test("delayed results cannot replace another selection or reappear after refresh and close", async ({ page }) => {
  // Deliberately ignore cancellation so this exercises response identity, not just AbortController.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return originalFetch(input, /\/api\/engineering\/runs\/[^/]+\/result(?:\?|$)/.test(url) ? { ...init, signal: undefined } : init);
    };
  });
  const fixture = await isolatedWorkspace(page), alpha = submittedResult(fixture), beta = submittedResult(fixture, "beta");
  const withPath = (path: string) => {
    const value = fixture.result(alpha.run.id); value.artifacts[0].path = `reports/${path}.html`; return value;
  };
  fixture.setResult(alpha.run.id, { hold: true, json: withPath("late-first-alpha") });
  const before = JSON.stringify(fixture.document);
  await open(page); await expandSubmission(page, alpha.item);
  await expect(originResult(page)).toContainText("正在核对本次结果…");
  await expect.poll(() => fixture.pendingResults.length).toBeGreaterThan(0);
  await expandSubmission(page, beta.item);
  await expect(originResult(page).getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /beta-result\.html/);
  fixture.setResult(alpha.run.id, { json: withPath("fresh-alpha") });
  await expandSubmission(page, alpha.item);
  await expect(originResult(page).getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /fresh-alpha\.html/);
  // StrictMode may replay the initial read. Release every old response after A-B-A is complete.
  for (const initial of fixture.pendingResults.splice(0)) {
    const waitInitial = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/runs/${alpha.run.id}/result`));
    await initial.release(); await waitInitial;
  }
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(originResult(page).getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /fresh-alpha\.html/);

  fixture.setResult(alpha.run.id, { hold: true, json: withPath("late-refreshed-alpha") });
  await originResult(page).getByRole("button", { name: "刷新核对", exact: true }).click();
  await expect(originResult(page)).toContainText("正在核对本次结果…");
  await expect(originResult(page).getByRole("link")).toHaveCount(0);
  await expect.poll(() => fixture.pendingResults.length).toBeGreaterThan(0);
  await card(page).getByRole("button", { name: "收起图上意见", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await expandSubmission(page, beta.item);
  await expect(originResult(page).getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /beta-result\.html/);
  for (const refreshed of fixture.pendingResults.splice(0)) {
    const waitRefreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/runs/${alpha.run.id}/result`));
    await refreshed.release(); await waitRefreshed;
  }
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(originResult(page)).toHaveAttribute("data-run-id", beta.run.id);
  await expect(originResult(page).getByRole("link", { name: "打开成果", exact: true })).toHaveAttribute("href", /beta-result\.html/);
  await expect(originResult(page).locator('a[href*="late-"]')).toHaveCount(0);
  expectReadOnly(fixture, before);
});
