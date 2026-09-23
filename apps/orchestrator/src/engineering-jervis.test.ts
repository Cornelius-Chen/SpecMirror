import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readYaml } from "@epm/spec-io";
import { EngineeringNodeSchema, type EngineeringCapabilityUse, type EngineeringRun, type EngineeringSnapshot } from "@epm/domain";
import { createEngineeringJervisBridge } from "./engineering-jervis.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const realJervis = resolve(process.env.MIRROR_JERVIS_ROOT ?? join(repo, "../Jervis/IRONMAN_Codex_Implementation_Pack_v1_1"));
const folders: string[] = [];
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const sourceRelative = "visual_language/accepted_advisory/quantified_advanced_view_effect_ontology_v1.yaml";

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "epm-jervis-bridge-"));
  folders.push(root);
  const jervisRoot = join(root, "jervis"), designer = join(root, "designer");
  for (const dir of ["registry/designer/p1_s0c", "legacy", "domains/designer/adapters"]) mkdirSync(join(jervisRoot, dir), { recursive: true });
  for (const name of ["projection_manifest.json", "objects.jsonl", "object_index.jsonl", "relations.jsonl", "intake_contract.json"]) copyFileSync(join(realJervis, "registry/designer/p1_s0c", name), join(jervisRoot, "registry/designer/p1_s0c", name));
  const declaration = readYaml<Record<string, any>>(join(realJervis, "legacy/SOURCE_ROOTS_DECLARATION.yaml"));
  mkdirSync(dirname(join(designer, sourceRelative)), { recursive: true });
  copyFileSync(join(declaration.source_root, sourceRelative), join(designer, sourceRelative));
  declaration.source_root = designer;
  writeFileSync(join(jervisRoot, "legacy/SOURCE_ROOTS_DECLARATION.yaml"), JSON.stringify(declaration));
  copyFileSync(join(realJervis, "domains/designer/adapters/mirror_bridge.py"), join(jervisRoot, "domains/designer/adapters/mirror_bridge.py"));
  const binding = { id: "capability:designer:view.comparison_decision_matrix", version: "0.1.0", purpose: "比较两种真实交付方案", input: { title: "交付方案比较", fit_context: "option_tradeoff", dimensions: [{ id: "cost", label: "费用", unit: "元", source: "测试方案报价" }, { id: "days", label: "交付周期", unit: "天", source: "测试排期" }], options: [{ id: "a", label: "方案 A", values: { cost: 100, days: 4 } }, { id: "b", label: "方案 B", values: { cost: 130, days: 2 } }] } };
  const node = EngineeringNodeSchema.parse({ id: "step-compare", parent_id: "task-decide", kind: "step", title: "比较交付方案", order: 0, revision: 1, status: "ready", constraints: { allow: ["*.html"] }, capabilities: [binding], criteria: [{ id: "comparison", text: "所有方案的维度、单位、来源可比较", kind: "file_exists", path: "comparison.html" }], created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" });
  const snapshot: EngineeringSnapshot = { node, lineage: [{ id: node.id, revision: 1 }], effective: { allow_layers: [{ node_id: node.id, title: node.title, patterns: ["*.html"] }], deny: [], rules: [], resources: [] }, contract_key: "fixture-contract-v1", dependencies: [], children: [] };
  const outputDir = join(root, "run-output");
  return { root, jervisRoot, designer, binding, snapshot, outputDir, bridge: createEngineeringJervisBridge(root, { jervisRoot }) };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder), parent = realpathSync(tmpdir()), rel = relative(parent, absolute);
    if (!rel.startsWith("epm-jervis-bridge-") || rel.includes(sep) || isAbsolute(rel)) throw new Error("Unsafe test cleanup target");
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("Jervis verified source and real candidate trial bridge", () => {
  it("reads the real candidate records, verifies hashes and exposes only the implemented controlled adapter", async () => {
    const f = fixture(), catalog = await f.bridge.readCatalog();
    expect(catalog.connected).toBe(true);
    expect(catalog.capabilities).toHaveLength(27);
    expect(catalog.capabilities.filter(item => item.usable).map(item => item.id)).toEqual([f.binding.id]);
    expect(catalog.capabilities.every(item => item.lifecycle === "candidate")).toBe(true);
    expect(catalog.capabilities.find(item => item.id === f.binding.id)?.applies_when).toContain("option_tradeoff");
    writeFileSync(join(f.jervisRoot, "registry/designer/p1_s0c/objects.jsonl"), "{}\n");
    expect(await f.bridge.readCatalog()).toMatchObject({ connected: false, capabilities: [], warnings: ["jervis_registry_hash_mismatch:objects.jsonl"] });
  });

  it("rejects drift in the declared source and never silently substitutes current unpinned guidance", async () => {
    const f = fixture();
    writeFileSync(join(f.designer, sourceRelative), "view_units: []\n");
    expect(await f.bridge.readCatalog()).toMatchObject({ connected: false, warnings: ["jervis_source_hash_mismatch"] });
  });

  it("prepares a packet without claiming use, then consumes that exact packet to emit and verify a real artifact", async () => {
    const f = fixture();
    const prepared = await f.bridge.prepare(f.binding, f.snapshot, "run-test", join(f.outputDir, ".private-capabilities/action1"));
    expect(prepared.use.state).toBe("prepared");
    expect(prepared.use.evidence_ids).toEqual([]);
    const packet = JSON.parse(readFileSync(prepared.packet_path, "utf8"));
    expect(packet.unit.validation_contract.scenario_fit_checks).toContain("dimensions_share_basis");
    expect(packet.unit.accessibility_contract).toContain("never encode difference by color alone");
    const artifact = await f.bridge.apply(prepared, join(f.outputDir, "comparison.html"));
    const html = readFileSync(artifact.path, "utf8");
    expect(html).toContain("测试方案报价");
    expect(html).toContain("方案 A");
    expect(html).toContain('scope="row"');
    expect(html).toContain(prepared.packet_hash);
    expect(artifact.sha256).toBe(digest(html));
    expect(artifact.checks.every(item => item.passed)).toBe(true);
    expect(readdirSync(f.outputDir).sort()).toEqual([".private-capabilities", "comparison.html"]);
    // Only the execution service may advance state after recording evidence.
    expect(prepared.use.state).toBe("prepared");
  });

  it("rejects incompatible, incomplete, tampered and out-of-project trials before output", async () => {
    const f = fixture();
    const invalid = { ...f.binding, input: { ...f.binding.input, fit_context: "incomparable_options" } };
    const invalidSnapshot = { ...f.snapshot, node: { ...f.snapshot.node, capabilities: [invalid] } };
    await expect(f.bridge.prepare(invalid, invalidSnapshot, "run-test", join(f.outputDir, ".private-capabilities"))).rejects.toThrow("jervis_candidate_not_applicable");
    const prepared = await f.bridge.prepare(f.binding, f.snapshot, "run-test", join(f.outputDir, ".private-capabilities"));
    await expect(f.bridge.apply(prepared, join(f.root, "..", "escaped.html"))).rejects.toThrow("jervis_path_outside_root");
    writeFileSync(prepared.packet_path, "{}\n");
    await expect(f.bridge.apply(prepared, join(f.outputDir, "comparison.html"))).rejects.toThrow("jervis_packet_hash_mismatch");
    expect(existsSync(join(f.outputDir, "comparison.html"))).toBe(false);
  });

  it("records reviewed actual application evidence in Jervis and verifies an immutable idempotent receipt", async () => {
    const f = fixture();
    const before = readFileSync(join(f.jervisRoot, "registry/designer/p1_s0c/projection_manifest.json"), "utf8");
    // Production has several run and action directory levels. Both packet and artifact
    // must remain readable beyond the legacy 260-character Win32 path boundary.
    // Keep the long-path precondition even when TEMP is a short drive-root path.
    const outputDir = join(f.root, ".project/engineering/recursive/outputs", "engineering-run-11111111-2222-3333-4444-555555555555", "深层实际输出目录".repeat(16));
    const prepared = await f.bridge.prepare(f.binding, f.snapshot, "run-test", join(outputDir, ".private-capabilities", "a".repeat(24)));
    const applied = await f.bridge.apply(prepared, join(outputDir, "comparison.html"));
    expect(prepared.packet_path.length).toBeGreaterThan(300);
    expect(applied.path.length).toBeGreaterThan(260);
    const use: EngineeringCapabilityUse = { ...prepared.use, state: "used", evidence_ids: ["artifact-evidence"] };
    const run: EngineeringRun = { id: "run-test", node_id: f.snapshot.node.id, mode: "controlled", status: "accepted", actor: "fixture-executor", snapshot: f.snapshot, started_at: "2026-09-05T00:00:00Z", finished_at: "2026-09-05T00:01:00Z", current_action: "", completed_action_ids: ["apply"], evidence: [{ id: "artifact-evidence", criterion_id: "comparison", kind: "capability", summary: applied.summary, path: "comparison.html", sha256: applied.sha256, passed: true, created_at: "2026-09-05T00:01:00Z" }], output_dir: outputDir, reason: "", review_note: "独立检查表格维度和来源", reviewed_at: "2026-09-05T00:02:00Z" };
    await expect(f.bridge.recordFeedback(prepared.use, run, "尚未执行")).rejects.toThrow("jervis_feedback_requires_reviewed_application");
    const receipt = await f.bridge.recordFeedback(use, run, "真实夹具验收；API_KEY=fixture-private-value");
    expect(receipt.receipt.startsWith(join(f.jervisRoot, "audit/mirror_project_feedback"))).toBe(true);
    const bytes = readFileSync(receipt.receipt);
    expect(receipt.receipt_hash).toBe(digest(bytes));
    expect(bytes.toString("utf8")).not.toContain("fixture-private-value");
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ authority: "project_evidence_only", promotion: "none", lifecycle_unchanged: true });
    expect(await f.bridge.recordFeedback(use, run, "真实夹具验收；API_KEY=fixture-private-value")).toEqual(receipt);
    expect(readFileSync(join(f.jervisRoot, "registry/designer/p1_s0c/projection_manifest.json"), "utf8")).toBe(before);
    await expect(f.bridge.recordFeedback({ ...use, packet_path: join(outputDir, "missing.json") }, run, "缺失包必须明确报错")).rejects.toThrow("feedback_file_missing");
    const packet = readFileSync(prepared.packet_path);
    writeFileSync(prepared.packet_path, Buffer.alloc(2_000_001));
    await expect(f.bridge.recordFeedback(use, run, "不得放宽大小限制")).rejects.toThrow("feedback_file_limit");
    writeFileSync(prepared.packet_path, packet);
    const linked = join(outputDir, "packet-link");
    symlinkSync(dirname(prepared.packet_path), linked, process.platform === "win32" ? "junction" : "dir");
    await expect(f.bridge.recordFeedback({ ...use, packet_path: join(linked, prepared.packet_path.split(/[\\/]/).at(-1)!) }, run, "不得经链接绕过路径约束")).rejects.toThrow("feedback_symlink_rejected");
    writeFileSync(applied.path, "tampered artifact");
    await expect(f.bridge.recordFeedback(use, run, "不得接收篡改证据")).rejects.toThrow("artifact_hash_mismatch");
  });
});
