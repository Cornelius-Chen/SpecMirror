import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticatedHumanApproval, canonicalJson } from "./human-approval.ts";
import { EngineeringServiceError, type EngineeringExecutionService, type EngineeringRecheckPackageRequest } from "./engineering-service.ts";

interface PreparedRecheck {
  service: EngineeringExecutionService; workspace: string; request: EngineeringRecheckPackageRequest;
  exact: string; manifest: string; expiresAt: number;
}

/** Separate from first-time work packages: history is preserved and only a
 * positively authenticated exact config-path correction can create readiness. */
export function registerEngineeringRecheckPackageRoutes(app: FastifyInstance, serviceFor: (request: FastifyRequest) => EngineeringExecutionService) {
  const previews = new Map<string, PreparedRecheck>();
  const workspace = (service: EngineeringExecutionService) => service.options.workspaceId ?? "host";
  function reject(code: string, message: string, status = 409): never { throw new EngineeringServiceError(code, message, status); }
  const respond = (reply: FastifyReply, operation: () => unknown) => {
    try { return reply.send(operation()); }
    catch (cause) { return reply.code(cause instanceof EngineeringServiceError ? cause.status : 400).send({ code: cause instanceof EngineeringServiceError ? cause.code : "engineering_recheck_invalid", error: cause instanceof Error ? cause.message : "检查配置修正未完成。" }); }
  };
  app.post<{ Body: EngineeringRecheckPackageRequest }>("/api/engineering/work-package/recheck/preview", async (request, reply) => respond(reply, () => {
    const service = serviceFor(request), proposal = service.previewRecheckPackage(request.body), at = Date.now();
    for (const [token, item] of previews) if (item.expiresAt <= at) previews.delete(token);
    if (previews.size >= 100) previews.delete(previews.keys().next().value!);
    const token = randomUUID(), frozen = structuredClone(request.body), expiresAt = at + 10 * 60_000;
    previews.set(token, { service, workspace: workspace(service), request: frozen, exact: canonicalJson(frozen), manifest: proposal.manifest_digest, expiresAt });
    return { ...proposal, token, workspace_id: workspace(service), request: frozen, expires_at: new Date(expiresAt).toISOString() };
  }));
  app.post<{ Body: { token: string; request: EngineeringRecheckPackageRequest } }>("/api/engineering/work-package/recheck/commit", async (request, reply) => respond(reply, () => {
    const human = authenticatedHumanApproval(request);
    if (!human || request.headers["x-engineering-agent-session-id"] !== undefined || request.headers["x-engineering-cwd"] !== undefined)
      reject("engineering_human_action_required", "检查配置修正需要本次已认证的人类确认，缺少 Agent 标识不是人类证明。", 403);
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["token", "request"].includes(key)) || typeof body.token !== "string")
      reject("engineering_recheck_invalid", "确认需要原预览令牌和完整修正请求。", 400);
    const service = serviceFor(request), prepared = previews.get(body.token);
    if (!prepared || prepared.service !== service || prepared.workspace !== workspace(service) || prepared.expiresAt <= Date.now())
      reject("engineering_recheck_preview_required", "修正预览已过期、已使用或属于另一工程，请重新预览。", 409);
    if (canonicalJson(body.request) !== prepared.exact) reject("engineering_recheck_preview_mismatch", "确认内容与预览不一致，请重新预览。", 409);
    previews.delete(body.token);
    return service.commitRecheckPackage(prepared.request, { work_package_id: body.token, principal_id: human!.principalId,
      approval_id: human!.approvalId, request_digest: human!.requestDigest }, prepared.manifest);
  }));
  app.addHook("onClose", async () => { previews.clear(); });
}
