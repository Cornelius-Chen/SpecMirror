import { platformAuthenticatorIsAvailable, startAuthentication, WebAuthnAbortService } from "@simplewebauthn/browser";

interface HumanApprovalStatus {
  configured: boolean;
  registered: boolean;
  rp_id: string;
  origin: string;
  uv: "required";
}

interface CeremonyOptions<T> { attempt_id: string; options: T }

export interface HumanApprovalRequest {
  method: string;
  url: string;
  workspace: string;
  body: unknown;
}

export class HumanApprovalClientError extends Error {
  constructor(message: string, public code = "human_approval_unavailable") {
    super(message);
    this.name = "HumanApprovalClientError";
  }
}

async function json<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, body === undefined ? { signal } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HumanApprovalClientError(payload.error || `人工确认未完成（${response.status}）`, payload.code);
  return payload as T;
}

function assertionHeader(response: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function browserReady() {
  if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
    throw new HumanApprovalClientError("当前窗口无法使用 Windows Hello。请从本机 localhost 工作台打开后重试。", "human_approval_browser_unsupported");
  }
}

function requireApprovalOrigin(status: HumanApprovalStatus) {
  if (!status.origin || window.location.origin === status.origin) return;
  throw new HumanApprovalClientError(
    `当前页面不是本机确认入口。请在运行 Mirror 的这台电脑打开 ${status.origin} 后重试；系统不会自动跳转。`,
    "human_approval_origin_mismatch"
  );
}

export async function humanApprovalStatus(signal?: AbortSignal): Promise<HumanApprovalStatus> {
  return json<HumanApprovalStatus>("/api/governance/human-approval/status", undefined, signal);
}

export async function humanApprovalHeaders(request: HumanApprovalRequest, signal?: AbortSignal): Promise<Record<string, string>> {
  const status = await humanApprovalStatus(signal);
  requireApprovalOrigin(status);
  browserReady();
  if (!status.configured) throw new HumanApprovalClientError("可信人工确认服务尚未接通，本次没有执行。", "human_approval_provider_missing");
  if (!status.registered) throw new HumanApprovalClientError("请先运行一次“SpecMirror Owner Setup”并完成 Windows Hello 注册。", "human_approval_registration_required");
  if (!await platformAuthenticatorIsAvailable()) {
    throw new HumanApprovalClientError("当前浏览器不能直接使用本机 Windows Hello，本次没有执行。请改用注册凭证的本机浏览器；如果浏览器显示手机二维码，请取消。", "human_approval_platform_unavailable");
  }

  const ceremony = await json<CeremonyOptions<Parameters<typeof startAuthentication>[0]["optionsJSON"]>>(
    "/api/governance/human-approval/authentication/options", request, signal
  );
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  const cancel = () => WebAuthnAbortService.cancelCeremony();
  try {
    if (signal?.aborted) { const failure = new Error("Human approval cancelled"); failure.name = "AbortError"; throw failure; }
    signal?.addEventListener("abort", cancel, { once: true });
    const optionsJSON = { ...ceremony.options, timeout: Math.min(ceremony.options.timeout ?? 30_000, 30_000) };
    response = await startAuthentication({ optionsJSON });
  }
  catch (cause) {
    const detail = cause instanceof Error && cause.name === "AbortError"
      ? "已取消 Windows Hello，本次没有执行。"
      : cause instanceof Error && cause.name === "NotAllowedError"
        ? "本机没有找到这个凭证，或你取消了验证。请使用注册凭证的本机浏览器；如果浏览器显示手机二维码，请取消，服务器不会接受跨设备结果。"
        : "Windows Hello 确认没有完成。";
    throw new HumanApprovalClientError(detail, "human_approval_authentication_cancelled");
  }
  finally { signal?.removeEventListener("abort", cancel); }
  return {
    "x-mirror-human-approval-attempt": ceremony.attempt_id,
    "x-mirror-human-approval-assertion": assertionHeader(response)
  };
}

export function cancelHumanApproval() {
  WebAuthnAbortService.cancelCeremony();
}

/** Retry one foreground write only after a request-bound Windows Hello assertion.
 * Reads pass through unchanged, and callers still own response/error parsing. */
export async function fetchWithHumanApproval(
  url: string,
  init: RequestInit,
  request: HumanApprovalRequest
): Promise<Response> {
  let response = await fetch(url, init);
  if (response.status !== 403) return response;
  const payload = await response.clone().json().catch(() => ({})) as { code?: string };
  if (payload.code !== "human_approval_required") return response;
  const approval = await humanApprovalHeaders(request, init.signal ?? undefined);
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(approval)) headers.set(name, value);
  response = await fetch(url, { ...init, headers });
  return response;
}
