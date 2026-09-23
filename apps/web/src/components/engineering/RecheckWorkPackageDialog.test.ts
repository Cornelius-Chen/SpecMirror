import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveEngineeringView } from "@epm/domain";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";

// Browser fixture API is in memory and cannot reach any production service or human gate.
function initialView() {
  const doc = inspectorDocument([inspectorNode("root", null), ...["backend", "frontend"].map((id, order) => inspectorNode(id, "root", {
    title: id === "backend" ? "导出运行记录" : "图上查看结果", owner: "codex:fixture-session", order,
    source_scope: { root: "D:/isolated-fixture", allow: [`src/${id}.ts`], deny: [], checks: [{ id: "vitest", title: "功能检查", program: "node",
      args: ["node_modules/vitest/vitest.mjs", "run", `src/${id}.test.ts`, "--config", "../vitest.config.ts", "--maxWorkers=1"], timeout_ms: 30_000 }] }
  }))]);
  doc.runs.push(inspectorRun(doc, "backend", "paused", "external"), inspectorRun(doc, "frontend", "blocked", "external"));
  return deriveEngineeringView(doc);
}

describe("recheck dialog real React lifecycle in an isolated browser", () => {
  let server: ViteDevServer | undefined, browser: Browser | undefined, directory: string | undefined, origin: string;
  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), "epm-recheck-dialog-test-"));
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const harness = `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {RecheckWorkPackageDialog} from '/src/components/engineering/RecheckWorkPackageDialog.tsx';
      import '/src/styles.css';
      const original=${JSON.stringify(initialView())};
      window.recheckTest={requests:[],commits:[],updates:[],closes:0,pendingPreviews:[],pendingCommits:[]};
      const log=window.recheckTest;
      function Harness(){const [state,setState]=useState({view:original,workspace:'isolated',disabled:false,open:true});
        window.recheckProps=patch=>setState(old=>({...old,...patch,view:patch.revision?{...old.view,document:{...old.view.document,revision:patch.revision}}:old.view}));
        const api={workspaceId:state.workspace,previewRecheckWorkPackage:request=>{log.requests.push(request);return new Promise((resolve,reject)=>log.pendingPreviews.push({request,view:state.view,workspace:state.workspace,resolve,reject}));},
          commitRecheckWorkPackage:(token,request)=>{log.commits.push({token,request});return new Promise((resolve,reject)=>log.pendingCommits.push({view:state.view,resolve,reject}));}};
        return state.open?React.createElement(RecheckWorkPackageDialog,{key:state.workspace,view:state.view,api,disabled:state.disabled,
          onUpdated:view=>log.updates.push(view),onClose:()=>{log.closes++;setState(old=>({...old,open:false}));}}):React.createElement('p',null,'已关闭');}
      window.resolveRecheckPreview=()=>{const pending=log.pendingPreviews.shift(),request=pending.request;
        pending.resolve({token:'preview-'+log.requests.length,request,workspace_id:pending.workspace,root_id:pending.view.document.root_id,
          expected_revision:request.expected_revision,manifest_digest:'a'.repeat(64),expires_at:new Date(Date.now()+600000).toISOString(),creates_runs:false,
          affected_ids:request.items.map(item=>item.node_id),ready_node_ids:request.items.map(item=>item.node_id),
          nodes:request.items.map(item=>{const node=pending.view.document.nodes.find(node=>node.id===item.node_id);return {id:node.id,title:node.title,owner:node.owner,prior_run_id:item.prior_run_id,
            checks:item.checks.map(check=>{const old=node.source_scope.checks.find(c=>c.id===check.id);return {id:check.id,title:old.title,before_args:old.args,args:check.args,timeout_ms:old.timeout_ms??30000,
              configuration:{test_root:'D:/isolated-fixture',path:'D:/isolated-fixture/vitest.config.ts',sha256:'b'.repeat(64)}};})};})});};
      window.resolveRecheckCommit=success=>{const pending=log.pendingCommits.shift();if(!success)pending.reject(new Error('隔离测试：确认失败'));else pending.resolve({...pending.view,document:{...pending.view.document,revision:pending.view.document.revision+1}});};
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));`;
    server = await createServer({ configFile: false, root: resolve(root, "apps/web"), cacheDir: resolve(directory, "vite"),
      resolve: { alias: { "@epm/domain": resolve(root, "packages/domain/src/index.ts") } }, esbuild: { jsx: "automatic" },
      optimizeDeps: { include: ["react", "react-dom/client", "zod"] }, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [root] } },
      plugins: [{ name: "isolated-recheck-dialog", resolveId: id => id === "/__recheck.js" ? id : undefined, load: id => id === "/__recheck.js" ? harness : undefined,
        configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
          if (request.url?.startsWith("/api/")) { response.statusCode = 403; response.end("No live API in fixture"); return; }
          if (request.url?.split("?")[0] !== "/__recheck.html") return next();
          response.setHeader("Content-Type", "text/html"); response.end(await vite.transformIndexHtml("/__recheck.html",
            '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__recheck.js"></script></body></html>'));
        }); } }] });
    await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close(); await server?.close();
    if (directory && relative(tmpdir(), directory).startsWith("epm-recheck-dialog-test-") && !relative(tmpdir(), directory).includes("..")) rmSync(directory, { recursive: true, force: true });
  });
  async function form(page: Page) {
    await page.goto(origin + "/__recheck.html");
    await page.getByRole("checkbox", { name: "导出运行记录" }).check();
    await page.getByRole("checkbox", { name: "图上查看结果" }).check();
    await page.getByRole("textbox", { name: "导出运行记录 · 功能检查 · 配置路径" }).fill("vitest.config.ts");
    await page.getByRole("textbox", { name: "图上查看结果 · 功能检查 · 配置路径" }).fill("vitest.config.ts");
    await page.getByRole("textbox", { name: "修正原因" }).fill("修正 Vitest 配置路径");
    await page.getByRole("button", { name: "预览 2 项修正" }).click();
  }
  async function prepared(page: Page) {
    await form(page); await page.evaluate("window.resolveRecheckPreview()");
    await page.getByRole("button", { name: "确认修正并准备复验" }).waitFor();
  }

  it("shows old/new paths and prior runs, delegates one exact commit despite duplicate clicks", async () => {
    const page = await browser!.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      await prepared(page);
      expect(await page.getByText("→ 新路径：", { exact: false }).count()).toBe(2);
      expect(await page.getByText("原路径：", { exact: false }).first().textContent()).toContain("../vitest.config.ts");
      expect(await page.getByText("原运行：", { exact: false }).first().textContent()).toContain("fixture-run-backend");
      await page.getByRole("button", { name: "确认修正并准备复验" }).evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
      expect(await page.evaluate("window.recheckTest.commits.length")).toBe(1);
      const args = await page.evaluate("window.recheckTest.commits[0].request.items[0].checks[0].args");
      expect(args).toEqual(["node_modules/vitest/vitest.mjs", "run", "src/backend.test.ts", "--config", "vitest.config.ts", "--maxWorkers=1"]);
      await page.evaluate("window.resolveRecheckCommit(true)"); await page.getByText("已关闭", { exact: true }).waitFor();
      expect(await page.evaluate("[window.recheckTest.updates.length,window.recheckTest.closes]")).toEqual([1, 1]); expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("retains corrected paths after failure and requires a fresh preview before retry", async () => {
    const page = await browser!.newPage();
    try {
      await prepared(page); await page.getByRole("button", { name: "确认修正并准备复验" }).click();
      await page.evaluate("window.resolveRecheckCommit(false)"); await page.getByRole("alert").waitFor();
      expect(await page.getByRole("textbox", { name: "导出运行记录 · 功能检查 · 配置路径" }).inputValue()).toBe("vitest.config.ts");
      expect(await page.getByRole("button", { name: "确认修正并准备复验" }).count()).toBe(0);
      await page.getByRole("button", { name: "预览 2 项修正" }).click(); await page.evaluate("window.resolveRecheckPreview()");
      await page.getByRole("button", { name: "确认修正并准备复验" }).waitFor();
      expect(await page.evaluate("[window.recheckTest.requests.length,window.recheckTest.commits.length]")).toEqual([2, 1]);
    } finally { await page.close(); }
  }, 30_000);

  it("ignores a late preview after a revision change and a late commit after switching workspaces", async () => {
    const page = await browser!.newPage();
    try {
      await form(page); await page.evaluate("window.recheckProps({revision:2})");
      await page.getByRole("alert").waitFor(); await page.evaluate("window.resolveRecheckPreview()");
      await page.getByRole("button", { name: "预览 2 项修正" }).waitFor();
      expect(await page.getByRole("button", { name: "确认修正并准备复验" }).count()).toBe(0);
      await prepared(page); await page.getByRole("button", { name: "确认修正并准备复验" }).click();
      await page.evaluate("window.recheckProps({workspace:'another-workspace'})");
      await page.getByRole("button", { name: "预览 0 项修正" }).waitFor();
      await page.evaluate("window.resolveRecheckCommit(true)");
      expect(await page.evaluate("[window.recheckTest.updates.length,window.recheckTest.closes]")).toEqual([0, 0]);
      expect(await page.getByRole("dialog", { name: "修正检查配置并复验" }).count()).toBe(1);
    } finally { await page.close(); }
  }, 30_000);
});
