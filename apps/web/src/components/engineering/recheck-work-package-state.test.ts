import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveEngineeringView, engineeringContractKey } from "@epm/domain";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { createEngineeringApi, type RecheckWorkPackagePreview, type RecheckWorkPackageRequest } from "../../engineering-api.ts";
import { RecheckWorkPackageDialog } from "./RecheckWorkPackageDialog.tsx";
import { initialRecheckWorkPackageDraft, prepareRecheckWorkPackageRequest, recheckConfigIndex,
  recheckWorkPackageCandidates, recheckWorkPackageContext, recheckWorkPackagePreviewCurrent } from "./recheck-work-package-state.ts";

function fixture() {
  const doc = inspectorDocument([inspectorNode("root", null), ...["backend", "frontend"].map((id, order) => inspectorNode(id, "root", {
    title: id === "backend" ? "导出运行记录" : "图上查看结果", owner: "codex:fixture-session", order,
    source_scope: { root: "D:/isolated-fixture", allow: [`src/${id}.ts`], deny: [], checks: [
      { id: "vitest", title: "功能检查", program: "node", args: ["node_modules/vitest/vitest.mjs", "run", `src/${id}.test.ts`, "--config", "../vitest.config.ts", "--maxWorkers=1"], timeout_ms: 60_000 },
      { id: "syntax", title: "语法检查", program: "node", args: ["--check", `src/${id}.js`] }
    ] }
  }))]);
  doc.runs.push(inspectorRun(doc, "backend", "paused", "external"), inspectorRun(doc, "frontend", "blocked", "external"));
  const view = deriveEngineeringView(doc), draft = initialRecheckWorkPackageDraft(view);
  draft.selected = ["backend", "frontend"]; draft.reason = "修正测试配置路径";
  draft.configPaths.backend.vitest = "vitest.config.ts"; draft.configPaths.frontend.vitest = "vitest.config.ts";
  return { view, draft };
}
function preview(view: ReturnType<typeof fixture>["view"], request: RecheckWorkPackageRequest): RecheckWorkPackagePreview {
  return { token: "isolated-preview", request: structuredClone(request), workspace_id: "isolated", root_id: view.document.root_id,
    expected_revision: request.expected_revision, manifest_digest: "a".repeat(64), expires_at: "2026-09-12T23:00:00Z", creates_runs: false,
    affected_ids: [view.document.root_id, ...request.items.map(item => item.node_id)], ready_node_ids: request.items.map(item => item.node_id),
    nodes: request.items.map(item => { const node = view.document.nodes.find(node => node.id === item.node_id)!;
      return { id: node.id, title: node.title, owner: node.owner, prior_run_id: item.prior_run_id, checks: item.checks.map(check => {
        const before = node.source_scope!.checks.find(candidate => candidate.id === check.id)!;
        return { id: check.id, title: before.title, args: [...check.args], before_args: [...before.args], timeout_ms: before.timeout_ms ?? 30_000,
          ...(JSON.stringify(check.args) === JSON.stringify(before.args) ? {} : { configuration: { test_root: "D:/isolated-fixture", path: "D:/isolated-fixture/vitest.config.ts", sha256: "b".repeat(64) } }) };
      }) };
    }) };
}
const now = Date.parse("2026-09-12T22:00:00Z");

describe("bounded recheck work package form", () => {
  it("starts unselected with original config values, and only changes the chosen path arguments", () => {
    const { view, draft } = fixture(), initial = initialRecheckWorkPackageDraft(view), before = JSON.stringify(view);
    expect(initial).toMatchObject({ selected: [], reason: "", configPaths: { backend: { vitest: "../vitest.config.ts" } } });
    const request = prepareRecheckWorkPackageRequest(view, draft);
    expect(request.items).toHaveLength(2);
    for (const item of request.items) {
      const node = view.document.nodes.find(node => node.id === item.node_id)!;
      expect(item.prior_run_id).toBe(view.document.runs.find(run => run.node_id === node.id)!.id);
      for (const check of item.checks) {
        const original = node.source_scope!.checks.find(candidate => candidate.id === check.id)!.args;
        const changed = check.args.flatMap((arg, index) => arg === original[index] ? [] : [index]);
        expect(changed).toEqual(check.id === "vitest" ? [4] : []);
      }
    }
    expect(JSON.stringify(view)).toBe(before);
    expect(Object.keys(request).sort()).toEqual(["expected_revision", "items", "reason"]);
  });

  it("requires an explicit selection, a reason, changed paths, and unambiguous config arguments", () => {
    const { view, draft } = fixture();
    expect(() => prepareRecheckWorkPackageRequest(view, { ...draft, selected: [] })).toThrow("请选择");
    expect(() => prepareRecheckWorkPackageRequest(view, { ...draft, reason: " " })).toThrow("为什么");
    draft.configPaths.backend.vitest = "../vitest.config.ts";
    expect(() => prepareRecheckWorkPackageRequest(view, draft)).toThrow("尚未修改");
    draft.configPaths.backend.vitest = "different.config.ts";
    expect(() => prepareRecheckWorkPackageRequest(view, draft)).toThrow("不能更换配置文件名");
    for (const path of ["", "--run", "a\nb"]) {
      draft.configPaths.backend.vitest = path;
      expect(() => prepareRecheckWorkPackageRequest(view, draft)).toThrow("配置文件路径");
    }
    for (const args of [["--config"], ["--config=x"], ["--config", "--run"], ["--config", "a", "--config", "b"]]) expect(recheckConfigIndex(args)).toBe(-1);
  });

  it("allows only current paused or blocked external leaves owned by their original task", () => {
    const { view, draft } = fixture();
    expect(recheckWorkPackageCandidates(view).map(item => item.unavailable)).toEqual(["", ""]);
    view.document.runs[0].mode = "controlled";
    expect(() => prepareRecheckWorkPackageRequest(view, draft)).toThrow("原负责人");
    view.document.runs[0].mode = "external"; view.document.runs[0].handoff!.owner = "codex:other";
    expect(() => prepareRecheckWorkPackageRequest(view, draft)).toThrow("负责人不一致");
    view.document.runs[0].handoff!.owner = "codex:fixture-session";
    view.document.runs[0].status = "running";
    expect(recheckWorkPackageCandidates(view).map(item => item.node.id)).toEqual(["frontend"]);
    view.document.runs[0].status = "paused"; view.document.nodes[1].revision++;
    expect(recheckWorkPackageCandidates(view).map(item => item.node.id)).toEqual(["frontend"]);
    view.document.runs[0].snapshot.contract_key = engineeringContractKey(view.document, "backend");
    expect(recheckWorkPackageCandidates(view)).toHaveLength(2);
  });

  it("rejects mismatched previews, workspaces, runs, before/after paths, expiration and revisions", () => {
    const { view, draft } = fixture(), request = prepareRecheckWorkPackageRequest(view, draft), candidate = preview(view, request);
    const valid = (value = candidate, workspace = "isolated", at = now) => recheckWorkPackagePreviewCurrent(value, request, view, "isolated", workspace, at);
    expect(valid()).toBe(true);
    expect(valid(candidate, "elsewhere")).toBe(false);
    expect(valid(candidate, "isolated", Date.parse(candidate.expires_at))).toBe(false);
    const mutations: Array<(p: RecheckWorkPackagePreview) => void> = [
      p => { p.workspace_id = "elsewhere"; }, p => { p.root_id = "wrong"; }, p => { p.manifest_digest = "invalid"; },
      p => { p.request.reason = "different"; }, p => { p.nodes[0].prior_run_id = "wrong"; },
      p => { p.nodes[0].checks[0].before_args[4] = "misleading-old.ts"; }, p => { p.nodes[0].checks[0].args[4] = "unreviewed.ts"; },
      p => { p.nodes[0].checks[0].timeout_ms++; }, p => { p.nodes[0].owner = "codex:other"; },
      p => { delete p.nodes[0].checks[0].configuration; }, p => { p.nodes[0].checks[0].configuration!.sha256 = "invalid"; },
      p => { p.nodes[0].checks[0].configuration!.path = " "; }, p => { p.nodes[0].checks[0].configuration!.test_root = ""; },
      p => { p.ready_node_ids = ["backend", "other"]; }, p => { p.nodes[1] = p.nodes[0]; }
    ];
    for (const mutate of mutations) { const changed = structuredClone(candidate); mutate(changed); expect(valid(changed)).toBe(false); }
    view.document.revision++; expect(valid()).toBe(false);
  });

  it("invalidates context for same-revision run or owner changes, while rendering no editable general arguments", () => {
    const { view } = fixture(), context = recheckWorkPackageContext(view, "isolated");
    const html = renderToStaticMarkup(createElement(RecheckWorkPackageDialog, { view, api: createEngineeringApi("isolated"), onClose: () => {}, onUpdated: () => {} }));
    expect(html).toContain("重新检查现有代码，历史执行记录保留");
    expect(html).toContain("修正原因"); expect(html).not.toContain("<select"); expect(html).not.toContain("checked=\"\"");
    view.document.runs[0].status = "running";
    expect(recheckWorkPackageContext(view, "isolated")).not.toBe(context);
  });
});
