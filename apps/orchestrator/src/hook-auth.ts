import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const HOOK_AUTH_HEADERS = {
  timestamp: "x-specmirror-hook-timestamp",
  nonce: "x-specmirror-hook-nonce",
  signature: "x-specmirror-hook-signature"
} as const;
export const HOOK_AUTH_MAX_SKEW_MS = 5 * 60_000;
const KEY_FILE = "hook-auth-v1.key";
const NONCE_DIRECTORY = "hook-auth-v1-nonces";
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const SIGNATURE_PATTERN = /^v1=([a-f0-9]{64})$/;

export type HookAuthFailure = "missing" | "invalid" | "expired" | "replayed";

export class HookAuthenticationError extends Error {
  readonly code = "codex_hook_auth_failed";
  readonly status = 401;
  constructor(readonly reason: HookAuthFailure) {
    super("Codex Hook authentication failed; the lifecycle event was ignored.");
  }
}

type HeaderValue = string | string[] | undefined;
type HookAuthHeaders = Record<string, HeaderValue>;

function singleHeader(value: HeaderValue) {
  return typeof value === "string" ? value : Array.isArray(value) && value.length === 1 ? value[0] : undefined;
}

export function hookAuthDataDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()) {
  const configured = env.SPECMIRROR_LOCAL_DATA_DIR;
  if (configured !== undefined) {
    if (!configured.trim() || !isAbsolute(configured)) throw new Error("SPECMIRROR_LOCAL_DATA_DIR must be an absolute local path.");
    return configured;
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, "AppData", "Local");
    return join(base, "SpecMirror");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "SpecMirror");
  const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(base, "specmirror");
}

export function hookAuthKeyPath(dataDirectory = hookAuthDataDirectory()) {
  if (!isAbsolute(dataDirectory)) throw new Error("Hook authentication data directory must be absolute.");
  return join(dataDirectory, KEY_FILE);
}

function decodeKey(raw: string) {
  const encoded = raw.trim();
  if (!KEY_PATTERN.test(encoded)) throw new Error("SpecMirror Hook authentication key is invalid.");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new Error("SpecMirror Hook authentication key is invalid.");
  return key;
}

/** The server is the sole creator. Relay processes only read this user-local key. */
export function ensureHookAuthKey(dataDirectory = hookAuthDataDirectory()) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const path = hookAuthKeyPath(dataDirectory);
  try {
    writeFileSync(path, randomBytes(32).toString("base64url") + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are inherited from the user-local directory. */ }
  return decodeKey(readFileSync(path, "utf8"));
}

function canonical(value: unknown, depth: number): string {
  if (depth > 32) throw new HookAuthenticationError("invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
  }
  throw new HookAuthenticationError("invalid");
}

export function canonicalHookPayload(payload: unknown) {
  return canonical(payload, 0);
}

function signedMessage(timestamp: string, nonce: string, payload: unknown) {
  return `${timestamp}\n${nonce}\n${canonicalHookPayload(payload)}`;
}

export function signHookPayload(payload: unknown, options: { dataDirectory?: string; timestamp?: number; nonce?: string } = {}) {
  const timestamp = String(options.timestamp ?? Date.now());
  const nonce = options.nonce ?? randomBytes(24).toString("base64url");
  if (!/^\d{13}$/.test(timestamp) || !NONCE_PATTERN.test(nonce)) throw new HookAuthenticationError("invalid");
  const key = ensureHookAuthKey(options.dataDirectory);
  const signature = createHmac("sha256", key).update(signedMessage(timestamp, nonce, payload)).digest("hex");
  return {
    [HOOK_AUTH_HEADERS.timestamp]: timestamp,
    [HOOK_AUTH_HEADERS.nonce]: nonce,
    [HOOK_AUTH_HEADERS.signature]: `v1=${signature}`
  };
}

export class HookRequestAuthenticator {
  readonly dataDirectory: string;
  private readonly key: Buffer;
  readonly nonceDirectory: string;
  #accepted = 0;

  constructor(options: { dataDirectory?: string; readonly now?: () => number; readonly maxSkewMs?: number } = {}) {
    this.dataDirectory = options.dataDirectory ?? hookAuthDataDirectory();
    this.now = options.now ?? Date.now;
    this.maxSkewMs = options.maxSkewMs ?? HOOK_AUTH_MAX_SKEW_MS;
    this.key = ensureHookAuthKey(this.dataDirectory);
    this.nonceDirectory = join(this.dataDirectory, NONCE_DIRECTORY);
    mkdirSync(this.nonceDirectory, { recursive: true, mode: 0o700 });
    this.cleanup();
  }

  readonly now: () => number;
  readonly maxSkewMs: number;

  verify(payload: unknown, headers: HookAuthHeaders) {
    const timestamp = singleHeader(headers[HOOK_AUTH_HEADERS.timestamp]);
    const nonce = singleHeader(headers[HOOK_AUTH_HEADERS.nonce]);
    const signed = singleHeader(headers[HOOK_AUTH_HEADERS.signature]);
    if (timestamp === undefined || nonce === undefined || signed === undefined) throw new HookAuthenticationError("missing");
    const signature = signed.match(SIGNATURE_PATTERN)?.[1];
    if (!/^\d{13}$/.test(timestamp) || !NONCE_PATTERN.test(nonce) || !signature) throw new HookAuthenticationError("invalid");
    const at = Number(timestamp), now = this.now();
    if (!Number.isSafeInteger(at) || !Number.isFinite(now) || Math.abs(now - at) > this.maxSkewMs) throw new HookAuthenticationError("expired");
    const expected = createHmac("sha256", this.key).update(signedMessage(timestamp, nonce, payload)).digest();
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HookAuthenticationError("invalid");
    this.claimNonce(nonce, timestamp);
    if (++this.#accepted % 64 === 0) this.cleanup();
    return Object.freeze({ timestamp: at, nonce });
  }

  private claimNonce(nonce: string, timestamp: string) {
    const marker = join(this.nonceDirectory, createHash("sha256").update(nonce).digest("hex"));
    try { writeFileSync(marker, timestamp + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new HookAuthenticationError("replayed");
      throw error;
    }
  }

  private cleanup() {
    const cutoff = this.now() - this.maxSkewMs * 2;
    try {
      for (const entry of readdirSync(this.nonceDirectory)) {
        const path = join(this.nonceDirectory, entry);
        try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* A concurrent verifier may already have removed it. */ }
      }
    } catch { /* A later exclusive nonce write still preserves fail-closed replay handling. */ }
  }
}
