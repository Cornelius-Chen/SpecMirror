import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { deriveEngineeringView, type EngineeringView } from "@epm/domain";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { ProjectNodeInspector } from "./ProjectNodeInspector.tsx";
import type { EngineeringRunResult } from "./node-result-state.ts";

interface Selection { view: EngineeringView; nodeId: string; workspaceId: string; ignoreAbort?: boolean }
const fileText = "隔离测试中的真实文件响应";
const fileHash = createHash("sha256").update(fileText).digest("hex");
declare global { interface Window { nodeResultSelect: (selection: Selection) => void; nodeResultSignals: AbortSignal[] } }
function scenario(): Selection {
  const doc = inspectorDocument(); doc.nodes.push(inspectorNode("second", "root"));
  for (const id of ["step", "second"]) doc.runs.push(inspectorRun(doc, id));
  return { view: deriveEngineeringView(doc), nodeId: "step", workspaceId: "isolated-one" };
}
function payload(selection: Selection, path = "artifacts/node-result/成果.md"): EngineeringRunResult {
  const run = selection.view.document.runs.find(item => item.node_id === selection.nodeId)!;
  return { schema_version: 1, kind: "engineering-run-result", workspace_id: selection.workspaceId, node_id: selection.nodeId, run_id: run.id,
    contract_key: run.snapshot.contract_key, node_revision: run.snapshot.node.revision, current_contract: true, observed_at: "2026-09-12T21:00:00Z",
    run_status: "review", started_at: run.started_at, finished_at: run.finished_at, review: null, source_checks: [], metrics: null, issues: [],
    artifacts: [{ evidence_id: "result-file", path, recorded_sha256: fileHash, actual_sha256: fileHash, status: "verified" }] };
}

it("does not repeat an accepted claim in the original inspector without a review record", () => {
  const value = scenario(); value.view.document.runs[0].status = "accepted"; value.view.document.runs[0].reviewed_at = null;
  value.view = deriveEngineeringView(value.view.document);
  const html = renderToStaticMarkup(createElement(ProjectNodeInspector, { ...value, onNavigateNode: () => {}, onOpenDetail: () => {} }));
  expect(html).toContain("验收记录待核对"); expect(html).not.toContain("本项已通过人工验收");
  expect(value.view.document.runs[0].status).toBe("accepted");
});

describe("real React result effects in an isolated browser", () => {
  let server: ViteDevServer | undefined, browser: Browser | undefined, directory: string | undefined, origin: string;
  let testApi: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), "epm-node-result-test-"));
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const initial: Selection = { view: deriveEngineeringView(inspectorDocument()), nodeId: "step", workspaceId: "isolated-one" };
    const harness = `import React, {useMemo,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ProjectNodeInspector} from '/src/components/project-map/ProjectNodeInspector.tsx';
      import {createEngineeringApi} from '/src/engineering-api.ts';
      import '/src/styles.css';
      window.nodeResultSignals=[];
      function Harness(){const [value,setValue]=useState(${JSON.stringify(initial)});window.nodeResultSelect=setValue;
        const api=useMemo(()=>{const base=createEngineeringApi(value.workspaceId);const read=base.result;
          return {...base,result:(id,signal)=>{window.nodeResultSignals.push(signal);return read(id,value.ignoreAbort?undefined:signal)}};
        },[value.workspaceId,value.ignoreAbort]);
        return React.createElement(ProjectNodeInspector,{...value,api,onNavigateNode:()=>{},onOpenDetail:()=>{}})}
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));`;
    server = await createServer({ configFile: false, root: resolve(root, "apps/web"), cacheDir: resolve(directory, "vite"),
      resolve: { alias: { "@epm/domain": resolve(root, "packages/domain/src/index.ts") } },
      esbuild: { jsx: "automatic" }, optimizeDeps: { include: ["react", "react-dom/client", "lucide-react", "zod"] },
      server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [root] } }, logLevel: "error",
      plugins: [{ name: "isolated-node-result-harness", resolveId: id => id === "/__node_result_harness.js" ? id : undefined,
        load: id => id === "/__node_result_harness.js" ? harness : undefined,
        configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
          if (request.url?.startsWith("/api/")) { if (testApi) testApi(request, response); else { response.statusCode = 404; response.end(); } return; }
          if (request.url?.split("?")[0] !== "/__node_result.html") return next();
          response.setHeader("Content-Type", "text/html"); response.end(await vite.transformIndexHtml("/__node_result.html",
            '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><main style="padding:16px;min-width:0;max-width:1100px;margin:auto"><p>隔离界面测试 · 不连接生产任务</p><div id="root"></div></main><script type="module" src="/__node_result_harness.js"></script></body></html>'));
        }); } }] });
    await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close(); await server?.close();
    if (directory && relative(tmpdir(), directory).startsWith("epm-node-result-test-") && !relative(tmpdir(), directory).includes("..")) rmSync(directory, { recursive: true, force: true });
  });

  it("drops late file bodies after another file, workspace, refresh or close is selected", async () => {
    const context = await browser!.newContext(); const page = await context.newPage();
    // Adversarial transport: ignore cancellation but expose signals for verification.
    await page.addInitScript(() => {
      const original = window.fetch; (window as any).previewSignals = [];
      window.fetch = (input, init) => {
        if (String(input).includes("/artifact?")) {
          (window as any).previewSignals.push(init?.signal);
          return original(input, { ...init, signal: undefined });
        }
        return original(input, init);
      };
    });
    const a = scenario(); let selected = a;
    const bodies: Record<string, string> = { "one.md": "第一份报告，属于原工作区。", "two.md": "第二份报告，不能被第一份覆盖。", "foreign.md": "另一个工作区的报告。" };
    const observed = () => {
      const data = payload(selected);
      const files = selected.workspaceId === a.workspaceId ? ["one.md", "two.md"] : ["foreign.md"];
      data.artifacts = files.map(path => ({ evidence_id: path, path, status: "verified", recorded_sha256: createHash("sha256").update(bodies[path]).digest("hex"), actual_sha256: createHash("sha256").update(bodies[path]).digest("hex") }));
      return data;
    };
    const pending: Array<{ path: string; release: () => void }> = [], seen: Array<{ path: string; query: string | null; header: string | string[] | undefined }> = [];
    testApi = (request, reply) => {
      const url = new URL(request.url!, origin);
      if (url.pathname.endsWith("/result")) { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify(observed())); return; }
      if (url.pathname.endsWith("/artifact")) {
        const path = url.searchParams.get("path")!;
        seen.push({ path, query: url.searchParams.get("workspace"), header: request.headers["x-mirror-workspace-id"] });
        pending.push({ path, release: () => { reply.setHeader("Content-Type", "text/plain; charset=utf-8"); reply.end(bodies[path]); } }); return;
      }
      reply.statusCode = 404; reply.end();
    };
    const reader = page.getByRole("region", { name: "成果原文", exact: true });
    await page.goto(origin + "/__node_result.html");
    await page.getByText("当前版本还未执行。", { exact: true }).waitFor();
    await page.evaluate(value => window.nodeResultSelect(value), a);
    await page.getByRole("button", { name: "one.md", exact: true }).click();
    // StrictMode mounts each reader twice; both requests deliberately ignore abort.
    await expect.poll(() => pending.length).toBe(2);
    const old = pending.splice(0);
    await page.getByRole("button", { name: "two.md", exact: true }).click();
    await expect.poll(() => pending.length).toBe(2); pending.splice(0).forEach(item => item.release());
    await page.getByLabel("报告内容", { exact: true }).waitFor(); old.forEach(item => item.release());
    await expect.poll(async () => reader.getAttribute("data-file-path")).toBe("two.md");
    expect(await page.getByLabel("报告内容", { exact: true }).innerText()).toBe(bodies["two.md"]);
    await page.getByRole("button", { name: "one.md", exact: true }).click();
    await expect.poll(() => pending.length).toBe(2); const oldWorkspace = pending.splice(0);
    selected = { ...a, workspaceId: "another-isolated-workspace" };
    await page.evaluate(value => window.nodeResultSelect(value), selected);
    await page.getByRole("button", { name: "打开成果", exact: true }).waitFor(); oldWorkspace.forEach(item => item.release());
    expect(await reader.count()).toBe(0);
    await page.getByRole("button", { name: "打开成果", exact: true }).click();
    await expect.poll(() => pending.length).toBe(2); pending.splice(0).forEach(item => item.release());
    await page.getByLabel("报告内容", { exact: true }).waitFor();
    expect(await page.getByLabel("报告内容", { exact: true }).innerText()).toBe(bodies["foreign.md"]);
    await page.getByRole("button", { name: "刷新核对", exact: true }).click();
    await page.getByRole("button", { name: "打开成果", exact: true }).waitFor();
    expect(await reader.count()).toBe(0);
    await page.getByRole("button", { name: "打开成果", exact: true }).click();
    await expect.poll(() => pending.length).toBe(2); const closed = pending.splice(0);
    await reader.getByRole("button", { name: "收起报告", exact: true }).click(); closed.forEach(item => item.release());
    expect(await reader.count()).toBe(0);
    expect(await page.evaluate(() => (window as any).previewSignals.every((signal: AbortSignal) => signal.aborted))).toBe(true);
    expect(seen.every(item => item.query === item.header)).toBe(true);
    expect(seen.at(-1)?.query).toBe(selected.workspaceId);
    await context.close();
  }, 30_000);

  it("isolates A-B-A, failures, workspace changes, refresh, historical downloads and actual file opening", async () => {
    const context = await browser!.newContext(); const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let response = payload(scenario()), fail = false, delay = false;
    const pending: Array<() => Promise<void>> = []; const requests: string[] = [];
    testApi = (request, reply) => {
      const url = new URL(request.url!, origin); requests.push(url.pathname + url.search);
      if (url.pathname.endsWith("/artifact")) { reply.setHeader("Content-Type", "text/plain; charset=utf-8"); reply.end(fileText); return; }
      if (!url.pathname.endsWith("/result")) { reply.statusCode = 404; reply.end(); return; }
      const body = JSON.stringify(response), status = fail ? 500 : 200;
      const send = async () => { if (reply.destroyed) return; reply.statusCode = status; reply.setHeader("Content-Type", "application/json"); reply.setHeader("Cache-Control", "no-store"); reply.setHeader("Content-Disposition", 'attachment; filename="engineering-run-result.json"'); reply.end(body); };
      if (delay) { pending.push(send); return; } void send();
    };
    await page.goto(origin + "/__node_result.html");
    await page.getByText("当前版本还未执行。", { exact: true }).waitFor(); expect(requests).toHaveLength(0);
    const a = { ...scenario(), ignoreAbort: true }; response = payload(a, "artifacts/node-result/first-A.md"); delay = true;
    await page.evaluate(value => window.nodeResultSelect(value), a);
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    const oldResponses = pending.splice(0); delay = false; fail = true;
    const b = { ...a, nodeId: "second" }; response = payload(b);
    await page.evaluate(value => window.nodeResultSelect(value), b);
    await page.getByRole("alert").waitFor(); expect(await page.getByRole("link", { name: "下载记录", exact: true }).count()).toBe(0);
    fail = false; response = payload(a, "artifacts/node-result/new-A.md");
    await page.evaluate(value => window.nodeResultSelect(value), a);
    await page.getByText("已提交1 份成果记录，等待人工查收。", { exact: true }).waitFor();
    for (const release of oldResponses) await release();
    await page.getByRole("button", { name: "打开成果", exact: true }).click();
    await page.getByLabel("报告内容", { exact: true }).waitFor();
    expect(await page.getByRole("region", { name: "成果原文", exact: true }).getAttribute("data-file-path")).toContain("new-A.md");
    expect(await page.evaluate(() => window.nodeResultSignals.some(signal => signal.aborted))).toBe(true);
    const foreign = { ...a, workspaceId: "isolated-two", ignoreAbort: false }; response = payload(foreign);
    await page.evaluate(value => window.nodeResultSelect(value), foreign);
    await expect.poll(async () => page.getByRole("link", { name: "下载记录", exact: true }).getAttribute("href")).toContain("workspace=isolated-two");
    response = { ...payload(foreign), workspace_id: "wrong-workspace" }; await page.getByRole("button", { name: "刷新核对", exact: true }).click();
    await page.getByRole("alert").waitFor(); expect(await page.getByRole("link", { name: "下载记录", exact: true }).count()).toBe(0);
    response = payload(foreign); response.artifacts[0].status = "changed";
    await page.getByRole("button", { name: "刷新核对", exact: true }).click(); await page.getByText("需要处理", { exact: true }).first().waitFor();
    response = payload(foreign); await page.getByRole("button", { name: "刷新核对", exact: true }).click();
    await page.getByText("待查收", { exact: true }).waitFor(); expect(await page.locator(".nr-issues").count()).toBe(0);
    await page.getByText("材料、检查与时间", { exact: true }).click(); await page.getByText("缺测", { exact: true }).waitFor();
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await page.locator(".node-result-panel").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.getByRole("button", { name: "打开成果", exact: true }).click();
    await page.getByLabel("报告内容", { exact: true }).waitFor();
    expect(await page.getByLabel("报告内容", { exact: true }).innerText()).toBe(fileText);
    expect(context.pages()).toHaveLength(1);
    expect(requests.some(url => url.includes("/artifact?") && url.includes("workspace=isolated-two"))).toBe(true);
    const doc = structuredClone(foreign.view.document); doc.nodes.find(node => node.id === "step")!.revision++;
    const historical = { ...foreign, view: deriveEngineeringView(doc) }; response = { ...payload(foreign), current_contract: false };
    await page.evaluate(value => window.nodeResultSelect(value), historical);
    await page.getByText("当前版本还未执行。 可选择历史记录查阅；历史成果不代表当前完成。", { exact: true }).waitFor();
    expect(await page.getByRole("link", { name: "下载记录", exact: true }).count()).toBe(0);
    await page.getByLabel("选择成果运行").selectOption(response.run_id); await page.getByText("历史运行 · 不代表当前完成", { exact: true }).waitFor();
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "下载记录", exact: true }).click();
    const download = await downloadPromise; expect(download.suggestedFilename()).toBe("engineering-run-result.json");
    const downloaded = JSON.parse(readFileSync((await download.path())!, "utf8")); expect(downloaded).toMatchObject({ workspace_id: "isolated-two", node_id: "step", run_id: response.run_id, current_contract: false });
    await page.reload(); await page.getByText("当前版本还未执行。", { exact: true }).waitFor();
    expect(errors).toEqual([]); await context.close();
  }, 60_000);
});
