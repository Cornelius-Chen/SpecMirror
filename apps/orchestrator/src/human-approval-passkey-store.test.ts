import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHumanApprovalPasskey, humanApprovalPasskeyPath, HumanApprovalPasskeyStoreError, isAllowedCodexLocalAppDataRedirect, loadHumanApprovalPasskey, replaceHumanApprovalPasskey, type StoredHumanApprovalPasskey } from "./human-approval-passkey-store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { const absolute = resolve(root); if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes("mirror-passkey-store-test-")) throw new Error("unsafe_test_path"); rmSync(absolute, { recursive: true, force: true }); } });
function root() { const value = join(tmpdir(), `mirror-passkey-store-test-${crypto.randomUUID()}`); mkdirSync(value); roots.push(value); return value; }
function stored(counter = 0): StoredHumanApprovalPasskey {
  return { schema_version: 1, principal_id: "owner", rp_id: "localhost", origin: "http://localhost:4317", registration_origin: "http://localhost:49999", created_at: "2026-09-08T00:00:00.000Z", updated_at: "2026-09-08T00:00:00.000Z", credential: { id: Buffer.from("id").toString("base64url"), public_key: Buffer.from("key").toString("base64url"), counter, device_type: "singleDevice", backed_up: false } };
}

describe("Codex LOCALAPPDATA virtualization", () => {
  it("accepts only the exact OS-managed Codex LocalCache mapping", () => {
    const local = "C:\\Users\\Owner\\AppData\\Local";
    const logical = `${local}\\SpecMirror\\human-approval-v1`;
    expect(isAllowedCodexLocalAppDataRedirect(
      logical,
      `${local}\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\SpecMirror\\human-approval-v1`,
      local,
      "win32"
    )).toBe(true);
    expect(isAllowedCodexLocalAppDataRedirect(
      logical,
      `${local}\\Packages\\Other.App_123\\LocalCache\\Local\\SpecMirror\\human-approval-v1`,
      local,
      "win32"
    )).toBe(false);
    expect(isAllowedCodexLocalAppDataRedirect(
      logical,
      `${local}\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\Elsewhere`,
      local,
      "win32"
    )).toBe(false);
    expect(isAllowedCodexLocalAppDataRedirect(
      `${local}\\OtherApp\\human-approval-v1`,
      `${local}\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\OtherApp\\human-approval-v1`,
      local,
      "win32"
    )).toBe(false);
  });
});

describe("human approval passkey store", () => {
  it("atomically creates exactly one credential and never replaces it", () => {
    const directory = join(root(), "approval"), first = stored(1), second = { ...stored(7), principal_id: "attacker" };
    createHumanApprovalPasskey(directory, first);
    expect(() => createHumanApprovalPasskey(directory, second)).toThrowError(expect.objectContaining({ code: "credential_store_exists" }));
    expect(loadHumanApprovalPasskey(directory, { rpID: "localhost", origin: "http://localhost:4317" })).toEqual(first);
    expect(readFileSync(humanApprovalPasskeyPath(directory), "utf8")).not.toContain("attacker");
  });

  it("updates only the same credential snapshot and preserves its identity", () => {
    const directory = join(root(), "approval"), first = stored(1); createHumanApprovalPasskey(directory, first);
    replaceHumanApprovalPasskey(directory, { ...first, updated_at: "2026-09-08T00:01:00.000Z", credential: { ...first.credential, counter: 2 } });
    expect(loadHumanApprovalPasskey(directory, { rpID: "localhost", origin: "http://localhost:4317" }).credential.counter).toBe(2);
    expect(() => replaceHumanApprovalPasskey(directory, { ...first, principal_id: "other" })).toThrowError(expect.objectContaining({ code: "credential_store_invalid" }));
  });

  it("rejects a reparse/symlink directory before writing credential bytes", () => {
    const base = root(), actual = join(base, "actual"), linked = join(base, "linked"); mkdirSync(actual);
    symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => createHumanApprovalPasskey(linked, stored())).toThrow(HumanApprovalPasskeyStoreError);
    expect(existsSync(humanApprovalPasskeyPath(actual))).toBe(false);
  });

  it("rejects an origin or RP ID mismatch", () => {
    const directory = join(root(), "approval"); createHumanApprovalPasskey(directory, stored());
    expect(() => loadHumanApprovalPasskey(directory, { rpID: "localhost", origin: "http://127.0.0.1:4317" })).toThrowError(expect.objectContaining({ code: "credential_store_invalid" }));
    expect(() => loadHumanApprovalPasskey(directory, { rpID: "example.test", origin: "http://localhost:4317" })).toThrowError(expect.objectContaining({ code: "credential_store_invalid" }));
  });
});
