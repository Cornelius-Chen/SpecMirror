import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadEngineering } from "@epm/spec-io";
import { AppServerRpcError, StdioJsonRpcTransport, safeAppServerEnvironment, type JsonRpcTransport } from "./stdio-jsonrpc.ts";
import { isRecentAgentSession } from "./agent-session-presence.ts";

type Thread = { id: string; name?: string | null; preview?: string; cwd?: string; updatedAt: number; recencyAt?: number; isPinned?: boolean; source?: unknown; ephemeral?: boolean; parentThreadId?: string | null };
type Receipt = { version: string; at: string };
export type TaskConnectionCandidate = { thread_id: string; cwd: string; source: "workspace" | "hook"; observed_at: string };
export type TaskConnection = { id: string; title: string; cwd: string; updatedAt: number; archive_status: "unknown" };
export type TaskConnections = { data: TaskConnection[]; partial: boolean; syncedAt: string };
const CONNECTION_LIMIT = 20, CONNECTION_CACHE_MS = 30_000, CONNECTION_DEADLINE_MS = 5_000;
function connectionCwd(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f]/.test(value)) return null;
  try {
    const path = normalize(existsSync(value) ? realpathSync.native(value) : resolve(value));
    return process.platform === "win32" ? path.replace(/^\\\\\?\\/, "").toLowerCase() : path;
  } catch { return null; }
}
function connectionCandidates(input: TaskConnectionCandidate[]) {
  const grouped = new Map<string, { id: string; cwds: Set<string>; at: number }>();
  for (const candidate of input) {
    const at = Date.parse(candidate.observed_at);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(candidate.thread_id) || typeof candidate.cwd !== "string" || !isAbsolute(candidate.cwd) || /[\x00-\x1f]/.test(candidate.cwd) || !Number.isFinite(at)
      || !["workspace", "hook"].includes(candidate.source) || candidate.source === "hook" && !isRecentAgentSession(candidate.observed_at)) continue;
    const entry = grouped.get(candidate.thread_id) ?? { id: candidate.thread_id, cwds: new Set<string>(), at };
    // One persisted workspace and one latest Hook can supply at most two directories per task.
    if (entry.cwds.size < 2) entry.cwds.add(candidate.cwd);
    entry.at = Math.max(entry.at, at); grouped.set(entry.id, entry);
  }
  // Bound the candidate set before filesystem canonicalization, not just before remote reads.
  const candidates = [...grouped.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, CONNECTION_LIMIT)
    .map(candidate => ({ ...candidate, cwds: new Set([...candidate.cwds].map(connectionCwd).filter((cwd): cwd is string => cwd !== null)) })).filter(candidate => candidate.cwds.size > 0);
  // Receipt timestamps change frequently; only candidate identities and directories invalidate cached reads.
  const key = JSON.stringify(candidates.map(candidate => [candidate.id, [...candidate.cwds].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return { candidates, key, truncated: grouped.size > CONNECTION_LIMIT };
}
export const taskVersion = (t: Thread) => createHash("sha256").update(JSON.stringify([t.id,t.updatedAt,t.recencyAt,t.name,t.preview,t.cwd])).digest("hex");
export function taskMessage(value: string, limit = 24000) {
  const withoutContext = value.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, "").replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
  const cleaned = (/^## Referenced ChatGPT conversation\b/i.test(withoutContext) ? withoutContext.split(/(?:^|\n)## My request:\s*/i).at(-1)! : withoutContext).replace(/^\s*## My request:\s*/i, "").trim();
  return cleaned.length > limit ? cleaned.slice(0,limit) + "\n\n（内容较长，此处为节选；完整内容请在 Codex 中查看。）" : cleaned;
}
export function catalogTransport(root: string) {
  // Prefer the desktop binary: older project CLIs cannot read paginated desktop histories.
  const binary = process.env.CODEX_TASK_CATALOG_BINARY ?? (process.env.PATH ?? process.env.Path ?? "").split(delimiter).map(p => join(p, process.platform === "win32" ? "codex.exe" : "codex")).find(existsSync);
  const env = safeAppServerEnvironment(process.env); delete env.OPENAI_API_KEY;
  return new StdioJsonRpcTransport({ command: binary ?? process.execPath, args: [...(binary ? [] : [join(root,"node_modules/@openai/codex/bin/codex.js")]),"app-server","--listen","stdio://"], cwd: root, env });
}

export class TaskCatalog {
  private transport?: JsonRpcTransport;
  private readonly connectionTransports = new Set<JsonRpcTransport>();
  private readonly turnTransports = new Set<JsonRpcTransport>();
  private connectionCache?: { key: string; expiresAt: number; result: TaskConnections };
  private connectionRead?: Promise<{ key: string; result: TaskConnections }>;
  private readonly secret = randomBytes(32);
  private readonly path: string;
  constructor(readonly root: string, private factory: () => JsonRpcTransport = () => catalogTransport(root)) { this.path = join(root,".project","task-inbox","receipts.json"); }
  private async rpc<T>(method: string, params: Record<string,unknown>) {
    const transport = this.transport ??= this.factory();
    try { return await transport.request<T>(method,params); }
    catch(error) {
      if (!(error instanceof AppServerRpcError) && this.transport === transport) { this.transport = undefined; await transport.close(); }
      throw error;
    }
  }
  private receipts(): Record<string,Receipt> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path,"utf8")) : {}; }
  private token(id: string, version: string) { return createHmac("sha256",this.secret).update(`${id}:${version}`).digest("hex"); }
  private summary(t: Thread, receipts: Record<string,Receipt>) {
    const version = taskVersion(t);
    return { id:t.id, title:t.name || t.preview?.split("\n")[0]?.slice(0,160) || "未命名任务", cwd:t.cwd ?? "", updatedAt:t.updatedAt, pinned:!!t.isPinned, version, received:receipts[t.id]?.version === version, receivedAt:(receipts[t.id]?.at ?? null) as string | null };
  }
  async list(input: { cursor?: string; search?: string; archived?: boolean }) {
    const result = await this.rpc<{data:Thread[];nextCursor:string|null}>("thread/list", {limit:50,sortKey:"updated_at",useStateDbOnly:true,sourceKinds:["cli","vscode","appServer","exec","unknown"],archived:!!input.archived,...(input.cursor ? {cursor:input.cursor} : {}),...(input.search ? {searchTerm:input.search} : {})});
    const receipts = this.receipts();
    return {data:result.data.map(t=>this.summary(t,receipts)),nextCursor:result.nextCursor ?? null,syncedAt:new Date().toISOString(),scope:"local"};
  }
  async source(id: string) {
    const {thread} = await this.rpc<{thread:Thread}>("thread/read",{threadId:id,includeTurns:false});
    if (thread.id !== id) throw new Error("task_source_identity_mismatch");
    return {...this.summary(thread,this.receipts()),preview:taskMessage(thread.preview ?? "",16000)};
  }
  /** Corroborate a signed Hook's new turn; this is identity metadata, never approval.
   * Desktop delegated turns need not emit UserPromptSubmit. No positive result is
   * cached, and the dedicated, bounded read cannot stall the task list transport. */
  verifyCurrentTurn(input: { sessionId: string; cwd: string; turnId: string }): Promise<typeof input | null> {
    const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
    const cwd = connectionCwd(input.cwd);
    if (!validId(input.sessionId) || !validId(input.turnId) || !cwd || this.turnTransports.size >= 2) return Promise.resolve(null);
    const transport = this.factory(); this.turnTransports.add(transport);
    return new Promise(resolveResult => {
      let settled = false;
      const finish = (verified: boolean) => {
        if (settled) return; settled = true; clearTimeout(timer);
        void transport.close().catch(() => {}).finally(() => this.turnTransports.delete(transport));
        resolveResult(verified ? { ...input } : null);
      };
      const timer = setTimeout(() => finish(false), 1_500);
      void (async () => {
        try {
          const { thread } = await transport.request<{ thread: Thread }>("thread/read", { threadId: input.sessionId, includeTurns: false });
          if (settled) return;
          if (!thread || thread.id !== input.sessionId || connectionCwd(thread.cwd) !== cwd || !["cli", "vscode", "appServer"].includes(String(thread.source))
            || thread.ephemeral !== false || thread.parentThreadId !== null || !Number.isFinite(thread.updatedAt)) return finish(false);
          const result = await transport.request<{ data: Array<{ id: string; status: string; completedAt?: number | null }> }>("thread/turns/list", {
            threadId: input.sessionId, limit: 1, sortDirection: "desc", itemsView: "summary"
          });
          const turn = result?.data?.[0];
          // Desktop recovery can persist "interrupted" while a signed tool Hook
          // proves activity. A completed turn or an unknown status cannot revive.
          finish(result?.data?.length === 1 && turn?.id === input.turnId && turn.completedAt === null
            && ["inProgress", "interrupted"].includes(turn.status));
        } catch { finish(false); }
      })();
    });
  }
  /** Separate discovery surface: thread/read does not prove current/archive membership or authority. */
  async connections(input: TaskConnectionCandidate[]): Promise<TaskConnections> {
    const selected = connectionCandidates(input);
    if (!selected.candidates.length) return { data: [], partial: false, syncedAt: new Date().toISOString() };
    if (this.connectionCache?.key === selected.key && this.connectionCache.expiresAt > Date.now()) return { ...this.connectionCache.result, partial: this.connectionCache.result.partial || selected.truncated };
    if (!this.connectionRead) {
      const pending = this.readConnections(selected.candidates).then(result => {
        // Failed or timed-out reads must be retryable immediately from the connection panel.
        if (!result.partial) this.connectionCache = { key: selected.key, expiresAt: Date.now() + CONNECTION_CACHE_MS, result };
        return { key: selected.key, result };
      });
      this.connectionRead = pending;
      void pending.finally(() => { if (this.connectionRead === pending) this.connectionRead = undefined; }).catch(() => {});
    }
    const batch = await this.connectionRead;
    // Concurrent callers share one bounded batch, even if Hook candidates change while it runs.
    const data = batch.result.data.filter(task => selected.candidates.some(candidate => candidate.id === task.id && candidate.cwds.has(connectionCwd(task.cwd)!)));
    return { ...batch.result, data, partial: batch.result.partial || selected.truncated || batch.key !== selected.key };
  }
  private readConnections(candidates: ReturnType<typeof connectionCandidates>["candidates"]): Promise<TaskConnections> {
    const transport = this.factory(); this.connectionTransports.add(transport);
    return new Promise(resolveResult => {
      const data: TaskConnection[] = []; let next = 0, workers = 2, settled = false, partial = false;
      const finish = (incomplete = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        // This dedicated transport cannot interrupt the original directory/history reader.
        void transport.close().catch(() => {}).finally(() => this.connectionTransports.delete(transport));
        resolveResult({ data: data.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), partial: partial || incomplete, syncedAt: new Date().toISOString() });
      };
      const timer = setTimeout(() => finish(true), CONNECTION_DEADLINE_MS);
      const worker = async () => {
        while (!settled && next < candidates.length) {
          const candidate = candidates[next++];
          try {
            const { thread } = await transport.request<{ thread: Thread }>("thread/read", { threadId: candidate.id, includeTurns: false });
            if (settled) return;
            const cwd = connectionCwd(thread?.cwd);
            if (!thread || thread.id !== candidate.id || !cwd || !candidate.cwds.has(cwd) || !["cli", "vscode", "appServer"].includes(String(thread.source))
              || thread.ephemeral !== false || thread.parentThreadId !== null || !Number.isFinite(thread.updatedAt)) { partial = true; continue; }
            data.push({ id: thread.id, title: this.summary(thread, {}).title, cwd: thread.cwd!, updatedAt: thread.updatedAt, archive_status: "unknown" });
          } catch { partial = true; }
        }
        if (--workers === 0) finish();
      };
      void worker(); void worker();
    });
  }
  async detail(id: string, cursor?: string) {
    const {thread} = await this.rpc<{thread:Thread}>("thread/read",{threadId:id,includeTurns:false});
    const summary = this.summary(thread,this.receipts());
    let history: { data: Array<{id:string;status:string;items:Array<{type:string;text?:string;content?:Array<{type:string;text?:string}>}>}>;nextCursor:string|null } | undefined;
    let historyUnavailable = false;
    try { history = await this.rpc("thread/turns/list",{threadId:id,limit:3,sortDirection:"desc",itemsView:"summary",...(cursor ? {cursor} : {})}); }
    catch { historyUnavailable = true; }
    const nodes = loadEngineering(this.root).nodes.filter(n=>n.status !== "archived" && n.owner === `codex:${id}`).map(n=>({id:n.id,title:n.title,status:n.status}));
    return {...summary,preview:taskMessage(thread.preview ?? "",16000),token:this.token(id,summary.version),historyUnavailable,nodes,
      turns:(history?.data ?? []).map(turn=>({id:turn.id,status:turn.status,messages:turn.items.filter(item=>item.type === "userMessage" || item.type === "agentMessage").map(item=>({role:item.type === "userMessage" ? "user" : "assistant",text:taskMessage(item.text ?? item.content?.filter(c=>c.type === "text").map(c=>c.text).join("\n") ?? "")}))})),nextCursor:history?.nextCursor ?? null};
  }
  async receive(id: string, version: string, token: string) {
    if (token !== this.token(id,version)) throw new Error("请先打开任务，核对当前内容后再查收。");
    const {thread} = await this.rpc<{thread:Thread}>("thread/read",{threadId:id,includeTurns:false});
    if (taskVersion(thread) !== version) throw new Error("任务已有新更新，请刷新内容后再查收。");
    // No awaits between reading and atomic replacement, so concurrent receipts cannot lose each other.
    const receipts = this.receipts(); receipts[id] = {version,at:new Date().toISOString()};
    mkdirSync(dirname(this.path),{recursive:true}); const temp = `${this.path}.tmp`;
    writeFileSync(temp,JSON.stringify(receipts,null,2),"utf8"); renameSync(temp,this.path);
    return receipts[id];
  }
  async close() { await Promise.all([this.transport?.close(), ...[...this.connectionTransports, ...this.turnTransports].map(transport => transport.close())]); }
}

export function registerTaskCatalogRoutes(app: FastifyInstance, root: string, catalog = new TaskCatalog(root), candidates: () => TaskConnectionCandidate[] = () => []) {
  app.addHook("onClose",()=>catalog.close());
  const text = (v:unknown, max=4096) => typeof v === "string" && v.length <= max ? v : undefined;
  app.get("/api/task-inbox/connections", async (_req, reply) => {
    try { return await catalog.connections(candidates()); }
    catch { return reply.code(503).send({ error: "暂时无法核对最近连接的 Codex 任务，请稍后重试。" }); }
  });
  app.get<{Querystring:{cursor?:string;search?:string;archived?:string}}>("/api/task-inbox",async(req,reply)=>{
    try { return await catalog.list({cursor:text(req.query.cursor),search:text(req.query.search,200),archived:req.query.archived === "true"}); }
    catch { return reply.code(503).send({error:"暂时无法读取本机 Codex 任务，请确认 Codex 已安装后重试。"}); }
  });
  app.get<{Params:{id:string};Querystring:{cursor?:string}}>("/api/task-inbox/:id",async(req,reply)=>{
    try { return await catalog.detail(req.params.id,text(req.query.cursor)); }
    catch { return reply.code(503).send({error:"暂时无法读取此任务，请刷新后重试。"}); }
  });
  app.post<{Params:{id:string};Body:{version?:string;token?:string}}>("/api/task-inbox/:id/receive",async(req,reply)=>{
    if (req.headers["x-engineering-agent-session-id"]) return reply.code(403).send({error:"查收由用户操作。"});
    try { return await catalog.receive(req.params.id,text(req.body?.version,128) ?? "",text(req.body?.token,128) ?? ""); }
    catch(error) { return reply.code(409).send({error:error instanceof Error ? error.message : "查收未保存，请重试。"}); }
  });
}
