import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface HumanApprovalRequirement {
  method: string; route: string; workspace: string; requestDigest: string;
}
export interface AuthenticatedHumanApproval {
  kind: "authenticated_human_approval";
  principalId: string; approvalId: string; requestDigest: string; expiresAt: number;
}
/** Trusted host integration only. Never construct this from request headers, body,
 * loopback Origin, Hook presence, or the historical Owner-ratification audit. */
export type HumanApprovalVerifier = (request: FastifyRequest, requirement: HumanApprovalRequirement) => Promise<AuthenticatedHumanApproval | null>;
const installed = new WeakSet<FastifyInstance>();
const instances = new WeakMap<FastifyInstance, string>();
const configured = new WeakMap<FastifyInstance, boolean>();
const verified = new WeakMap<FastifyRequest, AuthenticatedHumanApproval>();
const reads = new Set(["GET", "HEAD", "OPTIONS"]);
const agentOnlyOrObservation = new Set(["/api/codex-companion/hooks", "/api/codex-companion/plan", "/api/codex-companion/progress", "/api/codex-companion/run-plan"]);
const selfVerifyingHumanApprovalCeremonies = new Set([
  "/api/governance/human-approval/authentication/options"
]);

export interface HumanApprovalRequestTarget {
  method: string;
  url: string;
  workspace?: string;
  body?: unknown;
}

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialize = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("human_approval_target_not_json");
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== "object") throw new Error("human_approval_target_not_json");
    if (seen.has(candidate)) throw new Error("human_approval_target_not_json");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const result = `[${candidate.map(item => serialize(item)).join(",")}]`;
      seen.delete(candidate);
      return result;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("human_approval_target_not_json");
    const record = candidate as Record<string, unknown>;
    const result = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
    seen.delete(candidate);
    return result;
  };
  return serialize(value);
}

/** Build the same digest used by the guard without trusting caller-supplied route,
 * params or query metadata. The exact request URL already includes path and query. */
export function humanApprovalRequestDigest(app: FastifyInstance, target: HumanApprovalRequestTarget): string {
  const instance = instances.get(app);
  if (!instance) throw new Error("human_approval_guard_not_installed");
  const method = target.method.trim().toUpperCase();
  const url = target.url;
  const workspace = target.workspace?.trim() || "host";
  return createHash("sha256").update(canonicalJson({ instance, method, url, workspace, body: target.body ?? null })).digest("hex");
}

export function humanApprovalRequired(request: Pick<FastifyRequest, "method" | "headers" | "url" | "routeOptions">): boolean {
  if (reads.has(request.method)) return false;
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  if (!route.startsWith("/api/") || agentOnlyOrObservation.has(route) || selfVerifyingHumanApprovalCeremonies.has(route)) return false;
  if (!route.startsWith("/api/engineering/")) return true;
  // These previews prepare an in-memory proposal only. They never apply plans,
  // assign owners, mark ready, dispatch work, or authorize a later commit.
  if (route === "/api/engineering/structure-proposal/preview" || route === "/api/engineering/nodes/:id/preview"
    || route === "/api/engineering/plan-import/preview" || route === "/api/engineering/work-package/preview"
    || route === "/api/engineering/work-package/recheck/preview") return false;
  const supervisorOnly = /\/(ready|review|feedback)$/.test(route)
    || route === "/api/engineering/feedback-items/:id/update"
    || route === "/api/engineering/structure-proposal/commit"
    || route.startsWith("/api/engineering/plan-import/")
    || route.startsWith("/api/engineering/work-package/");
  if (supervisorOnly) return true;
  // Marked Agent writes still pass the existing identity AND node-owner checks.
  // Unmarked callers have no human identity and must present verified approval.
  return request.headers["x-engineering-agent-session-id"] === undefined && request.headers["x-engineering-cwd"] === undefined;
}

export function humanApprovalRequirement(request: FastifyRequest): HumanApprovalRequirement {
  const method = request.method, route = request.routeOptions.url ?? request.url.split("?")[0];
  const header = request.headers["x-mirror-workspace-id"];
  const workspace = typeof header === "string" ? header : "host";
  const requestDigest = humanApprovalRequestDigest(request.server, {method, url:request.url, workspace, body:request.body ?? null});
  return {method, route, workspace, requestDigest};
}

/** All public supervisors are closed until a trusted authentication provider is
 * explicitly installed. No HTTP endpoint issues its own approval credentials. */
export function registerHumanApprovalGuard(app: FastifyInstance, verifier?: HumanApprovalVerifier) {
  if (installed.has(app)) return;
  installed.add(app);
  instances.set(app, randomUUID());
  configured.set(app, Boolean(verifier));
  const used = new Map<string, number>();
  app.get("/api/governance/authentication", async () => ({
    supervisor_actions: "positive_human_approval_required", configured: Boolean(verifier),
    header_absence_is_human: false, ratification_is_reusable_approval: false,
    default: "deny", proof_scope: "single_request_and_host_instance"
  }));
  app.addHook("preHandler", async (request, reply) => {
    if (!humanApprovalRequired(request)) return;
    const reject = () => reply.code(403).send({code: "human_approval_required", error: "此操作需要已验证的人类授权；缺少 Agent 标识不代表人类身份。本次未执行。"});
    if (request.headers["x-engineering-agent-session-id"] !== undefined || request.headers["x-engineering-cwd"] !== undefined || !verifier) return reject();
    const requirement = humanApprovalRequirement(request);
    let approval: AuthenticatedHumanApproval | null;
    try { approval = await verifier(request, requirement); } catch { return reject(); }
    const at = Date.now();
    for (const [id, expires] of used) if (expires <= at) used.delete(id);
    if (!approval || approval.kind !== "authenticated_human_approval" || !approval.principalId?.trim() || !approval.approvalId?.trim()
      || approval.requestDigest !== requirement.requestDigest || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= at
      || approval.expiresAt > at + 5 * 60_000 || used.has(approval.approvalId) || used.size >= 10000) return reject();
    // Consume before the handler. Concurrent replay cannot execute twice.
    used.set(approval.approvalId, approval.expiresAt);
    verified.set(request, Object.freeze({...approval}));
  });
}

export function authenticatedHumanApproval(request: FastifyRequest) { return verified.get(request); }
export function humanApprovalConfigured(app: FastifyInstance) { return configured.get(app) ?? false; }
