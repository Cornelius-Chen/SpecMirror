import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { registerLegacyReadonlyGuard } from "./app.ts";
import { authenticatedHumanApproval, registerHumanApprovalGuard } from "./human-approval.ts";
import { createHumanApprovalPasskey, loadHumanApprovalPasskey, type StoredHumanApprovalPasskey } from "./human-approval-passkey-store.ts";
import { HUMAN_APPROVAL_ASSERTION_HEADER, HUMAN_APPROVAL_ATTEMPT_HEADER, LocalWebAuthnHumanApprovalProvider, type HumanApprovalAuthenticationPrimitives } from "./human-approval-webauthn.ts";

const cleanup: Array<{ root: string; app: ReturnType<typeof Fastify> }> = [];
afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    await item.app.close();
    const absolute = resolve(item.root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes("mirror-webauthn-test-")) throw new Error("unsafe_test_path");
    rmSync(absolute, { recursive: true, force: true });
  }
});

const credentialID = Buffer.from("credential-id").toString("base64url");
const publicKey = Buffer.from("test-public-key").toString("base64url");
function passkey(counter = 2, transports = ["internal"]): StoredHumanApprovalPasskey {
  return {
    schema_version: 1,
    principal_id: "local-owner-test",
    rp_id: "localhost",
    origin: "http://localhost:4317",
    registration_origin: "http://localhost:49200",
    created_at: "2026-09-08T00:00:00.000Z",
    updated_at: "2026-09-08T00:00:00.000Z",
    credential: { id: credentialID, public_key: publicKey, counter, transports, device_type: "singleDevice", backed_up: false }
  };
}
function assertion(id = credentialID): AuthenticationResponseJSON {
  return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { authenticatorData: "YQ", clientDataJSON: "Yg", signature: "Yw" } };
}
function encoded(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

function fixture(options: { registered?: boolean; now?: number; newCounter?: number; verifyDelay?: number; verified?: boolean; userVerified?: boolean; transports?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirror-webauthn-test-")), dataDirectory = join(root, "approval");
  let now = options.now ?? Date.now(), writes = 0, id = 0;
  const generateAuthenticationOptions = vi.fn(async () => ({ challenge: "Y2hhbGxlbmdl", timeout: 90_000, rpId: "localhost", allowCredentials: [], userVerification: "required" }));
  const verifyAuthenticationResponse = vi.fn(async () => {
    if (options.verifyDelay) await new Promise(resolveDelay => setTimeout(resolveDelay, options.verifyDelay));
    return { verified: options.verified ?? true, authenticationInfo: { credentialID, newCounter: options.newCounter ?? 3, userVerified: options.userVerified ?? true, credentialDeviceType: "singleDevice" as const, credentialBackedUp: false, origin: "http://localhost:4317", rpID: "localhost" } };
  });
  const webauthn = { generateAuthenticationOptions, verifyAuthenticationResponse } as unknown as HumanApprovalAuthenticationPrimitives;
  if (options.registered !== false) createHumanApprovalPasskey(dataDirectory, passkey(2, options.transports));
  const provider = new LocalWebAuthnHumanApprovalProvider({ dataDirectory, now: () => now, ids: () => `attempt-${++id}`, webauthn });
  const app = Fastify(); cleanup.push({ root, app });
  registerHumanApprovalGuard(app, provider.verifier); provider.registerRoutes(app);
  app.post("/api/engineering/runs/:id/review", async request => { writes++; return { approval: authenticatedHumanApproval(request)?.approvalId }; });
  return { app, provider, dataDirectory, generateAuthenticationOptions, verifyAuthenticationResponse, writes: () => writes, advance: (milliseconds: number) => { now += milliseconds; } };
}
async function prepare(f: ReturnType<typeof fixture>, id = "a", body: unknown = { verdict: "accepted" }, workspace = "host") {
  const url = `/api/engineering/runs/${id}/review`;
  const response = await f.app.inject({ method: "POST", url: "/api/governance/human-approval/authentication/options", payload: { method: "POST", url, workspace, body } });
  expect(response.statusCode, response.body).toBe(200);
  return { ...response.json(), url, body, workspace } as { attempt_id: string; options: { challenge: string; hints?: string[] }; url: string; body: unknown; workspace: string };
}
function approvedRequest(ceremony: Awaited<ReturnType<typeof prepare>>, overrides: Record<string, unknown> = {}) {
  return {
    method: "POST" as const,
    url: ceremony.url,
    payload: ceremony.body as object,
    headers: { [HUMAN_APPROVAL_ATTEMPT_HEADER]: ceremony.attempt_id, [HUMAN_APPROVAL_ASSERTION_HEADER]: encoded(assertion()), ...(ceremony.workspace !== "host" ? { "x-mirror-workspace-id": ceremony.workspace } : {}) },
    ...overrides
  };
}

describe("local WebAuthn human approval provider", () => {
  it("is read-only before setup and exposes no registration/reset/add route on the main API", async () => {
    const f = fixture({ registered: false });
    const status = await f.app.inject("/api/governance/human-approval/status");
    expect(status.json()).toMatchObject({ configured: true, registered: false, ready: false, required_origin: "http://localhost:4317", rp_id: "localhost", user_verification: "required", registration_mode: "separate_one_time_local_setup", registration_available_over_http: false, reset_over_http: false });
    expect(f.app.hasRoute({ method: "POST", url: "/api/governance/human-approval/registration/options" })).toBe(false);
    expect(f.app.hasRoute({ method: "POST", url: "/api/governance/human-approval/registration/verify" })).toBe(false);
    expect((await f.app.inject({ method: "POST", url: "/api/governance/human-approval/authentication/options", payload: { method: "POST", url: "/api/engineering/runs/a/review", workspace: "host", body: {} } })).json().code).toBe("human_approval_not_ready");
    expect(f.writes()).toBe(0);
  });

  it("keeps the authentication ceremony reachable through the production readonly legacy guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirror-webauthn-test-")), dataDirectory = join(root, "approval"), app = Fastify(); cleanup.push({ root, app });
    createHumanApprovalPasskey(dataDirectory, passkey());
    const provider = new LocalWebAuthnHumanApprovalProvider({ dataDirectory, webauthn: {
      generateAuthenticationOptions: vi.fn(async () => ({ challenge: "Y2hhbGxlbmdl" })) as never,
      verifyAuthenticationResponse: vi.fn() as never
    } });
    registerHumanApprovalGuard(app, provider.verifier); registerLegacyReadonlyGuard(app, true); provider.registerRoutes(app);
    const response = await app.inject({ method: "POST", url: "/api/governance/human-approval/authentication/options", payload: { method: "POST", url: "/api/engineering/runs/a/review", workspace: "host", body: {} } });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("uses localhost, UV required, binds one assertion to the exact request and atomically advances the counter", async () => {
    const f = fixture(), ceremony = await prepare(f);
    expect(f.generateAuthenticationOptions).toHaveBeenCalledWith(expect.objectContaining({ rpID: "localhost", timeout: 90_000, userVerification: "required", allowCredentials: [{ id: credentialID, transports: ["internal"] }] }));
    expect(ceremony.options).toMatchObject({ hints: ["client-device"] });
    const changed = await f.app.inject(approvedRequest(ceremony, { payload: { verdict: "needs_revision" } }));
    expect(changed.statusCode).toBe(403);
    expect((await f.app.inject(approvedRequest(ceremony))).statusCode).toBe(403);
    const exact = await prepare(f);
    const accepted = await f.app.inject(approvedRequest(exact));
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().approval).toBe(exact.attempt_id);
    expect(f.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: exact.options.challenge, expectedOrigin: "http://localhost:4317", expectedRPID: "localhost", expectedType: "webauthn.get", requireUserVerification: true, advancedFIDOConfig: { userVerification: "required" } }));
    expect(loadHumanApprovalPasskey(f.dataDirectory, { rpID: "localhost", origin: "http://localhost:4317" }).credential.counter).toBe(3);
    expect(f.writes()).toBe(1);
  });

  it("advertises only the local authenticator and refuses a hybrid-only credential", async () => {
    const local = fixture({ transports: ["hybrid", "internal"] });
    await prepare(local);
    expect(local.generateAuthenticationOptions).toHaveBeenCalledWith(expect.objectContaining({
      allowCredentials: [{ id: credentialID, transports: ["internal"] }]
    }));

    const hybrid = fixture({ transports: ["hybrid"] });
    const response = await hybrid.app.inject({
      method: "POST",
      url: "/api/governance/human-approval/authentication/options",
      payload: { method: "POST", url: "/api/engineering/runs/a/review", workspace: "host", body: {} }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "human_approval_local_credential_unavailable" });
    expect(hybrid.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it("rejects a cross-device attachment before verification or a protected write", async () => {
    const f = fixture(), ceremony = await prepare(f);
    const remote = assertion();
    remote.authenticatorAttachment = "cross-platform";
    const response = await f.app.inject(approvedRequest(ceremony, {
      headers: {
        [HUMAN_APPROVAL_ATTEMPT_HEADER]: ceremony.attempt_id,
        [HUMAN_APPROVAL_ASSERTION_HEADER]: encoded(remote)
      }
    }));
    expect(response.statusCode).toBe(403);
    expect(f.verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(f.writes()).toBe(0);
  });

  it("consumes an attempt before concurrent verification so replay executes once", async () => {
    const f = fixture({ verifyDelay: 20 }), ceremony = await prepare(f);
    const results = await Promise.all([f.app.inject(approvedRequest(ceremony)), f.app.inject(approvedRequest(ceremony))]);
    expect(results.map(item => item.statusCode).sort()).toEqual([200, 403]);
    expect(f.verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(1);
  });

  it("rejects expired, malformed, mismatched-credential and counter-regressing assertions without a write", async () => {
    const expired = fixture(), expiredCeremony = await prepare(expired); expired.advance(90_001);
    expect((await expired.app.inject(approvedRequest(expiredCeremony))).statusCode).toBe(403);
    expect(expired.verifyAuthenticationResponse).not.toHaveBeenCalled();

    const malformed = fixture(), malformedCeremony = await prepare(malformed);
    expect((await malformed.app.inject(approvedRequest(malformedCeremony, { headers: { [HUMAN_APPROVAL_ATTEMPT_HEADER]: malformedCeremony.attempt_id, [HUMAN_APPROVAL_ASSERTION_HEADER]: "***" } }))).statusCode).toBe(403);
    expect((await malformed.app.inject(approvedRequest(malformedCeremony))).statusCode).toBe(403);

    const mismatch = fixture(), mismatchCeremony = await prepare(mismatch);
    expect((await mismatch.app.inject(approvedRequest(mismatchCeremony, { headers: { [HUMAN_APPROVAL_ATTEMPT_HEADER]: mismatchCeremony.attempt_id, [HUMAN_APPROVAL_ASSERTION_HEADER]: encoded(assertion(Buffer.from("other").toString("base64url"))) } }))).statusCode).toBe(403);
    expect(mismatch.verifyAuthenticationResponse).not.toHaveBeenCalled();

    const regression = fixture({ newCounter: 2 }), regressionCeremony = await prepare(regression);
    expect((await regression.app.inject(approvedRequest(regressionCeremony))).statusCode).toBe(403);
    expect(loadHumanApprovalPasskey(regression.dataDirectory, { rpID: "localhost", origin: "http://localhost:4317" }).credential.counter).toBe(2);
    const noUv = fixture({ userVerified: false }), noUvCeremony = await prepare(noUv);
    expect((await noUv.app.inject(approvedRequest(noUvCeremony))).statusCode).toBe(403);
    expect(expired.writes() + malformed.writes() + mismatch.writes() + regression.writes() + noUv.writes()).toBe(0);
  });

  it("never treats loopback, claimed roles, ratification or missing Agent headers as human proof", async () => {
    const f = fixture();
    for (const headers of [{}, { origin: "http://localhost:4317", cookie: "role=owner", "x-human-approved": "true" }, { authorization: "Bearer HUMAN_RATIFIED" }, { "x-engineering-agent-session-id": "agent" }]) {
      const response = await f.app.inject({ method: "POST", url: "/api/engineering/runs/a/review", headers, payload: { verdict: "accepted", status: "HUMAN_RATIFIED" } });
      expect(response.statusCode).toBe(403);
    }
    expect(f.writes()).toBe(0);
  });

  it("refuses 127.0.0.1 as a production WebAuthn origin", () => {
    const root = mkdtempSync(join(tmpdir(), "mirror-webauthn-test-")), app = Fastify(); cleanup.push({ root, app });
    expect(() => new LocalWebAuthnHumanApprovalProvider({ dataDirectory: join(root, "approval"), expectedOrigin: "http://127.0.0.1:4317" })).toThrow("local_human_approval_requires_http_localhost_origin_and_localhost_rpid");
  });
});
