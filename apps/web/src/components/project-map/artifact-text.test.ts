import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineeringApi } from "../../engineering-api.ts";
import type { EngineeringRunResult } from "./node-result-state.ts";
import { canPreviewArtifactText, readArtifactText, TEXT_ARTIFACT_MAX_BYTES } from "./artifact-text.ts";

const origin = "http://127.0.0.1:5249", runId = "submitted-run";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const api = (workspaceId?: string): Pick<EngineeringApi, "artifact" | "workspaceId"> => ({ workspaceId,
  artifact: (id, path) => `/api/engineering/runs/${encodeURIComponent(id)}/artifact?${new URLSearchParams({ path, ...(workspaceId ? { workspace: workspaceId } : {}) })}` });
const record = (bytes: Uint8Array | string, patch: Partial<EngineeringRunResult["artifacts"][number]> = {}): EngineeringRunResult["artifacts"][number] => ({
  evidence_id: "result", path: "reports/result.md", recorded_sha256: hash(bytes), actual_sha256: hash(bytes), status: "verified", ...patch
});
const response = (body: BodyInit | Uint8Array | null, options: ResponseInit = {}, url = new URL(api("fixture").artifact(runId, "reports/result.md"), origin).href) => {
  const value = new Response(body instanceof Uint8Array ? new Uint8Array(body).buffer : body, { headers: { "content-type": "text/plain; charset=utf-8" }, ...options });
  Object.defineProperty(value, "url", { value: url }); return value;
};
const signal = () => new AbortController().signal;

beforeEach(() => { vi.stubGlobal("location", { origin }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded, scoped, hash-checked artifact text", () => {
  it.each(["md", "TXT", "json", "csv", "log"])("allows a safe relative %s path", extension => {
    expect(canPreviewArtifactText(`reports/结果.${extension}`)).toBe(true);
  });

  it.each([null, undefined, "", "../secret.txt", "/secret.txt", "C:/secret.txt", "reports\\result.txt", "a/./b.txt", "a//b.txt", "a/../b.txt", "x.html", "x.js", "x.svg", "x.pdf", "x.txt?token=x"])("rejects unsupported path %s", path => {
    expect(canPreviewArtifactText(path)).toBe(false);
  });

  it("reads exact UTF-8 bytes with an independent real hash and the scoped no-store GET", async () => {
    const text = "# 核对结果\n完成两项检查。\n", bytes = new TextEncoder().encode(text), controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(response(new ReadableStream({ start(stream) { stream.enqueue(bytes.slice(0, 5)); stream.enqueue(bytes.slice(5)); stream.close(); } })));
    vi.stubGlobal("fetch", fetcher);
    const artifact = record(bytes); const before = structuredClone(artifact);
    expect(await readArtifactText(api("fixture"), runId, artifact, controller.signal)).toEqual({ text, sha256: hash(bytes), mimeType: "text/plain", byteLength: bytes.byteLength });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(api("fixture").artifact(runId, artifact.path!), origin).href, expect.objectContaining({
      method: "GET", cache: "no-store", redirect: "error", mode: "same-origin", signal: controller.signal,
      headers: expect.objectContaining({ "x-mirror-workspace-id": "fixture" })
    }));
    expect(artifact).toEqual(before);
  });

  it("accepts the known SHA-256 of abc, uppercase observed hashes and the existing host URL omission", async () => {
    const known = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const fetcher = vi.fn().mockResolvedValue(response("abc", {}, new URL(api().artifact(runId, "reports/result.md"), origin).href)); vi.stubGlobal("fetch", fetcher);
    expect(await readArtifactText(api(), runId, record("abc", { actual_sha256: known.toUpperCase() }), signal())).toMatchObject({ sha256: known, byteLength: 3 });
    expect(fetcher.mock.calls[0][1].headers["x-mirror-workspace-id"]).toBe("host");
  });

  it("uses the currently observed hash for changed files and supports the server's log octet-stream MIME", async () => {
    const scoped = api("fixture"), path = "output/check.log";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("current", { headers: { "content-type": "application/octet-stream" } }, new URL(scoped.artifact(runId, path), origin).href)));
    expect(await readArtifactText(scoped, runId, record("current", { path, status: "changed", recorded_sha256: hash("old") }), signal())).toMatchObject({ text: "current", sha256: hash("current") });
  });

  it.each([null, "", "a".repeat(63), "g".repeat(64)])("rejects invalid actual hash %s before fetching", async actual_sha256 => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readArtifactText(api("fixture"), runId, record("x", { actual_sha256 }), signal())).rejects.toThrow("缺少有效的当前文件摘要");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["missing", "unreadable"] as const)("rejects a %s observation before fetching", async status => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readArtifactText(api("fixture"), runId, record("x", { status }), signal())).rejects.toThrow("当前文件缺失或不可读取");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.invalid/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md&workspace=fixture",
    "/api/engineering/runs/foreign-run/artifact?path=reports%2Fresult.md&workspace=fixture",
    "/api/engineering/runs/submitted-run/result?path=reports%2Fresult.md&workspace=fixture",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fother.md&workspace=fixture",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md&workspace=foreign",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md&workspace=fixture&workspace=fixture",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md&path=reports%2Fresult.md&workspace=fixture",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md&workspace=fixture&approval=forged",
    "/api/engineering/runs/submitted-run/artifact?path=reports%2Fresult.md&workspace=fixture#fragment"
  ])("rejects a URL outside the exact artifact scope (%s)", async url => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readArtifactText({ workspaceId: "fixture", artifact: () => url }, runId, record("x"), signal())).rejects.toThrow("成果链接与当前运行或工作区不一致");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])("does not expose a %s error response or invoke authentication", async status => {
    const secret = "private response should never reach the user";
    const fetcher = vi.fn().mockResolvedValue(response(secret, { status })); vi.stubGlobal("fetch", fetcher);
    const error = await readArtifactText(api("fixture"), runId, record("x"), signal()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a bounded reader error");
    expect(error.message).toContain(String(status)); expect(error.message).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["text/html; charset=utf-8", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/plain; charset=gbk", ""])("refuses unsupported MIME %s", async mime => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("private body", { headers: { "content-type": mime } })));
    await expect(readArtifactText(api("fixture"), runId, record("private body"), signal())).rejects.toThrow("响应不是支持的 UTF-8 文本");
  });

  it("rejects stale hashes after the result observation without returning either body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("changed after verification")));
    await expect(readArtifactText(api("fixture"), runId, record("original verified"), signal())).rejects.toThrow("文件在核对后又发生变化");
  });

  it.each([new Uint8Array([0xc3, 0x28]), new Uint8Array([0xe2, 0x82]), new Uint8Array([0xed, 0xa0, 0x80])])("refuses malformed UTF-8 bytes", async bytes => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(bytes)));
    await expect(readArtifactText(api("fixture"), runId, record(bytes), signal())).rejects.toThrow("文件不是有效的 UTF-8 文本");
  });

  it("refuses NUL even when the actual bytes match the observed hash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("a\0b")));
    await expect(readArtifactText(api("fixture"), runId, record("a\0b"), signal())).rejects.toThrow("文件包含二进制空字符");
  });

  it("accepts exactly 256 KiB and counts bytes independently of the declared Content-Length", async () => {
    const bytes = new Uint8Array(TEXT_ARTIFACT_MAX_BYTES).fill(65);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(bytes, { headers: { "content-type": "text/plain", "content-length": "1" } })));
    expect(await readArtifactText(api("fixture"), runId, record(bytes), signal())).toMatchObject({ byteLength: TEXT_ARTIFACT_MAX_BYTES, sha256: hash(bytes) });
  });

  it("returns an empty text file only after matching its actual empty-byte hash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("")));
    expect(await readArtifactText(api("fixture"), runId, record(""), signal())).toEqual({
      text: "", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", mimeType: "text/plain", byteLength: 0
    });
  });

  it.each([undefined, "1"])("stops and cancels an oversized stream with Content-Length %s", async length => {
    const cancel = vi.fn(); let part = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(part++ ? 1 : TEXT_ARTIFACT_MAX_BYTES).fill(65)); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(stream, { headers: { "content-type": "text/plain", ...(length ? { "content-length": length } : {}) } })));
    await expect(readArtifactText(api("fixture"), runId, record("x"), signal())).rejects.toThrow("文件超过 256 KiB");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns AbortError without fetching when already cancelled", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const controller = new AbortController(); controller.abort("private cancellation reason");
    await expect(readArtifactText(api("fixture"), runId, record("x"), controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "已取消读取成果。" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a pending stream read and suppresses partial content", async () => {
    let pulling!: () => void; const started = new Promise<void>(resolve => { pulling = resolve; }); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { pulling(); }, cancel });
    const getReader = vi.spyOn(stream, "getReader");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(stream)));
    const controller = new AbortController(), reading = readArtifactText(api("fixture"), runId, record("x"), controller.signal);
    const assertion = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await started; expect(getReader).toHaveBeenCalledTimes(1); controller.abort(); await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("sanitizes stream failures and rejects a redirected or foreign response", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("sensitive stream detail")); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(stream)));
    await expect(readArtifactText(api("fixture"), runId, record("x"), signal())).rejects.toThrow("读取成果内容失败");
    const redirected = response("x"); Object.defineProperty(redirected, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirected));
    await expect(readArtifactText(api("fixture"), runId, record("x"), signal())).rejects.toThrow("成果响应来源已变化");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("x", {}, "https://foreign.invalid/result")));
    await expect(readArtifactText(api("fixture"), runId, record("x"), signal())).rejects.toThrow("成果链接与当前运行或工作区不一致");
  });
});
