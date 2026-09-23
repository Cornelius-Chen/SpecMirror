import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformAuthenticatorIsAvailable, startAuthentication, WebAuthnAbortService } from "@simplewebauthn/browser";
import { cancelHumanApproval, humanApprovalHeaders } from "./human-approval-client.ts";

vi.mock("@simplewebauthn/browser", () => ({
  platformAuthenticatorIsAvailable: vi.fn(),
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

const target = { method: "POST", url: "/api/codex/smoke", workspace: "host", body: null };
const status = { configured: true, registered: true, rp_id: "localhost", origin: "http://localhost:4317", uv: "required" };
const response = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "Content-Type": "application/json" } });

describe("human approval browser client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(platformAuthenticatorIsAvailable).mockResolvedValue(true);
    vi.stubGlobal("window", {
      isSecureContext: true,
      PublicKeyCredential: class {},
      location: { origin: "http://localhost:4317", href: "http://localhost:4317/?workspace=archive", replace: vi.fn() }
    });
  });

  it("fails before requesting a ceremony when the current browser has no local platform authenticator", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
    vi.mocked(platformAuthenticatorIsAvailable).mockResolvedValue(false);

    await expect(humanApprovalHeaders(target)).rejects.toMatchObject({ code: "human_approval_platform_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("refuses a non-local approval origin without redirecting the page", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", {
      isSecureContext: true,
      PublicKeyCredential: class {},
      location: { origin: "http://192.168.1.20:4317", href: "http://192.168.1.20:4317/", replace }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));

    await expect(humanApprovalHeaders(target)).rejects.toMatchObject({ code: "human_approval_origin_mismatch" });
    expect(replace).not.toHaveBeenCalled();
    expect(platformAuthenticatorIsAvailable).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("caps the foreground prompt at 30 seconds and returns a request-bound assertion", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ attempt_id: "attempt-1", options: { challenge: "YQ", timeout: 90_000, rpId: "localhost", allowCredentials: [], userVerification: "required", hints: ["client-device"] } })));
    vi.mocked(startAuthentication).mockResolvedValue({ id: "credential", rawId: "credential", type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { authenticatorData: "YQ", clientDataJSON: "Yg", signature: "Yw" } });

    const headers = await humanApprovalHeaders(target);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ timeout: 30_000, hints: ["client-device"] }) });
    expect(headers["x-mirror-human-approval-attempt"]).toBe("attempt-1");
    expect(headers["x-mirror-human-approval-assertion"]).toBeTruthy();
  });

  it("aborts the options request before any system ceremony can start", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(status))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => { const failure = new Error("cancelled"); failure.name = "AbortError"; reject(failure); }, { once: true });
      })));

    const pending = humanApprovalHeaders(target, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("exposes an explicit cancellation hook for an active browser ceremony", () => {
    cancelHumanApproval();
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledTimes(1);
  });
});
