import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { findRepoRoot } from "@epm/spec-io";
import { createHumanApprovalPasskey, defaultHumanApprovalDataDirectory, humanApprovalPasskeyPath, HumanApprovalPasskeyStoreError, type StoredHumanApprovalPasskey } from "./human-approval-passkey-store.ts";

const SETUP_CAPABILITY_HEADER = "x-mirror-setup-capability";
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface HumanApprovalRegistrationPrimitives {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
}
export interface LocalHumanApprovalSetupOptions {
  dataDirectory?: string;
  setupOrigin: string;
  mainOrigin?: string;
  rpID?: string;
  capability?: string;
  attemptTtlMs?: number;
  now?: () => number;
  ids?: () => string;
  webauthn?: HumanApprovalRegistrationPrimitives;
}
export class HumanApprovalSetupError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A one-shot ceremony used only by the temporary setup listener, never the 4317 API. */
export class LocalHumanApprovalSetup {
  readonly capability: string;
  readonly dataDirectory: string;
  private activeCapability?: string;
  private attempt?: { id: string; challenge: string; expiresAt: number };
  readonly setupOrigin: string;
  private readonly mainOrigin: string;
  private readonly rpID: string;
  private readonly attemptTtlMs: number;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly webauthn: HumanApprovalRegistrationPrimitives;

  constructor(options: LocalHumanApprovalSetupOptions) {
    this.dataDirectory = options.dataDirectory ?? defaultHumanApprovalDataDirectory();
    this.setupOrigin = options.setupOrigin;
    this.mainOrigin = options.mainOrigin ?? "http://localhost:4317";
    this.rpID = options.rpID ?? "localhost";
    this.attemptTtlMs = options.attemptTtlMs ?? 90_000;
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.webauthn = options.webauthn ?? { generateRegistrationOptions, verifyRegistrationResponse };
    this.capability = options.capability ?? randomBytes(32).toString("base64url");
    this.activeCapability = this.capability;
    const setup = new URL(this.setupOrigin), main = new URL(this.mainOrigin);
    if (setup.origin !== this.setupOrigin || setup.protocol !== "http:" || setup.hostname !== "localhost"
      || main.origin !== this.mainOrigin || main.protocol !== "http:" || main.hostname !== "localhost" || this.rpID !== "localhost") {
      throw new Error("human_approval_setup_requires_exact_localhost_origins");
    }
    if (Buffer.from(this.capability, "base64url").byteLength !== 32 || !Number.isFinite(this.attemptTtlMs)
      || this.attemptTtlMs < 10_000 || this.attemptTtlMs > 120_000) throw new Error("invalid_human_approval_setup_configuration");
  }

  status() {
    const registered = existsSync(humanApprovalPasskeyPath(this.dataDirectory));
    return {
      ready: !registered && Boolean(this.activeCapability),
      attempt_started: Boolean(this.attempt),
      registered
    };
  }

  async options(suppliedCapability: string | undefined) {
    if (existsSync(humanApprovalPasskeyPath(this.dataDirectory))) throw new HumanApprovalSetupError("human_approval_already_registered", 409, "本机 Owner 凭证已经存在；Setup 不会添加或替换凭证。");
    if (!this.activeCapability || !suppliedCapability || !safeEqual(this.activeCapability, suppliedCapability)) throw new HumanApprovalSetupError("human_approval_setup_capability_invalid", 403, "Setup 能力值无效或已经使用。");
    // Consume before the first await. A failed/cancelled ceremony requires a new CLI run.
    this.activeCapability = undefined;
    const options = await this.webauthn.generateRegistrationOptions({
      rpName: "Mirror",
      rpID: this.rpID,
      userName: "Mirror Owner",
      userDisplayName: "Mirror 本机 Owner",
      userID: createHash("sha256").update(`${this.rpID}:mirror-local-owner-v1`).digest(),
      timeout: this.attemptTtlMs,
      attestationType: "none",
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
      preferredAuthenticatorType: "localDevice"
    });
    const id = this.ids();
    this.attempt = { id, challenge: options.challenge, expiresAt: this.now() + this.attemptTtlMs };
    return { attempt_id: id, options };
  }

  async verify(body: { attempt_id?: unknown; response?: unknown } | undefined) {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (!attempt || typeof body?.attempt_id !== "string" || body.attempt_id !== attempt.id || attempt.expiresAt <= this.now()) throw new HumanApprovalSetupError("human_approval_setup_attempt_invalid", 409, "Setup 请求已失效，请重新运行 Setup。");
    if (!body.response || typeof body.response !== "object" || Array.isArray(body.response)) throw new HumanApprovalSetupError("human_approval_registration_invalid", 400, "Windows Hello 注册响应无效。");
    if ((body.response as RegistrationResponseJSON).authenticatorAttachment !== "platform") throw new HumanApprovalSetupError("human_approval_registration_rejected", 403, "只允许本机 Windows Hello；未写入跨设备凭证。");
    if (existsSync(humanApprovalPasskeyPath(this.dataDirectory))) throw new HumanApprovalSetupError("human_approval_already_registered", 409, "本机 Owner 凭证已经存在；Setup 不会添加或替换凭证。");
    let result;
    try {
      result = await this.webauthn.verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: attempt.challenge,
        expectedOrigin: this.setupOrigin,
        expectedRPID: this.rpID,
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: true
      });
    } catch { throw new HumanApprovalSetupError("human_approval_registration_rejected", 403, "Windows Hello 未能验证本机 Owner；未写入凭证。"); }
    if (!result.verified || !result.registrationInfo?.userVerified) throw new HumanApprovalSetupError("human_approval_registration_rejected", 403, "Windows Hello 未确认用户身份；未写入凭证。");
    const info = result.registrationInfo, timestamp = new Date(this.now()).toISOString();
    const stored: StoredHumanApprovalPasskey = {
      schema_version: 1,
      principal_id: `local-owner-${this.ids()}`,
      rp_id: this.rpID,
      origin: this.mainOrigin,
      registration_origin: this.setupOrigin,
      created_at: timestamp,
      updated_at: timestamp,
      credential: {
        id: info.credential.id,
        public_key: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: info.credential.counter,
        transports: info.credential.transports,
        device_type: info.credentialDeviceType,
        backed_up: info.credentialBackedUp
      }
    };
    try { createHumanApprovalPasskey(this.dataDirectory, stored); }
    catch (failure) {
      const detail = failure instanceof HumanApprovalPasskeyStoreError
        ? failure.code
        : (typeof failure === "object" && failure && "code" in failure && typeof failure.code === "string" ? failure.code : "unknown");
      throw new HumanApprovalSetupError("human_approval_credential_create_failed", 409, `凭证未写入（${detail}）；本机存储校验失败。`);
    }
    return { verified: true, registered: true };
  }
}

export function renderHumanApprovalSetupPage(nonce: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mirror Windows Hello Setup</title><style nonce="${nonce}">body{font-family:system-ui;margin:0;background:#f7f8f5;color:#17231d}.card{max-width:640px;margin:10vh auto;padding:32px;border:1px solid #ccd4ce;border-radius:16px;background:white;box-shadow:0 18px 45px rgba(28,56,43,.12)}button{font:inherit;padding:12px 18px;border:0;border-radius:9px;background:#176b4d;color:white;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}p{line-height:1.7;color:#526159}#status{font-weight:650;color:#173f31;padding:12px 14px;border-radius:9px;background:#edf6f1}#status[data-tone="error"]{color:#8b2d24;background:#fff0ed}#status[data-tone="working"]{color:#18588d;background:#eef6ff}#diagnostics{font-size:13px;color:#627269;margin-top:14px}</style></head><body><main class="card"><h1>注册本机 Windows Hello</h1><p>这是一次性 Owner Setup。只有点击按钮并通过 Windows Hello 后才会写入凭证；取消或失败后需要重新运行 Setup。</p><button id="start" disabled>正在检查…</button><p id="status" role="status" aria-live="polite">正在检查 Setup 服务和 Windows Hello…</p><p id="diagnostics">服务：检查中 · 页面：检查中 · Windows Hello：检查中</p></main><script nonce="${nonce}">
const status=document.querySelector('#status'),diagnostics=document.querySelector('#diagnostics'),button=document.querySelector('#start');const capability=location.hash.slice(1);history.replaceState(null,'',location.pathname);let serverReady=false,ceremonyStarted=false,healthTimer;
const show=(message,tone='info')=>{status.textContent=message;status.dataset.tone=tone};
const stop=(message)=>{serverReady=false;button.disabled=true;button.textContent='请重新运行 Setup';show(message,'error');if(healthTimer)clearInterval(healthTimer)};
const from64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
const to64=value=>{const bytes=new Uint8Array(value);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text).split('+').join('-').split('/').join('_').replace(/=+$/,'')};
async function checkHealth(){if(ceremonyStarted)return;const secure=window.isSecureContext;const hello=typeof PublicKeyCredential!=='undefined'&&navigator.credentials&&typeof navigator.credentials.create==='function';diagnostics.textContent='服务：检查中 · 页面：'+(secure?'安全':'不安全')+' · Windows Hello：'+(hello?'可调用':'不可调用');if(!capability)return stop('这个页面缺少一次性 Setup 凭据，请关闭窗口并重新运行 Setup。');if(!secure)return stop('当前页面不是安全的本机页面，Windows Hello 无法启动。');if(!hello)return stop('当前浏览器不支持 Windows Hello 注册，请使用新版 Edge 或 Chrome。');try{const response=await fetch('/health',{cache:'no-store'});const state=await response.json();if(!response.ok||!state.ready)return stop(state.error||'这次 Setup 已经使用或失效，请关闭窗口并重新运行 Setup。');serverReady=true;button.disabled=false;button.textContent='开始注册';show('准备就绪。点击后应立即出现 Windows Hello。');diagnostics.textContent='服务：在线 · 页面：安全 · Windows Hello：可调用'}catch{stop('Setup 服务已经关闭或过期。这个旧页面不能继续，请重新运行 Setup。')}}
button.addEventListener('click',async()=>{if(!serverReady||ceremonyStarted)return;ceremonyStarted=true;serverReady=false;button.disabled=true;button.textContent='正在启动 Windows Hello…';if(healthTimer)clearInterval(healthTimer);try{show('正在向本机 Setup 服务申请一次性注册…','working');const prepared=await fetch('/options',{method:'POST',headers:{'x-mirror-setup-capability':capability}});const ceremony=await prepared.json();if(!prepared.ok)throw Error(ceremony.error||'Setup 已失效。');const o=ceremony.options;o.challenge=from64(o.challenge);o.user.id=from64(o.user.id);for(const item of o.excludeCredentials||[])item.id=from64(item.id);show('正在等待 Windows Hello。若弹窗被遮住，请查看任务栏中的系统验证窗口。','working');const credential=await navigator.credentials.create({publicKey:o});if(!credential)throw Error('浏览器没有返回 Windows Hello 凭据。');show('Windows Hello 已完成，正在写入本机 Owner 凭据…','working');const r=credential.response;const response={id:credential.id,rawId:to64(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment||undefined,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:to64(r.clientDataJSON),attestationObject:to64(r.attestationObject),transports:r.getTransports?r.getTransports():undefined,authenticatorData:r.getAuthenticatorData?to64(r.getAuthenticatorData()):undefined,publicKeyAlgorithm:r.getPublicKeyAlgorithm?r.getPublicKeyAlgorithm():undefined,publicKey:r.getPublicKey&&r.getPublicKey()?to64(r.getPublicKey()):undefined}};const verified=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attempt_id:ceremony.attempt_id,response})});const result=await verified.json();if(!verified.ok)throw Error(result.error||'Windows Hello 未通过。');show('注册完成。现在可以关闭此窗口并返回 Mirror。');diagnostics.textContent='服务：完成 · 页面：安全 · Windows Hello：已验证';button.hidden=true}catch(error){const message=error&&error.name==='NotAllowedError'?'Windows Hello 被取消或超时。本次一次性 Setup 已结束，请重新运行后再试。':(error&&error.message||'Setup 未完成。');stop(message)}});
checkHealth();healthTimer=setInterval(checkHealth,5000);
</script></body></html>`;
}

export function openHumanApprovalSetupWindow(setupURL: string) {
  // Keep the one-time capability out of the long-lived browser command line.
  // The shell launcher exits immediately after handing the URL to the default browser.
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", setupURL], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return "default";
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

export function humanApprovalSetupRequestAllowed(request: Pick<IncomingMessage, "method" | "headers" | "socket">, expectedHost: string, setupOrigin: string) {
  if (!loopbackAddresses.has(request.socket.remoteAddress ?? "") || request.headers.host !== expectedHost || request.method === "OPTIONS") return false;
  if (request.method === "GET") return true;
  const fetchSite = request.headers["sec-fetch-site"];
  return request.method === "POST" && request.headers.origin === setupOrigin && (fetchSite === "same-origin" || fetchSite === "none");
}
async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 1024 * 1024) throw new HumanApprovalSetupError("setup_body_too_large", 413, "Setup 响应过大。"); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function runHumanApprovalSetup(options: { dataDirectory?: string; mainOrigin?: string } = {}) {
  const dataDirectory = options.dataDirectory ?? defaultHumanApprovalDataDirectory();
  if (existsSync(humanApprovalPasskeyPath(dataDirectory))) throw new Error("本机 Owner 凭证已经存在；没有 HTTP reset 或第二凭证入口。");
  const nonce = randomBytes(18).toString("base64url");
  let setup: LocalHumanApprovalSetup | undefined, completed = false, expectedHost = "";
  const expiresAt = Date.now() + 5 * 60_000;
  const server = createServer(async (request, response) => {
    if (!setup || !humanApprovalSetupRequestAllowed(request, expectedHost, setup.setupOrigin)) return sendJson(response, 403, { code: "setup_request_rejected", error: "仅允许当前一次性本机 Setup 页面。" });
    let closeAfterResponse = false;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/") {
        const body = renderHumanApprovalSetupPage(nonce);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, "permissions-policy": "publickey-credentials-create=(self)", "x-content-type-options": "nosniff" });
        return response.end(body);
      }
      if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ...setup.status(), expires_at: new Date(expiresAt).toISOString() });
      if (request.method === "POST" && url.pathname === "/options") return sendJson(response, 200, await setup!.options(typeof request.headers[SETUP_CAPABILITY_HEADER] === "string" ? request.headers[SETUP_CAPABILITY_HEADER] : undefined));
      if (request.method === "POST" && url.pathname === "/verify") {
        closeAfterResponse = true;
        const result = await setup!.verify(await readJson(request) as { attempt_id?: unknown; response?: unknown });
        completed = true; return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { code: "not_found", error: "Setup 路径不存在。" });
    } catch (failure) {
      const known = failure instanceof HumanApprovalSetupError;
      return sendJson(response, known ? failure.status : 400, { code: known ? failure.code : "setup_failed", error: known ? failure.message : "Setup 请求无效。" });
    } finally {
      if (closeAfterResponse) setImmediate(() => server.close());
    }
  });
  server.listen(0, "localhost");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动本机 Setup listener。");
  const origin = `http://localhost:${address.port}`;
  setup = new LocalHumanApprovalSetup({ dataDirectory, setupOrigin: origin, mainOrigin: options.mainOrigin });
  expectedHost = `localhost:${address.port}`;
  const setupURL = `${origin}/#${setup.capability}`;
  console.log("Mirror 一次性 Windows Hello Setup 已启动。请在 5 分钟内完成；能力值不会发送到主 API。");
  if (process.platform === "win32") {
    openHumanApprovalSetupWindow(setupURL);
    console.log("已使用默认浏览器打开 Setup 页面。");
  } else {
    console.log(setupURL);
  }
  const timeout = setTimeout(() => server.close(), 5 * 60_000);
  await once(server, "close");
  clearTimeout(timeout);
  if (!completed) throw new Error("Setup 已关闭且没有写入凭证。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = findRepoRoot(), localEnv = join(root, ".env.local");
  if (existsSync(localEnv)) loadEnvFile(localEnv);
  const port = Number(process.env.EPM_PORT ?? 4317);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("EPM_PORT 必须是有效端口。");
  runHumanApprovalSetup({ mainOrigin: `http://localhost:${port}` }).catch(failure => { console.error(failure instanceof Error ? failure.message : "Setup 失败。"); process.exitCode = 1; });
}
