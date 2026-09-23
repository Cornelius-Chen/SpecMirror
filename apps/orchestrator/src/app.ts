import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { deriveCompletionProgress, deriveSupervisionProgress, parsePlanCandidates, SupervisionDetailSchema, SupervisionTaskSchema, type ExternalAgentReceipt } from "@epm/domain";
import { allGraphEntities, appendSupervisionDetail, appendSupervisionTask, captureIdea, findRepoRoot, freezeSupervisionTask, impactReport, importSupervisionPlan, loadCapabilities, loadCompletionAudit, loadPermissionContracts, loadProject, loadSupervision, loadSupervisionHistory, loadSupervisionRuns, projectMap, rebuildIndex, validateCompletionEvidence, validateProject, writePermissionContract, writeSupervisionDetail, writeSupervisionRun, writeSupervisionTask } from "@epm/spec-io";
import { DeferredCodexGateway, MockAgentGateway } from "./gateway.ts";
import type { AgentGateway } from "./gateway.ts";
import { CodexAppServerGateway } from "./jsonrpc.ts";
import { createProjectCodexTransport, localCodexRuntimeReady } from "./codex-app-server-runtime.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { attachExternalSupervisionOutput, compileSupervisionDetail, dispatchSupervisionDetail, dispatchSupervisionGoal, reconcileSupervisionRuns, resumeSupervisionGoalRun, stopSupervisionGoalRun } from "./supervision.ts";
import { CodexReadinessManager } from "./codex-readiness.ts";
import { registerEngineeringRoutes } from "./engineering-routes.ts";
import { registerTaskCatalogRoutes, TaskCatalog } from "./task-catalog.ts";
import { registerTaskWorkspaceRoutes, TaskWorkspaces } from "./task-workspaces.ts";
import { WorkspaceCompanion } from "./workspace-companion.ts";
import { registerEngineeringPlanImports } from "./engineering-plan-import.ts";
import { registerEngineeringRestructure } from "./engineering-restructure.ts";
import { registerTaskPresentationRoutes } from "./task-presentation.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import type { HumanApprovalProvider } from "./human-approval-webauthn.ts";
import { bindCompanionSession, queueCompanionFeedback, readCompanionStatus, receiveCompanionHook, reportCompanionProgress, syncCompanionPlan, type CompanionHookPayload } from "./codex-companion.ts";
import { HookAuthenticationError, HookRequestAuthenticator } from "./hook-auth.ts";
import { CodexRolloutUsageReader } from "./codex-run-metrics.ts";

export interface AppOptions { root?: string; gateway?: "mock" | "codex-app-server"; recoverInterrupted?: boolean; readonlyLegacy?: boolean; hostSourceRoots?: string[]; humanApprovalVerifier?: HumanApprovalVerifier; humanApprovalProvider?: HumanApprovalProvider; hookAuthDataDirectory?: string }

export function registerLegacyReadonlyGuard(app: FastifyInstance, enabled: boolean) {
  if (!enabled) return;
  app.addHook("preHandler", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const route = request.routeOptions.url ?? request.url.split("?")[0];
    const currentTaskSurface = request.headers["x-mirror-surface"] === "current-task";
    const currentFlow = route === "/api/task-workspaces" || route === "/api/task-presentation" || route === "/api/codex-companion/hooks" || route === "/api/codex-companion/run-plan"
      || currentTaskSurface && (route === "/api/codex/smoke" || route === "/api/codex/smoke/stop")
      || route === "/api/governance/human-approval/authentication/options"
      || route === "/api/task-inbox/:id/receive" || route === "/api/engineering" || route.startsWith("/api/engineering/");
    if (route.startsWith("/api/") && !currentFlow) return reply.code(409).send({ code: "legacy_archive_readonly", error: "历史档案只供查阅；请在统一任务工作区管理方案、执行和验收。" });
  });
}

export async function buildApp(options: AppOptions = {}) {
  const root = options.root ?? findRepoRoot();
  const readonlyLegacy = options.readonlyLegacy ?? process.env.MIRROR_READONLY_LEGACY === "1";
  const requestedGateway = options.gateway ?? "mock";
  const selection = selectGateway(root, requestedGateway);
  await selection.initialize?.();
  const gateway = selection.gateway;
  const orchestrator = createOrchestrator(gateway, root, true, readonlyLegacy ? false : options.recoverInterrupted ?? false);
  if (!readonlyLegacy) await orchestrator.reconcileThreadGoalStatuses();
  const codexReadiness = new CodexReadinessManager({
    root,
    gatewaySelected: requestedGateway === "codex-app-server",
    gatewayReady: () => gateway.ready !== false,
    credentialStatus: selection.health.credential === "configured" ? "configured" : selection.health.credential === "rejected" ? "rejected" : "required",
    credentialSource: typeof selection.health.credential_source === "string" ? selection.health.credential_source as "none" | "stored" | "api-key" | "provider" : "none",
    selectedModel: typeof selection.health.codex_model === "string" ? selection.health.codex_model : null,
    runtimeReady: localCodexRuntimeReady(root),
    runtime: orchestrator.runtime!,
    events: orchestrator.events
  });
  if (!readonlyLegacy) reconcileSupervisionRuns(root, orchestrator.events);
  const app = Fastify({ logger: false });
  if (options.humanApprovalProvider && options.humanApprovalVerifier) throw new Error("configure either humanApprovalProvider or humanApprovalVerifier, not both");
  const humanApprovalVerifier = options.humanApprovalProvider?.verifier ?? options.humanApprovalVerifier;
  registerLegacyReadonlyGuard(app, readonlyLegacy);
  registerHumanApprovalGuard(app, humanApprovalVerifier);
  options.humanApprovalProvider?.registerRoutes(app);
  app.addHook("onClose", async () => { codexReadiness.close(); await gateway.close?.(); orchestrator.close(); });
  await app.register(cors, { origin: ["http://127.0.0.1:5173", "http://localhost:5173"] });
  const taskCatalog = new TaskCatalog(root);
  const workspaceCompanion = new WorkspaceCompanion(root, orchestrator.runtime!, orchestrator.events, { readonlyLegacy });
  const hookAuthenticator = new HookRequestAuthenticator({ dataDirectory: options.hookAuthDataDirectory });
  const usageObserver = new CodexRolloutUsageReader();
  const taskWorkspaces = new TaskWorkspaces(root, orchestrator.events, taskCatalog, { sessions: record => workspaceCompanion.sessions(record), observations: record => workspaceCompanion.lifecycleObservations(record), hostSourceRoots: options.hostSourceRoots, usageObserver });
  registerEngineeringRoutes(app, root, orchestrator.events, undefined, taskWorkspaces);
  registerTaskCatalogRoutes(app, root, taskCatalog, () => [
    ...taskWorkspaces.records().flatMap(record => record.thread_id ? [{ thread_id: record.thread_id, cwd: record.source_cwd, source: "workspace" as const, observed_at: record.created_at }] : []),
    ...workspaceCompanion.taskConnectionCandidates()
  ]);
  registerTaskWorkspaceRoutes(app, taskWorkspaces, workspaceCompanion);
  registerEngineeringPlanImports(app, taskWorkspaces);
  registerEngineeringRestructure(app, taskWorkspaces);
  registerTaskPresentationRoutes(app, taskWorkspaces);

  registerCodexReadinessRoutes(app, { selection, requestedGateway, readonlyLegacy, codexReadiness });
  app.get<{ Querystring: { cwd?: string; session_id?: string; workspace_id?: string } }>("/api/codex-companion/status", async (request, reply) => {
    try { return workspaceCompanion.readStatus(request.query, taskWorkspaces); }
    catch (failure) {
      const known = failure instanceof Error && "status" in failure && "code" in failure;
      return reply.code(known ? Number(failure.status) : 400).send({ error: failure instanceof Error ? failure.message : "codex_status_failed", code: known ? failure.code : "codex_status_failed" });
    }
  });
  app.post<{ Body: { session_id?: string; cwd?: string } }>("/api/codex-companion/bind", async (request, reply) => {
    try { return bindCompanionSession(root, orchestrator.runtime!, orchestrator.events, request.body ?? {}); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "codex_binding_failed" }); }
  });
  app.post<{ Body: CompanionHookPayload }>("/api/codex-companion/hooks", async (request, reply) => {
    try {
      const authenticated = hookAuthenticator.verify(request.body ?? {}, request.headers);
      const input = request.body ?? {};
      const authoritativeTurn = workspaceCompanion.needsCurrentTurnVerification(input, authenticated.timestamp)
        ? await taskCatalog.verifyCurrentTurn({ sessionId: String(input.session_id), cwd: String(input.cwd), turnId: String(input.turn_id) })
        : null;
      return workspaceCompanion.receiveHook(input, taskWorkspaces, authenticated.timestamp, authoritativeTurn ?? undefined);
    }
    catch (error) {
      if (error instanceof HookAuthenticationError) return reply.code(error.status).send({ code: error.code, error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : "codex_hook_failed" });
    }
  });
  app.post<{ Body: { cwd?: string; session_id?: string; explanation?: string; plan?: Array<{ step: string; status?: string }> } }>("/api/codex-companion/plan", async (request, reply) => {
    try { return reply.code(201).send(syncCompanionPlan(root, orchestrator.runtime!, orchestrator.events, { ...request.body, plan: Array.isArray(request.body?.plan) ? request.body.plan : [] })); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "codex_plan_sync_failed" }); }
  });
  app.post<{ Body: { cwd?: string; session_id?: string; task_id?: string; task?: string; stage?: string; summary?: string } }>("/api/codex-companion/progress", async (request, reply) => {
    try { return reportCompanionProgress(root, orchestrator.runtime!, orchestrator.events, request.body ?? {}); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "codex_progress_failed" }); }
  });
  app.post<{ Body: { session_id?: string; task_id?: string; text?: string } }>("/api/codex-companion/feedback", async (request, reply) => {
    try { return reply.code(202).send(queueCompanionFeedback(root, orchestrator.runtime!, orchestrator.events, request.body ?? {})); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "codex_feedback_failed" }); }
  });
  app.get("/api/project/map", async () => projectMap(loadProject(root)));
  app.get("/api/supervision", async () => loadSupervision(root));
  app.get("/api/supervision/history", async () => loadSupervisionHistory(root));
  app.get("/api/supervision/runs", async () => loadSupervisionRuns(root));
  app.get("/api/supervision/progress", async () => deriveSupervisionProgress(loadSupervision(root), loadSupervisionRuns(root)));
  app.post<{ Body: { text?: string } }>("/api/supervision/plan/import", async (request, reply) => {
    if (typeof request.body?.text !== "string" || !request.body.text.trim()) return reply.code(400).send({ error: "plan_text_required" });
    try {
      const result = importSupervisionPlan(root, request.body.text);
      orchestrator.events.emit({ type: "plan", message: `已把 Codex Plan 导入为 ${result.imported_task_ids.length} 个可编辑任务；尚未冻结或派发。`, data: { kind: "supervision-plan", planVersion: result.document.plan.version, taskIds: result.imported_task_ids } });
      return reply.code(201).send(result);
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "plan_import_failed" }); }
  });
  app.post<{ Body: { title?: string } }>("/api/supervision/tasks", async (request, reply) => {
    if (request.body?.title !== undefined && typeof request.body.title !== "string") return reply.code(400).send({ error: "title_must_be_text" });
    const result = appendSupervisionTask(root, request.body?.title);
    orchestrator.events.emit({ type: "plan", message: `已新增 Plan 任务“${result.task.title}”；先完善任务与设计，不会自动派发。`, data: { kind: "supervision-task", taskId: result.task.id } });
    return reply.code(201).send(result);
  });
  app.put<{ Params: { id: string }; Body: unknown }>("/api/supervision/tasks/:id", async (request, reply) => {
    const parsed = SupervisionTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_supervision_task", issues: parsed.error.issues });
    if (parsed.data.id !== request.params.id) return reply.code(400).send({ error: "task_id_mismatch" });
    try { return writeSupervisionTask(root, parsed.data); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "task_update_failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/supervision/tasks/:id/freeze", async (request, reply) => {
    try {
      const document = freezeSupervisionTask(root, request.params.id);
      const task = document.tasks.find((item) => item.id === request.params.id)!;
      orchestrator.events.emit({ type: "approval", message: `Plan 任务“${task.title}”已冻结；后续 Goal 必须引用 ${document.plan.version}/${task.version}。`, data: { kind: "supervision-task", taskId: task.id, planVersion: document.plan.version, taskVersion: task.version } });
      return document;
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "task_freeze_failed" }); }
  });
  app.get("/api/completion", async (_request, reply) => {
    const audit = loadCompletionAudit(root);
    const findings = validateCompletionEvidence(root, audit);
    if (findings.length) return reply.code(409).send({ error: "completion_evidence_invalid", findings });
    const model = loadProject(root);
    const supervision = loadSupervision(root);
    const readiness = codexReadiness.readiness();
    return deriveCompletionProgress(audit, {
      acceptedSupervisionDetailIds: supervision.details.filter((detail) => detail.status === "accepted").map((detail) => detail.id),
      codexSmokePassed: readiness.smoke.status === "passed" && readiness.smoke.evidence_status === "verified",
      guardedBaselineIds: model.project.baselines.filter((baseline) => baseline.status === "guarded").map((baseline) => baseline.id)
    });
  });
  app.post<{ Body: { category?: string; title?: string; task_id?: string } }>("/api/supervision/details", async (request, reply) => {
    const category = request.body?.category;
    if (!category || !["function", "visual", "interaction", "copy", "asset"].includes(category)) return reply.code(400).send({ error: "invalid_supervision_category" });
    if (request.body.title !== undefined && typeof request.body.title !== "string") return reply.code(400).send({ error: "title_must_be_text" });
    if (request.body.task_id !== undefined && typeof request.body.task_id !== "string") return reply.code(400).send({ error: "task_id_must_be_text" });
    let document;
    try { document = appendSupervisionDetail(root, category as "function" | "visual" | "interaction" | "copy" | "asset", request.body.title, request.body.task_id); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : "task_not_found" }); }
    const detail = document.details.at(-1)!;
    orchestrator.events.emit({ type: "system", message: `已新增“${detail.title}”草稿；尚未创建 Goal、工程映射或 Agent 运行。`, data: { kind: "supervision", phase: "design", detailId: detail.id, category: detail.category } });
    return reply.code(201).send({ document, detail });
  });
  app.get("/api/capabilities", async () => ({ capabilities: loadCapabilities(root), contracts: loadPermissionContracts(root) }));
  app.post<{ Body: { capability_id?: string; detail_id?: string; purpose?: string } }>("/api/permission-contracts", async (request, reply) => {
    const capability = loadCapabilities(root).find((item) => item.id === request.body?.capability_id);
    const detail = loadSupervision(root).details.find((item) => item.id === request.body?.detail_id);
    if (!capability || !detail) return reply.code(404).send({ error: !capability ? "capability_not_found" : "detail_not_found" });
    const duplicate = loadPermissionContracts(root).find((item) => item.capability_id === capability.id && item.detail_id === detail.id && ["proposed", "approved"].includes(item.status));
    if (duplicate) return reply.code(409).send({ error: "active_contract_exists", contract: duplicate });
    const now = new Date();
    const contract = writePermissionContract(root, {
      schema_version: 1,
      id: `permission-${randomUUID()}`,
      title: `${capability.title} → ${detail.title}`,
      capability_id: capability.id,
      detail_id: detail.id,
      status: "proposed",
      purpose: request.body?.purpose?.trim() || `仅用于“${detail.title}”的 ${detail.category} 类任务`,
      allowed_actions: [...capability.actions.map((item) => `能力动作：${item}`), ...detail.prompt.allowed_changes.map((item) => `任务范围：${item}`)],
      forbidden_actions: [...capability.constraints, ...detail.prompt.forbidden_changes],
      credential_mode: capability.requires_credential ? "server_only" : "none",
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: now.toISOString(),
      reviewed_at: null
    });
    orchestrator.events.emit({ type: "approval", message: `已生成“${contract.title}”授权草案，等待人工批准。`, data: { kind: "permission-contract", contractId: contract.id } });
    return reply.code(201).send(contract);
  });
  app.post<{ Params: { id: string }; Body: { verdict?: "approved" | "revoked" } }>("/api/permission-contracts/:id/review", async (request, reply) => {
    const verdict = request.body?.verdict;
    if (!verdict || !["approved", "revoked"].includes(verdict)) return reply.code(400).send({ error: "invalid_verdict" });
    const contract = loadPermissionContracts(root).find((item) => item.id === request.params.id);
    if (!contract) return reply.code(404).send({ error: "contract_not_found" });
    const capability = loadCapabilities(root).find((item) => item.id === contract.capability_id)!;
    if (verdict === "approved" && capability.status !== "available") return reply.code(409).send({ error: "capability_disabled" });
    let next;
    try { next = writePermissionContract(root, { ...contract, status: verdict, reviewed_at: new Date().toISOString() }); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "invalid_permission_transition" }); }
    orchestrator.events.emit({ type: "approval", message: verdict === "approved" ? `已批准“${next.title}”，仅限合同声明范围。` : `已撤销“${next.title}”。`, data: { kind: "permission-contract", contractId: next.id, verdict } });
    return next;
  });
  app.post<{ Params: { id: string }; Body: { mode?: "mock" | "codex" } }>("/api/supervision/details/:id/dispatch", async (request, reply) => {
    try { return dispatchSupervisionDetail(root, orchestrator.events, request.params.id, request.body?.mode ?? "mock"); }
    catch (error) {
      const message = error instanceof Error ? error.message : "dispatch_failed";
      return reply.code(message.startsWith("credential_required") ? 409 : 404).send({ error: message });
    }
  });
  app.post<{ Params: { id: string }; Body: ExternalAgentReceipt }>("/api/supervision/details/:id/external-output", async (request, reply) => {
    try { return reply.code(201).send(attachExternalSupervisionOutput(root, orchestrator.events, request.params.id, request.body)); }
    catch (error) {
      const message = error instanceof Error ? error.message : "external_receipt_invalid";
      return reply.code(message.startsWith("detail_not_found") ? 404 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { id: string } }>("/api/supervision/details/:id/compile-goal", async (request, reply) => {
    try {
      const compiled = compileSupervisionDetail(root, request.params.id);
      return reply.code(compiled.existing ? 200 : 201).send({ ...compiled, validation: orchestrator.compile(compiled.change.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "compile_failed";
      const status = message.startsWith("detail_not_found") || message.startsWith("supervision_task_not_found") ? 404 : message.startsWith("detail_not_ready") || message.startsWith("execution_scope_required") || message.startsWith("supervision_task_not_frozen") ? 409 : 400;
      return reply.code(status).send({ error: message });
    }
  });
  app.post<{ Params: { id: string } }>("/api/supervision/details/:id/dispatch-goal", async (request, reply) => {
    try { return reply.code(202).send(dispatchSupervisionGoal(root, orchestrator, request.params.id)); }
    catch (error) {
      const message = error instanceof Error ? error.message : "dispatch_failed";
      const status = message.startsWith("detail_not_found") ? 404 : 409;
      return reply.code(status).send({ error: message });
    }
  });
  app.post<{ Params: { id: string } }>("/api/supervision/runs/:id/stop", async (request, reply) => {
    try { return await stopSupervisionGoalRun(root, orchestrator, request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "stop_failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/supervision/runs/:id/resume", async (request, reply) => {
    try { return reply.code(202).send(resumeSupervisionGoalRun(root, orchestrator, request.params.id)); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "resume_failed" }); }
  });
  app.put<{ Params: { id: string }; Body: unknown }>("/api/supervision/details/:id", async (request, reply) => {
    const parsed = SupervisionDetailSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_supervision_detail", issues: parsed.error.issues });
    if (parsed.data.id !== request.params.id) return reply.code(400).send({ error: "detail_id_mismatch" });
    const current = loadSupervision(root).details.find((item) => item.id === request.params.id);
    if (!current) return reply.code(404).send({ error: "detail_not_found" });
    if (parsed.data.task_id !== current.task_id) return reply.code(409).send({ error: "detail_task_immutable" });
    if (parsed.data.category !== current.category) return reply.code(409).send({ error: "detail_category_immutable" });
    const activeRun = loadSupervisionRuns(root).filter((run) => run.detail_id === current.id).at(-1);
    if (activeRun && ["queued", "running"].includes(activeRun.status)) return reply.code(409).send({ error: "detail_has_active_run" });
    const designContent = (detail: typeof current) => ({ title: detail.title, intent: detail.intent, acceptance: detail.acceptance, prompt: { ...detail.prompt, version: undefined }, execution: detail.execution });
    if (JSON.stringify(designContent(current)) === JSON.stringify(designContent(parsed.data))) return reply.code(400).send({ error: "no_design_changes" });
    const nextVersion = (value: string, prefix: string) => `${prefix}${Number(value.match(/\d+$/)?.[0] ?? 0) + 1}`;
    if (parsed.data.version !== nextVersion(current.version, "v")) return reply.code(409).send({ error: "detail_version_conflict", expected: nextVersion(current.version, "v") });
    if (parsed.data.prompt.version !== nextVersion(current.prompt.version, "p")) return reply.code(409).send({ error: "prompt_version_conflict", expected: nextVersion(current.prompt.version, "p") });
    try { return writeSupervisionDetail(root, { ...parsed.data, status: "ready", output: undefined }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "detail_not_found";
      return reply.code(message.startsWith("Invalid supervision transition") ? 409 : 404).send({ error: message });
    }
  });
  app.post<{ Params: { id: string }; Body: { verdict?: string; note?: string } }>("/api/supervision/details/:id/review", async (request, reply) => {
    if (!request.body || !["accepted", "needs_revision"].includes(request.body.verdict ?? "")) return reply.code(400).send({ error: "invalid_verdict" });
    const document = loadSupervision(root);
    const detail = document.details.find((item) => item.id === request.params.id);
    if (!detail) return reply.code(404).send({ error: "detail_not_found" });
    if (!detail.output) return reply.code(409).send({ error: "output_required" });
    const reviewerNote = typeof request.body.note === "string" ? request.body.note.trim() : "";
    let nextDocument;
    try {
      nextDocument = writeSupervisionDetail(root, {
        ...detail,
        status: request.body.verdict === "accepted" ? "accepted" : "needs_revision",
        output: { ...detail.output, reviewer_status: request.body.verdict as "accepted" | "needs_revision", reviewer_note: reviewerNote }
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "invalid_supervision_transition" });
    }
    const latestRun = loadSupervisionRuns(root).filter((run) => run.detail_id === detail.id
      && run.output?.produced_at === detail.output?.produced_at
      && run.prompt_snapshot.version === detail.prompt.version).at(-1);
    // A reopened design does not rewrite an already-final historical run verdict.
    if (latestRun?.output && latestRun.status === "reviewing") writeSupervisionRun(root, {
      ...latestRun,
      status: request.body.verdict as "accepted" | "needs_revision",
      output: { ...latestRun.output, reviewer_status: request.body.verdict as "accepted" | "needs_revision", reviewer_note: reviewerNote },
      events: [...latestRun.events, { type: "review", message: request.body.verdict === "accepted" ? "监督者已通过本条产出。" : "监督者要求保持类别隔离后重做。", at: new Date().toISOString() }]
    });
    orchestrator.events.emit({ type: "approval", message: request.body.verdict === "accepted" ? `“${detail.title}”已通过人工检查。` : `“${detail.title}”被退回，只允许重做 ${detail.category} 类别。`, data: { kind: "supervision", detailId: detail.id, verdict: request.body.verdict } });
    return nextDocument;
  });
  app.get("/api/status", async () => {
    const model = loadProject(root);
    return { ...projectMap(model).metrics, ...orchestrator.status(), gateway: gateway.kind, frontier: model.project.frontier };
  });
  app.post<{ Body: { title: string; body?: string } }>("/api/inbox/capture", async (request, reply) => {
    if (typeof request.body?.title !== "string" || !request.body.title.trim()) return reply.code(400).send({ error: "title_required" });
    if (request.body.body !== undefined && typeof request.body.body !== "string") return reply.code(400).send({ error: "body_must_be_text" });
    return reply.code(201).send(captureIdea(root, request.body.title.trim(), request.body.body?.trim()));
  });
  app.post<{ Body: { text: string } }>("/api/plan/import", async (request, reply) => {
    if (typeof request.body?.text !== "string" || !request.body.text.trim()) return reply.code(400).send({ error: "plan_text_required" });
    return { candidates: parsePlanCandidates(request.body.text), notice: "导入只生成候选，不会静默建立正式关系。" };
  });
  app.post<{ Body: { id: string } }>("/api/impact", async (request, reply) => {
    const model = loadProject(root);
    if (typeof request.body?.id !== "string" || !request.body.id) return reply.code(400).send({ error: "id_required" });
    if (request.body.id !== model.project.id && !allGraphEntities(model).some((item) => item.id === request.body.id)) return reply.code(404).send({ error: "entity_not_found" });
    return impactReport(model, request.body.id);
  });
  app.post<{ Params: { id: string } }>("/api/changesets/:id/compile", async (request, reply) => {
    try { return orchestrator.compile(request.params.id); }
    catch (error) { return reply.code(apiErrorStatus(error)).send({ error: error instanceof Error ? error.message : "compile_failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/changesets/:id/dispatch", async (request, reply) => {
    try { return orchestrator.dispatch(request.params.id); }
    catch (error) { return reply.code(apiErrorStatus(error)).send({ error: error instanceof Error ? error.message : "dispatch_failed" }); }
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = loadProject(root).runs.find((item) => item.id === request.params.id);
    return run ?? reply.code(404).send({ error: "run_not_found" });
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (request, reply) => {
    try { return await orchestrator.stop(request.params.id); }
    catch (error) { return reply.code(apiErrorStatus(error)).send({ error: error instanceof Error ? error.message : "stop_failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (request, reply) => {
    try { return orchestrator.resume(request.params.id); }
    catch (error) { return reply.code(apiErrorStatus(error)).send({ error: error instanceof Error ? error.message : "resume_failed" }); }
  });
  app.post("/api/index/rebuild", async () => rebuildIndex(root));
  app.get("/api/validate", async () => validateProject(root));
  app.get<{ Querystring: { after?: string } }>("/api/events", async (request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const write = (event: { id: number }) => reply.raw.write(serializeSseEvent(event));
    const cursor = resolveSseCursor(request.query.after, request.headers["last-event-id"]);
    for (const event of orchestrator.events.since(cursor)) write(event);
    const listener = (event: { id: number }) => write(event);
    orchestrator.events.emitter.on("event", listener);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20_000);
    request.raw.on("close", () => { clearInterval(heartbeat); orchestrator.events.emitter.off("event", listener); });
    return reply.hijack();
  });

  const webDist = join(root, "apps", "web", "dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "not_found" }) : reply.sendFile("index.html"));
  }
  return app;
}

export function resolveSseCursor(queryAfter?: string, lastEventId?: string | string[]) {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const value = Number(queryAfter ?? header ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function serializeSseEvent(event: { id: number }) {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function apiErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Unknown (?:Change Set|run|goal):/.test(message)) return 404;
  if (/required|rejected|not_(?:stoppable|resumable)|already_running|orchestrator_already_running/i.test(message)) return 409;
  return 400;
}

export interface GatewaySelection {
  gateway: AgentGateway;
  health: Record<string, string | boolean>;
  initialize?: () => Promise<void>;
}

export interface GatewaySelectionDependencies {
  runtimeReady?: (root: string) => boolean;
  createTransport?: typeof createProjectCodexTransport;
}

export function registerCodexReadinessRoutes(app: FastifyInstance, options: {
  selection: GatewaySelection;
  requestedGateway: "mock" | "codex-app-server";
  readonlyLegacy: boolean;
  codexReadiness: CodexReadinessManager;
}) {
  const { selection, requestedGateway, readonlyLegacy, codexReadiness } = options;
  app.get("/api/health", async () => ({ ok: true, host: "127.0.0.1", gateway: selection.gateway.kind, readonly_legacy: readonlyLegacy, ...liveGatewayHealth(selection, requestedGateway) }));
  app.get("/api/codex/readiness", async () => codexReadiness.readiness());
  app.get("/api/codex/smoke/receipt", async (_request, reply) => {
    try {
      return reply.header("Content-Disposition", 'attachment; filename="codex-smoke-receipt.json"')
        .header("Cache-Control", "no-store").send(codexReadiness.receipt());
    } catch { return reply.code(404).send({ error: "smoke_receipt_unavailable" }); }
  });
  app.post("/api/codex/smoke", async (_request, reply) => {
    try { return reply.code(202).send(codexReadiness.start()); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "codex_smoke_start_failed" }); }
  });
  app.post("/api/codex/smoke/stop", async (_request, reply) => {
    try { return await codexReadiness.stop(); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "codex_smoke_stop_failed" }); }
  });
}

export function liveGatewayHealth(selection: GatewaySelection, requested: "mock" | "codex-app-server") {
  const gatewayReady = selection.gateway.ready !== false;
  return {
    ...selection.health,
    gateway_ready: gatewayReady,
    ...(requested === "codex-app-server" ? { app_server: gatewayReady ? "ready" : "unavailable" } : {})
  };
}

export function selectGateway(root: string, requested: "mock" | "codex-app-server", source: NodeJS.ProcessEnv = process.env, dependencies: GatewaySelectionDependencies = {}): GatewaySelection {
  if (requested === "mock") return { gateway: new MockAgentGateway(), health: { credential: "not_required", runtime: "not_required", enabled: true, app_server: "not_required" } };
  const apiKeyConfigured = Boolean(source.OPENAI_API_KEY?.trim());
  const explicitlyEnabled = source.EPM_ENABLE_CODEX === "1";
  const runtimeReady = (dependencies.runtimeReady ?? localCodexRuntimeReady)(root);
  const health: Record<string, string | boolean> = {
    credential: apiKeyConfigured ? "configured" : "unchecked",
    credential_source: "none",
    runtime: runtimeReady ? "ready" : "required",
    enabled: explicitlyEnabled,
    app_server: "unavailable"
  };
  if (!explicitlyEnabled) return { gateway: new DeferredCodexGateway("codex_enable_required: 设置 EPM_ENABLE_CODEX=1 后才会启动真实 Gateway。"), health };
  if (!runtimeReady) return { gateway: new DeferredCodexGateway("codex_runtime_required: 项目本地 Codex CLI 不完整，真实 Gateway 未启动。"), health };
  health.app_server = "checking";
  const transport = (dependencies.createTransport ?? createProjectCodexTransport)(root, source);
  const gateway = new CodexAppServerGateway(transport, root, false, () => transport.selectedModel());
  return {
    gateway,
    health,
    initialize: async () => {
      try {
        const readiness = await transport.verify();
        gateway.setReady(true);
        health.credential = "configured";
        health.credential_source = readiness.credential_source;
        health.codex_model = readiness.selected_model ?? "server-default";
        health.app_server = "ready";
      } catch {
        const failure = transport.readiness().reason ?? "codex_runtime_unavailable:app-server";
        const credentialSource = transport.readiness().credential_source;
        gateway.setReady(false);
        health.credential_source = credentialSource;
        health.credential = credentialSource !== "none" ? "configured"
          : failure.startsWith("authentication_error") ? "rejected"
          : failure.startsWith("credential_required") ? "required"
          : apiKeyConfigured ? "configured" : "required";
        health.app_server = "unavailable";
        health.readiness_failure = failure;
        await transport.close().catch(() => undefined);
      }
    }
  };
}
