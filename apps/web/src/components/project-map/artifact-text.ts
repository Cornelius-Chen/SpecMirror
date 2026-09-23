import type { EngineeringApi } from "../../engineering-api.ts";
import { isResultArtifactPath, type EngineeringRunResult } from "./node-result-state.ts";

/** Browser-side bound only; the existing artifact endpoint may read the whole file. */
export const TEXT_ARTIFACT_MAX_BYTES = 256 * 1024;
export interface ArtifactText {
  text: string;
  sha256: string;
  mimeType: string;
  byteLength: number;
}

export function canPreviewArtifactText(path: unknown): path is string {
  return isResultArtifactPath(path) && /\.(?:md|txt|json|csv|log)$/i.test(path);
}

const abortError = () => new DOMException("已取消读取成果。", "AbortError");
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw abortError(); };
const textMimeTypes = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/json", "application/octet-stream"]);

function checkedUrl(value: string, origin: string, runId: string, path: string, workspace: string) {
  let url: URL;
  try { url = new URL(value, `${origin}/`); } catch { throw new Error("成果链接不可用，请刷新记录后重试。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.hash
    || url.pathname !== `/api/engineering/runs/${encodeURIComponent(runId)}/artifact`
    || [...url.searchParams.keys()].some(key => key !== "path" && key !== "workspace")
    || url.searchParams.getAll("path").length !== 1 || url.searchParams.get("path") !== path
    || url.searchParams.getAll("workspace").length > 1 || (url.searchParams.get("workspace") ?? "host") !== workspace) {
    throw new Error("成果链接与当前运行或工作区不一致，未读取正文。");
  }
  return url;
}

/**
 * Reuse the existing scoped artifact URL, then verify the bytes against the last
 * observed actual hash. No approval helper, login flow, redirects or executable view.
 * Platform APIs: MDN Request/redirect, TextDecoder/fatal and SubtleCrypto/digest.
 * https://developer.mozilla.org/en-US/docs/Web/API/Request/redirect
 * https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/fatal
 * https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
 */
export async function readArtifactText(
  api: Pick<EngineeringApi, "artifact" | "workspaceId">,
  runId: string,
  artifact: EngineeringRunResult["artifacts"][number],
  signal: AbortSignal
): Promise<ArtifactText> {
  checkAbort(signal);
  if (!canPreviewArtifactText(artifact.path)) throw new Error("此文件不支持原处文本预览，可使用原文件入口查看。");
  if (!artifact.actual_sha256 || !/^[a-f\d]{64}$/i.test(artifact.actual_sha256)) throw new Error("缺少有效的当前文件摘要，请先刷新成果核对。");
  if (["missing", "unreadable"].includes(artifact.status)) throw new Error("当前文件缺失或不可读取，请先刷新成果核对。");
  const workspace = api.workspaceId ?? "host";
  if (!runId || !workspace || /[\u0000-\u001f\u007f]/.test(runId + workspace)) throw new Error("缺少有效的运行或工作区标识，未读取正文。");
  const origin = globalThis.location?.origin;
  if (!origin || origin === "null") throw new Error("当前页面无法确认成果来源，未读取正文。");
  let artifactUrl: string;
  try { artifactUrl = api.artifact(runId, artifact.path); } catch { throw new Error("成果链接不可用，请刷新记录后重试。"); }
  const url = checkedUrl(artifactUrl, origin, runId, artifact.path, workspace);
  const expectedHash = artifact.actual_sha256.toLowerCase();
  let response: Response;
  try {
    response = await fetch(url.href, { method: "GET", cache: "no-store", redirect: "error", mode: "same-origin", credentials: "same-origin", signal,
      headers: { "x-mirror-workspace-id": workspace, Accept: "text/plain, text/markdown, text/csv, application/json, application/octet-stream" } });
  } catch {
    checkAbort(signal);
    throw new Error("无法读取成果；网络请求失败或重定向已被拒绝。");
  }
  const discardResponse = () => { void response.body?.cancel().catch(() => {}); };
  if (signal.aborted) { discardResponse(); throw abortError(); }
  if (response.redirected || response.type === "opaqueredirect" || !response.url) {
    discardResponse(); throw new Error("成果响应来源已变化，未读取正文。");
  }
  try { checkedUrl(response.url, origin, runId, artifact.path, workspace); } catch (error) { discardResponse(); throw error; }
  if (!response.ok || response.status !== 200) {
    discardResponse();
    throw new Error(response.status === 401 || response.status === 403
      ? `当前权限无法读取成果（${response.status}），请在原页面核对访问权限。`
      : `成果读取未完成（${response.status}），请刷新后重试。`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const mimeType = contentType.split(";", 1)[0].trim().toLowerCase();
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (!textMimeTypes.has(mimeType) || charset && charset !== "utf-8" && charset !== "utf8") {
    discardResponse();
    throw new Error("响应不是支持的 UTF-8 文本，未展示正文。");
  }
  if (!response.body) throw new Error("成果响应没有可读取的内容流，请刷新后重试。");

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const bytes = new Uint8Array(TEXT_ARTIFACT_MAX_BYTES);
  let byteLength = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch {
        checkAbort(signal);
        throw new Error("读取成果内容失败，请刷新后重试。");
      }
      checkAbort(signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error("成果内容流格式不可用，未展示正文。");
      // Count actual streamed bytes, including when Content-Length is absent or false.
      if (byteLength + chunk.value.byteLength > TEXT_ARTIFACT_MAX_BYTES) throw new Error("文件超过 256 KiB，原处预览已停止，请使用原文件入口查看。");
      bytes.set(chunk.value, byteLength); byteLength += chunk.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel(); reader.releaseLock();
  }
  checkAbort(signal);
  const content = bytes.subarray(0, byteLength);
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest("SHA-256", content); } catch {
    checkAbort(signal);
    throw new Error("当前环境无法校验文件摘要，未展示正文。");
  }
  checkAbort(signal);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== expectedHash) throw new Error("文件在核对后又发生变化，请刷新成果核对后重试。");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { throw new Error("文件不是有效的 UTF-8 文本，未展示正文。"); }
  if (text.includes("\0")) throw new Error("文件包含二进制空字符，不能作为文本预览。");
  checkAbort(signal);
  return { text, sha256, mimeType, byteLength };
}
