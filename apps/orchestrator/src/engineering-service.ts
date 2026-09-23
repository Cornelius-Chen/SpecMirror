import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  EngineeringNodeSchema, EngineeringCompositionSchema, currentEngineeringRun, deriveEngineeringView, effectiveEngineeringConstraints, engineeringDeliveryIssues,
  engineeringContractKey, engineeringDescendants, engineeringLineage, engineeringNodesConflict,
  engineeringPathViolation, previewEngineeringChange, validateEngineeringDocument,
  engineeringDirectPrerequisites, engineeringEffectivePrerequisites, engineeringLineageVersions,
  engineeringCompositionCoverage, engineeringCompositionIssues, engineeringFrozenDeliveryInputs, prepareEngineeringNodeRevision, engineeringNodeContractRevision, engineeringChangeClassification,
  EngineeringFeedbackCreateSchema, EngineeringFeedbackUpdateSchema, engineeringFeedbackTargetExists, engineeringFeedbackTargetValue,
  engineeringFeedbackScopeValid, engineeringFeedbackScopeSnapshot, engineeringFeedbackGroupStatus,
  deriveEngineeringCollaborationPlan, effectiveEngineeringAgentOwner,
  type EngineeringAction, type EngineeringCriterion, type EngineeringDocument, type EngineeringEvidence,
  type EngineeringNode, type EngineeringRun, type EngineeringSnapshot, type EngineeringHandoffPacket,
  type EngineeringView, type EngineeringFeedback, type EngineeringFeedbackCreate, type EngineeringFeedbackUpdate,
  type EngineeringAgentAssignment, type EngineeringCollaborationConflict, type EngineeringCollaborationHandoff, type EngineeringCollaborationZone
} from "@epm/domain";
import { loadEngineering, saveEngineering, RuntimeStore } from "@epm/spec-io";
import type { EventBus } from "./events.ts";
import { createEngineeringJervisBridge, type EngineeringJervisBridge } from "./engineering-jervis.ts";
import { readCompanionStatus, type CompanionSession } from "./codex-companion.ts";
import { isRecentAgentSession } from "./agent-session-presence.ts";
import { captureEngineeringSourceBaseline, freezeEngineeringSourceScope, verifyEngineeringSourceProof } from "./engineering-source-proof.ts";
import { planEngineeringSourceIntegration } from "./engineering-source-integration.ts";
import type { EngineeringRunUsageObserver } from "./codex-run-metrics.ts";
export { ENGINEERING_AGENT_FRESHNESS_MS } from "./agent-session-presence.ts";

const ACTIVE = new Set(["queued", "running"]);
const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identifier = (prefix: string) => prefix + "-" + randomUUID();
export class EngineeringServiceError extends Error {
  constructor(readonly code: string, message = code, readonly status = 409) { super(message); }
}
function fail(code: string, message = code, status = 409): never { throw new EngineeringServiceError(code, message, status); }
function sourceRootsOverlap(left: string, right: string) {
  const within = (a: string, b: string) => { const value = relative(a, b); return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(".." + sep)); };
  return within(left, right) || within(right, left);
}

/** One scheduler per host; output paths are local to a workspace, resources are shared. */
export class EngineeringHostScheduler {
  readonly services = new Set<EngineeringExecutionService>();
  readonly maxParallel = 3;
  stats() {
    const runs = [...this.services].flatMap(service => loadEngineering(service.root).runs);
    const active = new Set([...runs.filter(run => run.status === "running").map(run => run.id), ...[...this.services].flatMap(service => service.activeSourceCheckIds())]);
    return { max_parallel: this.maxParallel, active: active.size, queued: runs.filter(run => run.status === "queued").length };
  }
  permits(service: EngineeringExecutionService, resources: string[], sourceRoot?: string) {
    return this.blockers(service, resources, sourceRoot).length === 0;
  }
  blockers(service: EngineeringExecutionService, resources: string[], sourceRoot?: string) {
    const blockers: string[] = [];
    if (this.stats().active >= this.maxParallel) blockers.push("全部任务共用的 3 个执行位置已占满，释放后继续。");
    for (const other of this.services) {
      if (sourceRoot) for (const reservation of other.sourceReservations()) {
        if (sourceRootsOverlap(sourceRoot, reservation.root)) blockers.push("等待“" + reservation.title + "”" + (reservation.stopping ? "实际结束已取消的检查" : reservation.review ? "完成源目录的人工验收" : "完成源目录修改与验收") + "；同一或嵌套源目录不能并行归因。");
      }
      if (other === service) continue;
      for (const run of loadEngineering(other.root).runs.filter(run => run.status === "running")) {
        const shared = run.snapshot.effective.resources.filter(resource => resources.includes(resource));
        if (shared.length) blockers.push("等待“" + run.snapshot.node.title + "”释放共享资源：" + shared.join("、") + "。");
      }
    }
    return blockers;
  }
  wake() { for (const service of this.services) service.schedule(); }
}

export interface EngineeringServiceOptions {
  scheduler?: EngineeringHostScheduler;
  workspaceId?: string;
  authorizeIdentity?: (sessionId: string, cwd: string) => false | "current" | "stale";
  /** Discovery eligibility for human owner assignment, never execution authority. */
  candidateOwnerIdentity?: (sessionId: string, cwd: string) => false | "current" | "stale";
  agentSessions?: () => CompanionSession[];
  agentObservations?: () => CompanionSession[];
  approvedSourceRoots?: () => readonly string[];
  usageObserver?: EngineeringRunUsageObserver;
}

export interface EngineeringZoneHandoffPacket {
  schema_version: 1;
  workspace_id: string;
  scope_root_id: string;
  zone: EngineeringCollaborationZone;
  nodes: EngineeringNode[];
  node_assignments: Record<string, EngineeringAgentAssignment>;
  handoffs: EngineeringCollaborationHandoff[];
  conflicts: EngineeringCollaborationConflict[];
  runs: EngineeringHandoffPacket[];
  contract_key: string;
  claimable: boolean;
  blocked_reason: string;
}

export interface EngineeringZoneClaimResult {
  zone_id: string;
  claimed_run_ids: string[];
  view: EngineeringView;
}

export interface EngineeringWorkPackageRequest {
  root_id: string;
  expected_revision: number;
  composition: NonNullable<EngineeringNode["composition"]>;
  assignments: Array<{ node_id: string; owner: string }>;
  reason: string;
}

export interface EngineeringWorkPackagePreview {
  root_id: string;
  expected_revision: number;
  nodes: Array<Pick<EngineeringNode, "id" | "title" | "owner" | "source_scope">>;
  affected_ids: string[];
  ready_node_ids: string[];
  manifest_digest: string;
  creates_runs: false;
}

export interface EngineeringWorkPackageAudit {
  work_package_id: string;
  principal_id: string;
  approval_id: string;
  request_digest: string;
}

export interface EngineeringRecheckPackageRequest {
  expected_revision: number;
  reason: string;
  items: Array<{ node_id: string; prior_run_id: string; checks: Array<{ id: string; args: string[] }> }>;
}

export interface EngineeringRecheckPackagePreview {
  root_id: string;
  expected_revision: number;
  nodes: Array<{ id: string; title: string; owner: string; prior_run_id: string;
    checks: Array<{ id: string; title: string; before_args: string[]; args: string[]; timeout_ms: number;
      configuration?: EngineeringRecheckConfiguration }> }>;
  affected_ids: string[];
  ready_node_ids: string[];
  manifest_digest: string;
  creates_runs: false;
}

export interface EngineeringRecheckConfiguration { test_root: string; path: string; sha256: string }

export class EngineeringExecutionService {
  readonly runtime: RuntimeStore;
  readonly jervis: EngineeringJervisBridge;
  readonly jobs = new Map<string, Promise<void>>();
  readonly previews = new Set<string>();
  readonly maxParallel = 3;
  private scheduled = false;
  private closed = false;
  private closing?: Promise<void>;
  private readonly sourceChecks = new Map<string, { controller: AbortController; roots: string[]; title: string }>();

  constructor(readonly root: string, readonly events: EventBus, jervis?: EngineeringJervisBridge, readonly options: EngineeringServiceOptions = {}) {
    this.runtime = new RuntimeStore(root);
    this.jervis = jervis ?? createEngineeringJervisBridge(root);
    const doc = loadEngineering(root);
    const interrupted = doc.runs.filter((run) => run.status === "running");
    if (interrupted.length) {
      for (const run of interrupted) {
        run.status = "paused"; run.reason = "服务重启，执行已暂停；保留快照和产物供检查后重新派发。";
        this.node(doc, run.node_id).status = "paused";
        this.releaseRunLocks(run.id);
      }
      this.save(doc, "execution", doc.root_id, "恢复了中断运行，等待明确重新派发。");
    }
    options.scheduler?.services.add(this);
    this.kick();
  }

  view() {
    const view = deriveEngineeringView(loadEngineering(this.root), this.maxParallel);
    // Group status is a projection of independent member evidence, never a separate approval.
    for (const feedback of view.document.feedbacks ?? []) if (feedback.scope_node_ids) feedback.status = engineeringFeedbackGroupStatus(view.document, feedback);
    if (this.options.scheduler) {
      view.scheduler = this.options.scheduler.stats();
      for (const run of view.document.runs.filter(run => run.status === "queued")) {
        const roots = this.sourceScopes(run).map(scope => scope.root);
        for (const root of roots.length ? roots : [undefined]) view.derived[run.node_id]?.blockers.push(...this.options.scheduler.blockers(this, run.snapshot.effective.resources, root));
      }
    }
    return this.observe(view);
  }
  private observe(view: EngineeringView): EngineeringView {
    const sessions = this.options.agentObservations?.() ?? [];
    view.observation = { captured_at: now(), source: "local-engineering-service", runs: {} };
    for (const run of view.document.runs) {
      if (run.mode !== "external") {
        const at = view.document.events.filter(event => event.run_id === run.id).at(-1)?.at ?? run.finished_at ?? run.started_at;
        view.observation.runs[run.id] = { state: "local", last_observed_at: at, message: "本机运行记录；不代表外部 Codex 活动。" };
        continue;
      }
      const session = sessions.find(item => "codex:" + item.session_id === run.handoff?.owner);
      let matching = false;
      try { matching = !!session && !!run.handoff && relative(this.realPath(session.cwd), this.realPath(run.handoff.source_cwd)) === ""; } catch { /* Missing source paths are not live observations. */ }
      const fresh = matching && isRecentAgentSession(session!.last_seen_at);
      view.observation.runs[run.id] = {
        state: !matching ? "unobserved" : fresh ? "current" : "stale", last_observed_at: matching ? session!.last_seen_at : null,
        message: !matching ? "未观察到对应来源的真实会话，活动状态待更新。" : fresh ? "最近有真实会话活动；是否执行以本次领取与运行记录为准。" : "近期没有真实会话活动，当前执行状态待更新。"
      };
    }
    return view;
  }
  async catalog() { return this.jervis.readCatalog(); }
  private approvedSourceRoots() { return this.options.approvedSourceRoots?.() ?? [this.root]; }
  private sourceScopes(run: EngineeringRun) { return run.source_scope ? [run.source_scope] : run.source_integration_scopes ?? []; }
  private hasSourceAudit(run: EngineeringRun) { return this.sourceScopes(run).length > 0; }
  private measureRunUsage(run: EngineeringRun, state: "measuring" | "observed" | "final") {
    if (run.mode !== "external" || run.handoff?.state !== "claimed") return;
    const sessionId = run.handoff.owner.startsWith("codex:") ? run.handoff.owner.slice("codex:".length) : "";
    const sample = this.options.usageObserver?.snapshot(sessionId);
    if (!sample) {
      return;
    }
    const baseline = run.metrics?.baseline ?? sample;
    const fields = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;
    if (fields.some(field => sample[field] < baseline[field])) return;
    run.metrics = {
      source: "codex_rollout", attribution: "assigned_task_window", state, baseline, latest: sample,
      token_usage: {
        input_tokens: sample.input_tokens - baseline.input_tokens,
        cached_input_tokens: sample.cached_input_tokens - baseline.cached_input_tokens,
        output_tokens: sample.output_tokens - baseline.output_tokens,
        reasoning_output_tokens: sample.reasoning_output_tokens - baseline.reasoning_output_tokens,
        total_tokens: sample.total_tokens - baseline.total_tokens
      }
    };
  }
  activeSourceCheckIds() { return [...this.sourceChecks.keys()]; }
  sourceReservations() {
    const doc = loadEngineering(this.root);
    const reservations = doc.runs.filter(run => this.hasSourceAudit(run) && ["running", "review"].includes(run.status)).flatMap(run => this.sourceScopes(run).map(scope => ({ runId: run.id, root: scope.root, title: run.snapshot.node.title, review: run.status === "review", stopping: false })));
    for (const [runId, check] of this.sourceChecks) if (!reservations.some(item => item.runId === runId)) reservations.push(...check.roots.map(root => ({ runId, root, title: check.title, review: false, stopping: true })));
    return reservations;
  }
  private releaseRunLocks(runId: string) {
    const pending = this.sourceChecks.get(runId);
    if (pending) { pending.controller.abort(); return; }
    this.runtime.releaseLocks(runId);
  }

  private externalOwner(doc: EngineeringDocument, node: EngineeringNode) {
    const owner = effectiveEngineeringAgentOwner(doc, node.id);
    if (!owner) fail("engineering_external_owner_required", "协作执行需要先在区域根选择真实 Codex 会话作为负责人；未分配区域不能接收任务。");
    const id = owner.slice("codex:".length);
    const session = (this.options.agentSessions?.() ?? readCompanionStatus(this.root, this.runtime).sessions).find(item => item.session_id === id);
    if (!session) fail("engineering_external_session_unknown", "负责人尚未被此工作区的真实 Hook 发现，请在对应 Codex 任务中连接后刷新会话。");
    if (!isRecentAgentSession(session.last_seen_at)) fail("engineering_external_session_stale", "负责人最近 30 分钟没有真实 Hook 活动。请在对应 Codex 任务中恢复连接后再交接；历史会话记录不代表当前在线。");
    this.authorizeAgent(id, session.cwd);
    return { owner, session };
  }

  private externalActor(doc: EngineeringDocument, run: EngineeringRun, actor?: string) {
    if (!actor?.startsWith("codex:")) fail("engineering_external_agent_required", "外部运行需要由真实负责人在 Codex 中领取和提交，界面不能代替 Agent 执行。", 403);
    if (actor !== run.actor || actor !== run.handoff?.owner) fail("engineering_agent_run_owner_mismatch", "只有本次冻结的真实负责人可以领取和提交。", 403);
    const { owner, session } = this.externalOwner(doc, this.node(doc, run.node_id));
    if (owner !== run.handoff?.owner) fail("engineering_agent_run_owner_mismatch", "区域负责人已经变化，本次冻结交接不能继续领取。", 403);
    if (relative(this.realPath(session.cwd), this.realPath(run.handoff.source_cwd)) !== "") fail("engineering_external_source_changed", "负责人当前工作目录与冻结交接包不同，请核对来源后重新交接。", 403);
  }

  private handoffPacket(doc: EngineeringDocument, run: EngineeringRun): EngineeringHandoffPacket {
    if (run.mode !== "external" || !run.handoff?.contract_key) fail("engineering_handoff_unavailable", "该历史运行没有可验证的外部交接包，请保留历史并重新准备交接。");
    const node = run.snapshot.node;
    return { schema_version:1, workspace_id:this.options.workspaceId ?? "host", node_id:node.id, run_id:run.id,
      source_cwd:run.handoff.source_cwd, owner:run.handoff.owner, document_revision:run.handoff.document_revision, node_revision:node.revision,
      contract_key:run.handoff.contract_key, objective:node.objective, method:node.method, architecture:node.architecture,
      constraints:structuredClone(run.snapshot.effective), actions:structuredClone(node.actions), criteria:structuredClone(node.criteria), capabilities:structuredClone(node.capabilities),
      handoff:structuredClone(run.handoff), current:currentEngineeringRun(doc,run.node_id)?.id === run.id && !["paused","blocked","stale","rejected"].includes(run.status),
      ...(run.source_scope ? {source_scope:structuredClone(run.source_scope)} : {}),
      ...(node.delivery ? {delivery:structuredClone(node.delivery)} : {}),
      ...(node.composition ? {composition:structuredClone(node.composition)} : {}),
      ...(node.contribution ? {contribution:structuredClone(node.contribution)} : {}),
      ...(node.prerequisites ? {prerequisites:structuredClone(node.prerequisites)} : {}),
      ...(node.interactions ? {interactions:structuredClone(node.interactions)} : {}),
      contract_revision: engineeringNodeContractRevision(node),
      contributes_to: structuredClone(node.contributes_to),
      ...(run.snapshot.context_lineage ? {context_lineage:structuredClone(run.snapshot.context_lineage)} : {}),
      ...(run.snapshot.delivery_inputs ? {delivery_inputs:structuredClone(run.snapshot.delivery_inputs)} : {}),
      ...(run.snapshot.delivery_lineage ? {delivery_lineage:structuredClone(run.snapshot.delivery_lineage)} : {}) };
  }

  handoff(runId: string): EngineeringHandoffPacket {
    const doc = loadEngineering(this.root), run = this.run(doc, runId);
    return this.handoffPacket(doc, run);
  }

  private collaborationZone(doc: EngineeringDocument, zoneId: string) {
    const match = /^zone:([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159})$/.exec(zoneId);
    if (!match) fail("engineering_zone_id_invalid", "协作区域标识无效。", 400);
    const rootNode = this.node(doc, match[1]!);
    const scopeRootId = rootNode.parent_id ?? rootNode.id;
    const plan = deriveEngineeringCollaborationPlan(doc, scopeRootId);
    const zone = plan.zones.find(item => item.id === zoneId);
    if (!zone) fail("engineering_zone_not_found", "没有找到这项协作区域。", 404);
    return { rootNode, scopeRootId, plan, zone };
  }

  private collaborationZoneOwner(rootNode: EngineeringNode, zone: EngineeringCollaborationZone) {
    const declared = /^codex:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(rootNode.owner) ? rootNode.owner : null;
    if (!declared) return { owner: null, code: "engineering_zone_owner_required", reason: "区域根尚未明确分配给真实 Codex 负责人。" };
    if (zone.owner_state === "mixed" || zone.available_leaf_ids.length || zone.effective_agent_owner !== declared) return { owner: null, code: "engineering_zone_owner_mixed", reason: "区域内存在其他或非 Agent 负责人，需拆分或重新分配后分别领取。" };
    return { owner: declared, code: "", reason: "" };
  }

  private zoneClaimContractKey(zone: EngineeringCollaborationZone, runs: EngineeringRun[]) {
    const members = runs.map(run => ({ id: run.id, contract_key: run.handoff?.contract_key ?? "" }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return sha256(JSON.stringify({ schema_version: 1, zone_contract_key: zone.contract_key, runs: members }));
  }

  zoneHandoff(zoneId: string): EngineeringZoneHandoffPacket {
    const doc = loadEngineering(this.root), { rootNode, scopeRootId, plan, zone } = this.collaborationZone(doc, zoneId);
    const ownership = this.collaborationZoneOwner(rootNode, zone);
    const nodeIds = new Set(zone.node_ids);
    const awaiting = doc.runs.filter(run => nodeIds.has(run.node_id) && run.mode === "external" && run.handoff?.state === "awaiting_claim"
      && currentEngineeringRun(doc, run.node_id)?.id === run.id).sort((left, right) => left.id.localeCompare(right.id));
    const runs = awaiting.map(run => this.handoffPacket(doc, run));
    const allRunsClaimable = awaiting.every(run => zone.claimable_run_ids.includes(run.id) && run.handoff?.contract_key === run.snapshot.contract_key);
    return {
      schema_version: 1,
      workspace_id: this.options.workspaceId ?? "host",
      scope_root_id: scopeRootId,
      zone: structuredClone(zone),
      nodes: doc.nodes.filter(node => nodeIds.has(node.id)).map(node => structuredClone(node)),
      node_assignments: Object.fromEntries(zone.node_ids.map(nodeId => [nodeId, structuredClone(plan.node_assignments[nodeId]!) ])),
      handoffs: plan.handoffs.filter(item => item.from_zone_id === zone.id || item.to_zone_id === zone.id).map(item => structuredClone(item)),
      conflicts: plan.conflicts.filter(item => item.left_zone_id === zone.id || item.right_zone_id === zone.id).map(item => structuredClone(item)),
      runs,
      contract_key: this.zoneClaimContractKey(zone, awaiting),
      claimable: Boolean(ownership.owner && runs.length && allRunsClaimable),
      blocked_reason: ownership.reason || (!runs.length ? "区域内没有当前等待领取的外部运行。" : !allRunsClaimable ? "区域内存在与当前节点合同不一致的交接，请重新派发后领取。" : "")
    };
  }

  claimZone(zoneId: string, input: { contract_key: string }, actor?: string): EngineeringZoneClaimResult {
    const doc = loadEngineering(this.root), { rootNode, zone } = this.collaborationZone(doc, zoneId);
    const ownership = this.collaborationZoneOwner(rootNode, zone);
    if (!ownership.owner) fail(ownership.code, ownership.reason, 409);
    if (!actor?.startsWith("codex:")) fail("engineering_external_agent_required", "协作区域需要由真实负责人在 Codex 中领取，界面不能代替 Agent 执行。", 403);
    if (actor !== ownership.owner) fail("engineering_agent_zone_owner_mismatch", "只有区域根明确分配的真实负责人可以领取整个区域。", 403);
    const zoneNodeIds = new Set(zone.node_ids);
    const runs = doc.runs.filter(run => zoneNodeIds.has(run.node_id) && run.mode === "external" && run.handoff?.state === "awaiting_claim"
      && currentEngineeringRun(doc, run.node_id)?.id === run.id).sort((left, right) => left.id.localeCompare(right.id));
    if (!runs.length) fail("engineering_zone_no_awaiting_claim", "区域内没有当前等待领取的外部运行。");
    if (input?.contract_key !== this.zoneClaimContractKey(zone, runs)) fail("engineering_zone_version_conflict", "区域交接包或待领取任务已变化，请重新读取当前区域后再领取。");
    // Validate every member before mutating any of them. One invalid handoff
    // rejects the whole claim, so a zone can never be half claimed.
    for (const run of runs) {
      if (!zone.claimable_run_ids.includes(run.id) || run.handoff?.contract_key !== run.snapshot.contract_key) fail("engineering_zone_run_contract_mismatch", "区域内存在与当前节点合同不一致的交接，请重新派发后领取。");
      if (!['queued', 'running'].includes(run.status)) fail("engineering_handoff_not_claimable", "区域内存在已结束、暂停或失效的运行，不能整区领取。");
      this.externalActor(doc, run, actor);
      this.assertCurrent(doc, run);
    }
    const claimedAt = now();
    for (const run of runs) {
      run.handoff!.state = "claimed";
      run.handoff!.claimed_at = claimedAt;
      run.handoff!.claimed_by = actor;
      run.reason = "区域负责人已真实领取，等待依赖与共享执行条件。";
    }
    const view = this.save(doc, "execution", rootNode.id, `区域负责人已领取 ${runs.length} 个冻结交接包；满足各自依赖与资源条件后开始。`);
    this.kick();
    return { zone_id: zone.id, claimed_run_ids: runs.map(run => run.id), view };
  }

  claim(runId: string, input: {contract_key: string}, actor?: string) {
    const doc = loadEngineering(this.root), run = this.run(doc, runId);
    if (run.mode !== "external" || !run.handoff?.contract_key) fail("engineering_handoff_unavailable", "此运行没有可领取的外部交接记录。");
    this.externalActor(doc, run, actor);
    if (input?.contract_key !== run.handoff.contract_key) fail("engineering_handoff_version_conflict", "交接包版本不一致，请重新读取当前冻结包。");
    this.assertCurrent(doc, run);
    if (!["queued","running"].includes(run.status)) fail("engineering_handoff_not_claimable", "本次运行已结束、暂停或失效，不能继续领取。");
    if (run.handoff.state === "claimed") return this.view();
    run.handoff.state = "claimed"; run.handoff.claimed_at = now(); run.handoff.claimed_by = actor;
    run.reason = "负责人已真实领取，等待依赖与共享执行条件。";
    this.save(doc,"execution",run.node_id,"负责人已领取冻结交接包；满足依赖与资源条件后开始。",undefined,run.id);
    this.kick();
    return this.view();
  }

  authorizeAgent(sessionId: string, cwd: string, target: { nodeId?: string; runId?: string; proposed?: EngineeringNode; humanOnly?: boolean } = {}) {
    if (this.options.authorizeIdentity) {
      const identity = sessionId && isAbsolute(cwd) ? this.options.authorizeIdentity(sessionId, cwd) : false;
      if (!identity) fail("engineering_agent_session_unknown", "会话未真实发现，或未关联当前任务工作区。", 403);
      if (identity === "stale") fail("engineering_external_session_stale", "负责人最近 30 分钟没有真实 Hook 活动。请在对应 Codex 任务中恢复连接后再交接；历史会话记录不代表当前在线。");
    } else {
      if (!sessionId || !isAbsolute(cwd) || !this.contained(this.realPath(this.root), this.realPath(cwd))) fail("engineering_agent_project_mismatch", "Agent 工作目录与宿主项目不一致。", 403);
      if (!readCompanionStatus(this.root, this.runtime).sessions.some((item) => item.session_id === sessionId)) fail("engineering_agent_session_unknown", "Agent 会话尚未被宿主发现。", 403);
    }
    if (target.humanOnly) fail("engineering_human_action_required", "该操作需要监督者在界面中确认。", 403);
    const actor = "codex:" + sessionId;
    const doc = loadEngineering(this.root);
    if (target.nodeId && effectiveEngineeringAgentOwner(doc, this.node(doc, target.nodeId).id) !== actor) fail("engineering_agent_owner_mismatch", "Agent 不拥有这项任务。", 403);
    if (target.runId && this.run(doc, target.runId).actor !== actor) fail("engineering_agent_run_owner_mismatch", "Agent 不拥有这次运行。", 403);
    if (target.proposed) {
      const previous = this.node(doc, target.proposed.id);
      if (target.proposed.owner !== previous.owner) fail("engineering_agent_owner_immutable", "Agent 不能自行分配新的执行者。", 403);
      if (previous.parent_id !== target.proposed.parent_id) fail("engineering_agent_parent_immutable", "Agent 不能自行移动任务的上级归属。", 403);
    }
    return actor;
  }

  createNode(input: { parent_id: string; title: string; kind?: string; expected_revision: number }, actor?: string) {
    const doc = this.revision(input.expected_revision);
    const parent = this.node(doc, input.parent_id);
    if (parent.status === "archived") fail("engineering_parent_archived");
    if (doc.runs.some((run) => run.node_id === parent.id && ACTIVE.has(run.status))) fail("engineering_parent_running");
    const node = EngineeringNodeSchema.parse({
      id: identifier("node"), parent_id: parent.id, title: input.title, kind: input.kind ?? (parent.kind === "project" ? "task" : "step"),
      objective: "", method: "", architecture: "", owner: actor ?? "未分配", order: doc.nodes.filter((item) => item.parent_id === parent.id).length,
      revision: 1, status: "draft", constraints: { allow: [], deny: [], rules: [], resources: [] },
      created_at: now(), updated_at: now()
    });
    doc.nodes.push(node);
    this.validate(doc);
    this.invalidate(doc, this.structuralImpact(doc, parent.id), "任务已细分，需要核对新的子项覆盖。");
    return this.save(doc, "plan", node.id, "已新增“" + node.title + "”，请定义结果、边界和验收。");
  }

  /** Commit one reviewed batch as drafts; no execution, assignment or acceptance is inferred. */
  appendDraftNodes(parentId: string, nodes: EngineeringNode[], expectedRevision: number, reason: string) {
    const doc = this.revision(expectedRevision), parent = this.node(doc, parentId);
    if (parent.status === "archived") fail("engineering_parent_archived");
    if (doc.runs.some(run => run.node_id === parentId && ACTIVE.has(run.status))) fail("engineering_parent_running");
    if (!reason?.trim()) fail("engineering_change_reason_required");
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 300) fail("engineering_draft_batch_invalid", "一次导入需要 1 至 300 项草稿。", 400);
    const additions = nodes.map(node => EngineeringNodeSchema.parse(node));
    const ids = new Set(additions.map(node => node.id));
    if (ids.size !== additions.length || doc.nodes.some(node => ids.has(node.id))) fail("engineering_draft_batch_id_conflict", "批量草稿必须使用全新的唯一任务编号。", 409);
    if (additions.some(node => node.status !== "draft" || node.owner !== "未分配" || node.revision !== 1 || node.legacy_ref)) fail("engineering_draft_batch_state_invalid", "导入内容只能是未分配、首个版本的计划草稿。", 400);
    if (additions.some(node => node.parent_id !== parentId && (!node.parent_id || !ids.has(node.parent_id)))) fail("engineering_draft_batch_parent_invalid", "草稿只能属于所选上级或本批次中的任务。", 400);
    doc.nodes.push(...structuredClone(additions));
    this.validate(doc);
    this.invalidate(doc, this.structuralImpact(doc, parentId), "详细计划已扩展，受影响的整合与依赖需要重新核对。");
    return this.save(doc, "plan", parentId, "已导入 " + additions.length + " 项未分配的详细计划草稿。", reason.trim());
  }

  /** A complete replacement is one reviewed transaction; existing identities remain historical. */
  previewDraftStructure(rootId: string, nodes: EngineeringNode[], rootPatch: EngineeringNode, expectedRevision: number) {
    return this.prepareDraftStructure(rootId, nodes, rootPatch, expectedRevision);
  }

  replaceDraftStructure(rootId: string, nodes: EngineeringNode[], rootPatch: EngineeringNode, expectedRevision: number, reason: string) {
    if (!reason?.trim()) fail("engineering_change_reason_required");
    const before = this.revision(expectedRevision);
    const prepared = this.prepareDraftStructure(rootId, nodes, rootPatch, expectedRevision), doc = prepared.document;
    for (const id of prepared.affected_ids) {
      const previous = before.nodes.find(node => node.id === id), next = doc.nodes.find(node => node.id === id);
      if (previous && next) doc.changes.push({ id: identifier("change"), at: now(), node_id: id, reason: reason.trim(), before: structuredClone(previous), after: structuredClone(next), affected_ids: prepared.affected_ids });
    }
    for (const runId of prepared.invalidated_run_ids) this.releaseRunLocks(runId);
    return this.save(doc, "change", rootId, "已应用成果结构草稿；原任务与证据保留历史，新结构需要分别执行和验收。", reason.trim());
  }

  private prepareDraftStructure(rootId: string, nodes: EngineeringNode[], rootPatch: EngineeringNode, expectedRevision: number) {
    const doc = this.revision(expectedRevision), root = this.node(doc, rootId);
    if (rootId !== doc.root_id || root.parent_id !== null) fail("engineering_restructure_root_required", "只能从整个工程的根节点重组。", 400);
    if (doc.runs.some(run => ACTIVE.has(run.status))) fail("engineering_restructure_active_runs", "请先结束或暂停排队、执行中的运行，再重组工程。");
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 300) fail("engineering_draft_batch_invalid", "一次重组需要 1 至 300 项成果草稿。", 400);
    const additions = nodes.map(node => EngineeringNodeSchema.parse(node)), ids = new Set(additions.map(node => node.id));
    if (ids.size !== additions.length || doc.nodes.some(node => ids.has(node.id))) fail("engineering_draft_batch_id_conflict", "新结构必须使用全新的任务身份，不能继承原节点的验收状态。", 409);
    if (additions.some(node => node.status !== "draft" || node.owner !== "未分配" || node.revision !== 1 || node.legacy_ref)) fail("engineering_draft_batch_state_invalid", "新结构只能包含未分配、首个版本的成果草稿。", 400);
    if (additions.some(node => node.parent_id !== rootId && (!node.parent_id || !ids.has(node.parent_id)))) fail("engineering_draft_batch_parent_invalid", "新成果必须属于工程根节点或本批次中的成果。", 400);
    const nextRoot = this.proposed(doc, rootId, rootPatch);
    if (nextRoot.owner !== root.owner || nextRoot.legacy_ref !== root.legacy_ref) fail("engineering_restructure_root_identity", "重组不能改变工程根节点的负责人或历史来源。", 400);
    if (JSON.stringify(nextRoot.constraints) !== JSON.stringify(root.constraints)) fail("engineering_restructure_root_constraints", "重组必须保留根节点原有的全部执行范围和约束；新成果可在各自范围内收窄。", 400);
    if (root.criteria.some(criterion => !nextRoot.criteria.some(item => item.id === criterion.id))) fail("engineering_restructure_root_criteria", "须保留根节点原有验收条件身份，以保留历史子项的目标关联。", 400);
    const affected = new Set([rootId, ...doc.nodes.filter(node => node.id !== rootId && node.status !== "archived").map(node => node.id)]);
    const invalidated = doc.runs.filter(run => affected.has(run.node_id) && run.status !== "stale").map(run => run.id), stamp = now();
    doc.nodes = doc.nodes.map(node => node.id === rootId ? nextRoot : affected.has(node.id) ? { ...node, status: "archived", revision: node.revision + 1, updated_at: stamp } : node);
    doc.nodes.push(...structuredClone(additions));
    for (const run of doc.runs) if (invalidated.includes(run.id)) {
      run.status = "stale"; run.current_action = ""; run.reason = "工程结构已按新的成果边界重组；原快照与证据仅保留历史，不构成新成果的验收。";
    }
    this.validate(doc);
    return { document: doc, affected_ids: [...affected], invalidated_run_ids: invalidated };
  }

  preview(nodeId: string, input: { node: EngineeringNode; expected_revision: number }) {
    const doc = this.revision(input.expected_revision);
    const proposed = this.proposed(doc, nodeId, input.node);
    this.validate({ ...doc, nodes: doc.nodes.map((item) => item.id === nodeId ? proposed : item) });
    const preview = previewEngineeringChange(doc, proposed);
    this.previews.add(this.previewKey(doc.revision, proposed));
    if (this.previews.size > 200) this.previews.delete(this.previews.values().next().value!);
    return preview;
  }

  updateNode(nodeId: string, input: { node: EngineeringNode; expected_revision: number; reason?: string }) {
    const doc = this.revision(input.expected_revision);
    const previous = this.node(doc, nodeId);
    const proposed = this.proposed(doc, nodeId, input.node);
    if (!this.previews.has(this.previewKey(doc.revision, proposed))) fail("engineering_change_preview_required", "请先预览当前版本的变更影响。");
    if (!input.reason?.trim()) fail("engineering_change_reason_required");
    const impact = previewEngineeringChange(doc, proposed);
    if (impact.classification === "none") fail("engineering_no_changes");
    doc.nodes = doc.nodes.map((item) => item.id === nodeId ? proposed : item);
    const reorder = (parentId: string | null, moved?: EngineeringNode) => {
      const siblings = doc.nodes.filter((item) => item.parent_id === parentId && item.id !== moved?.id).sort((left, right) => left.order - right.order);
      if (moved) siblings.splice(Math.min(moved.order, siblings.length), 0, moved);
      siblings.forEach((item, index) => { item.order = index; });
    };
    if (previous.parent_id !== proposed.parent_id) reorder(previous.parent_id);
    reorder(proposed.parent_id, proposed);
    this.validate(doc);
    if (impact.classification !== "presentation") this.invalidate(doc, impact.affected_ids, "方案版本已变化，原证据保留历史，需要重新执行或验收。");
    doc.changes.push({ id: identifier("change"), at: now(), node_id: nodeId, reason: input.reason.trim(), before: previous, after: proposed, affected_ids: impact.affected_ids });
    return this.save(doc, "change", nodeId, "已保存方案修订，受影响任务已明确标出。", input.reason.trim());
  }

  archive(nodeId: string, input: { expected_revision: number; reason?: string }) {
    const doc = this.revision(input.expected_revision);
    const node = this.node(doc, nodeId);
    if (node.id === doc.root_id) fail("engineering_cannot_archive_root");
    if (!input.reason?.trim()) fail("engineering_change_reason_required");
    if (engineeringDescendants(doc, nodeId).some((item) => item.status !== "archived")) fail("engineering_archive_has_children");
    if (doc.nodes.some((item) => item.status !== "archived" && (engineeringDirectPrerequisites(item).includes(nodeId) || item.interactions?.some(relation => relation.target_node_id === nodeId)))) fail("engineering_archive_has_dependents");
    if (doc.runs.some((run) => run.node_id === nodeId && ACTIVE.has(run.status))) fail("engineering_node_running");
    const before = structuredClone(node);
    node.status = "archived"; node.revision++; node.updated_at = now();
    const affected = this.structuralImpact(doc, nodeId);
    this.invalidate(doc, affected.filter((id) => id !== nodeId), "子项归档，整体验收需要重新核对。");
    doc.changes.push({ id: identifier("change"), at: now(), node_id: nodeId, reason: input.reason.trim(), before, after: structuredClone(node), affected_ids: affected });
    return this.save(doc, "change", nodeId, "任务已归档，原方案和运行历史保留。");
  }

  ready(nodeId: string, expectedRevision: number) {
    const doc = this.revision(expectedRevision);
    const node = this.node(doc, nodeId);
    if (node.status === "archived") fail("engineering_node_archived");
    if (doc.runs.some((run) => run.node_id === nodeId && ACTIVE.has(run.status))) fail("engineering_node_running");
    this.validatePlan(doc, node);
    node.status = "ready"; node.updated_at = now();
    const current = currentEngineeringRun(doc, nodeId);
    if (current && ["paused", "blocked", "rejected", "review"].includes(current.status)) { current.status = "stale"; this.releaseRunLocks(current.id); }
    return this.save(doc, "plan", nodeId, "执行方案已准备好，将使用确定版本的动作和约束。", undefined, undefined, engineeringContractKey(doc, nodeId));
  }

  /** One business transaction for a never-run work package. No dispatcher,
   * readiness endpoint, or intermediate save is called while preparing it. */
  previewWorkPackage(input: EngineeringWorkPackageRequest): EngineeringWorkPackagePreview {
    const prepared = this.workPackageCandidate(input);
    return {
      root_id: input.root_id, expected_revision: input.expected_revision,
      nodes: prepared.nodes.map(node => ({ id: node.id, title: node.title, owner: node.owner, ...(node.source_scope ? { source_scope: structuredClone(node.source_scope) } : {}) })),
      affected_ids: prepared.affectedIds, ready_node_ids: prepared.nodes.map(node => node.id), manifest_digest: prepared.manifestDigest, creates_runs: false
    };
  }

  /** The HTTP command must establish authenticatedHumanApproval before calling
   * this service method. actor records that verified principal, not a role claim. */
  commitWorkPackage(input: EngineeringWorkPackageRequest, audit: Readonly<EngineeringWorkPackageAudit>, expectedManifest: string): EngineeringView {
    if (!audit?.work_package_id?.trim() || !audit.principal_id?.trim() || !audit.approval_id?.trim() || !/^[a-f0-9]{64}$/.test(audit.request_digest)) fail("engineering_human_action_required", "开工包必须由已认证的人类确认。", 403);
    const actor = "human:" + audit.principal_id;
    // Rebuild and revalidate at commit time, including Hook freshness and cwd.
    const { doc, nodes, changes, affectedIds, manifestDigest } = this.workPackageCandidate(input);
    if (!/^[a-f0-9]{64}$/.test(expectedManifest) || expectedManifest !== manifestDigest) fail("engineering_work_package_manifest_changed", "工程内容、影响范围或负责人来源与预览不一致，请重新预览。", 409);
    const auditDetail = { actor, work_package_id: audit.work_package_id, approval_id: audit.approval_id, request_digest: audit.request_digest, manifest_digest: manifestDigest, pre_revision: doc.revision, post_revision: doc.revision + 1 };
    const stamp = now();
    for (const node of nodes) { node.status = "ready"; node.updated_at = stamp; }
    for (const change of changes) doc.changes.push({
      id: identifier("change"), at: stamp, node_id: change.before.id,
      reason: input.reason.trim(), before: change.before, after: structuredClone(this.node(doc, change.before.id)), affected_ids: affectedIds
    });
    // Compute readiness keys after every composition/owner update, so sibling
    // interactions cannot invalidate a member prepared earlier in the batch.
    for (const node of nodes) doc.events.push({
      id: identifier("event"), at: stamp, node_id: node.id, kind: "plan",
      message: "开工包已确认本项负责人和执行方案；尚未派发或开始运行。",
      detail: JSON.stringify({ ...auditDetail, work_package_root_id: input.root_id, owner: node.owner, reason: input.reason.trim() }),
      readiness_contract_key: engineeringContractKey(doc, node.id)
    });
    this.validate(doc);
    return this.save(doc, "plan", input.root_id, `已一次确认 ${nodes.length} 项开工准备；等待明确派发或领取。`, JSON.stringify({ ...auditDetail, reason: input.reason.trim(), node_ids: nodes.map(node => node.id), affected_ids: affectedIds, creates_runs: false }));
  }

  private workPackageCandidate(input: EngineeringWorkPackageRequest) {
    const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    const keysOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
    if (!record(input) || !keysOnly(input, ["root_id", "expected_revision", "composition", "assignments", "reason"])
      || typeof input.root_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(input.root_id)
      || !Number.isInteger(input.expected_revision) || input.expected_revision < 1
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 12000
      || !Array.isArray(input.assignments) || input.assignments.length < 1 || input.assignments.length > 20)
      fail("engineering_work_package_invalid", "开工包需要当前根节点、版本、组合说明、1 到 20 项负责人分配和原因。", 400);
    const parsed = EngineeringCompositionSchema.strict().safeParse(input.composition);
    if (!parsed.success || !parsed.data.summary || !parsed.data.scenario || !parsed.data.integration_criterion_ids.length)
      fail("engineering_work_package_composition_required", "请一次补齐组合说明、完整使用场景和父级整体验收条件。", 400);
    const assigned = new Set<string>();
    for (const assignment of input.assignments) {
      if (!record(assignment) || !keysOnly(assignment, ["node_id", "owner"])
        || typeof assignment.node_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(assignment.node_id)
        || typeof assignment.owner !== "string" || !/^codex:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(assignment.owner)
        || assigned.has(assignment.node_id)) fail("engineering_work_package_assignment_invalid", "每项必须明确且唯一地选择一个真实 Codex 负责人。", 400);
      assigned.add(assignment.node_id);
    }
    const doc = this.revision(input.expected_revision), originalDocumentDigest = sha256(JSON.stringify(doc)), root = this.node(doc, input.root_id);
    const descendants = engineeringDescendants(doc, root.id), subtree = new Set([root.id, ...descendants.map(node => node.id)]);
    if (!descendants.some(node => node.status !== "archived")) fail("engineering_work_package_children_required", "先在现有工程中保存子项，再准备开工。", 400);
    const allowedState = (node: EngineeringNode) => node.status === "draft" || node.status === "needs_revision";
    if (!allowedState(root)) fail("engineering_work_package_not_draft", "本命令只准备尚未运行的草稿工程。", 409);
    const affected = new Set(this.structuralImpact(doc, root.id));
    for (const id of assigned) {
      const node = this.node(doc, id);
      if (id === root.id || !subtree.has(id) || doc.nodes.some(child => child.parent_id === id && child.status !== "archived"))
        fail("engineering_work_package_leaf_required", "只能分配选中工程内部的现有末级子项，不能移动或新建节点。", 400);
      if (!allowedState(node)) fail("engineering_work_package_not_draft", "待分配项必须仍是草稿或待修订，不能替换已有就绪、运行或验收状态。", 409);
      for (const impacted of this.structuralImpact(doc, id)) affected.add(impacted);
    }
    for (const id of subtree) affected.add(id);
    if (doc.runs.some(run => affected.has(run.node_id))) fail("engineering_work_package_has_history", "选中范围或受影响节点已有运行历史；请使用逐项修订流程，开工包不会使历史结果失效。", 409);
    if (doc.nodes.some(node => affected.has(node.id) && node.status !== "archived" && !allowedState(node)))
      fail("engineering_work_package_affected_not_draft", "受影响范围包含已就绪或正在推进的节点，不能使用新工程开工包。", 409);
    const changes: Array<{ before: EngineeringNode }> = [];
    const replace = (current: EngineeringNode, value: EngineeringNode) => {
      if (engineeringChangeClassification(current, value) === "none") return current;
      const proposed = this.proposed(doc, current.id, value);
      for (const id of previewEngineeringChange(doc, proposed).affected_ids) affected.add(id);
      changes.push({ before: structuredClone(current) });
      doc.nodes = doc.nodes.map(node => node.id === current.id ? proposed : node);
      return proposed;
    };
    replace(root, { ...root, composition: parsed.data });
    const nodes = input.assignments.map(assignment => {
      const current = this.node(doc, assignment.node_id);
      return replace(current, { ...current, owner: assignment.owner });
    });
    // All proposed owners and the root composition exist together before the
    // same plan and source-scope checks used by ordinary ready/dispatch run.
    this.validate(doc);
    this.validatePlan(doc, this.node(doc, root.id));
    if (engineeringCompositionCoverage(doc, root.id).some(item => !item.covered)) fail("engineering_child_coverage_missing", "父级完成条件尚未由子项或本层整合完整承接。");
    const sources = nodes.map(node => {
      this.validatePlan(doc, node);
      const { owner, session } = this.workPackageOwner(doc, node);
      return { node_id: node.id, owner, source_cwd: this.realPath(session.cwd), source_scope: node.source_scope ? freezeEngineeringSourceScope(node.source_scope, this.approvedSourceRoots()) : null };
    });
    if (doc.runs.some(run => affected.has(run.node_id))) fail("engineering_work_package_has_history", "预览影响范围存在既有运行，不能批量改写。", 409);
    if (doc.nodes.some(node => affected.has(node.id) && node.status !== "archived" && !allowedState(node))) fail("engineering_work_package_affected_not_draft", "预览影响范围包含非草稿状态。", 409);
    const affectedIds = [...affected].sort();
    const manifestDigest = sha256(JSON.stringify({
      original_document_sha256: originalDocumentDigest, affected_ids: affectedIds, sources,
      contracts: affectedIds.map(id => {
        const { updated_at: _updated, ...node } = this.node(doc, id);
        return { node, effective: effectiveEngineeringConstraints(doc, id), contract_key: engineeringContractKey(doc, id) };
      })
    }));
    return { doc, nodes, changes, affectedIds, manifestDigest };
  }

  private workPackageOwner(doc: EngineeringDocument, node: EngineeringNode) {
    if (!this.options.candidateOwnerIdentity) return this.externalOwner(doc, node);
    const owner = effectiveEngineeringAgentOwner(doc, node.id);
    if (!owner) fail("engineering_external_owner_required", "请选择真实 Codex 负责人。");
    const session = (this.options.agentSessions?.() ?? []).find(item => "codex:" + item.session_id === owner);
    if (!session) fail("engineering_external_session_unknown", "候选负责人尚未被当前工作区的真实 Hook 发现。");
    const candidate = this.options.candidateOwnerIdentity(session.session_id, session.cwd);
    if (!candidate) fail("engineering_external_session_unknown", "候选负责人没有对应当前源目录的真实生命周期观察。", 403);
    if (candidate === "stale" || !isRecentAgentSession(session.last_seen_at)) fail("engineering_external_session_stale", "候选负责人近期没有真实 Hook 活动，请恢复连接后重新预览。");
    return { owner, session };
  }

  previewRecheckPackage(input: EngineeringRecheckPackageRequest): EngineeringRecheckPackagePreview {
    const prepared = this.recheckPackageCandidate(input);
    return { root_id: prepared.doc.root_id, expected_revision: input.expected_revision, nodes: prepared.members.map(member => ({
      id: member.node.id, title: member.node.title, owner: member.owner, prior_run_id: member.prior.id,
      checks: member.node.source_scope!.checks.map(check => ({ id: check.id, title: check.title,
        before_args: [...member.before.source_scope!.checks.find(item => item.id === check.id)!.args], args: [...check.args], timeout_ms: check.timeout_ms ?? 30_000,
        ...(member.configurations[check.id] ? { configuration: member.configurations[check.id] } : {}) }))
    })), affected_ids: prepared.affectedIds, ready_node_ids: prepared.members.map(member => member.node.id), manifest_digest: prepared.manifestDigest, creates_runs: false };
  }

  /** A new exact human confirmation repairs current check arguments. Historical
   * runs remain byte-for-byte data equivalents; no evidence is recertified. */
  commitRecheckPackage(input: EngineeringRecheckPackageRequest, audit: Readonly<EngineeringWorkPackageAudit>, expectedManifest: string): EngineeringView {
    if (!audit?.work_package_id?.trim() || !audit.principal_id?.trim() || !audit.approval_id?.trim() || !/^[a-f0-9]{64}$/.test(audit.request_digest))
      fail("engineering_human_action_required", "修正检查配置需要针对本次请求的已认证人类确认。", 403);
    const { doc, members, affectedIds, manifestDigest } = this.recheckPackageCandidate(input);
    if (!/^[a-f0-9]{64}$/.test(expectedManifest) || expectedManifest !== manifestDigest)
      fail("engineering_recheck_manifest_changed", "工程、历史运行、检查配置或负责人连接已变化，请重新预览。", 409);
    const stamp = now(), detail = { package_kind: "check_config_recheck", work_package_id: audit.work_package_id,
      actor: "human:" + audit.principal_id, approval_id: audit.approval_id, request_digest: audit.request_digest,
      manifest_digest: manifestDigest, pre_revision: doc.revision, post_revision: doc.revision + 1,
      reason: input.reason.trim(), creates_runs: false, preserves_prior_runs: true,
      attribution: "本轮仅修正检查配置并准备复验；原编码、用量与未通过的检查保留在原运行，不重计为本轮编码。" };
    for (const member of members) { member.node.status = "ready"; member.node.updated_at = stamp; }
    // Compute every readiness key after all mutually interacting members have
    // their final revisions. No intermediate save/invalidation/scheduler kick.
    for (const member of members) {
      doc.changes.push({ id: identifier("change"), at: stamp, node_id: member.node.id, reason: input.reason.trim(),
        before: member.before, after: structuredClone(member.node), affected_ids: affectedIds });
      doc.events.push({ id: identifier("event"), at: stamp, node_id: member.node.id, kind: "plan",
        message: "检查配置路径已修正，可由原负责人领取复验；旧运行与证据原样保留，尚未开始新运行。",
        readiness_contract_key: engineeringContractKey(doc, member.node.id),
        detail: JSON.stringify({ ...detail, prior_run_id: member.prior.id, prior_status: member.prior.status, owner: member.owner,
          checks: member.node.source_scope!.checks.map(check => ({ id: check.id, before_args: member.before.source_scope!.checks.find(item => item.id === check.id)!.args, args: check.args,
            ...(member.configurations[check.id] ? { configuration: member.configurations[check.id] } : {}) })) }) });
    }
    this.validate(doc);
    return this.save(doc, "plan", doc.root_id, `已一次确认 ${members.length} 项检查配置修正；等待原负责人领取复验。`,
      JSON.stringify({ ...detail, affected_ids: affectedIds, items: members.map(member => ({ node_id: member.node.id, prior_run_id: member.prior.id, prior_status: member.prior.status, owner: member.owner })) }));
  }

  private recheckPackageCandidate(input: EngineeringRecheckPackageRequest) {
    const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
    const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
    if (!record(input) || !only(input, ["expected_revision", "reason", "items"]) || !Number.isInteger(input.expected_revision) || input.expected_revision < 1
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 12000 || !Array.isArray(input.items) || !input.items.length || input.items.length > 20)
      fail("engineering_recheck_invalid", "请提供当前版本、修正原因和 1 至 20 项已有运行的检查配置修正。", 400);
    const selected = new Set<string>();
    for (const item of input.items) {
      if (!record(item) || !only(item, ["node_id", "prior_run_id", "checks"]) || !id(item.node_id) || !id(item.prior_run_id)
        || selected.has(item.node_id) || !Array.isArray(item.checks) || !item.checks.length || item.checks.length > 12)
        fail("engineering_recheck_item_invalid", "每项必须唯一对应一个现有节点、原运行及完整检查集合。", 400);
      selected.add(item.node_id);
      const checkIds = new Set<string>();
      for (const check of item.checks) {
        if (!record(check) || !only(check, ["id", "args"]) || !id(check.id) || checkIds.has(check.id) || !Array.isArray(check.args)
          || !check.args.length || check.args.length > 100 || check.args.some(arg => typeof arg !== "string" || arg.length > 16000 || arg.includes("\0")))
          fail("engineering_recheck_checks_invalid", "检查只能提交原检查编号和有界的参数数组，不能修改检查数量、程序或超时。", 400);
        checkIds.add(check.id);
      }
    }
    const doc = this.revision(input.expected_revision), originalDigest = sha256(JSON.stringify(doc));
    this.validate(doc);
    // Recheck is deliberately narrower than ordinary plan editing: independent
    // leaves only, never repair a dependency chain or invalidate accepted work.
    for (const node of doc.nodes.filter(node => node.status !== "archived")) {
      const dependencies = engineeringEffectivePrerequisites(doc, node.id);
      if (selected.has(node.id) ? dependencies.length : dependencies.some(dependency => selected.has(dependency)))
        fail("engineering_recheck_dependencies", "本次快捷复验只支持没有前后置依赖的独立末级任务；依赖链请逐项预览修订。", 409);
    }
    const affected = new Set<string>();
    const members = input.items.map(item => {
      const before = this.node(doc, item.node_id), prior = this.run(doc, item.prior_run_id);
      if (before.id === doc.root_id || doc.nodes.some(node => node.parent_id === before.id && node.status !== "archived") || !before.source_scope)
        fail("engineering_recheck_leaf_required", "只能修正已有源码合同的末级任务检查，不能调整总项或树结构。", 400);
      if (!["paused", "blocked"].includes(before.status) || !["paused", "blocked"].includes(prior.status) || prior.mode !== "external"
        || prior.node_id !== before.id || currentEngineeringRun(doc, before.id)?.id !== prior.id)
        fail("engineering_recheck_current_run_required", "节点及其当前外部运行必须已暂停或受阻；不能改写运行中、待审查、已验收或过期运行。", 409);
      if (doc.runs.some(run => run.node_id === before.id && ["running", "queued", "review"].includes(run.status)) || this.sourceChecks.has(prior.id))
        fail("engineering_recheck_still_active", "旧运行或源检查仍在活动，请等待其实际停止后再修正。", 409);
      if (engineeringLineage(doc, before.id).some(ancestor => ancestor.id !== before.id && ["paused", "archived"].includes(ancestor.status)))
        fail("engineering_recheck_ancestor_unavailable", "上级工程仍暂停或归档，请先按原流程处理。", 409);
      if (!["none", "presentation"].includes(engineeringChangeClassification(prior.snapshot.node, before)))
        fail("engineering_recheck_contract_changed", "当前任务的动作、条件、权限或交付已偏离原冻结版本，不能借检查路径修正一并确认。", 409);
      const frozenContext = (snapshot: EngineeringSnapshot) => ({
        contract_key: snapshot.contract_key, lineage: snapshot.lineage, effective: {
          resources: snapshot.effective.resources,
          allow_layers: snapshot.effective.allow_layers.map(({ title: _title, ...layer }) => layer),
          deny: snapshot.effective.deny.map(({ title: _title, ...rule }) => rule),
          rules: snapshot.effective.rules.map(({ title: _title, ...rule }) => rule)
        },
        context_lineage: (snapshot.context_lineage ?? []).map(({ title: _title, ...context }) => context),
        delivery_lineage: (snapshot.delivery_lineage ?? []).map(({ title: _title, ...delivery }) => delivery),
        delivery_inputs: snapshot.delivery_inputs ?? [], dependencies: snapshot.dependencies, children: snapshot.children
      });
      if (!isDeepStrictEqual(frozenContext(prior.snapshot), frozenContext(this.snapshot(doc, before.id))))
        fail("engineering_recheck_contract_changed", "上级目标、权限、交付关系或冻结上下文已变化，请正式修订方案，不能借检查路径修正一并确认。", 409);
      const { owner, session } = this.externalOwner(doc, before);
      if (prior.actor !== owner || prior.handoff?.owner !== owner || prior.handoff.state !== "claimed" || prior.handoff.claimed_by !== owner
        || prior.handoff.contract_key !== prior.snapshot.contract_key || prior.snapshot.node.owner !== before.owner
        || relative(this.realPath(prior.handoff.source_cwd), this.realPath(session.cwd)) !== "")
        fail("engineering_recheck_owner_changed", "只能由原运行已真实领取的同一负责人继续；不能换人或改变来源工程。", 403);
      const frozenBefore = freezeEngineeringSourceScope(before.source_scope, this.approvedSourceRoots());
      if (!prior.source_scope || !prior.snapshot.node.source_scope || frozenBefore.contract_sha256 !== prior.source_scope.contract_sha256
        || freezeEngineeringSourceScope(prior.source_scope, this.approvedSourceRoots()).contract_sha256 !== prior.source_scope.contract_sha256
        || freezeEngineeringSourceScope(prior.snapshot.node.source_scope, this.approvedSourceRoots()).contract_sha256 !== frozenBefore.contract_sha256)
        fail("engineering_recheck_frozen_scope_changed", "当前源码范围或检查集合与原冻结合同不一致，请使用正式方案修订。", 409);
      if (before.source_scope.checks.length !== item.checks.length || before.source_scope.checks.some(check => !item.checks.some(candidate => candidate.id === check.id)))
        fail("engineering_recheck_checks_changed", "复验必须保留原检查编号、数量和顺序，不能增加或删除检查。", 400);
      let changed = false;
      const configurations: Record<string, EngineeringRecheckConfiguration> = {};
      const checks = before.source_scope.checks.map(check => {
        const args = item.checks.find(candidate => candidate.id === check.id)!.args;
        if (JSON.stringify(check.args) === JSON.stringify(args)) return structuredClone(check);
        const config = check.args.indexOf("--config");
        if (config < 0 || config !== check.args.lastIndexOf("--config") || config + 1 >= check.args.length || args.length !== check.args.length
          || !args[config + 1].trim() || args[config + 1].startsWith("-") || args.some((arg, index) => index !== config + 1 && arg !== check.args[index]))
          fail("engineering_recheck_config_only", "本次只允许修正唯一 --config 后的配置路径；测试列表、Node 入口、--root、并发参数及其他内容须原样保留。", 400);
        changed = true;
        configurations[check.id] = this.recheckConfiguration(frozenBefore.root, check.args, args);
        return { ...structuredClone(check), args: [...args] };
      });
      if (!changed) fail("engineering_recheck_no_changes", "所选任务的检查配置没有实际变化。", 400);
      const node = this.proposed(doc, before.id, { ...before, source_scope: { ...before.source_scope, checks } });
      for (const affectedId of previewEngineeringChange(doc, node).affected_ids) affected.add(affectedId);
      return { before: structuredClone(before), node, prior, owner, sourceCwd: this.realPath(session.cwd), frozenBefore, configurations,
        frozenAfter: freezeEngineeringSourceScope(node.source_scope!, this.approvedSourceRoots()) };
    });
    for (const member of members) affected.add(member.node.id);
    for (const node of doc.nodes.filter(node => affected.has(node.id) && !selected.has(node.id))) {
      if (doc.runs.some(run => run.node_id === node.id) || ["ready", "running", "review", "accepted"].includes(node.status))
        fail("engineering_recheck_unselected_impact", "修正还会影响未选中的已有执行或验收，不能隐式使其失效；请扩大明确修订范围。", 409);
    }
    doc.nodes = doc.nodes.map(node => members.find(member => member.node.id === node.id)?.node ?? node);
    this.validate(doc);
    for (const member of members) this.validatePlan(doc, member.node);
    const affectedIds = [...affected].sort();
    const manifestDigest = sha256(JSON.stringify({ original_document_sha256: originalDigest, affected_ids: affectedIds,
      members: members.map(member => ({ node_id: member.node.id, prior_run_id: member.prior.id, prior_run_sha256: sha256(JSON.stringify(member.prior)),
        owner: member.owner, source_cwd: member.sourceCwd, before: member.frozenBefore, after: member.frozenAfter, configurations: member.configurations,
        contract_key: engineeringContractKey(doc, member.node.id) })) }));
    return { doc, members, affectedIds, manifestDigest };
  }

  private recheckConfiguration(sourceRoot: string, before: string[], args: string[]): EngineeringRecheckConfiguration {
    const noLinks = (raw: string) => {
      const absolute = resolve(raw), base = parse(absolute).root; let cursor = base;
      for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) fail("engineering_recheck_config_link", "复验配置及测试根目录不能经过符号链接或目录联接。", 400);
      }
      return realpathSync.native(absolute);
    };
    if (before.some(arg => arg === "-r" || arg.startsWith("-r=") || arg.startsWith("--root=") || arg === "-c" || arg.startsWith("-c=") || arg.startsWith("--config=")))
      fail("engineering_recheck_runner_unsupported", "快捷修正仅支持明确的 Vitest 入口和唯一长选项 --root / --config，不能存在其他覆盖形式。", 400);
    const rootIndex = before.indexOf("--root"), configIndex = before.indexOf("--config");
    if (rootIndex !== before.lastIndexOf("--root") || (rootIndex >= 0 && (!before[rootIndex + 1]?.trim() || before[rootIndex + 1].startsWith("-"))))
      fail("engineering_recheck_root_invalid", "Vitest 测试根必须是冻结命令中唯一且完整的 --root 参数。", 400);
    // Vitest createVitest resolves options.config from options.root, not from
    // the node source cwd. Match that existing runner's rule without changing cwd.
    const testRoot = noLinks(resolve(sourceRoot, rootIndex < 0 ? "." : before[rootIndex + 1]));
    if (!lstatSync(testRoot).isDirectory() || !this.approvedSourceRoots().some(root => this.contained(noLinks(root), testRoot)))
      fail("engineering_recheck_root_unapproved", "冻结的测试根不属于当前工程已授权目录。", 400);
    const lexicalRunner = resolve(sourceRoot, before[0]), expectedLexicalRunner = join(testRoot, "node_modules", "vitest", "vitest.mjs");
    const runner = this.realPath(lexicalRunner), expectedRunner = this.realPath(expectedLexicalRunner);
    // pnpm commonly installs this preexisting runner through a junction. Keep
    // its exact lexical entry and require its resolved package in the same
    // approved project, rather than rejecting that legitimate install layout.
    if (relative(lexicalRunner, expectedLexicalRunner) !== "" || relative(runner, expectedRunner) !== "" || !existsSync(runner) || !lstatSync(runner).isFile()
      || !this.approvedSourceRoots().some(root => { const approved = noLinks(root); return this.contained(approved, testRoot) && this.contained(approved, runner); }))
      fail("engineering_recheck_runner_unsupported", "本次快捷修正只用于该测试根已安装的 Vitest 执行器，不能切换执行程序。", 400);
    const rawConfig = args[configIndex + 1], oldConfig = before[configIndex + 1];
    if (/[\x00-\x1f]/.test(rawConfig) || basename(rawConfig.replaceAll("\\", "/")) !== basename(oldConfig.replaceAll("\\", "/")))
      fail("engineering_recheck_config_renamed", "只修正同名配置文件的定位，不允许改名或选择另一种检查方案。", 400);
    const lexicalConfig = resolve(testRoot, rawConfig);
    if (!this.contained(testRoot, lexicalConfig)) fail("engineering_recheck_config_outside_root", "修正后的配置必须位于冻结测试根内，不能越界或逃逸到父目录。", 400);
    const config = noLinks(lexicalConfig);
    if (!this.contained(testRoot, config)) fail("engineering_recheck_config_outside_root", "配置真实路径越过冻结测试根。", 400);
    const stat = lstatSync(config);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      fail("engineering_recheck_config_file_invalid", "配置必须是至多 1 MB 的普通独立文件，不能是硬链接或特殊文件。", 400);
    const fd = openSync(config, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const start = fstatSync(fd), content = Buffer.alloc(1024 * 1024 + 1); let bytes = 0;
      if (!start.isFile() || start.nlink !== 1 || start.dev !== stat.dev || start.ino !== stat.ino || start.size !== stat.size)
        fail("engineering_recheck_config_changed", "配置在读取前发生变化，请重新预览。", 409);
      while (bytes < content.length) { const count = readSync(fd, content, bytes, content.length - bytes, bytes); if (!count) break; bytes += count; }
      const end = fstatSync(fd), pathStat = lstatSync(config);
      if (bytes > 1024 * 1024 || start.size !== bytes || end.size !== bytes || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs
        || end.nlink !== 1 || pathStat.isSymbolicLink() || pathStat.dev !== end.dev || pathStat.ino !== end.ino || noLinks(lexicalConfig) !== config)
        fail("engineering_recheck_config_changed", "配置在读取过程中被更换或改写，请重新预览。", 409);
      return { test_root: testRoot, path: config, sha256: sha256(content.subarray(0, bytes)) };
    } finally { closeSync(fd); }
  }

  private assertRecheckConfiguration(doc: EngineeringDocument, run: EngineeringRun) {
    const event = [...doc.events].reverse().find(event => event.node_id === run.node_id && event.kind === "plan" && event.readiness_contract_key === run.snapshot.contract_key && (() => {
      try { return JSON.parse(event.detail ?? "null")?.package_kind === "check_config_recheck"; } catch { return false; }
    })());
    if (!event) return;
    const receipt = JSON.parse(event.detail!);
    const configChecks = Array.isArray(receipt.checks) ? receipt.checks.filter((check: { configuration?: unknown }) => check.configuration) : [];
    if (!configChecks.length || !run.source_scope) fail("engineering_recheck_config_receipt_missing", "缺少已确认配置文件身份，不能启动复验。", 409);
    for (const check of configChecks) {
      const frozen = run.source_scope.checks.find(item => item.id === check.id);
      if (!frozen || JSON.stringify(frozen.args) !== JSON.stringify(check.args)) fail("engineering_recheck_config_changed", "复验参数偏离已确认内容，请重新核对。", 409);
      const current = this.recheckConfiguration(run.source_scope.root, check.before_args, frozen.args);
      if (current.path !== check.configuration.path || current.test_root !== check.configuration.test_root || current.sha256 !== check.configuration.sha256)
        fail("engineering_recheck_config_changed", "配置文件在确认后已变化，不能按旧确认执行复验。", 409);
    }
    return { event, receipt };
  }

  dispatch(input: { node_ids: string[]; mode?: "controlled" | "external"; expected_revision?: number }, actor?: string) {
    const doc = loadEngineering(this.root);
    const agentActor = actor?.startsWith("codex:") ? actor : undefined;
    if (input.expected_revision !== undefined && input.expected_revision !== doc.revision) fail("engineering_revision_conflict", "派发前任务文档已更新，请重新核对。 ");
    if (!Array.isArray(input.node_ids) || !input.node_ids.length || input.node_ids.length > 100) fail("engineering_node_ids_required", "请选择要派发的任务。", 400);
    if (input.mode !== undefined && !["controlled", "external"].includes(input.mode)) fail("engineering_mode_invalid", "不支持该执行方式。", 400);
    if (agentActor && input.mode !== "external") fail("engineering_agent_external_mode_required", "协作 Agent 只能按已冻结的外部动作逐项执行。", 403);
    const nodes = [...new Set(input.node_ids)].map((id) => this.node(doc, id));
    for (const node of nodes) {
      if (node.status !== "ready") fail("engineering_node_not_ready", "“" + node.title + "”尚未准备好。");
      if (doc.runs.some((run) => run.node_id === node.id && ["queued", "running", "review"].includes(run.status) && this.sameLineage(doc, run))) fail("engineering_run_already_active");
      this.validatePlan(doc, node);
      if (node.source_scope && input.mode !== "external") fail("engineering_source_external_required", "源文件工程修改必须交给真实外部负责人执行。");
      if (node.actions.some((action) => action.type === "agent_artifact") && (input.mode !== "external" || doc.nodes.some((item) => item.parent_id === node.id && item.status !== "archived"))) fail("engineering_agent_artifact_external_required", "Agent 生成产物只能由外部协作 Agent 在叶任务内提交。");
      if (input.mode === "external" && !doc.nodes.some(item => item.parent_id === node.id && item.status !== "archived")) {
        const { owner } = this.externalOwner(doc, node);
        if (agentActor && agentActor !== owner) fail("engineering_agent_owner_mismatch", "只有已分配的真实负责人可以直接领取派发。", 403);
      }
    }
    for (const node of nodes) {
      const id = identifier("engineering-run");
      const hasChildren = doc.nodes.some((item) => item.parent_id === node.id && item.status !== "archived");
      const mode = hasChildren ? "integration" : input.mode ?? "controlled";
      const createdAt = now();
      const external = mode === "external" ? this.externalOwner(doc, node) : undefined;
      const sourceScope = node.source_scope ? freezeEngineeringSourceScope(node.source_scope, this.approvedSourceRoots()) : undefined;
      const run: EngineeringRun = {
        id, node_id: node.id, mode, status: "queued", actor: mode === "external" ? agentActor ?? external!.owner : actor ?? (mode === "integration" ? "本地整合检查" : "本地受控执行"),
        snapshot: this.snapshot(doc, node.id), started_at: now(), finished_at: null,
        current_action: "", completed_action_ids: [], evidence: [], output_dir: join(this.root, ".project", "engineering", "recursive", "outputs", id),
        reason: mode === "external" && !agentActor ? "冻结方案已生成，等待负责人在 Codex 中领取；尚未开始执行。" : "", review_note: "", reviewed_at: null,
        ...(sourceScope ? {source_scope:sourceScope} : {}),
        ...(external ? {handoff:{state:agentActor ? "claimed" as const : "awaiting_claim" as const,owner:external.owner,source_cwd:external.session.cwd,document_revision:doc.revision,contract_key:engineeringContractKey(doc,node.id),created_at:createdAt,...(agentActor ? {claimed_at:createdAt,claimed_by:agentActor} : {})}} : {})
      };
      const recheck = this.assertRecheckConfiguration(doc, run);
      if (recheck) {
        const { receipt } = recheck;
        doc.events.push({ id: identifier("event"), at: createdAt, kind: "execution", node_id: node.id, run_id: run.id,
          message: "本次为检查配置修正后的新复验运行；原编码与检查记录保留在此前运行，未重算为本轮编码。",
          detail: JSON.stringify({ package_kind: "check_config_recheck", work_package_id: receipt.work_package_id, prior_run_id: receipt.prior_run_id,
            new_run_id: run.id, readiness_event_id: recheck.event.id, contract_key: run.snapshot.contract_key, attribution: "verification_retry_only" }) });
      }
      doc.runs.push(run);
    }
    this.save(doc, "execution", nodes[0].id, input.mode === "external" && !agentActor ? "已冻结交接方案；外部步骤等待真实负责人领取，尚未开始执行。" : "已登记 " + nodes.length + " 项执行；依赖和资源满足后开始。");
    this.kick();
    return this.view();
  }

  pause(nodeId: string, reason = "监督者暂停") {
    const doc = loadEngineering(this.root);
    this.node(doc, nodeId);
    const affected = new Set([nodeId, ...engineeringDescendants(doc, nodeId).map((item) => item.id)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of doc.nodes) if (!affected.has(node.id) && engineeringEffectivePrerequisites(doc, node.id).some((id) => affected.has(id))) {
        affected.add(node.id); engineeringDescendants(doc, node.id).forEach((item) => affected.add(item.id)); changed = true;
      }
    }
    for (const run of doc.runs.filter((item) => affected.has(item.node_id) && ACTIVE.has(item.status))) {
      run.status = "paused"; run.reason = reason; this.releaseRunLocks(run.id);
    }
    for (const node of doc.nodes.filter((item) => affected.has(item.id) && item.status !== "archived")) node.status = "paused";
    this.save(doc, "execution", nodeId, "相关执行链已暂停；无依赖关系的任务可继续。", reason);
    this.kick();
    return this.view();
  }

  async executeAction(runId: string, actionId: string, internal = false, submission?: unknown, actor?: string) {
    let doc = loadEngineering(this.root);
    let run = this.run(doc, runId);
    if (!internal && run.mode !== "external") fail("engineering_action_mode_invalid");
    if (!internal) this.externalActor(doc, run, actor);
    const action = run.snapshot.node.actions.find((item) => item.id === actionId);
    if (!action) fail("engineering_action_not_in_snapshot", "此动作不在本次冻结方案中。");
    let submittedContent: string | undefined;
    if (action.type === "agent_artifact") {
      if (run.mode !== "external" || internal) fail("engineering_agent_artifact_external_required");
      if (!submission || typeof submission !== "object" || Object.keys(submission).length !== 1 || typeof (submission as { content?: unknown }).content !== "string") fail("engineering_artifact_content_required", "此动作仅接收 Agent 生成的 content 文本，其他字段不可修改。", 400);
      submittedContent = (submission as { content: string }).content;
      if (Buffer.byteLength(submittedContent, "utf8") > 1_000_000) fail("engineering_artifact_content_too_large", "单份产物不能超过 1 MB。", 400);
    } else if (submission !== undefined && submission !== null && (typeof submission !== "object" || Object.keys(submission).length > 0)) fail("engineering_action_payload_not_allowed", "只能执行已冻结动作，不能通过请求替换内容。", 400);
    if (!internal && run.handoff?.state === "awaiting_claim") {
      if (run.snapshot.node.actions[run.completed_action_ids.length]?.id !== actionId) fail("engineering_action_order");
      this.claim(runId,{contract_key:run.handoff.contract_key},actor);
      this.drain();
      doc=loadEngineering(this.root);run=this.run(doc,runId);
    }
    if (run.completed_action_ids.includes(actionId)) {
      if (submittedContent !== undefined && !run.evidence.some((item) => item.kind === "artifact" && item.path === action.path && item.sha256 === sha256(submittedContent))) fail("engineering_action_already_completed", "此动作已有确定产物，不能在原运行中覆盖。 ");
      return this.view();
    }
    try { this.assertCurrent(doc, run); }
    catch (error) { this.blockRun(runId, error); throw error; }
    if (run.status !== "running") fail("engineering_run_not_running");
    if (run.current_action) fail("engineering_action_busy");
    if (run.snapshot.node.actions[run.completed_action_ids.length]?.id !== actionId) fail("engineering_action_order");
    run.current_action = actionId;
    this.save(doc, "execution", run.node_id, "执行：" + action.title, undefined, run.id);
    try {
      const evidence: EngineeringEvidence[] = [];
      let capabilityUse: EngineeringDocument["capability_uses"][number] | undefined;
      if (action.type === "write_file" || action.type === "agent_artifact") {
        const path = this.path(run, action.path, true);
        writeFileSync(path, submittedContent ?? action.content, { encoding: "utf8", flag: "wx" });
        evidence.push(this.evidence(action.criterion_id, "artifact", "已真实写入并计算文件摘要。", { path: action.path, sha256: sha256(readFileSync(path)), passed: true }));
      } else if (action.type === "check_file") {
        const criterion = run.snapshot.node.criteria.find((item) => item.id === action.criterion_id && item.kind !== "manual");
        if (!criterion) fail("engineering_check_criterion_invalid");
        evidence.push(this.check(run, criterion));
      } else {
        const binding = run.snapshot.node.capabilities.find((item) => item.id === action.capability_id);
        if (!binding) fail("engineering_capability_not_bound");
        const outputPath = this.path(run, action.path, true);
        if (existsSync(outputPath)) fail("engineering_output_exists");
        const packetDir = this.privateDirectory(run, action.id);
        const prepared = await this.jervis.prepare(binding, run.snapshot, run.id, packetDir);
        doc = loadEngineering(this.root); run = this.run(doc, runId); this.assertCurrent(doc, run);
        if (run.status !== "running") fail("engineering_run_not_running");
        // Recheck the concrete destination after asynchronous capability preparation.
        this.path(run, action.path, true);
        const applied = await this.jervis.apply(prepared, outputPath);
        if (resolve(applied.path) !== resolve(outputPath)) fail("engineering_capability_output_mismatch");
        const actualPath = this.path(run, action.path, false);
        if (sha256(readFileSync(actualPath)) !== applied.sha256 || !applied.checks.length || applied.checks.some((item) => !item.passed)) fail("engineering_capability_validation_failed");
        const item = this.evidence(action.criterion_id, "capability", applied.summary, { path: action.path, sha256: applied.sha256, passed: true });
        evidence.push(item);
        capabilityUse = { ...prepared.use, state: "used", evidence_ids: [item.id], summary: applied.summary };
      }
      doc = loadEngineering(this.root); run = this.run(doc, runId); this.assertCurrent(doc, run);
      if (run.status !== "running") fail("engineering_run_not_running");
      run.evidence.push(...evidence); run.completed_action_ids.push(actionId); run.current_action = "";
      if (capabilityUse) doc.capability_uses.push(capabilityUse);
      if (evidence.some((item) => item.passed === false)) {
        run.status = "blocked"; run.reason = "实际检查失败，请核对证据后修改方案。";
        this.node(doc, run.node_id).status = "blocked"; this.releaseRunLocks(run.id);
      }
      this.save(doc, capabilityUse ? "capability" : "execution", run.node_id, action.title + (run.status === "blocked" ? "：检查未通过。" : "：已执行并留下证据。"), undefined, run.id);
    } catch (error) {
      doc = loadEngineering(this.root); run = this.run(doc, runId);
      if (run.status === "running") {
        run.status = "blocked"; run.reason = error instanceof Error ? error.message : String(error); run.current_action = "";
        this.node(doc, run.node_id).status = "blocked";
        this.save(doc, "constraint", run.node_id, "动作已被停止，未放宽原有约束。", run.reason, run.id);
      }
      this.releaseRunLocks(runId); this.kick();
      throw error;
    }
    return this.view();
  }

  async finish(runId: string, internal = false, actor?: string) {
    const initial = loadEngineering(this.root), candidate = this.run(initial, runId);
    if (!internal && candidate.mode !== "external") fail("engineering_action_mode_invalid");
    if (!internal) this.externalActor(initial, candidate, actor);
    if (candidate.current_action) fail("engineering_action_busy", "本次运行仍有动作或源文件检查进行中。");
    const controller = this.hasSourceAudit(candidate) ? new AbortController() : undefined;
    if (controller) this.sourceChecks.set(runId, { controller, roots: this.sourceScopes(candidate).map(scope => scope.root), title: candidate.snapshot.node.title });
    const operation = async () => {
      if (this.hasSourceAudit(candidate)) {
        let doc = loadEngineering(this.root), run = this.run(doc, runId);
        this.assertCurrent(doc, run);
        if (run.status !== "running" || run.completed_action_ids.length !== run.snapshot.node.actions.length) fail("engineering_actions_incomplete");
        const baselines = run.source_scope ? run.source_baseline ? [run.source_baseline] : [] : run.source_integration_baselines ?? [];
        if (!baselines.length || baselines.length !== this.sourceScopes(run).length) fail("engineering_source_baseline_required", "本次源文件运行缺少真实执行起点，不能验收。");
        run.current_action = "source-verification";
        this.save(doc, "execution", run.node_id, "正在核对源文件变更并执行冻结的实际检查。", undefined, run.id);
        const proofs = [];
        for (const baseline of baselines) {
          this.assertRecheckConfiguration(doc, run);
          proofs.push(await verifyEngineeringSourceProof(baseline, this.approvedSourceRoots(), { signal: controller?.signal,
            assertCheckContext: () => this.assertRecheckConfiguration(doc, run) }));
          this.assertRecheckConfiguration(doc, run);
        }
        if (!run.source_scope && !controller?.signal.aborted) for (const [index, baseline] of baselines.entries()) {
          const final = captureEngineeringSourceBaseline(baseline.scope);
          if (final.manifest_sha256 !== baseline.manifest_sha256) Object.assign(proofs[index], { passed: false, status: "failed", source_changed_during_checks: true, final_manifest_sha256: final.manifest_sha256, error: "组合检查开始后源目录出现变化，不能将检查视为最终代码的通过证据。" });
        }
        if (this.closed) fail("engineering_service_closed", "服务已经关闭，不能提交检查结果。", 503);
        doc = loadEngineering(this.root); run = this.run(doc, runId); this.assertCurrent(doc, run);
        if (run.status !== "running" || run.current_action !== "source-verification") fail("engineering_run_not_running");
        if (run.source_scope) run.source_proof = proofs[0]; else run.source_integration_proofs = proofs;
        run.current_action = "";
        for (const proof of proofs) run.evidence.push(this.evidence("", "check", proof.passed ? (run.source_scope ? "源目录变更符合冻结范围，实际检查通过；基线前已有修改单独列出。" : "已对组合后的源目录实际复跑冻结检查：" + proof.root) : "源目录核验未通过：" + proof.error, { passed: proof.passed, sha256: sha256(JSON.stringify(proof)) }));
        if (proofs.some(proof => !proof.passed)) {
          run.status = "blocked"; run.reason = proofs.find(proof => !proof.passed)?.error ?? "源文件核验失败。"; run.finished_at = now();
          this.measureRunUsage(run, "observed");
          this.node(doc, run.node_id).status = "blocked"; this.releaseRunLocks(run.id);
          this.save(doc, "constraint", run.node_id, "源文件核验阻止了提交验收。", run.reason, run.id); this.kick(); return this.view();
        }
        this.save(doc, "execution", run.node_id, "源文件核验结果已保存，继续检查本任务的其他验收条件。", undefined, run.id);
      }
      return this.finishRun(runId, internal);
    };
    const job = operation().finally(() => {
      if (this.hasSourceAudit(candidate)) {
        this.sourceChecks.delete(runId);
        const status = this.run(loadEngineering(this.root), runId).status;
        if (this.closed || !["running", "review"].includes(status)) this.runtime.releaseLocks(runId);
      }
    });
    if (this.hasSourceAudit(candidate)) this.jobs.set(runId, job.then(() => {}, () => {}));
    try { return await job; }
    catch (error) {
      this.blockRun(runId, error);
      throw error;
    }
    finally { if (this.hasSourceAudit(candidate)) { this.jobs.delete(runId); this.kick(); } }
  }

  private finishRun(runId: string, internal = false) {
    const doc = loadEngineering(this.root);
    const run = this.run(doc, runId);
    if (!internal && run.mode !== "external") fail("engineering_action_mode_invalid");
    this.assertCurrent(doc, run);
    if (run.status !== "running" || run.current_action) fail("engineering_run_not_finishable");
    if (run.completed_action_ids.length !== run.snapshot.node.actions.length) fail("engineering_actions_incomplete");
    this.assertPrerequisites(doc, run.node_id);
    this.verifyArtifactsRecursively(doc, run);
    for (const criterion of run.snapshot.node.criteria.filter((item) => item.kind !== "manual")) {
      run.evidence = run.evidence.filter((item) => !(item.kind === "check" && item.criterion_id === criterion.id));
      run.evidence.push(this.check(run, criterion));
    }
    if (run.mode === "integration") {
      for (const child of run.snapshot.children) {
        const childRun = this.run(doc, child.run_id); this.verifyArtifactsRecursively(doc, childRun);
        run.evidence.push(this.evidence("", "check", "已核对子项“" + this.node(doc, child.node_id).title + "”的验收版本、合同和真实产物。", { passed: true }));
      }
    }
    const failed = run.evidence.some((item) => item.kind === "check" && item.passed === false);
    run.status = failed ? "blocked" : "review"; run.finished_at = now();
    this.measureRunUsage(run, "observed");
    run.reason = failed ? "自动验收未通过，不能提交人工通过。" : "";
    this.node(doc, run.node_id).status = failed ? "blocked" : "review";
    if (!this.hasSourceAudit(run) || failed) this.releaseRunLocks(run.id);
    this.save(doc, "review", run.node_id, failed ? "自动验收失败，保留实际失败证据。" : "执行已结束，等待逐项人工检查。", undefined, run.id);
    this.kick();
    return this.view();
  }

  review(runId: string, input: { verdict: "accepted" | "needs_revision"; note?: string; checks?: Array<{ criterion_id: string; passed: boolean; note?: string }> }) {
    const doc = loadEngineering(this.root);
    const run = this.run(doc, runId);
    this.assertCurrent(doc, run);
    if (run.status !== "review") fail("engineering_run_not_reviewable");
    if (!["accepted", "needs_revision"].includes(input.verdict)) fail("engineering_verdict_invalid", "请选择通过或退回。", 400);
    if (!input.note?.trim()) fail("engineering_review_note_required");
    const checks = input.checks ?? [];
    if (!Array.isArray(checks) || checks.some(item => !item || typeof item.passed !== "boolean" || (item.note !== undefined && typeof item.note !== "string")) || new Set(checks.map((item) => item.criterion_id)).size !== checks.length || checks.some((item) => !run.snapshot.node.criteria.some((criterion) => criterion.id === item.criterion_id))) fail("engineering_review_checks_invalid");
    if (input.verdict === "accepted") {
      if (checks.some(item => item.passed === false)) fail("engineering_review_checks_failed", "仍有单项被标为未通过，请修订后重新交付。");
      this.assertPrerequisites(doc, run.node_id);
      this.verifyArtifactsRecursively(doc, run);
      this.verifyCurrentSourceEvidence(run);
      for (const criterion of run.snapshot.node.criteria) {
        if (criterion.kind === "manual") {
          const check = checks.find((item) => item.criterion_id === criterion.id);
          if (check?.passed !== true || !check.note?.trim()) fail("engineering_manual_check_required", "请逐条确认“" + criterion.text + "”并说明依据。");
        } else {
          const actual = this.check(run, criterion);
          if (actual.passed !== true) fail("engineering_automatic_check_failed", "实际文件未通过“" + criterion.text + "”。");
        }
      }
      if (!deriveEngineeringView(doc).derived[run.node_id].can_accept) fail("engineering_acceptance_gates_failed");
    }
    for (const check of checks.filter((item) => run.snapshot.node.criteria.some((criterion) => criterion.id === item.criterion_id && criterion.kind === "manual"))) run.evidence.push(this.evidence(check.criterion_id, "human", check.note?.trim() || input.note.trim(), { passed: check.passed }));
    run.status = input.verdict === "accepted" ? "accepted" : "rejected";
    this.releaseRunLocks(run.id);
    run.review_note = input.note.trim(); run.reviewed_at = now();
    this.measureRunUsage(run, "final");
    this.node(doc, run.node_id).status = input.verdict === "accepted" ? "accepted" : "needs_revision";
    if (run.status === "accepted") this.invalidateObsoleteRuns(doc);
    this.save(doc, "review", run.node_id, input.verdict === "accepted" ? "本任务已逐项通过人工验收。" : "本任务已退回，历史证据保留。", input.note.trim(), run.id);
    this.kick();
    return this.view();
  }

  createFeedback(input: EngineeringFeedbackCreate, actor = "监督者") {
    const request = EngineeringFeedbackCreateSchema.parse(input), doc = this.revision(request.expected_revision);
    const node = this.node(doc, request.target.node_id);
    if (node.revision !== request.base_node_revision) fail("engineering_feedback_target_changed", "反馈对应的内容已更新，请先核对当前版本。");
    if (!engineeringFeedbackTargetExists(doc, request.target)) fail("engineering_feedback_target_missing", "反馈对应的节点、关系、成果或条件已不存在。", 400);
    if (request.scope_node_ids && !engineeringFeedbackScopeValid(doc, request.target, request.scope_node_ids)) fail("engineering_feedback_scope_invalid", "请选择真实且未归档的节点，并把反馈归属到它们的共同上级。", 400);
    const at = now();
    const feedback: EngineeringFeedback = {
      id: identifier("feedback"), target: request.target, kind: request.kind, note: request.note, status: "open",
      base_document_revision: doc.revision, base_node_revision: node.revision,
      base_contract_key: engineeringContractKey(doc, node.id), base_lineage: engineeringLineageVersions(doc, node.id),
      base_run_id: currentEngineeringRun(doc, node.id)?.id ?? null,
      target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(node, request.target)),
      created_at: at, updated_at: at, history: [{ at, action: "create", actor, note: request.note, basis: {
        document_revision: doc.revision, node_revision: node.revision, contract_key: engineeringContractKey(doc, node.id),
        lineage: engineeringLineageVersions(doc, node.id), run_id: currentEngineeringRun(doc, node.id)?.id ?? null,
        target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(node, request.target))
      } }]
    };
    if (request.scope_node_ids) {
      feedback.scope_node_ids = request.scope_node_ids;
      feedback.scope_snapshot = engineeringFeedbackScopeSnapshot(doc, request.scope_node_ids);
      feedback.history[0].basis!.scope_snapshot = structuredClone(feedback.scope_snapshot);
      const children: EngineeringFeedback[] = feedback.scope_snapshot.map(snapshot => ({
        id: identifier("feedback"), target: { kind: "node", node_id: snapshot.node_id }, kind: request.kind, note: request.note,
        scope_group_id: feedback.id, status: "open", base_document_revision: doc.revision,
        base_node_revision: snapshot.node_revision, base_contract_key: snapshot.contract_key, base_lineage: snapshot.lineage,
        base_run_id: snapshot.run_id, target_snapshot: snapshot.target_snapshot, created_at: at, updated_at: at,
        history: [{ at, action: "create", actor, note: request.note, basis: {
          document_revision: doc.revision, node_revision: snapshot.node_revision, contract_key: snapshot.contract_key,
          lineage: snapshot.lineage, run_id: snapshot.run_id, target_snapshot: snapshot.target_snapshot
        } }]
      }));
      feedback.scope_feedback_ids = children.map(child => child.id);
      (doc.feedbacks ??= []).push(...children);
    }
    (doc.feedbacks ??= []).push(feedback);
    return this.save(doc, "change", node.id, request.scope_node_ids ? "已记录范围意见及逐项反馈；尚未改变工程约定或执行状态。" : "已记录定点反馈；尚未改变工程约定或执行状态。", request.note);
  }

  updateFeedback(feedbackId: string, input: EngineeringFeedbackUpdate) {
    const request = EngineeringFeedbackUpdateSchema.parse(input), doc = this.revision(request.expected_revision);
    const feedback = doc.feedbacks?.find(item => item.id === feedbackId);
    if (!feedback) fail("engineering_feedback_not_found", "没有找到这条反馈。", 404);
    if (feedback.scope_node_ids) fail("engineering_feedback_scope_review_required", "范围意见按所选节点逐项落实与查收；请打开对应子意见，不能用单项结果关闭整个范围。");
    const scopeGroup = feedback.scope_group_id ? doc.feedbacks?.find(item => item.id === feedback.scope_group_id) : undefined;
    if (feedback.scope_group_id && (!scopeGroup?.scope_node_ids || !scopeGroup.scope_feedback_ids?.includes(feedback.id)
      || feedback.target.kind !== "node" || scopeGroup.scope_node_ids[scopeGroup.scope_feedback_ids.indexOf(feedback.id)] !== feedback.target.node_id)) fail("engineering_feedback_scope_invalid", "范围意见的逐项关联不完整，请保留历史并核对原范围。");
    if (scopeGroup && request.action !== "dismiss" && !engineeringFeedbackScopeValid(doc, scopeGroup.target, scopeGroup.scope_node_ids!)) fail("engineering_feedback_scope_invalid", "原反馈范围已有节点归档或移出共同上级，请核对当前范围后重新提出意见；原意见和依据保留。");
    const node = this.node(doc, feedback.target.node_id), at = now();
    const lineage = () => engineeringLineageVersions(doc, node.id);
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const assertAdopted = () => {
      if (!feedback.adopted_lineage || !same(feedback.adopted_lineage, lineage())) fail("engineering_feedback_contract_changed", "采用反馈后的约定又有变化，请重新核对这条反馈并重新采用。");
    };
    const verifyPlanRevision = () => {
      assertAdopted();
      const change = doc.changes.find(item => item.id === feedback.adopted_change_id && item.node_id === node.id);
      if (!change || engineeringChangeClassification(change.before, change.after) !== "presentation" || !same(engineeringFeedbackTargetValue(change.after, feedback.target), engineeringFeedbackTargetValue(node, feedback.target))) fail("engineering_feedback_change_required", "当前显示内容与采用的修订不一致，请重新核对。");
    };
    const currentResult = (id: string | undefined) => {
      if (!id) fail("engineering_feedback_run_required", "请关联本次反馈处理后重新交付的运行。");
      const run = this.run(doc, id);
      if (run.node_id !== node.id || run.id === feedback.base_run_id) fail("engineering_feedback_result_mismatch", "不能使用原结果或其他任务的结果关闭反馈。");
      this.assertCurrent(doc, run);
      if (!same(run.snapshot.lineage, feedback.adopted_lineage)) fail("engineering_feedback_result_mismatch", "提交结果不属于采用反馈后的约定版本。");
      const adoptedAt = feedback.history.filter(item => item.action === "adopt").at(-1)?.at;
      if (!adoptedAt || Date.parse(run.started_at) < Date.parse(adoptedAt)) fail("engineering_feedback_result_mismatch", "需要关联采用反馈后实际重新执行的结果。");
      return run;
    };
    let evidenceIds: string[] | undefined;
    let basis: EngineeringFeedback["history"][number]["basis"];
    if (request.action === "adopt") {
      if (feedback.status !== "open") fail("engineering_feedback_transition_invalid", "只有待处理反馈可以采用。");
      if (node.status === "archived") fail("engineering_node_archived");
      if (feedback.kind === "requirement_change") {
        const change = doc.changes.find(item => item.id === request.change_id && item.node_id === node.id);
        if (!change || change.before.revision < feedback.base_node_revision || JSON.stringify(engineeringFeedbackTargetValue(change.before, feedback.target)) !== feedback.target_snapshot || same(engineeringFeedbackTargetValue(change.before, feedback.target), engineeringFeedbackTargetValue(change.after, feedback.target)) || !same(engineeringFeedbackTargetValue(change.after, feedback.target), engineeringFeedbackTargetValue(node, feedback.target))) fail("engineering_feedback_change_required", "请先预览并保存对应目标的具体修订，再关联该修改；无关或过期的修改不能作为落实依据。");
        feedback.adopted_change_id = change.id;
        feedback.resolution_kind = engineeringChangeClassification(change.before, change.after) === "presentation" ? "plan" : "delivery";
      } else {
        if (request.change_id || !same(feedback.base_lineage, lineage()) || feedback.base_contract_key !== engineeringContractKey(doc, node.id)) fail("engineering_feedback_contract_changed", "原约定或来源已变化，请核对后重新提出反馈；结果缺陷应按原标准修复。");
        const affected = this.structuralImpact(doc, node.id);
        this.invalidate(doc, affected, "原结果反馈已采用，需要按原标准修复并重新交付。");
        // The unchanged contract cannot make an acknowledged defective result current again.
        for (const run of doc.runs.filter(item => affected.includes(item.node_id) && item.status === "accepted")) {
          run.status = "stale"; run.reason = "已采用原结果缺陷反馈，原验收与证据保留历史，需重新交付。";
        }
        feedback.resolution_kind = "delivery";
      }
      feedback.adopted_lineage = lineage(); feedback.status = "adopted";
    } else if (request.action === "working" || request.action === "submit") {
      if (!["adopted", "working", "review"].includes(feedback.status)) fail("engineering_feedback_transition_invalid", "反馈需要先采用，才能关联执行和重新交付。");
      assertAdopted();
      if (feedback.resolution_kind === "plan") {
        if (request.action !== "submit" || request.run_id) fail("engineering_feedback_plan_only", "显示修订按保存后的内容复核，不登记新的执行。");
        verifyPlanRevision(); feedback.status = "review";
      } else {
        const run = currentResult(request.run_id);
        if (request.action === "working") {
        if (run.status !== "running" || (run.mode === "external" && run.handoff?.state !== "claimed")) fail("engineering_feedback_run_not_running", "所关联运行尚未实际开始执行。");
        feedback.status = "working";
        } else {
        if (!["review", "accepted"].includes(run.status)) fail("engineering_feedback_result_not_ready", "需要先完成实际交付并提交验收。");
        feedback.submitted_run_id = run.id; feedback.status = "review";
        }
      }
    } else if (request.action === "resolve") {
      if (feedback.status !== "review") fail("engineering_feedback_transition_invalid", "请先关联重新交付的结果，再复核解决情况。");
      assertAdopted();
      if (feedback.resolution_kind === "plan") {
        if (request.run_id) fail("engineering_feedback_plan_only", "显示修订的复核不修改运行或成果验收。");
        verifyPlanRevision(); feedback.status = "resolved";
      } else {
        if (request.run_id && request.run_id !== feedback.submitted_run_id) fail("engineering_feedback_result_mismatch");
        const run = currentResult(feedback.submitted_run_id);
        if (run.status !== "accepted" || !run.reviewed_at) fail("engineering_feedback_review_required", "反馈对应的新结果尚未通过人工验收。");
        this.assertPrerequisites(doc, node.id); this.verifyArtifactsRecursively(doc, run); this.verifyCurrentSourceEvidence(run);
        evidenceIds = run.evidence.map(item => item.id); feedback.status = "resolved";
      }
    } else if (request.action === "dismiss") {
      if (feedback.status !== "open") fail("engineering_feedback_transition_invalid", "只有待处理意见可以标为不采用；已采用内容需先核对后重新打开。");
      feedback.status = "dismissed";
    } else {
      if (feedback.status === "open") fail("engineering_feedback_transition_invalid", "反馈已经处于待处理状态。");
      if (!engineeringFeedbackTargetExists(doc, feedback.target)) fail("engineering_feedback_target_missing", "原目标已删除，保留此反馈历史，请对当前目标提出新的反馈。");
      feedback.status = "open";
      feedback.base_document_revision = doc.revision; feedback.base_node_revision = node.revision;
      feedback.base_contract_key = engineeringContractKey(doc, node.id); feedback.base_lineage = lineage();
      feedback.base_run_id = currentEngineeringRun(doc, node.id)?.id ?? null;
      feedback.target_snapshot = JSON.stringify(engineeringFeedbackTargetValue(node, feedback.target));
      basis = { document_revision: doc.revision, node_revision: node.revision, contract_key: feedback.base_contract_key,
        lineage: feedback.base_lineage, run_id: feedback.base_run_id, target_snapshot: feedback.target_snapshot };
      delete feedback.adopted_change_id; delete feedback.adopted_lineage; delete feedback.submitted_run_id; delete feedback.resolution_kind;
    }
    if (request.action === "resolve" || request.action === "dismiss") basis = {
      document_revision: doc.revision, node_revision: node.revision, contract_key: engineeringContractKey(doc, node.id),
      lineage: lineage(), run_id: feedback.submitted_run_id ?? currentEngineeringRun(doc, node.id)?.id ?? null,
      target_snapshot: JSON.stringify(engineeringFeedbackTargetValue(node, feedback.target))
    };
    feedback.updated_at = at;
    feedback.history.push({ at, action: request.action, actor: "监督者", note: request.note, ...(request.change_id ? { change_id: request.change_id } : {}), ...(request.run_id || (request.action === "resolve" && feedback.submitted_run_id) ? { run_id: request.run_id ?? feedback.submitted_run_id } : {}), ...(evidenceIds ? { evidence_ids: evidenceIds } : {}), ...(basis ? { basis } : {}) });
    if (scopeGroup) {
      const status = engineeringFeedbackGroupStatus(doc, scopeGroup);
      if (status === "resolved") for (const id of scopeGroup.scope_feedback_ids!) {
        const member = doc.feedbacks!.find(item => item.id === id)!;
        if (member.status !== "resolved" || member.resolution_kind !== "delivery") continue;
        const run = this.run(doc, member.submitted_run_id ?? "");
        if (run.node_id !== member.target.node_id || run.status !== "accepted" || !run.reviewed_at) fail("engineering_feedback_scope_result_stale", "范围内有子项结果不再满足验收，请回到对应节点重新查收。");
        this.assertCurrent(doc, run); this.assertPrerequisites(doc, run.node_id);
        this.verifyArtifactsRecursively(doc, run); this.verifyCurrentSourceEvidence(run);
      }
      scopeGroup.status = status; scopeGroup.updated_at = at;
      scopeGroup.history.push({ at, action: request.action, actor: "逐项反馈汇总", note: "“" + node.title + "”的处理已更新；范围状态依据各子意见汇总。" });
    }
    return this.save(doc, "change", node.id, request.action === "resolve" ? "已根据重新交付及验收证据复核反馈。" : "已更新反馈处理记录。", request.note, request.run_id);
  }

  async feedback(runId: string, input: { capability_use_id: string; note?: string }) {
    let doc = loadEngineering(this.root);
    const run = this.run(doc, runId);
    const use = doc.capability_uses.find((item) => item.id === input.capability_use_id && item.run_id === runId);
    if (!use || !["used", "feedback_recorded"].includes(use.state)) fail("engineering_capability_use_required");
    if (!["accepted", "rejected"].includes(run.status) || !run.reviewed_at) fail("engineering_feedback_requires_review", "能力反馈必须关联已经人工验收或退回的真实应用。");
    if (!input.note?.trim()) fail("engineering_feedback_note_required");
    if (use.state === "feedback_recorded") return this.view();
    this.verifyArtifacts(run);
    const receipt = await this.jervis.recordFeedback(use, run, input.note.trim());
    doc = loadEngineering(this.root);
    const current = doc.capability_uses.find((item) => item.id === use.id)!;
    current.state = "feedback_recorded"; current.feedback_receipt = receipt.receipt;
    return this.save(doc, "capability", run.node_id, "Jervis 已记录本次实际应用反馈；候选未被自动晋级。", receipt.receipt_hash, runId);
  }

  artifact(runId: string, relativePath: string) {
    const run = this.run(loadEngineering(this.root), runId);
    const path = this.path(run, relativePath, false);
    if (!existsSync(path) || !lstatSync(path).isFile()) fail("engineering_artifact_not_found", "没有找到该运行的文件。", 404);
    return { path, content: readFileSync(path) };
  }

  history(nodeId: string) {
    const doc = this.view().document; this.node(doc, nodeId);
    return { changes: doc.changes.filter((item) => item.node_id === nodeId || item.affected_ids.includes(nodeId)), runs: doc.runs.filter((item) => item.node_id === nodeId), events: doc.events.filter((item) => item.node_id === nodeId), feedbacks: (doc.feedbacks ?? []).filter(item => item.target.node_id === nodeId || item.scope_node_ids?.includes(nodeId)) };
  }

  async settled() { while (this.jobs.size || this.scheduled) { await new Promise<void>((done) => setImmediate(done)); await Promise.allSettled([...this.jobs.values()]); } }
  close() {
    if (this.closed) return this.closing ?? Promise.resolve();
    this.closed = true;
    for (const pending of this.sourceChecks.values()) pending.controller.abort();
    const doc = loadEngineering(this.root);
    const running = doc.runs.filter((run) => run.status === "running");
    if (running.length) {
      for (const run of running) { run.status = "paused"; run.reason = "服务关闭，等待重新派发。"; this.node(doc, run.node_id).status = "paused"; this.releaseRunLocks(run.id); }
      this.save(doc, "execution", doc.root_id, "运行已暂停并保留现场。");
    }
    const finish = () => { this.runtime.close(); this.options.scheduler?.services.delete(this); this.options.scheduler?.wake(); };
    if (!this.sourceChecks.size) { finish(); return this.closing = Promise.resolve(); }
    return this.closing = Promise.allSettled([...this.jobs.values()]).then(() => { finish(); });
  }

  private kick() {
    if (this.options.scheduler) this.options.scheduler.wake();
    else this.schedule();
  }

  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.closed) this.drain(); });
  }

  private drain() {
    let doc = loadEngineering(this.root);
    if (this.invalidateObsoleteRuns(doc)) this.save(doc, "change", doc.root_id, "已停止引用失效验收结果的运行，保留快照并释放执行资源。");
    for (const candidate of doc.runs.filter((run) => run.status === "queued")) {
      doc = loadEngineering(this.root);
      const run = this.run(doc, candidate.id);
      if (run.mode === "external") {
        if (!run.handoff?.contract_key) {
          run.status="paused";run.reason="历史外部运行没有可验证交接记录，已暂停；请重新准备并交给真实负责人。";
          this.node(doc,run.node_id).status="paused";this.releaseRunLocks(run.id);
          this.save(doc,"execution",run.node_id,run.reason,undefined,run.id);continue;
        }
        if (run.handoff.state !== "claimed") continue;
        try { this.externalActor(doc,run,run.actor); }
        catch (error) { run.status="paused";run.reason=error instanceof Error ? error.message : String(error);this.node(doc,run.node_id).status="paused";this.releaseRunLocks(run.id);this.save(doc,"execution",run.node_id,run.reason,undefined,run.id);continue; }
      }
      if (new Set([...doc.runs.filter(item => item.status === "running").map(item => item.id), ...this.activeSourceCheckIds()]).size >= this.maxParallel) break;
      try { this.assertPrerequisites(doc, run.node_id); } catch (error) {
        if (error instanceof EngineeringServiceError && error.code === "engineering_delivery_incomplete") {
          run.status = "blocked"; run.reason = error.message; this.node(doc, run.node_id).status = "blocked";
          this.save(doc, "constraint", run.node_id, "交付约定不完整，尚未开始执行。", error.message, run.id);
        }
        continue;
      }
      let integration: ReturnType<typeof planEngineeringSourceIntegration> | undefined;
      if (!run.source_scope) {
        try {
          const currentSnapshot = this.snapshot(doc, run.node_id);
          integration = planEngineeringSourceIntegration(doc, { ...run, snapshot: currentSnapshot }, this.approvedSourceRoots());
          if (integration.scopes.length && JSON.stringify(run.source_integration_scopes) !== JSON.stringify(integration.scopes)) {
            run.source_integration_scopes = integration.scopes;
            this.save(doc, "plan", run.node_id, "已准备组合源码检查，等待对应源目录可用。", undefined, run.id);
            this.kick(); continue;
          }
        } catch (error) {
          run.status = "blocked"; run.reason = error instanceof Error ? error.message : String(error); this.node(doc, run.node_id).status = "blocked";
          this.save(doc, "constraint", run.node_id, "组合源码检查方案未满足门禁。", run.reason, run.id); continue;
        }
      }
      const active = doc.runs.filter((item) => item.status === "running");
      if (active.some((item) => engineeringNodesConflict(doc, item.node_id, run.node_id))) continue;
      const effective = effectiveEngineeringConstraints(doc, run.node_id);
      const sourceScopes = this.sourceScopes(run);
      if (sourceScopes.some(scope => this.sourceReservations().some(other => other.runId !== run.id && sourceRootsOverlap(scope.root, other.root)))) continue;
      if (this.options.scheduler && (sourceScopes.length ? sourceScopes.some(scope => !this.options.scheduler!.permits(this, effective.resources, scope.root)) : !this.options.scheduler.permits(this, effective.resources))) continue;
      const paths = this.node(doc, run.node_id).actions.filter((item) => ["write_file", "agent_artifact", "use_capability"].includes(item.type)).map((item) => item.path);
      const scopes = paths.length ? paths : effective.allow_layers.at(-1)?.patterns ?? [];
      const resources = effective.resources.map((resource) => "engineering/" + resource);
      for (const scope of sourceScopes) resources.push("engineering-source/" + sha256(scope.root.toLowerCase()));
      try { this.assertRecheckConfiguration(doc, run); }
      catch (error) {
        run.status = "blocked"; run.reason = error instanceof Error ? error.message : String(error); this.node(doc, run.node_id).status = "blocked";
        this.save(doc, "constraint", run.node_id, "复验配置已偏离本次确认，尚未开始执行。", run.reason, run.id); continue;
      }
      if (!this.runtime.acquireGoalLocks(scopes.map((scope) => "engineering/" + scope), resources, run.id)) continue;
      run.snapshot = this.snapshot(doc, run.node_id); run.status = "running"; run.started_at = now(); run.reason = "";
      this.measureRunUsage(run, "measuring");
      this.node(doc, run.node_id).status = "running";
      try {
        this.ensureOutputDirectory(run);
        if (run.source_scope) {
          const verified = freezeEngineeringSourceScope(run.source_scope, this.approvedSourceRoots());
          if (verified.contract_sha256 !== run.source_scope.contract_sha256) fail("engineering_source_contract_changed");
          run.source_baseline = captureEngineeringSourceBaseline(verified);
        } else if (integration?.scopes.length) {
          for (const latest of integration.latest) {
            const actual = captureEngineeringSourceBaseline(latest.scope);
            if (actual.manifest_sha256 !== latest.final_manifest_sha256) fail("engineering_source_final_check_required", "源目录在最新有效检查后又有变化。请先让实际修改对应的源码步骤重新检查并验收，再执行整体整合。");
          }
          run.source_integration_baselines = integration.scopes.map(scope => captureEngineeringSourceBaseline(scope));
        }
      } catch (error) {
        run.status = "blocked"; run.reason = (error as Error).message; this.node(doc, run.node_id).status = "blocked"; this.releaseRunLocks(run.id);
      }
      this.save(doc, "execution", run.node_id, run.status === "running" ? run.actor + "已开始，使用已冻结动作方案。" : run.reason, undefined, run.id);
      if (run.status === "running" && run.mode !== "external") {
        const promise = this.controlled(run.id).finally(() => { this.jobs.delete(run.id); this.kick(); });
        this.jobs.set(run.id, promise);
      }
    }
  }

  private async controlled(runId: string) {
    try {
      const run = this.run(loadEngineering(this.root), runId);
      for (const action of run.snapshot.node.actions) {
        if (this.closed || this.run(loadEngineering(this.root), runId).status !== "running") return;
        await this.executeAction(runId, action.id, true);
      }
      if (!this.closed && this.run(loadEngineering(this.root), runId).status === "running") await this.finish(runId, true);
    } catch (error) { this.blockRun(runId, error); }
  }

  private blockRun(runId: string, error: unknown) {
    if (this.closed) return;
    const doc = loadEngineering(this.root);
    const run = this.run(doc, runId);
    if (run.status === "running") {
      run.status = "blocked"; run.current_action = ""; run.reason = error instanceof Error ? error.message : String(error);
      this.node(doc, run.node_id).status = "blocked";
      this.save(doc, "constraint", run.node_id, "执行已阻止，保留失败原因和现场。", run.reason, run.id);
    }
    this.releaseRunLocks(runId); this.kick();
  }

  private snapshot(doc: EngineeringDocument, nodeId: string): EngineeringSnapshot {
    const lineage = engineeringLineage(doc, nodeId);
    const deliveryLineage = lineage.flatMap(node => node.delivery ? [{ node_id: node.id, title: node.title, delivery: structuredClone(node.delivery) }] : []);
    const accepted = (id: string) => {
      const run = currentEngineeringRun(doc, id);
      return run?.status === "accepted" ? [{ node_id: id, run_id: run.id, contract_key: run.snapshot.contract_key }] : [];
    };
    return {
      node: structuredClone(this.node(doc, nodeId)), lineage: engineeringLineageVersions(doc, nodeId),
      ...(deliveryLineage.length ? { delivery_lineage: deliveryLineage } : {}),
      effective: effectiveEngineeringConstraints(doc, nodeId), contract_key: engineeringContractKey(doc, nodeId),
      dependencies: engineeringEffectivePrerequisites(doc, nodeId).flatMap(accepted),
      delivery_inputs: engineeringFrozenDeliveryInputs(doc, nodeId),
      context_lineage: lineage.map(item => ({ node_id: item.id, title: item.title, objective: item.objective,
        contract_revision: engineeringNodeContractRevision(item), criteria: structuredClone(item.criteria), contributes_to: [...item.contributes_to],
        ...(item.composition ? {composition:structuredClone(item.composition)} : {}), ...(item.contribution ? {contribution:structuredClone(item.contribution)} : {}),
        ...(item.prerequisites ? {prerequisites:structuredClone(item.prerequisites)} : {}), ...(item.interactions ? {interactions:structuredClone(item.interactions)} : {}) })),
      children: doc.nodes.filter((item) => item.parent_id === nodeId && item.status !== "archived").flatMap((item) => accepted(item.id))
    };
  }

  private assertPrerequisites(doc: EngineeringDocument, nodeId: string) {
    const node = this.node(doc, nodeId);
    const lineage = engineeringLineage(doc, nodeId);
    this.validateDelivery(doc, nodeId);
    if (lineage.some((item) => ["paused", "archived"].includes(item.status))) fail("engineering_ancestor_unavailable");
    for (const id of engineeringEffectivePrerequisites(doc, nodeId)) if (currentEngineeringRun(doc, id)?.status !== "accepted") fail("engineering_dependency_waiting");
    const children = doc.nodes.filter((item) => item.parent_id === nodeId && item.status !== "archived");
    if (children.some((item) => currentEngineeringRun(doc, item.id)?.status !== "accepted")) fail("engineering_children_waiting");
    if (children.length && engineeringCompositionCoverage(doc, nodeId).some(item => !item.covered)) fail("engineering_child_coverage_missing");
  }

  private validatePlan(doc: EngineeringDocument, node: EngineeringNode) {
    this.validate(doc);
    this.validateDelivery(doc, node.id);
    if (!node.objective.trim() || !node.criteria.length) fail("engineering_plan_incomplete", "请填写预期结果和至少一条验收条件。");
    const children = doc.nodes.filter((item) => item.parent_id === node.id && item.status !== "archived");
    if (!children.length && !node.actions.length && !node.source_scope) fail("engineering_actions_required", "请先定义本步骤实际执行的动作。");
    if (node.source_scope) {
      if (children.length) fail("engineering_source_leaf_required", "源文件合同只属于实际执行的末级步骤；上级通过子项证据进行整合验收。");
      freezeEngineeringSourceScope(node.source_scope, this.approvedSourceRoots());
    }
    const effective = effectiveEngineeringConstraints(doc, node.id);
    const outputs = new Set<string>();
    for (const action of node.actions) {
      if (action.type === "check_file") {
        if (!node.criteria.some((item) => item.id === action.criterion_id && item.kind !== "manual")) fail("engineering_check_criterion_invalid");
      } else {
        const violation = engineeringPathViolation(effective, action.path);
        if (violation) fail("engineering_scope_violation", violation);
        this.safeRelative(action.path);
        const key = action.path.replaceAll("\\", "/").toLowerCase();
        if (outputs.has(key)) fail("engineering_duplicate_output_path"); outputs.add(key);
        if (action.criterion_id && !node.criteria.some((item) => item.id === action.criterion_id)) fail("engineering_action_criterion_invalid");
        if (action.type === "use_capability" && !node.capabilities.some((item) => item.id === action.capability_id)) fail("engineering_capability_not_bound");
      }
    }
    for (const criterion of node.criteria.filter((item) => item.kind !== "manual")) {
      this.safeRelative(criterion.path);
      const violation = engineeringPathViolation(effective, criterion.path);
      if (violation) fail("engineering_scope_violation", violation);
      if (criterion.kind === "file_contains" && !criterion.expected) fail("engineering_criterion_expected_required");
    }
  }

  private validateDelivery(doc: EngineeringDocument, nodeId: string) {
    const issues = engineeringLineage(doc, nodeId).flatMap(node => [...engineeringDeliveryIssues(doc, node.id), ...engineeringCompositionIssues(doc, node.id)]);
    if (issues.length) fail("engineering_delivery_incomplete", [...new Set(issues)].join(" "));
  }

  private check(run: EngineeringRun, criterion: EngineeringCriterion): EngineeringEvidence {
    const path = this.path(run, criterion.path, false);
    let passed = existsSync(path) && lstatSync(path).isFile();
    let hash: string | undefined;
    if (passed) {
      const content = readFileSync(path); hash = sha256(content);
      if (criterion.kind === "file_contains") passed = content.toString("utf8").includes(criterion.expected);
      if (criterion.kind === "json_valid") { try { JSON.parse(content.toString("utf8")); } catch { passed = false; } }
    }
    return this.evidence(criterion.id, "check", criterion.text + (passed ? "：实际文件检查通过。" : "：实际文件检查失败。"), { path: criterion.path, sha256: hash, passed });
  }

  private evidence(criterionId: string, kind: EngineeringEvidence["kind"], summary: string, extra: Partial<EngineeringEvidence> = {}): EngineeringEvidence {
    return { id: identifier("evidence"), criterion_id: criterionId, kind, summary, passed: null, created_at: now(), ...extra };
  }

  private verifyCurrentSourceEvidence(run: EngineeringRun) {
    if (!this.hasSourceAudit(run)) return;
    const proofs = run.source_scope ? run.source_proof ? [run.source_proof] : [] : run.source_integration_proofs ?? [];
    if (proofs.length !== this.sourceScopes(run).length || proofs.some(proof => !proof.passed)) fail("engineering_source_proof_required", "缺少通过的真实源文件核验。");
    for (const [index, sourceScope] of this.sourceScopes(run).entries()) {
      const scope = freezeEngineeringSourceScope(sourceScope, this.approvedSourceRoots()), current = captureEngineeringSourceBaseline(scope);
      if (current.manifest_sha256 !== proofs[index].final_manifest_sha256) fail("engineering_source_changed_after_check", "源目录在实际检查后又有变化，请重新执行检查，不能沿用旧通过结果。");
    }
  }

  private verifyArtifacts(run: EngineeringRun) {
    for (const evidence of run.evidence.filter((item) => ["artifact", "capability"].includes(item.kind))) {
      if (!evidence.path || !evidence.sha256) fail("engineering_evidence_incomplete");
      const path = this.path(run, evidence.path, false);
      if (!existsSync(path) || sha256(readFileSync(path)) !== evidence.sha256) fail("engineering_artifact_changed", "产物已变化，与本次执行证据不一致。");
    }
  }

  private verifyArtifactsRecursively(doc: EngineeringDocument, run: EngineeringRun, seen = new Set<string>()) {
    if (seen.has(run.id)) return;
    seen.add(run.id);
    this.verifyArtifacts(run);
    for (const ref of [...run.snapshot.children, ...run.snapshot.dependencies]) {
      const upstream = this.run(doc, ref.run_id);
      if (upstream.status !== "accepted" || upstream.snapshot.contract_key !== ref.contract_key || currentEngineeringRun(doc, ref.node_id)?.id !== upstream.id) fail("engineering_upstream_evidence_stale", "子项或依赖产出已失效，不能沿用旧整合证据。");
      this.verifyArtifactsRecursively(doc, upstream, seen);
    }
  }

  private ensureOutputDirectory(run: EngineeringRun) {
    const expected = resolve(this.root, ".project", "engineering", "recursive", "outputs", run.id);
    if (!/^engineering-run-[a-f0-9-]+$/.test(run.id) || resolve(run.output_dir) !== expected) fail("engineering_output_directory_invalid");
    const project = this.realPath(this.root);
    if (!this.contained(project, this.realPath(expected))) fail("engineering_path_escape");
    mkdirSync(expected, { recursive: true });
  }

  private path(run: EngineeringRun, raw: string, write: boolean) {
    this.safeRelative(raw); this.ensureOutputDirectory(run);
    const violation = engineeringPathViolation(run.snapshot.effective, raw);
    if (violation) fail("engineering_scope_violation", violation);
    const base = realpathSync(run.output_dir);
    const target = resolve(base, raw.replaceAll("\\", "/"));
    if (!this.contained(base, target) || !this.contained(base, this.realPath(target))) fail("engineering_path_escape", "文件路径越过本次运行目录。");
    if (write) {
      mkdirSync(dirname(target), { recursive: true });
      if (!this.contained(base, realpathSync(dirname(target)))) fail("engineering_path_escape");
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) fail("engineering_path_escape");
    }
    return target;
  }

  private privateDirectory(run: EngineeringRun, actionId: string) {
    this.ensureOutputDirectory(run);
    const path = resolve(run.output_dir, ".private-capabilities", sha256(actionId).slice(0, 24));
    if (!this.contained(realpathSync(run.output_dir), this.realPath(path))) fail("engineering_path_escape");
    mkdirSync(path, { recursive: true });
    return path;
  }

  private safeRelative(path: string) {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.includes(":") || /[\x00-\x1f]/.test(path) || path.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.startsWith(".private"))) fail("engineering_path_escape", "请使用本次运行内的安全相对路径。", 400);
  }
  private realPath(path: string) {
    let ancestor = resolve(path); const suffix: string[] = [];
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    return resolve(existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor, ...suffix);
  }
  private contained(root: string, path: string) { const value = relative(root, path); return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(".." + sep)); }

  private sameLineage(doc: EngineeringDocument, run: EngineeringRun) {
    return JSON.stringify(run.snapshot.lineage) === JSON.stringify(engineeringLineageVersions(doc, run.node_id));
  }
  private assertCurrent(doc: EngineeringDocument, run: EngineeringRun) {
    if (currentEngineeringRun(doc, run.node_id)?.id !== run.id) fail("engineering_run_stale", "任务、依赖或子项验收结果已变化，不能继续使用旧运行。");
  }
  private structuralImpact(doc: EngineeringDocument, nodeId: string) {
    const affected = new Set(engineeringLineage(doc, nodeId).map((item) => item.id));
    let changed = true;
    while (changed) {
      changed = false;
      const add = (id: string) => { if (!affected.has(id)) { affected.add(id); changed = true; } };
      for (const node of doc.nodes) if (!affected.has(node.id) && (engineeringEffectivePrerequisites(doc, node.id).some((id) => affected.has(id)) || node.interactions?.some(item => affected.has(item.target_node_id)) || doc.nodes.some(source => affected.has(source.id) && source.interactions?.some(item => item.target_node_id === node.id)))) {
        add(node.id);
        for (const child of engineeringDescendants(doc, node.id)) add(child.id);
      }
      for (const id of [...affected]) for (const ancestor of engineeringLineage(doc, id)) add(ancestor.id);
    }
    return [...affected];
  }
  private invalidateObsoleteRuns(doc: EngineeringDocument) {
    const invalid = doc.runs.filter((run) => ["queued", "running", "review"].includes(run.status) && currentEngineeringRun(doc, run.node_id)?.id !== run.id);
    for (const run of invalid) {
      run.status = "stale"; run.current_action = ""; run.reason = "已经引用的验收结果发生变化，需要重新核对并派发。";
      this.releaseRunLocks(run.id);
      this.node(doc, run.node_id).status = "needs_revision";
      doc.events.push({ id: identifier("event"), at: now(), node_id: run.node_id, run_id: run.id, kind: "change", message: run.reason });
    }
    return invalid.length;
  }
  private invalidate(doc: EngineeringDocument, ids: string[], reason: string) {
    const affected = new Set(ids);
    for (const run of doc.runs.filter((item) => affected.has(item.node_id) && ["queued", "running", "review", "paused"].includes(item.status))) {
      run.status = "stale"; run.reason = reason; this.releaseRunLocks(run.id);
    }
    for (const node of doc.nodes.filter((item) => affected.has(item.id) && !["archived", "draft"].includes(item.status))) node.status = "needs_revision";
    this.kick();
  }
  private proposed(doc: EngineeringDocument, nodeId: string, value: EngineeringNode) {
    const current = this.node(doc, nodeId);
    if (value.id !== nodeId) fail("engineering_node_id_mismatch");
    if (nodeId === doc.root_id && (value.parent_id !== null || value.kind !== "project")) fail("engineering_root_immutable");
    if (current.status === "archived") fail("engineering_node_archived");
    const retained = Object.fromEntries((["delivery", "composition", "contribution", "prerequisites", "interactions"] as const).filter(key => value[key] === undefined && current[key] !== undefined).map(key => [key, current[key]]));
    return prepareEngineeringNodeRevision(current, EngineeringNodeSchema.parse({ ...value, ...retained, created_at: current.created_at, updated_at: now() }));
  }
  private previewKey(revision: number, node: EngineeringNode) { return revision + ":" + sha256(JSON.stringify({ ...node, created_at: "", updated_at: "" })); }
  private revision(expected: number) { const doc = loadEngineering(this.root); if (!Number.isInteger(expected) || doc.revision !== expected) fail("engineering_revision_conflict", "内容已更新，请重新读取后修改。"); return doc; }
  private node(doc: EngineeringDocument, id: string) { const node = doc.nodes.find((item) => item.id === id); if (!node) fail("engineering_node_not_found", "没有找到任务。", 404); return node; }
  private run(doc: EngineeringDocument, id: string) { const run = doc.runs.find((item) => item.id === id); if (!run) fail("engineering_run_not_found", "没有找到运行。", 404); return run; }
  private validate(doc: EngineeringDocument) { const errors = validateEngineeringDocument(doc); if (errors.length) fail("engineering_document_invalid", errors.join(" "), 400); }
  private save(doc: EngineeringDocument, kind: EngineeringDocument["events"][number]["kind"], nodeId: string, message: string, detail?: string, runId?: string, readinessContractKey?: string) {
    doc.events.push({ id: identifier("event"), at: now(), node_id: nodeId, run_id: runId, kind, message, detail, ...(readinessContractKey ? { readiness_contract_key: readinessContractKey } : {}) });
    const next = saveEngineering(this.root, doc, doc.revision);
    this.events.emit({ type: kind === "review" ? "approval" : kind === "plan" || kind === "change" ? "plan" : "execution", message, data: { kind: "engineering", nodeId, runId, revision: next.revision, workspaceId: this.options.workspaceId } });
    const view = deriveEngineeringView(next, this.maxParallel);
    if (this.options.scheduler) view.scheduler = this.options.scheduler.stats();
    return this.observe(view);
  }
}
