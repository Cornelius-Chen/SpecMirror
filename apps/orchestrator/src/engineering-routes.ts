import { extname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { EngineeringNode, EngineeringFeedbackCreate, EngineeringFeedbackUpdate } from "@epm/domain";
import type { EventBus } from "./events.ts";
import type { EngineeringJervisBridge } from "./engineering-jervis.ts";
import { EngineeringExecutionService, EngineeringServiceError, type EngineeringServiceOptions } from "./engineering-service.ts";
import { requestWorkspaceId, type TaskWorkspaces } from "./task-workspaces.ts";
import { authenticatedHumanApproval, registerHumanApprovalGuard } from "./human-approval.ts";
import { registerEngineeringWorkPackageRoutes } from "./engineering-work-package-routes.ts";
import { registerEngineeringRecheckPackageRoutes } from "./engineering-recheck-package-routes.ts";
import { buildEngineeringRunResult, EngineeringRunResultError } from "./engineering-run-result.ts";

export function registerEngineeringRoutes(app: FastifyInstance, root: string, events: EventBus, jervis?: EngineeringJervisBridge, workspaces?: TaskWorkspaces, serviceOptions?: EngineeringServiceOptions) {
  registerHumanApprovalGuard(app);
  const service = workspaces?.resolve("host").service ?? new EngineeringExecutionService(root, events, jervis, serviceOptions);
  const serviceFor = (request: FastifyRequest) => {
    const workspaceId = requestWorkspaceId(request);
    if (workspaces) return workspaces.resolve(workspaceId).service;
    if (workspaceId !== "host") throw new EngineeringServiceError("task_workspace_not_found", "没有找到这个任务工作区。", 404);
    return service;
  };
  const respond = async (reply: { code(status: number): any }, operation: () => unknown | Promise<unknown>, success = 200) => {
    try { return reply.code(success).send(await operation()); }
    catch (error) {
      const known = error instanceof EngineeringServiceError;
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(known ? error.status : message === "engineering_revision_conflict" ? 409 : 400).send({ error: message, code: known ? error.code : message });
    }
  };
  const resultError = (reply: { code(status: number): any }, error: unknown) => reply.code(
    error instanceof EngineeringRunResultError || error instanceof EngineeringServiceError ? error.status : 500
  ).send({ code: error instanceof EngineeringRunResultError || error instanceof EngineeringServiceError ? error.code : "engineering_result_unavailable",
    error: error instanceof EngineeringRunResultError ? error.message : "无法读取该工作区的运行结果。" });
  const actor = (request: FastifyRequest) => typeof request.headers["x-engineering-agent-session-id"] === "string" ? "codex:" + request.headers["x-engineering-agent-session-id"] : authenticatedHumanApproval(request) ? "human:" + authenticatedHumanApproval(request)!.principalId : undefined;
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/engineering")) return;
    try { serviceFor(request); } catch (error) { return request.routeOptions.url === "/api/engineering/runs/:id/result" ? resultError(reply, error) : respond(reply, () => { throw error; }); }
    const route = request.routeOptions.url;
    // Structure proposal discovery and preview are review-only reads. They do
    // not grant ownership or execution authority, even when an Agent identifies
    // itself, and must remain available before a trusted human verifier exists.
    if (route === "/api/engineering/structure-proposal" || route === "/api/engineering/structure-proposal/preview"
      || route === "/api/engineering/work-package/preview" || route === "/api/engineering/work-package/recheck/preview") return;
    const sessionId = request.headers["x-engineering-agent-session-id"];
    const encodedCwd = request.headers["x-engineering-cwd"];
    if (sessionId === undefined && encodedCwd === undefined) return;
    try {
      if (typeof sessionId !== "string" || typeof encodedCwd !== "string") throw new EngineeringServiceError("engineering_agent_context_required", "Agent 请求必须同时声明会话和工作目录。", 403);
      const cwd = decodeURIComponent(encodedCwd);
      const service = serviceFor(request);
      service.authorizeAgent(sessionId, cwd);
      if (request.method === "GET") return;
      const params = request.params as { id?: string };
      const body = request.body as { parent_id?: string; node?: EngineeringNode; node_ids?: string[]; mode?: string; target?: {node_id?:string}; scope_node_ids?: string[] } | undefined;
      if (route?.endsWith("/ready") || route?.endsWith("/review") || route?.endsWith("/feedback") || route === "/api/engineering/feedback-items/:id/update") service.authorizeAgent(sessionId, cwd, { humanOnly: true });
      if (route === "/api/engineering/feedback-items") {
        if (!body?.target?.node_id) throw new EngineeringServiceError("engineering_feedback_target_missing", "请指定反馈对应任务。", 400);
        service.authorizeAgent(sessionId, cwd, { nodeId: body.target.node_id });
        if (body.scope_node_ids !== undefined) {
          if (!Array.isArray(body.scope_node_ids) || body.scope_node_ids.length < 2 || body.scope_node_ids.length > 80 || body.scope_node_ids.some(id => typeof id !== "string")) throw new EngineeringServiceError("engineering_feedback_scope_invalid", "请选择 2 到 80 个真实节点。", 400);
          for (const nodeId of body.scope_node_ids) service.authorizeAgent(sessionId, cwd, { nodeId });
        }
      }
      if (route === "/api/engineering/nodes") service.authorizeAgent(sessionId, cwd, { nodeId: body?.parent_id ?? "" });
      else if (route?.startsWith("/api/engineering/nodes/:id")) service.authorizeAgent(sessionId, cwd, { nodeId: params.id, proposed: body?.node });
      else if (route === "/api/engineering/dispatch") {
        if (!Array.isArray(body?.node_ids) || body.mode !== "external") throw new EngineeringServiceError("engineering_agent_external_mode_required", "Agent 只能派发自己的外部受控任务。", 403);
        for (const nodeId of body.node_ids) service.authorizeAgent(sessionId, cwd, { nodeId });
      } else if (route?.startsWith("/api/engineering/runs/:id")) service.authorizeAgent(sessionId, cwd, { runId: params.id });
    } catch (error) { return route === "/api/engineering/runs/:id/result" ? resultError(reply, error) : respond(reply, () => { throw error; }); }
  });
  app.addHook("onClose", async () => { if (workspaces) await workspaces.close(); else await service.close(); });
  registerEngineeringWorkPackageRoutes(app, serviceFor);
  registerEngineeringRecheckPackageRoutes(app, serviceFor);
  app.get("/api/engineering", async (request, reply) => respond(reply, () => serviceFor(request).view()));
  app.get("/api/engineering/capabilities", async (request, reply) => respond(reply, () => serviceFor(request).catalog()));
  app.post<{ Body: EngineeringFeedbackCreate }>("/api/engineering/feedback-items", async (request, reply) => respond(reply, () => serviceFor(request).createFeedback(request.body, actor(request)), 201));
  app.post<{ Params: { id: string }; Body: EngineeringFeedbackUpdate }>("/api/engineering/feedback-items/:id/update", async (request, reply) => respond(reply, () => serviceFor(request).updateFeedback(request.params.id, request.body)));
  app.post<{ Body: { parent_id: string; title: string; kind?: string; expected_revision: number } }>("/api/engineering/nodes", async (request, reply) => respond(reply, () => serviceFor(request).createNode(request.body, actor(request)), 201));
  app.post<{ Params: { id: string }; Body: { node: EngineeringNode; expected_revision: number } }>("/api/engineering/nodes/:id/preview", async (request, reply) => respond(reply, () => serviceFor(request).preview(request.params.id, request.body)));
  app.put<{ Params: { id: string }; Body: { node: EngineeringNode; expected_revision: number; reason?: string } }>("/api/engineering/nodes/:id", async (request, reply) => respond(reply, () => serviceFor(request).updateNode(request.params.id, request.body)));
  app.post<{ Params: { id: string }; Body: { expected_revision: number; reason?: string } }>("/api/engineering/nodes/:id/archive", async (request, reply) => respond(reply, () => serviceFor(request).archive(request.params.id, request.body)));
  app.post<{ Params: { id: string }; Body: { expected_revision: number } }>("/api/engineering/nodes/:id/ready", async (request, reply) => respond(reply, () => serviceFor(request).ready(request.params.id, request.body.expected_revision)));
  app.post<{ Body: { node_ids: string[]; mode?: "controlled" | "external"; expected_revision?: number } }>("/api/engineering/dispatch", async (request, reply) => respond(reply, () => serviceFor(request).dispatch(request.body, actor(request)), 202));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/engineering/nodes/:id/pause", async (request, reply) => respond(reply, () => serviceFor(request).pause(request.params.id, request.body?.reason)));
  app.post<{ Params: { id: string; actionId: string }; Body: unknown }>("/api/engineering/runs/:id/actions/:actionId", async (request, reply) => respond(reply, () => {
    return serviceFor(request).executeAction(request.params.id, request.params.actionId, false, request.body, actor(request));
  }));
  app.post<{ Params: { id: string } }>("/api/engineering/runs/:id/finish", async (request, reply) => respond(reply, () => serviceFor(request).finish(request.params.id, false, actor(request))));
  app.get<{ Params: { id: string } }>("/api/engineering/zones/:id/handoff", async (request, reply) => respond(reply, () => serviceFor(request).zoneHandoff(request.params.id)));
  app.post<{ Params: { id: string }; Body: { contract_key: string } }>("/api/engineering/zones/:id/claim", async (request, reply) => respond(reply, () => serviceFor(request).claimZone(request.params.id, request.body, actor(request))));
  app.get<{ Params: { id: string } }>("/api/engineering/runs/:id/handoff", async (request, reply) => respond(reply, () => serviceFor(request).handoff(request.params.id)));
  app.post<{ Params: { id: string }; Body: { contract_key: string } }>("/api/engineering/runs/:id/claim", async (request, reply) => respond(reply, () => serviceFor(request).claim(request.params.id, request.body, actor(request))));
  app.post<{ Params: { id: string }; Body: { verdict: "accepted" | "needs_revision"; note?: string; checks?: Array<{ criterion_id: string; passed: boolean; note?: string }> } }>("/api/engineering/runs/:id/review", async (request, reply) => respond(reply, () => serviceFor(request).review(request.params.id, request.body)));
  app.post<{ Params: { id: string }; Body: { capability_use_id: string; note?: string } }>("/api/engineering/runs/:id/feedback", async (request, reply) => respond(reply, () => serviceFor(request).feedback(request.params.id, request.body)));
  app.get<{ Params: { id: string }; Querystring: { workspace?: string } }>("/api/engineering/runs/:id/result", {
    onRequest: async (_request, reply) => { reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff"); }
  }, async (request, reply) => {
    try {
      if (Object.keys(request.query ?? {}).some(key => key !== "workspace")) return reply.code(400).send({ code: "engineering_result_query_invalid", error: "结果读取仅接受工作区和运行标识。" });
      const scoped = serviceFor(request);
      const result = buildEngineeringRunResult({ root: scoped.root, workspace_id: scoped.options.workspaceId ?? "host", document: scoped.view().document,
        run_id: request.params.id, approved_source_roots: scoped.options.approvedSourceRoots?.() ?? [scoped.root] });
      return reply.header("Content-Disposition", 'attachment; filename="engineering-run-result.json"').type("application/json; charset=utf-8").send(result);
    } catch (error) {
      return resultError(reply, error);
    }
  });
  app.get<{ Params: { id: string }; Querystring: { path: string } }>("/api/engineering/runs/:id/artifact", async (request, reply) => {
    try {
      const artifact = serviceFor(request).artifact(request.params.id, request.query.path);
      const contentType = ({ ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8" } as Record<string, string>)[extname(artifact.path).toLowerCase()] ?? "application/octet-stream";
      return reply.header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'").header("X-Content-Type-Options", "nosniff").type(contentType).send(artifact.content);
    } catch (error) { return respond(reply, () => { throw error; }); }
  });
  app.get<{ Params: { nodeId: string } }>("/api/engineering/history/:nodeId", async (request, reply) => respond(reply, () => serviceFor(request).history(request.params.nodeId)));
  return service;
}
