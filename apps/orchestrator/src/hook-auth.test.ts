import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalHookPayload,
  ensureHookAuthKey,
  HOOK_AUTH_HEADERS,
  HookAuthenticationError,
  HookRequestAuthenticator,
  hookAuthKeyPath,
  signHookPayload
} from "./hook-auth.ts";

const fixtures: string[] = [];
function fixture() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "specmirror-hook-auth-"));
  fixtures.push(dataDirectory);
  return dataDirectory;
}

afterEach(() => {
  for (const directory of fixtures.splice(0).reverse()) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_test_cleanup");
    rmSync(absolute, { recursive: true, force: true });
  }
});

function failure(run: () => unknown) {
  try { run(); }
  catch (error) { return error as HookAuthenticationError; }
  throw new Error("expected Hook authentication to fail");
}

describe("local Codex Hook authentication", () => {
  it("creates one private random key and never returns or embeds it in signed headers", () => {
    const dataDirectory = fixture();
    const first = ensureHookAuthKey(dataDirectory), second = ensureHookAuthKey(dataDirectory);
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    const encoded = readFileSync(hookAuthKeyPath(dataDirectory), "utf8").trim();
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") expect(statSync(hookAuthKeyPath(dataDirectory)).mode & 0o777).toBe(0o600);
    const headers = signHookPayload({ hook_event_name: "SessionStart" }, { dataDirectory, timestamp: 1_788_787_200_000, nonce: "0123456789abcdefghijklmn" });
    expect(JSON.stringify(headers)).not.toContain(encoded);
  });

  it("canonicalizes object keys while retaining array order", () => {
    expect(canonicalHookPayload({ z: [2, 1], a: { y: true, x: null } }))
      .toBe(canonicalHookPayload({ a: { x: null, y: true }, z: [2, 1] }));
    expect(canonicalHookPayload({ z: [2, 1] })).not.toBe(canonicalHookPayload({ z: [1, 2] }));
  });

  it("fails closed for missing, malformed, wrong, expired, future and tampered requests", () => {
    const dataDirectory = fixture(), now = 1_788_787_200_000;
    const auth = new HookRequestAuthenticator({ dataDirectory, now: () => now });
    const payload = { session_id: "session-a", cwd: "C:\\source", hook_event_name: "SessionStart" };
    expect(failure(() => auth.verify(payload, {})).reason).toBe("missing");
    expect(failure(() => auth.verify(payload, {
      [HOOK_AUTH_HEADERS.timestamp]: String(now), [HOOK_AUTH_HEADERS.nonce]: "short", [HOOK_AUTH_HEADERS.signature]: "v1=bad"
    })).reason).toBe("invalid");
    const wrong = signHookPayload(payload, { dataDirectory, timestamp: now, nonce: "wrong_signature_nonce_0001" });
    wrong[HOOK_AUTH_HEADERS.signature] = `v1=${"0".repeat(64)}`;
    expect(failure(() => auth.verify(payload, wrong)).reason).toBe("invalid");
    const old = signHookPayload(payload, { dataDirectory, timestamp: now - 300_001, nonce: "expired_nonce_00000000001" });
    expect(failure(() => auth.verify(payload, old)).reason).toBe("expired");
    const future = signHookPayload(payload, { dataDirectory, timestamp: now + 300_001, nonce: "future_nonce_000000000001" });
    expect(failure(() => auth.verify(payload, future)).reason).toBe("expired");
    const signed = signHookPayload(payload, { dataDirectory, timestamp: now, nonce: "tampered_payload_nonce_001" });
    expect(failure(() => auth.verify({ ...payload, session_id: "session-b" }, signed)).reason).toBe("invalid");
  });

  it("accepts a valid request once and rejects replay after an authenticator restart", () => {
    const dataDirectory = fixture(), now = 1_788_787_200_000;
    const payload = { session_id: "session-a", cwd: "C:\\source", hook_event_name: "SessionStart" };
    const headers = signHookPayload(payload, { dataDirectory, timestamp: now, nonce: "unique_replay_nonce_000001" });
    expect(new HookRequestAuthenticator({ dataDirectory, now: () => now }).verify(payload, headers)).toMatchObject({ timestamp: now });
    expect(failure(() => new HookRequestAuthenticator({ dataDirectory, now: () => now }).verify(payload, headers)).reason).toBe("replayed");
  });
});
