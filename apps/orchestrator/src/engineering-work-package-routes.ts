import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticatedHumanApproval, canonicalJson } from "./human-approval.ts";
import { EngineeringServiceError, type EngineeringExecutionService, type EngineeringWorkPackageRequest } from "./engineering-service.ts";

const lifetimeMs = 10 * 60_000;
interface PreparedWorkPackage {
  service: EngineeringExecutionService;
  workspace: string;
  request: EngineeringWorkPackageRequest;
  exact: string;
  manifestDigest: string;
  expiresAt: number;
}

/** The host registers the existing human guard first. Preview stores no project
 * state; commit additionally requires its positive verified human result. */
export function registerEngineeringWorkPackageRoutes(app: FastifyInstance, serviceFor: (request: FastifyRequest) => EngineeringExecutionService) {
  const previews = new Map<string, PreparedWorkPackage>();
  function reject(code: string, message: string, status = 409): never { throw new EngineeringServiceError(code, message, status); }
  const respond = (reply: FastifyReply, action: () => unknown) => {
    try { return reply.send(action()); }
    catch (error) { return reply.code(error instanceof EngineeringServiceError ? error.status : 400).send({ code: error instanceof EngineeringServiceError ? error.code : "engineering_work_package_invalid", error: error instanceof Error ? error.message : "开工包未完成。" }); }
  };
  const workspace = (service: EngineeringExecutionService) => service.options.workspaceId ?? "host";
  app.post<{ Body: EngineeringWorkPackageRequest }>("/api/engineering/work-package/preview", async (request, reply) => respond(reply, () => {
    const service = serviceFor(request), proposal = service.previewWorkPackage(request.body), at = Date.now();
    for (const [token, row] of previews) if (row.expiresAt <= at) previews.delete(token);
    if (previews.size >= 100) previews.delete(previews.keys().next().value!);
    const token = randomUUID(), frozenRequest = structuredClone(request.body), expiresAt = at + lifetimeMs;
    previews.set(token, { service, workspace: workspace(service), request: frozenRequest, exact: canonicalJson(frozenRequest), manifestDigest: proposal.manifest_digest, expiresAt });
    return { ...proposal, token, workspace_id: workspace(service), request: frozenRequest, expires_at: new Date(expiresAt).toISOString() };
  }));
  app.post<{ Body: { token: string; request: EngineeringWorkPackageRequest } }>("/api/engineering/work-package/commit", async (request, reply) => respond(reply, () => {
    const human = authenticatedHumanApproval(request);
    if (request.headers["x-engineering-agent-session-id"] !== undefined || request.headers["x-engineering-cwd"] !== undefined || !human)
      reject("engineering_human_action_required", "开工包需要针对本次请求的已认证人类确认；缺少 Agent 标识不代表人类。", 403);
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["token", "request"].includes(key)) || typeof body.token !== "string")
      reject("engineering_work_package_invalid", "需要对应预览令牌与完整原请求。", 400);
    const service = serviceFor(request), prepared = previews.get(body.token);
    if (!prepared || prepared.service !== service || prepared.workspace !== workspace(service) || prepared.expiresAt <= Date.now())
      reject("engineering_work_package_preview_required", "开工包预览已过期、已使用或属于另一工程，请重新预览。", 409);
    if (canonicalJson(body.request) !== prepared.exact) reject("engineering_work_package_preview_mismatch", "确认内容与预览不一致，请重新预览。", 409);
    // A verified attempt consumes its exact preview before execution; stale
    // versions or owners fail atomically and need a new reviewable preview.
    previews.delete(body.token);
    return service.commitWorkPackage(prepared.request, { work_package_id: body.token, principal_id: human!.principalId, approval_id: human!.approvalId, request_digest: human!.requestDigest }, prepared.manifestDigest);
  }));
  app.addHook("onClose", async () => { previews.clear(); });
}
