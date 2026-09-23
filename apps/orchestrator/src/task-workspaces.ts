import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EngineeringNodeSchema, type EngineeringDocument } from "@epm/domain";
import { atomicWriteYaml, engineeringDocumentPath, loadEngineering, readYaml } from "@epm/spec-io";
import { readCompanionStatus, type CompanionSession } from "./codex-companion.ts";
import { createEngineeringJervisBridge, type EngineeringJervisBridge } from "./engineering-jervis.ts";
import { EngineeringExecutionService, EngineeringHostScheduler, EngineeringServiceError } from "./engineering-service.ts";
import type { EventBus } from "./events.ts";
import type { TaskCatalog } from "./task-catalog.ts";
import { registerHumanApprovalGuard } from "./human-approval.ts";
import { isRecentAgentSession } from "./agent-session-presence.ts";
import type { EngineeringRunUsageObserver } from "./codex-run-metrics.ts";

export interface TaskWorkspaceRecord {
  id: string; thread_id: string | null; title: string; source_cwd: string;
  kind: "existing" | "managed"; source_version: string | null; created_at: string;
}
export interface TaskWorkspaceSummary extends TaskWorkspaceRecord {
  root_node_id: string; revision: number; status: string;
  counts: { total: number; accepted: number; review: number; running: number; blocked: number };
  attention_counts: { review: number; running: number; blocked: number };
  updated_at: string;
}
export interface TaskWorkspaceOptions {
  jervis?: EngineeringJervisBridge;
  sessions?: (record: TaskWorkspaceRecord) => CompanionSession[];
  observations?: (record: TaskWorkspaceRecord) => CompanionSession[];
  hostSourceRoots?: readonly string[];
  usageObserver?: EngineeringRunUsageObserver;
}
export interface TaskWorkspaceContext {
  record: TaskWorkspaceRecord;
  root: string;
  service: EngineeringExecutionService;
}
type Registry = { schema_version: 1; workspaces: TaskWorkspaceRecord[] };
const error = (code: string, message: string, status = 409): never => { throw new EngineeringServiceError(code, message, status); };
function canonical(path: string) {
  let ancestor = resolve(path); const suffix: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return resolve(existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor, ...suffix);
}
const samePath = (a: string, b: string) => {
  return relative(canonical(a), canonical(b)) === "";
};

/** Reviewable associations only. Chat history stays in Codex and is read on demand. */
export class TaskWorkspaces {
  readonly scheduler = new EngineeringHostScheduler();
  readonly services = new Map<string, EngineeringExecutionService>();
  readonly path: string;
  private closed = false;
  constructor(readonly root: string, readonly events: EventBus, readonly catalog: Pick<TaskCatalog, "source">, readonly options: TaskWorkspaceOptions = {}) {
    this.path = join(root, ".project", "task-workspaces", "registry.yaml");
    if (!existsSync(this.path)) {
      const doc = loadEngineering(root);
      this.persist({ schema_version: 1, workspaces: [{ id: "host", thread_id: null, title: doc.nodes.find(node => node.id === doc.root_id)?.title ?? "现有工程", source_cwd: resolve(root), kind: "existing", source_version: null, created_at: new Date().toISOString() }] });
    }
    // Eager recovery prevents an unopened workspace from retaining invisible active runs.
    for (const record of this.records()) this.resolve(record.id);
  }
  records() {
    const registry = readYaml<Registry>(this.path);
    if (registry.schema_version !== 1 || !Array.isArray(registry.workspaces)) error("task_workspace_registry_invalid", "任务关联目录无法读取。", 500);
    const ids = new Set<string>(), threads = new Set<string>();
    for (const record of registry.workspaces) {
      if (!record || !(record.id === "host" || /^workspace-[a-f0-9-]{36}$/.test(record.id)) || ids.has(record.id) || !isAbsolute(record.source_cwd) || (record.kind !== "existing" && record.kind !== "managed") || (record.id === "host") !== (record.kind === "existing")) error("task_workspace_registry_invalid", "任务关联记录无效。", 500);
      ids.add(record.id);
      if (record.thread_id !== null) {
        if (typeof record.thread_id !== "string" || !record.thread_id || threads.has(record.thread_id)) error("task_workspace_registry_invalid", "任务关联出现重复。", 500);
        threads.add(record.thread_id);
      }
    }
    if (!ids.has("host")) error("task_workspace_registry_invalid", "原有工程关联丢失。", 500);
    return registry.workspaces;
  }
  private assertManagedPath(path: string) {
    const expected = resolve(canonical(this.root), relative(resolve(this.root), resolve(path)));
    if (relative(expected, canonical(path)) !== "") error("task_workspace_path_escape", "工作区不能通过符号链接指向其他工作区或目录。", 403);
  }
  private persist(registry: Registry) { this.assertManagedPath(this.path); atomicWriteYaml(this.path, registry); }
  resolve(id = "host"): TaskWorkspaceContext {
    const record = this.records().find(item => item.id === id);
    if (!record) return error("task_workspace_not_found", "没有找到这个任务工作区。", 404);
    const root = record.kind === "existing" ? this.root : join(this.root, ".project", "task-workspaces", record.id);
    if (record.kind === "managed") this.assertManagedPath(engineeringDocumentPath(root));
    let service = this.services.get(id);
    if (!service) {
      if (this.closed) error("task_workspace_closed", "服务已关闭。", 503);
      if (record.kind === "managed" && !existsSync(engineeringDocumentPath(root))) error("task_workspace_document_missing", "该任务的工程文档缺失，请检查保存记录。", 409);
      service = new EngineeringExecutionService(root, this.events, this.options.jervis ?? createEngineeringJervisBridge(this.root), {
        scheduler: this.scheduler, workspaceId: id,
        agentSessions: () => this.sessions(id),
        agentObservations: () => this.options.observations?.(this.records().find(item => item.id === id)!) ?? [],
        approvedSourceRoots: () => id === "host" ? this.options.hostSourceRoots ?? [this.root] : [this.records().find(item => item.id === id)!.source_cwd],
        authorizeIdentity: (sessionId, cwd) => this.agentIdentityState(sessionId, cwd, id),
        candidateOwnerIdentity: (sessionId, cwd) => this.candidateOwnerIdentityState(sessionId, cwd, id),
        usageObserver: this.options.usageObserver
      });
      this.services.set(id, service);
    }
    return { record, root, service };
  }
  forThread(threadId: string): TaskWorkspaceContext | undefined {
    const record = this.records().find(item => item.thread_id === threadId);
    return record ? this.resolve(record.id) : undefined;
  }
  sessions(id: string) {
    const { record, service } = this.resolve(id);
    if (this.options.sessions) return this.options.sessions(record);
    const discovered = readCompanionStatus(this.root, this.services.get("host")?.runtime ?? service.runtime).sessions;
    return discovered.filter(session => record.thread_id ? session.session_id === record.thread_id && samePath(session.cwd, record.source_cwd) : samePath(session.cwd, record.source_cwd));
  }
  contextForAgent(sessionId: string, cwd: string, workspaceId?: string): TaskWorkspaceContext | undefined {
    return this.contextForAgentWithFreshness(sessionId, cwd, workspaceId, true);
  }
  private agentIdentityState(sessionId: string, cwd: string, workspaceId: string): false | "current" | "stale" {
    if (this.contextForAgentWithFreshness(sessionId, cwd, workspaceId, true)) return "current";
    return this.contextForAgentWithFreshness(sessionId, cwd, workspaceId, false) ? "stale" : false;
  }
  /** Eligibility for a proposed human assignment only; never execution authority.
   * The normal Agent resolver below still requires a persisted assignment. */
  private candidateOwnerIdentityState(sessionId: string, cwd: string, workspaceId: string): false | "current" | "stale" {
    if (!sessionId || !isAbsolute(cwd)) return false;
    const record = this.records().find(item => item.id === workspaceId);
    if (!record || !samePath(record.source_cwd, cwd)) return false;
    const observations = this.options.observations?.(record) ?? this.sessions(record.id);
    const matches = observations.filter(session => session.session_id === sessionId && samePath(session.cwd, cwd));
    if (!matches.length) return false;
    return matches.some(session => isRecentAgentSession(session.last_seen_at)) ? "current" : "stale";
  }
  private contextForAgentWithFreshness(sessionId: string, cwd: string, workspaceId: string | undefined, requireFresh: boolean): TaskWorkspaceContext | undefined {
    if (!sessionId || !isAbsolute(cwd)) return undefined;
    const match = this.records().filter(record => (!workspaceId || workspaceId === record.id)
      && (this.options.observations?.(record) ?? this.sessions(record.id)).some(session => session.session_id === sessionId && samePath(session.cwd, cwd) && (!requireFresh || isRecentAgentSession(session.last_seen_at)))
      && (record.thread_id === sessionId || (!record.thread_id && record.kind === "existing") || loadEngineering(this.resolve(record.id).root).nodes.some(node => node.status !== "archived" && node.owner === "codex:" + sessionId)));
    const primary = !workspaceId && match.find(record => record.thread_id === sessionId);
    return primary ? this.resolve(primary.id) : match.length === 1 ? this.resolve(match[0].id) : undefined;
  }
  summary(id: string): TaskWorkspaceSummary {
    const { record, service } = this.resolve(id), view = service.view(), root = view.derived[view.document.root_id];
    const active = view.document.nodes.filter(node => node.status !== "archived").map(node => view.derived[node.id]?.status ?? node.status);
    return { ...record, title: record.thread_id ? record.title : view.document.nodes.find(node => node.id === view.document.root_id)?.title ?? record.title,
      root_node_id: view.document.root_id, revision: view.document.revision, status: root?.status ?? "draft",
      counts: root?.counts ?? { total: 0, accepted: 0, review: 0, running: 0, blocked: 0 },
      attention_counts: { review: active.filter(status => status === "review").length, running: active.filter(status => status === "running").length, blocked: active.filter(status => ["blocked", "needs_revision", "paused"].includes(status)).length },
      updated_at: view.document.updated_at };
  }
  list() { return { data: this.records().map(record => this.summary(record.id)) }; }
  async connect(input: { thread_id: string; source_version: string; mode: "create" | "link_existing" }) {
    if (typeof input?.thread_id !== "string" || !input.thread_id || typeof input.source_version !== "string" || !["create", "link_existing"].includes(input.mode)) error("task_workspace_input_invalid", "请从真实任务目录选择任务并核对版本。", 400);
    let source: Awaited<ReturnType<TaskCatalog["source"]>>;
    try { source = await this.catalog.source(input.thread_id); }
    catch { return error("task_workspace_source_unavailable", "暂时无法核对 Codex 来源任务，请稍后重试。", 503); }
    if (source.version !== input.source_version) error("task_workspace_source_stale", "来源任务已经更新，请重新读取任务后建立关联。", 409);
    if (!isAbsolute(source.cwd)) error("task_workspace_source_cwd_missing", "来源任务没有可核对的工作目录。", 409);
    // No awaits below: re-read and atomic replace serialize concurrent HTTP association requests.
    const records = this.records(), existing = records.find(record => record.thread_id === input.thread_id);
    if (existing) {
      if ((input.mode === "link_existing") !== (existing.kind === "existing")) error("task_workspace_already_bound", "此任务已有工程，不能再关联另一套工程。", 409);
      return this.summary(existing.id);
    }
    const at = new Date().toISOString();
    let record: TaskWorkspaceRecord;
    if (input.mode === "link_existing") {
      record = records.find(item => item.id === "host")!;
      if (record.thread_id) error("task_workspace_existing_already_bound", "现有工程已经关联另一个 Codex 任务。", 409);
      Object.assign(record, { thread_id: source.id, source_cwd: source.cwd, title: source.title, source_version: source.version });
    } else {
      record = { id: "workspace-" + randomUUID(), thread_id: source.id, title: source.title, source_cwd: source.cwd, kind: "managed", source_version: source.version, created_at: at };
      const managedRoot = join(this.root, ".project", "task-workspaces", record.id);
      this.assertManagedPath(engineeringDocumentPath(managedRoot));
      const objective = source.preview.length > 11_900 ? source.preview.slice(0, 11_900) + "\n\n（来源摘要，完整请求见对话；请继续细化目标。）" : source.preview;
      const node = EngineeringNodeSchema.parse({ id: "engineering-project", parent_id: null, kind: "project", title: source.title, objective, delivery: { included: [], excluded: [], outputs: [], inputs: [] }, method: "", architecture: "", owner: "未分配", order: 0, revision: 1, status: "draft", constraints: { allow: ["artifacts/**"], deny: [], rules: [], resources: [] }, created_at: at, updated_at: at });
      const doc: EngineeringDocument = { schema_version: 1, id: "engineering-document", revision: 1, root_id: node.id, created_at: at, updated_at: at, nodes: [node], runs: [], events: [], changes: [], capability_uses: [] };
      mkdirSync(dirname(engineeringDocumentPath(managedRoot)), { recursive: true });
      atomicWriteYaml(engineeringDocumentPath(managedRoot), doc);
      records.push(record);
    }
    this.persist({ schema_version: 1, workspaces: records });
    this.events.emit({ type: "plan", message: "已将 Codex 任务关联到独立工程，方案仍需细化与分配。", data: { kind: "task-workspace", workspaceId: record.id, threadId: record.thread_id } });
    return this.summary(record.id);
  }
  async settled() { await Promise.all([...this.services.values()].map(service => service.settled())); }
  close() { this.closed = true; return Promise.all([...this.services.values()].map(service => service.close())).then(() => {}); }
}

export function requestWorkspaceId(request: FastifyRequest) {
  const header = request.headers["x-mirror-workspace-id"];
  const query = (request.query as { workspace?: unknown } | undefined)?.workspace;
  if ((header !== undefined && typeof header !== "string") || (query !== undefined && typeof query !== "string") || (header && query && header !== query)) error("task_workspace_scope_invalid", "工作区标识不一致。", 400);
  return (header ?? query ?? "host") as string;
}

export function registerTaskWorkspaceRoutes(app: FastifyInstance, workspaces: TaskWorkspaces,
  runPlans?: {
    readRunPlanProjections(workspaceId: string, workspaces: Pick<TaskWorkspaces, "resolve">): unknown;
    readTaskRunPlanProjections?(input: { session_id?: unknown; cwd?: unknown }): unknown;
    syncRunPlanProjection?(input: unknown, workspaces: Pick<TaskWorkspaces, "contextForAgent" | "records" | "resolve">): unknown;
  }) {
  registerHumanApprovalGuard(app);
  const respond = async (reply: { code(status: number): any }, operation: () => unknown | Promise<unknown>, success = 200) => {
    try { return reply.code(success).send(await operation()); }
    catch (failure) { const known = failure instanceof EngineeringServiceError; return reply.code(known ? failure.status : 400).send({ error: failure instanceof Error ? failure.message : String(failure), code: known ? failure.code : "task_workspace_failed" }); }
  };
  app.get("/api/task-workspaces", async (_request, reply) => respond(reply, () => workspaces.list()));
  app.get<{Params: {id: string}}>("/api/task-workspaces/:id/sessions", async (request, reply) => respond(reply, () => ({sessions: workspaces.sessions(request.params.id)})));
  if (runPlans) app.get<{Params: {id: string}}>("/api/task-workspaces/:id/run-plan-projections", async (request, reply) =>
    respond(reply, () => runPlans.readRunPlanProjections(request.params.id, workspaces)));
  if (runPlans?.readTaskRunPlanProjections) app.get<{ Params: { sessionId: string }; Querystring: { cwd?: string } }>("/api/task-run-plans/:sessionId", async (request, reply) =>
    respond(reply, () => runPlans.readTaskRunPlanProjections!({ session_id: request.params.sessionId, cwd: request.query.cwd })));
  if (runPlans?.syncRunPlanProjection) app.post<{Body: unknown}>("/api/codex-companion/run-plan", async (request, reply) =>
    respond(reply, () => runPlans.syncRunPlanProjection!(request.body ?? {}, workspaces), 201));
  app.post<{Body: {thread_id: string; source_version: string; mode: "create" | "link_existing"}}>("/api/task-workspaces", async (request, reply) => respond(reply, () => {
    if (request.headers["x-engineering-agent-session-id"]) error("engineering_human_action_required", "任务关联由用户在界面中确认。", 403);
    return workspaces.connect(request.body);
  }, 201));
}
