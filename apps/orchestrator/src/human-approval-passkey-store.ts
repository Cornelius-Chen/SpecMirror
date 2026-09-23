import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep, win32 } from "node:path";

const base64url = /^[A-Za-z0-9_-]+$/u;

export interface StoredHumanApprovalPasskey {
  schema_version: 1;
  principal_id: string;
  rp_id: string;
  origin: string;
  registration_origin: string;
  created_at: string;
  updated_at: string;
  credential: {
    id: string;
    public_key: string;
    counter: number;
    transports?: string[];
    device_type: "singleDevice" | "multiDevice";
    backed_up: boolean;
  };
}

export class HumanApprovalPasskeyStoreError extends Error {
  constructor(public readonly code: "credential_store_exists" | "credential_store_invalid" | "credential_store_missing") { super(code); }
}

export function defaultHumanApprovalDataDirectory(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData?.trim()) throw new Error("LOCALAPPDATA_is_required_for_human_approval");
  return join(resolve(localAppData), "SpecMirror", "human-approval-v1");
}

export function humanApprovalPasskeyPath(dataDirectory: string) {
  return join(resolve(dataDirectory), "passkey.json");
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Packaged Codex processes can transparently virtualize LOCALAPPDATA writes into
 * their own LocalCache. This is an OS-managed redirect, not a user-created
 * symlink or junction. Accept only the exact Codex package mapping and keep all
 * other realpath changes fail-closed.
 */
export function isAllowedCodexLocalAppDataRedirect(
  logicalPath: string,
  resolvedPath: string,
  localAppData = process.env.LOCALAPPDATA,
  platform = process.platform
) {
  if (platform !== "win32" || !localAppData?.trim()) return false;
  const localRoot = win32.resolve(localAppData);
  const logical = win32.resolve(logicalPath);
  const redirected = win32.resolve(resolvedPath);
  const logicalRelative = win32.relative(localRoot, logical);
  if (!logicalRelative || logicalRelative === ".." || logicalRelative.startsWith(`..${win32.sep}`) || win32.isAbsolute(logicalRelative)) return false;
  const logicalParts = logicalRelative.split(win32.sep).filter(Boolean);
  if (logicalParts[0]?.toLowerCase() !== "specmirror") return false;
  const packageRelative = win32.relative(win32.join(localRoot, "Packages"), redirected);
  const parts = packageRelative.split(win32.sep).filter(Boolean);
  if (parts.length < 4 || !/^OpenAI\.Codex_[A-Za-z0-9]+$/iu.test(parts[0] ?? "")
    || parts[1]?.toLowerCase() !== "localcache" || parts[2]?.toLowerCase() !== "local") return false;
  return win32.resolve(...parts.slice(3)).toLowerCase() === win32.resolve(logicalRelative).toLowerCase();
}

/** Rejects symlink/junction traversal for every existing component of the store path. */
function assertNoReparseTraversal(path: string) {
  const absolute = resolve(path), parsedRoot = resolve(absolute.slice(0, absolute.indexOf(sep) + 1));
  const segments = relative(parsedRoot, absolute).split(sep).filter(Boolean);
  let current = parsedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
    const actual = realpathSync.native(current);
    if (!samePath(actual, resolve(current))) {
      const physical = lstatSync(actual);
      if (!isAllowedCodexLocalAppDataRedirect(current, actual) || physical.isSymbolicLink()
        || physical.dev !== stats.dev || physical.ino !== stats.ino) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
    }
  }
}

export function strictBase64urlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !base64url.test(value)) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  const bytes = Buffer.from(value, "base64url");
  if (Buffer.from(bytes).toString("base64url") !== value) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function parse(value: unknown): StoredHumanApprovalPasskey {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  const record = value as Record<string, unknown>, credential = record.credential;
  if (record.schema_version !== 1 || typeof record.principal_id !== "string" || !record.principal_id
    || typeof record.rp_id !== "string" || !record.rp_id || typeof record.origin !== "string" || !record.origin
    || typeof record.registration_origin !== "string" || !record.registration_origin
    || typeof record.created_at !== "string" || typeof record.updated_at !== "string"
    || !credential || typeof credential !== "object" || Array.isArray(credential)) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  const item = credential as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.public_key !== "string"
    || typeof item.counter !== "number" || !Number.isSafeInteger(item.counter) || item.counter < 0
    || !["singleDevice", "multiDevice"].includes(String(item.device_type)) || typeof item.backed_up !== "boolean"
    || (item.transports !== undefined && (!Array.isArray(item.transports) || item.transports.some(entry => typeof entry !== "string")))) {
    throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  }
  strictBase64urlBytes(item.id);
  strictBase64urlBytes(item.public_key);
  return value as StoredHumanApprovalPasskey;
}

export function loadHumanApprovalPasskey(dataDirectory: string, expected: { rpID: string; origin: string }): StoredHumanApprovalPasskey {
  const path = humanApprovalPasskeyPath(dataDirectory);
  assertNoReparseTraversal(path);
  if (!existsSync(path)) throw new HumanApprovalPasskeyStoreError("credential_store_missing");
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128 * 1024) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  let stored: StoredHumanApprovalPasskey;
  try { stored = parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch (failure) {
    if (failure instanceof HumanApprovalPasskeyStoreError) throw failure;
    throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  }
  if (stored.origin !== expected.origin || stored.rp_id !== expected.rpID) throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  return stored;
}

function completeTemp(dataDirectory: string, stored: StoredHumanApprovalPasskey) {
  const path = humanApprovalPasskeyPath(dataDirectory), directory = dirname(path);
  assertNoReparseTraversal(directory);
  mkdirSync(directory, { recursive: true });
  assertNoReparseTraversal(directory);
  const temp = join(directory, `.passkey-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(parse(stored), null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const descriptor = openSync(temp, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return { path, temp };
}

/** Atomically creates the one allowed credential and never replaces an existing file. */
export function createHumanApprovalPasskey(dataDirectory: string, stored: StoredHumanApprovalPasskey) {
  const { path, temp } = completeTemp(dataDirectory, stored);
  try { linkSync(temp, path); }
  catch (failure) {
    if (existsSync(path)) throw new HumanApprovalPasskeyStoreError("credential_store_exists");
    throw failure;
  } finally {
    try { unlinkSync(temp); } catch { /* a temporary file is never an accepted credential */ }
  }
  assertNoReparseTraversal(path);
}

/** Replaces only the registered credential's counter snapshot. */
export function replaceHumanApprovalPasskey(dataDirectory: string, stored: StoredHumanApprovalPasskey) {
  const path = humanApprovalPasskeyPath(dataDirectory);
  const current = loadHumanApprovalPasskey(dataDirectory, { rpID: stored.rp_id, origin: stored.origin });
  if (current.principal_id !== stored.principal_id || current.credential.id !== stored.credential.id || current.created_at !== stored.created_at) {
    throw new HumanApprovalPasskeyStoreError("credential_store_invalid");
  }
  const complete = completeTemp(dataDirectory, stored);
  try { renameSync(complete.temp, path); }
  catch (failure) { try { unlinkSync(complete.temp); } catch { /* preserve previous valid store */ } throw failure; }
  assertNoReparseTraversal(path);
}
