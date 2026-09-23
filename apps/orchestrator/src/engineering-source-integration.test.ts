import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineeringNodeSchema, effectiveEngineeringConstraints, engineeringContractKey, engineeringLineage, type EngineeringDocument, type EngineeringRun, type EngineeringSourceScope } from "@epm/domain";
import { captureEngineeringSourceBaseline, freezeEngineeringSourceScope, verifyEngineeringSourceProof } from "./engineering-source-proof.ts";
import { planEngineeringSourceIntegration } from "./engineering-source-integration.ts";

const folders: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), "mirror-source-integration-")); folders.push(root); writeFileSync(join(root, "feature.txt"), "alpha"); return root; }
afterEach(() => { for (const item of folders.splice(0)) { const root = resolve(item); if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe_cleanup"); rmSync(root, { recursive: true, force: true }); } });
function document(): EngineeringDocument {
  const root = EngineeringNodeSchema.parse({ id: "project", title: "整合工程", kind: "project", parent_id: null, order: 0, revision: 1, status: "ready", objective: "全部已验收功能在最终代码仍成立", constraints: { allow: ["**"], deny: [], rules: [], resources: [] }, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" });
  return { schema_version: 1, id: "fixture", root_id: root.id, revision: 1, nodes: [root], runs: [], events: [], changes: [], capability_uses: [], created_at: "now", updated_at: "now" };
}
function skeleton(doc: EngineeringDocument, nodeId: string, status: EngineeringRun["status"] = "accepted"): EngineeringRun {
  const node = doc.nodes.find(item => item.id === nodeId)!;
  return { id: "run-" + nodeId + "-" + doc.runs.length, node_id: nodeId, mode: nodeId === "project" ? "integration" : "external", status, actor: "fixture", started_at: "now", finished_at: "later", current_action: "", completed_action_ids: [], evidence: [], output_dir: "fixture", reason: "", review_note: "fixture accepted", reviewed_at: "later", snapshot: { node: structuredClone(node), lineage: engineeringLineage(doc, nodeId).map(item => ({ id: item.id, revision: item.revision })), effective: effectiveEngineeringConstraints(doc, nodeId), contract_key: engineeringContractKey(doc, nodeId), children: [], dependencies: [] } };
}
function check(id = "syntax", expression = "process.exit(0)") { return { id, title: "真实检查 " + id, program: "node" as const, args: ["-e", expression] }; }
async function accepted(doc: EngineeringDocument, id: string, root: string, checks: EngineeringSourceScope["checks"] = [check()], change?: () => void, parent = "project") {
  const spec = { root, allow: ["**"], deny: [], checks };
  doc.nodes.push(EngineeringNodeSchema.parse({ id, title: id, parent_id: parent, kind: "step", order: 0, revision: 1, status: "accepted", constraints: { allow: [], deny: [], rules: [], resources: [] }, source_scope: spec, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" }));
  const run = skeleton(doc, id); run.source_scope = freezeEngineeringSourceScope(spec, [root]); run.source_baseline = captureEngineeringSourceBaseline(run.source_scope);
  change?.(); run.source_proof = await verifyEngineeringSourceProof(run.source_baseline, [root]); expect(run.source_proof.passed).toBe(true);
  doc.runs.push(run); return run;
}
const reference = (run: EngineeringRun) => ({ node_id: run.node_id, run_id: run.id, contract_key: run.snapshot.contract_key });
function integration(doc: EngineeringDocument, sources = doc.runs) { const run = skeleton(doc, "project", "running"); run.snapshot.children = sources.map(reference); return run; }

describe("final source integration planning", () => {
  it("rechecks earlier accepted functions against final source instead of accepting only the latest manifest", async () => {
    const root = directory(), doc = document();
    const first = await accepted(doc, "first", root, [check("alpha", "require('node:assert').match(require('node:fs').readFileSync('feature.txt','utf8'),/alpha/)")]);
    const second = await accepted(doc, "second", root, [check("beta", "require('node:assert').match(require('node:fs').readFileSync('feature.txt','utf8'),/beta/)")], () => writeFileSync(join(root, "feature.txt"), "beta"));
    const plan = planEngineeringSourceIntegration(doc, integration(doc), [root]);
    expect(plan.latest.map(item => item.run_id)).toEqual([second.id]); expect(plan.scopes).toHaveLength(1); expect(plan.scopes[0].checks).toHaveLength(2);
    const baseline = captureEngineeringSourceBaseline(plan.scopes[0]); expect(baseline.manifest_sha256).toBe(second.source_proof?.final_manifest_sha256);
    const final = await verifyEngineeringSourceProof(baseline, [root]);
    expect(final).toMatchObject({ passed: false, status: "failed" }); expect(final.checks.map(item => item.status)).toEqual(["failed", "passed"]);
    expect(first.source_proof?.passed).toBe(true); // Historical proof remains historical, not silently rewritten.
  });
  it("deduplicates commands per original cwd and retains independent roots", async () => {
    const a = directory(), b = directory(), doc = document();
    await accepted(doc, "a1", a, [{ ...check("one"), timeout_ms: 1000 }]);
    await accepted(doc, "a2", a, [{ ...check("same-command"), timeout_ms: 2000 }]);
    await accepted(doc, "b", b);
    const plan = planEngineeringSourceIntegration(doc, integration(doc), [a, b]);
    expect(plan.scopes).toHaveLength(2); expect(plan.latest).toHaveLength(2);
    expect(plan.scopes.find(scope => scope.root === a)?.checks).toHaveLength(1);
    expect(plan.scopes.find(scope => scope.root === a)?.checks[0].timeout_ms).toBe(1000);
    expect(plan.scopes.every(scope => scope.allow.join() === "**" && scope.deny.length === 0)).toBe(true);
  });
  it("requires a final wide-root proof when the newest overlapping proof is narrow", async () => {
    const root = directory(), nested = join(root, "nested"), doc = document(); mkdirSync(nested); writeFileSync(join(nested, "file.txt"), "source");
    const broad = await accepted(doc, "broad", root), narrow = await accepted(doc, "narrow", nested);
    broad.source_proof!.verified_at = "2026-09-05T01:00:00Z"; narrow.source_proof!.verified_at = "2026-09-05T02:00:00Z";
    expect(() => planEngineeringSourceIntegration(doc, integration(doc), [root])).toThrow("较窄");
    broad.source_proof!.verified_at = "2026-09-05T03:00:00Z";
    const plan = planEngineeringSourceIntegration(doc, integration(doc), [root]);
    expect(plan.latest.map(item => item.run_id)).toEqual([broad.id]); expect(plan.scopes).toHaveLength(2);
  });
  it("recurses through accepted intermediate integration and rejects stale references or missing actual proof", async () => {
    const root = directory(), doc = document();
    doc.nodes.push(EngineeringNodeSchema.parse({ id: "group", title: "中间整合", parent_id: "project", kind: "task", order: 0, revision: 1, status: "accepted", constraints: { allow: [], deny: [], rules: [], resources: [] }, created_at: "now", updated_at: "now" }));
    const leaf = await accepted(doc, "leaf", root, [check()], undefined, "group"), group = skeleton(doc, "group");
    group.mode = "integration"; group.snapshot.children = [reference(leaf)]; doc.runs.push(group);
    expect(planEngineeringSourceIntegration(doc, integration(doc, [group]), [root]).latest[0].run_id).toBe(leaf.id);
    leaf.source_proof!.checks[0].status = "failed";
    expect(() => planEngineeringSourceIntegration(doc, integration(doc, [group]), [root])).toThrow("实际检查");
    leaf.source_proof!.checks[0].status = "passed"; doc.nodes.find(node => node.id === "leaf")!.revision++;
    expect(() => planEngineeringSourceIntegration(doc, integration(doc, [group]), [root])).toThrow("已失效");
  });
  it("returns no source work for artifact-only references and refuses an unbounded final check list", async () => {
    const root = directory(), doc = document();
    expect(planEngineeringSourceIntegration(doc, integration(doc), [root])).toEqual({ scopes: [], latest: [] });
    await accepted(doc, "twelve", root, Array.from({ length: 12 }, (_, index) => check("check-" + index, "process.exit(0); // check " + index)));
    await accepted(doc, "extra", root, [check("extra", "process.exit(0); // thirteenth")]);
    expect(() => planEngineeringSourceIntegration(doc, integration(doc), [root])).toThrow("超过 12");
  });
});
