import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON, type WebAuthnCredential } from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { humanApprovalRequestDigest, type AuthenticatedHumanApproval, type HumanApprovalRequestTarget, type HumanApprovalRequirement, type HumanApprovalVerifier } from "./human-approval.ts";
import { defaultHumanApprovalDataDirectory, humanApprovalPasskeyPath, loadHumanApprovalPasskey, replaceHumanApprovalPasskey, strictBase64urlBytes, type StoredHumanApprovalPasskey } from "./human-approval-passkey-store.ts";

export const HUMAN_APPROVAL_ATTEMPT_HEADER = "x-mirror-human-approval-attempt";
export const HUMAN_APPROVAL_ASSERTION_HEADER = "x-mirror-human-approval-assertion";
export const HUMAN_APPROVAL_AUTHENTICATION_OPTIONS_PATH = "/api/governance/human-approval/authentication/options";
export const HUMAN_APPROVAL_STATUS_PATH = "/api/governance/human-approval/status";
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const base64url = /^[A-Za-z0-9_-]+$/u;

interface AuthenticationAttempt { id: string; challenge: string; requestDigest: string; expiresAt: number }
export interface HumanApprovalAuthenticationPrimitives {
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}
export interface LocalWebAuthnHumanApprovalOptions {
  dataDirectory?: string;
  expectedOrigin?: string;
  rpID?: string;
  attemptTtlMs?: number;
  now?: () => number;
  ids?: () => string;
  webauthn?: HumanApprovalAuthenticationPrimitives;
}
export interface HumanApprovalProvider { verifier: HumanApprovalVerifier; registerRoutes(app: FastifyInstance): void }

class HumanApprovalProviderError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
function errorResponse(reply: FastifyReply, failure: unknown) {
  if (failure instanceof HumanApprovalProviderError) return reply.code(failure.status).send({ code: failure.code, error: failure.message });
  return reply.code(400).send({ code: "human_approval_ceremony_failed", error: "Windows Hello 验证没有完成，本次未执行。" });
}
function oneHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}
function assertedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HumanApprovalProviderError("human_approval_target_invalid", 400, `${name} 无效。`);
  return value;
}
function parseTarget(value: unknown): Required<Pick<HumanApprovalRequestTarget, "method" | "url" | "workspace">> & Pick<HumanApprovalRequestTarget, "body"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HumanApprovalProviderError("human_approval_target_invalid", 400, "待确认请求无效。");
  const record = value as Record<string, unknown>;
  const method = assertedString(record.method, "method", 12).toUpperCase();
  const url = assertedString(record.url, "url", 8192);
  const workspace = assertedString(record.workspace ?? "host", "workspace", 256);
  if (!mutationMethods.has(method) || !url.startsWith("/api/") || url.includes("#") || url.includes("://")) throw new HumanApprovalProviderError("human_approval_target_invalid", 400, "只能确认一个明确的本机写请求。");
  return { method, url, workspace, body: record.body ?? null };
}
function parseAssertionHeader(value: string): AuthenticationResponseJSON {
  if (value.length > 65_536 || !base64url.test(value)) throw new Error("invalid_assertion");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength > 48_000 || Buffer.from(bytes).toString("base64url") !== value) throw new Error("invalid_assertion");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_assertion");
  return parsed as AuthenticationResponseJSON;
}

export class LocalWebAuthnHumanApprovalProvider implements HumanApprovalProvider {
  readonly verifier: HumanApprovalVerifier;
  readonly storePath: string;
  readonly dataDirectory: string;
  readonly expectedOrigin: string;
  readonly rpID: string;
  private readonly attemptTtlMs: number;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly webauthn: HumanApprovalAuthenticationPrimitives;
  private readonly attempts = new Map<string, AuthenticationAttempt>();
  private queue: Promise<unknown> = Promise.resolve();
  private routesRegistered = false;

  constructor(options: LocalWebAuthnHumanApprovalOptions = {}) {
    this.dataDirectory = options.dataDirectory ?? defaultHumanApprovalDataDirectory();
    this.expectedOrigin = options.expectedOrigin ?? "http://localhost:4317";
    this.rpID = options.rpID ?? "localhost";
    this.attemptTtlMs = options.attemptTtlMs ?? 90_000;
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.webauthn = options.webauthn ?? { generateAuthenticationOptions, verifyAuthenticationResponse };
    this.storePath = humanApprovalPasskeyPath(this.dataDirectory);
    const origin = new URL(this.expectedOrigin);
    if (origin.origin !== this.expectedOrigin || origin.protocol !== "http:" || origin.hostname !== "localhost" || this.rpID !== "localhost") throw new Error("local_human_approval_requires_http_localhost_origin_and_localhost_rpid");
    if (!Number.isFinite(this.attemptTtlMs) || this.attemptTtlMs < 10_000 || this.attemptTtlMs > 120_000) throw new Error("invalid_human_approval_attempt_ttl");
    this.verifier = (request, requirement) => this.verifyProtectedRequest(request, requirement);
  }

  status() {
    const registered = existsSync(this.storePath);
    let credentialStoreValid = false;
    if (registered) try { this.loadPasskey(); credentialStoreValid = true; } catch { credentialStoreValid = false; }
    return {
      configured: true,
      registered,
      ready: registered && credentialStoreValid,
      credential_store_valid: credentialStoreValid,
      rp_id: this.rpID,
      origin: this.expectedOrigin,
      required_origin: this.expectedOrigin,
      uv: "required" as const,
      user_verification: "required" as const,
      authenticator_transport: "internal_only" as const,
      cross_device_allowed: false,
      registration_mode: "separate_one_time_local_setup" as const,
      registration_available_over_http: false,
      reset_over_http: false,
      credential_add_over_http: false
    };
  }

  registerRoutes(app: FastifyInstance) {
    if (this.routesRegistered) throw new Error("human_approval_routes_already_registered");
    this.routesRegistered = true;
    app.get(HUMAN_APPROVAL_STATUS_PATH, async () => this.status());
    app.post<{ Body: unknown }>(HUMAN_APPROVAL_AUTHENTICATION_OPTIONS_PATH, async (request, reply) => {
      try { return await this.authenticationOptions(app, request.body, reply); }
      catch (failure) { return errorResponse(reply, failure); }
    });
  }

  private pruneAttempts() {
    const now = this.now();
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(id);
  }
  private saveAttempt(attempt: AuthenticationAttempt) {
    this.pruneAttempts();
    if (this.attempts.size >= 256) throw new HumanApprovalProviderError("human_approval_busy", 429, "待确认请求过多，请稍后重试。");
    this.attempts.set(attempt.id, attempt);
  }
  /** Removes an attempt synchronously before any cryptographic await, so replay races lose. */
  private takeAttempt(id: string): AuthenticationAttempt | null {
    this.pruneAttempts();
    const attempt = this.attempts.get(id);
    this.attempts.delete(id);
    return attempt && attempt.expiresAt > this.now() ? attempt : null;
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private loadPasskey() { return loadHumanApprovalPasskey(this.dataDirectory, { rpID: this.rpID, origin: this.expectedOrigin }); }

  private async authenticationOptions(app: FastifyInstance, body: unknown, reply: FastifyReply) {
    let stored: StoredHumanApprovalPasskey;
    try { stored = this.loadPasskey(); }
    catch { throw new HumanApprovalProviderError("human_approval_not_ready", 409, "请先运行一次性本机 Setup 并完成 Windows Hello 注册；本次未执行。"); }
    if (!stored.credential.transports?.includes("internal")) {
      throw new HumanApprovalProviderError("human_approval_local_credential_unavailable", 409, "当前凭证不能用于本机 Windows Hello；已禁止切换到手机二维码，本次未执行。");
    }
    const target = parseTarget(body);
    let requestDigest: string;
    try { requestDigest = humanApprovalRequestDigest(app, target); }
    catch { throw new HumanApprovalProviderError("human_approval_target_invalid", 400, "待确认请求不能被精确绑定。"); }
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.rpID,
      // Never advertise the saved hybrid transport. A cross-device QR can steal
      // focus and cannot authenticate this machine's localhost workflow.
      allowCredentials: [{ id: stored.credential.id, transports: ["internal"] }],
      timeout: this.attemptTtlMs,
      userVerification: "required"
    });
    const id = this.ids();
    this.saveAttempt({ id, challenge: options.challenge, requestDigest, expiresAt: this.now() + this.attemptTtlMs });
    return reply.send({ attempt_id: id, options: { ...options, hints: ["client-device"] } });
  }

  private async verifyProtectedRequest(request: FastifyRequest, requirement: HumanApprovalRequirement): Promise<AuthenticatedHumanApproval | null> {
    // No fallback identity exists: Agent/Hook headers, loopback, cookies and historical
    // Owner ratification are never inspected as proof of a current human ceremony.
    const attemptID = oneHeader(request, HUMAN_APPROVAL_ATTEMPT_HEADER);
    const encodedAssertion = oneHeader(request, HUMAN_APPROVAL_ASSERTION_HEADER);
    if (!attemptID || !encodedAssertion) return null;
    const attempt = this.takeAttempt(attemptID);
    if (!attempt || attempt.requestDigest !== requirement.requestDigest) return null;
    let response: AuthenticationResponseJSON;
    try { response = parseAssertionHeader(encodedAssertion); } catch { return null; }
    if (response.authenticatorAttachment !== "platform") return null;
    return this.exclusive(async (): Promise<AuthenticatedHumanApproval | null> => {
      let stored: StoredHumanApprovalPasskey;
      try { stored = this.loadPasskey(); } catch { return null; }
      if (response.id !== stored.credential.id) return null;
      const credential: WebAuthnCredential = { id: stored.credential.id, publicKey: strictBase64urlBytes(stored.credential.public_key), counter: stored.credential.counter, transports: stored.credential.transports };
      let result;
      try {
        result = await this.webauthn.verifyAuthenticationResponse({
          response,
          expectedChallenge: attempt.challenge,
          expectedOrigin: this.expectedOrigin,
          expectedRPID: this.rpID,
          expectedType: "webauthn.get",
          credential,
          requireUserVerification: true,
          advancedFIDOConfig: { userVerification: "required" }
        });
      } catch { return null; }
      const info = result.authenticationInfo;
      if (!result.verified || !info.userVerified || info.credentialID !== stored.credential.id
        || !Number.isSafeInteger(info.newCounter) || info.newCounter < 0
        || (stored.credential.counter > 0 && info.newCounter <= stored.credential.counter)) return null;
      const updated: StoredHumanApprovalPasskey = {
        ...stored,
        updated_at: new Date(this.now()).toISOString(),
        credential: { ...stored.credential, counter: info.newCounter, device_type: info.credentialDeviceType, backed_up: info.credentialBackedUp }
      };
      try { replaceHumanApprovalPasskey(this.dataDirectory, updated); } catch { return null; }
      return {
        kind: "authenticated_human_approval",
        principalId: stored.principal_id,
        approvalId: attempt.id,
        requestDigest: requirement.requestDigest,
        expiresAt: this.now() + 15_000
      };
    });
  }
}

export function createLocalWebAuthnHumanApprovalProvider(options: LocalWebAuthnHumanApprovalOptions = {}) {
  return new LocalWebAuthnHumanApprovalProvider(options);
}
