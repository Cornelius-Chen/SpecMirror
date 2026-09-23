import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanApprovalPasskeyPath, loadHumanApprovalPasskey } from "./human-approval-passkey-store.ts";
import { humanApprovalSetupRequestAllowed, HumanApprovalSetupError, LocalHumanApprovalSetup, renderHumanApprovalSetupPage, type HumanApprovalRegistrationPrimitives } from "./human-approval-setup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { const absolute = resolve(root); if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes("mirror-setup-test-")) throw new Error("unsafe_test_path"); rmSync(absolute, { recursive: true, force: true }); } });
function dataDirectory() { const root = join(tmpdir(), `mirror-setup-test-${crypto.randomUUID()}`); mkdirSync(root); roots.push(root); return join(root, "approval"); }
const credentialID = Buffer.from("registered-id").toString("base64url");
function primitives(options: { verified?: boolean; userVerified?: boolean; delay?: number } = {}) {
  const generateRegistrationOptions = vi.fn(async () => {
    if (options.delay) await new Promise(resolveDelay => setTimeout(resolveDelay, options.delay));
    return { challenge: "cmVnaXN0cmF0aW9uLWNoYWxsZW5nZQ", rp: { id: "localhost", name: "Mirror" }, user: { id: "dXNlcg", name: "Mirror Owner", displayName: "Mirror Owner" }, pubKeyCredParams: [], timeout: 90_000 };
  });
  const verifyRegistrationResponse = vi.fn(async () => ({ verified: options.verified ?? true, ...((options.verified ?? true) ? { registrationInfo: { fmt: "none" as const, aaguid: "00000000-0000-0000-0000-000000000000", credential: { id: credentialID, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] }, credentialType: "public-key" as const, attestationObject: new Uint8Array([1]), userVerified: options.userVerified ?? true, credentialDeviceType: "singleDevice" as const, credentialBackedUp: false, origin: "http://localhost:49001", rpID: "localhost" } } : {}) }));
  return { generateRegistrationOptions, verifyRegistrationResponse, webauthn: { generateRegistrationOptions, verifyRegistrationResponse } as unknown as HumanApprovalRegistrationPrimitives };
}
function response() { return { id: credentialID, rawId: credentialID, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: "YQ", attestationObject: "Yg" } }; }

describe("one-time local human approval setup", () => {
  it("emits browser JavaScript that parses before the registration button is clicked", () => {
    const page = renderHumanApprovalSetupPage("test-nonce");
    const script = page.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("renders a gated start button with visible readiness and stale-page diagnostics", () => {
    const page = renderHumanApprovalSetupPage("test-nonce");
    expect(page).toContain('<button id="start" disabled>正在检查…</button>');
    expect(page).toContain("fetch('/health'");
    expect(page).toContain("Setup 服务已经关闭或过期");
    expect(page).toContain("若弹窗被遮住，请查看任务栏中的系统验证窗口");
    expect(page).toContain('script nonce="test-nonce"');
  });

  it("accepts only the exact ephemeral Host and same-origin POST without an OPTIONS/CORS path", () => {
    const allowed = (method: string, headers: Record<string, string>, remoteAddress = "::1") => humanApprovalSetupRequestAllowed({ method, headers, socket: { remoteAddress } } as never, "localhost:49001", "http://localhost:49001");
    expect(allowed("GET", { host: "localhost:49001", "sec-fetch-site": "none" })).toBe(true);
    expect(allowed("POST", { host: "localhost:49001", origin: "http://localhost:49001", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(allowed("POST", { host: "localhost:49001", origin: "http://localhost:49001", "sec-fetch-site": "none" })).toBe(true);
    expect(allowed("POST", { host: "127.0.0.1:49001", origin: "http://localhost:49001", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(allowed("POST", { host: "localhost:49001", origin: "http://evil.invalid", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(allowed("POST", { host: "localhost:49001", origin: "http://localhost:49001" })).toBe(false);
    expect(allowed("OPTIONS", { host: "localhost:49001", origin: "http://localhost:49001", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(allowed("POST", { host: "localhost:49001", origin: "http://localhost:49001", "sec-fetch-site": "same-origin" }, "10.0.0.2")).toBe(false);
  });

  it("uses a 32-byte in-memory capability and consumes it atomically when options are issued", async () => {
    const p = primitives({ delay: 15 }), directory = dataDirectory();
    const setup = new LocalHumanApprovalSetup({ dataDirectory: directory, setupOrigin: "http://localhost:49001", webauthn: p.webauthn });
    expect(Buffer.from(setup.capability, "base64url")).toHaveLength(32);
    await expect(setup.options("wrong")).rejects.toMatchObject({ code: "human_approval_setup_capability_invalid" });
    const results = await Promise.allSettled([setup.options(setup.capability), setup.options(setup.capability)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")[0]).toMatchObject({ reason: { code: "human_approval_setup_capability_invalid" } });
    expect(p.generateRegistrationOptions).toHaveBeenCalledTimes(1);
    expect(p.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({ rpID: "localhost", attestationType: "none", preferredAuthenticatorType: "localDevice", authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" } }));
    expect(setup.status()).toEqual({ ready: false, attempt_started: true, registered: false });
  });

  it("consumes a failed ceremony and writes nothing", async () => {
    const p = primitives({ verified: false }), directory = dataDirectory();
    const setup = new LocalHumanApprovalSetup({ dataDirectory: directory, setupOrigin: "http://localhost:49001", capability: Buffer.alloc(32, 4).toString("base64url"), webauthn: p.webauthn });
    const ceremony = await setup.options(setup.capability);
    await expect(setup.verify({ attempt_id: ceremony.attempt_id, response: response() })).rejects.toMatchObject({ code: "human_approval_registration_rejected" });
    await expect(setup.verify({ attempt_id: ceremony.attempt_id, response: response() })).rejects.toMatchObject({ code: "human_approval_setup_attempt_invalid" });
    expect(existsSync(humanApprovalPasskeyPath(directory))).toBe(false);
  });

  it("requires verified UV, verifies the temporary exact origin, and anchors storage to the main origin", async () => {
    const noUv = primitives({ userVerified: false }), noUvDirectory = dataDirectory();
    const rejected = new LocalHumanApprovalSetup({ dataDirectory: noUvDirectory, setupOrigin: "http://localhost:49001", webauthn: noUv.webauthn });
    const rejectedCeremony = await rejected.options(rejected.capability);
    await expect(rejected.verify({ attempt_id: rejectedCeremony.attempt_id, response: response() })).rejects.toBeInstanceOf(HumanApprovalSetupError);
    expect(existsSync(humanApprovalPasskeyPath(noUvDirectory))).toBe(false);

    const valid = primitives(), directory = dataDirectory();
    const setup = new LocalHumanApprovalSetup({ dataDirectory: directory, setupOrigin: "http://localhost:49001", mainOrigin: "http://localhost:4317", webauthn: valid.webauthn });
    const ceremony = await setup.options(setup.capability);
    await expect(setup.verify({ attempt_id: ceremony.attempt_id, response: response() })).resolves.toEqual({ verified: true, registered: true });
    expect(valid.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: ceremony.options.challenge, expectedOrigin: "http://localhost:49001", expectedRPID: "localhost", expectedType: "webauthn.create", requireUserPresence: true, requireUserVerification: true }));
    expect(loadHumanApprovalPasskey(directory, { rpID: "localhost", origin: "http://localhost:4317" })).toMatchObject({ origin: "http://localhost:4317", registration_origin: "http://localhost:49001", credential: { id: credentialID } });
  });

  it("rejects a cross-device registration before verification or storage", async () => {
    const p = primitives(), directory = dataDirectory();
    const setup = new LocalHumanApprovalSetup({ dataDirectory: directory, setupOrigin: "http://localhost:49001", webauthn: p.webauthn });
    const ceremony = await setup.options(setup.capability);
    const remote = { ...response(), authenticatorAttachment: "cross-platform" as const };
    await expect(setup.verify({ attempt_id: ceremony.attempt_id, response: remote })).rejects.toMatchObject({ code: "human_approval_registration_rejected" });
    expect(p.verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(existsSync(humanApprovalPasskeyPath(directory))).toBe(false);
  });

  it("refuses any second setup instead of exposing add or reset semantics", async () => {
    const p = primitives(), directory = dataDirectory(), first = new LocalHumanApprovalSetup({ dataDirectory: directory, setupOrigin: "http://localhost:49001", webauthn: p.webauthn });
    const ceremony = await first.options(first.capability); await first.verify({ attempt_id: ceremony.attempt_id, response: response() });
    const second = new LocalHumanApprovalSetup({ dataDirectory: directory, setupOrigin: "http://localhost:49002", webauthn: primitives().webauthn });
    await expect(second.options(second.capability)).rejects.toMatchObject({ code: "human_approval_already_registered" });
  });
});
