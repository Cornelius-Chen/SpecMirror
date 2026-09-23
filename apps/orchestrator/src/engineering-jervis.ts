import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { readYaml } from "@epm/spec-io";
import type { EngineeringCapabilityBinding, EngineeringCapabilityCatalog, EngineeringCapabilityUse, EngineeringRun, EngineeringSnapshot } from "@epm/domain";

const MATRIX = "capability:designer:view.comparison_decision_matrix";
const PROJECTION = "registry/designer/p1_s0c";
const ONTOLOGY = "visual_language/accepted_advisory/quantified_advanced_view_effect_ontology_v1.yaml";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type JsonObject = Record<string, any>;
export interface PreparedCapability { use: EngineeringCapabilityUse; packet_hash: string; packet_path: string; summary: string }
export interface AppliedCapability {
  path: string; sha256: string; summary: string; packet_hash: string;
  checks: Array<{ id: string; passed: boolean; summary: string }>;
}
export interface EngineeringJervisBridge {
  readCatalog(): Promise<EngineeringCapabilityCatalog>;
  prepare(binding: EngineeringCapabilityBinding, snapshot: EngineeringSnapshot, runId: string, outputDir: string): Promise<PreparedCapability>;
  apply(prepared: PreparedCapability, artifactPath: string): Promise<AppliedCapability>;
  recordFeedback(use: EngineeringCapabilityUse, run: EngineeringRun, note: string): Promise<{ receipt: string; receipt_hash: string }>;
}

function assertWithin(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("jervis_path_outside_root");
}
function noLinks(root: string, path: string): void {
  assertWithin(root, path);
  let cursor = resolve(root);
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("jervis_symlink_rejected");
  for (const part of relative(cursor, resolve(path)).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("jervis_symlink_rejected");
  }
}
function bounded(root: string, path: string, limit = 2_000_000): Buffer {
  noLinks(root, path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error("jervis_file_limit");
  const result = readFileSync(path);
  if (result.length > limit) throw new Error("jervis_file_limit");
  return result;
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("jervis_invalid_object");
  return value as JsonObject;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function checkedYaml(root: string, path: string, expected?: string): JsonObject {
  const bytes = bounded(root, path);
  if (expected && hash(bytes) !== expected) throw new Error("jervis_source_hash_mismatch");
  const parsed = object(readYaml(path));
  if (hash(bounded(root, path)) !== hash(bytes)) throw new Error("jervis_source_changed_during_read");
  return parsed;
}
function loadSource(jervisRoot: string) {
  const folder = join(jervisRoot, PROJECTION);
  const manifest = object(JSON.parse(bounded(jervisRoot, join(folder, "projection_manifest.json")).toString("utf8")));
  const files: Record<string, Buffer> = {};
  for (const name of ["objects.jsonl", "object_index.jsonl", "relations.jsonl", "intake_contract.json"]) {
    files[name] = bounded(jervisRoot, join(folder, name));
    if (hash(files[name]) !== manifest.registry_files?.[name]) throw new Error("jervis_registry_hash_mismatch:" + name);
  }
  const lines = files["objects.jsonl"].toString("utf8").trim().split(/\r?\n/);
  const records = lines.map(line => object(JSON.parse(line)));
  if (records.length > 1000) throw new Error("jervis_catalog_limit");
  const index = files["object_index.jsonl"].toString("utf8").trim().split(/\r?\n/).map(line => object(JSON.parse(line)));
  for (const [i, record] of records.entries()) {
    const entry = index.find(item => item.object_id === record.object_id && item.version === record.version);
    if (!entry || entry.line_number !== i + 1 || entry.record_sha256 !== hash(lines[i])) throw new Error("jervis_record_hash_mismatch");
  }
  const declaration = checkedYaml(jervisRoot, join(jervisRoot, "legacy/SOURCE_ROOTS_DECLARATION.yaml"));
  const declared = declaration.files?.find((item: JsonObject) => item.relative_path === ONTOLOGY);
  if (!declared || !/^[a-f0-9]{64}$/.test(declared.expected_sha256 ?? "")) throw new Error("jervis_source_not_declared");
  const designerRoot = resolve(jervisRoot, declaration.source_root);
  const ontology = checkedYaml(designerRoot, join(designerRoot, ONTOLOGY), declared.expected_sha256);
  const units = [...(ontology.view_units ?? []), ...(ontology.motion_units ?? [])];
  return { records, index, units, sourceHash: declared.expected_sha256 as string };
}

interface MatrixInput {
  fit_context: string; title: string;
  dimensions: Array<{ id: string; label: string; unit: string; source: string }>;
  options: Array<{ id: string; label: string; values: Record<string, string | number | boolean> }>;
}
function text(value: unknown, label: string, limit = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("jervis_input_required:" + label);
  return value.trim();
}
function matrixInput(value: unknown, unit: JsonObject): MatrixInput {
  const input = object(value);
  const fit = text(input.fit_context, "fit_context");
  if (!strings(unit.applicability?.high_fit).includes(fit) || strings(unit.applicability?.low_fit).includes(fit)) throw new Error("jervis_candidate_not_applicable");
  if (!Array.isArray(input.dimensions) || input.dimensions.length < 1 || input.dimensions.length > 20) throw new Error("jervis_dimensions_required");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 6) throw new Error("jervis_comparison_requires_2_to_6_options");
  const dimensions = input.dimensions.map((raw: unknown) => { const item = object(raw); return { id: text(item.id, "dimension.id", 80), label: text(item.label, "dimension.label"), unit: text(item.unit, "dimension.unit"), source: text(item.source, "dimension.source", 1000) }; });
  if (new Set(dimensions.map(item => item.id)).size !== dimensions.length) throw new Error("jervis_duplicate_dimension");
  const options = input.options.map((raw: unknown) => {
    const item = object(raw), values = object(item.values), kept: Record<string, string | number | boolean> = {};
    for (const dimension of dimensions) {
      const cell = values[dimension.id];
      if (!["string", "number", "boolean"].includes(typeof cell) || (typeof cell === "number" && !Number.isFinite(cell)) || String(cell).length > 2000) throw new Error("jervis_missing_comparable_value:" + dimension.id);
      kept[dimension.id] = cell;
    }
    return { id: text(item.id, "option.id", 80), label: text(item.label, "option.label"), values: kept };
  });
  if (new Set(options.map(item => item.id)).size !== options.length) throw new Error("jervis_duplicate_option");
  return { title: typeof input.title === "string" ? text(input.title, "title") : "方案比较", fit_context: fit, dimensions, options };
}
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
function renderMatrix(input: MatrixInput, packetHash: string): string {
  const headings = input.options.map(item => `<th scope="col">${escape(item.label)}</th>`).join("");
  const rows = input.dimensions.map(dimension => `<tr><th scope="row">${escape(dimension.label)}<small>单位：${escape(dimension.unit)} · 来源：${escape(dimension.source)}</small></th>${input.options.map(option => `<td data-dimension="${escape(dimension.id)}">${escape(option.values[dimension.id])}</td>`).join("")}</tr>`).join("");
  const data = JSON.stringify({ schema_version: 1, kind: "comparison_matrix", packet_hash: packetHash, input }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'"><title>${escape(input.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:24px;color:#18232d;background:#faf9f6}h1{font-size:26px}.comparison{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:520px}caption{text-align:left;padding:12px 0}th,td{padding:12px;text-align:left;border-bottom:1px solid #c6ccd0;vertical-align:top}th{background:#edf0ef}small{display:block;font-size:12px;font-weight:400;color:#48545d}@media(max-width:600px){body{margin:12px}th[scope=row]{position:sticky;left:0;max-width:150px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style></head><body><h1>${escape(input.title)}</h1><p>候选方法试用 · 根据提供的数据比较，未替你判定最优方案。</p><div class="comparison" role="region" aria-label="可横向滚动的方案比较" tabindex="0"><table><caption>统一维度、单位与来源</caption><thead><tr><th scope="col">比较维度</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div><script id="mirror-capability-data" type="application/json">${data}</script></body></html>`;
}

export function createEngineeringJervisBridge(projectRoot: string, options: { jervisRoot?: string; pythonExecutable?: string } = {}): EngineeringJervisBridge {
  const jervisRoot = resolve(options.jervisRoot ?? process.env.MIRROR_JERVIS_ROOT ?? join(projectRoot, "../Jervis/IRONMAN_Codex_Implementation_Pack_v1_1"));
  const python = options.pythonExecutable ?? process.env.MIRROR_JERVIS_PYTHON ?? "python";
  return {
    async readCatalog() {
      try {
        const source = loadSource(jervisRoot);
        return { connected: true, source: jervisRoot, warnings: ["Jervis 当前只有候选能力；试用及任务验收不会自动晋级稳定能力。"], capabilities: source.records.filter(record => record.object_type === "Capability").map(record => {
          const unit = source.units.find(item => item.id === record.object_id.replace("capability:designer:", "") + ".v1");
          const usable = record.object_id === MATRIX && record.lifecycle_state === "candidate" && strings(record.permission_scope).includes("candidate_eval_or_shadow_only") && Boolean(unit);
          return { id: record.object_id, title: record.human_name ?? record.object_id, version: record.version, lifecycle: record.lifecycle_state, purpose: record.job_to_be_done, applies_when: strings(unit?.applicability?.high_fit), fails_when: strings(unit?.applicability?.low_fit), source: PROJECTION + "/objects.jsonl", record_hash: source.index.find(item => item.object_id === record.object_id)?.record_sha256 ?? "", usable, reason: usable ? "可运行受控比较矩阵试用；仍需独立验收" : "真实候选，尚无受控执行适配器；可供外部 Worker 研究，不计为已应用", parameters: { planning: unit?.planning_parameters ?? {}, ...(usable ? { input: { fit_context: "option_tradeoff", title: "方案比较", dimensions: [{ id: "cost", label: "费用", unit: "元", source: "提供的方案报价" }], options: [{ id: "a", label: "方案 A", values: { cost: 100 } }, { id: "b", label: "方案 B", values: { cost: 120 } }] } } : {}) } };
        }) };
      } catch (error) { return { connected: false, source: jervisRoot, capabilities: [], warnings: [error instanceof Error ? error.message : "jervis_unavailable"] }; }
    },
    async prepare(binding, snapshot, runId, outputDir) {
      if (!snapshot.node.capabilities.some(item => item.id === binding.id && item.version === binding.version && JSON.stringify(item.input) === JSON.stringify(binding.input))) throw new Error("jervis_binding_not_in_snapshot");
      const source = loadSource(jervisRoot);
      const record = source.records.find(item => item.object_id === binding.id && item.version === binding.version);
      if (!record || record.lifecycle_state !== "candidate" || !strings(record.permission_scope).includes("candidate_eval_or_shadow_only")) throw new Error("jervis_candidate_trial_only");
      const unit = source.units.find(item => item.id === binding.id.replace("capability:designer:", "") + ".v1");
      if (!unit) throw new Error("jervis_unit_missing");
      if (binding.id === MATRIX) matrixInput(binding.input, unit);
      noLinks(projectRoot, outputDir);
      mkdirSync(outputDir, { recursive: true });
      const packet = { schema_version: 1, run_id: runId, node_id: snapshot.node.id, contract_key: snapshot.contract_key, capability: { id: binding.id, version: binding.version, lifecycle: record.lifecycle_state, record_hash: source.index.find(item => item.object_id === binding.id)?.record_sha256, source_hash: source.sourceHash, permission_scope: record.permission_scope }, unit, binding, task_contract: { title: snapshot.node.title, objective: snapshot.node.objective, method: snapshot.node.method, constraints: snapshot.effective, criteria: snapshot.node.criteria }, provenance_refs: record.provenance_refs, state: "prepared" };
      const content = JSON.stringify(packet, null, 2) + "\n";
      const packetHash = hash(content), packetPath = join(outputDir, "packet-" + packetHash + ".json");
      noLinks(projectRoot, packetPath);
      if (existsSync(packetPath)) { if (hash(bounded(projectRoot, packetPath)) !== packetHash) throw new Error("jervis_packet_collision"); }
      else writeFileSync(packetPath, content, { flag: "wx" });
      const summary = "已准备 " + record.human_name + " 候选试用包，尚未执行";
      return { packet_hash: packetHash, packet_path: packetPath, summary, use: { id: "capuse-" + randomUUID(), node_id: snapshot.node.id, run_id: runId, capability_id: binding.id, version: binding.version, packet_hash: packetHash, packet_path: packetPath, state: "prepared", summary, evidence_ids: [], created_at: new Date().toISOString() } };
    },
    async apply(prepared, artifactPath) {
      const bytes = bounded(projectRoot, prepared.packet_path);
      if (hash(bytes) !== prepared.packet_hash || prepared.use.packet_hash !== prepared.packet_hash) throw new Error("jervis_packet_hash_mismatch");
      const packet = object(JSON.parse(bytes.toString("utf8")));
      if (packet.capability?.id !== MATRIX || packet.capability?.id !== prepared.use.capability_id || packet.run_id !== prepared.use.run_id || packet.node_id !== prepared.use.node_id) throw new Error("jervis_controlled_adapter_unavailable");
      if (packet.capability.lifecycle !== "candidate") throw new Error("jervis_candidate_trial_only");
      const input = matrixInput(packet.binding.input, packet.unit);
      const output = renderMatrix(input, prepared.packet_hash);
      noLinks(projectRoot, artifactPath);
      if (!/\.html?$/i.test(artifactPath)) throw new Error("jervis_artifact_requires_html");
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, output, { flag: "wx" });
      const actual = bounded(projectRoot, artifactPath).toString("utf8");
      const checks = [
        { id: "dimensions_share_basis", passed: (actual.match(/<td data-dimension=/g) ?? []).length === input.dimensions.length * input.options.length, summary: "每个方案具备完全一致的比较维度" },
        { id: "units_and_sources_explicit", passed: input.dimensions.every(item => actual.includes(escape(item.unit)) && actual.includes(escape(item.source))), summary: "每个维度展示单位及数据来源" },
        { id: "semantic_labels", passed: actual.includes('scope="row"') && actual.includes('scope="col"') && actual.includes("<caption>"), summary: "产物保留语义表格、行列标题与说明" },
        { id: "reduced_motion_no_information_loss", passed: actual.includes("prefers-reduced-motion") && !actual.includes("<script src="), summary: "信息不依赖动画或外部脚本" },
        { id: "packet_consumed", passed: actual.includes(prepared.packet_hash), summary: "产物记录实际读取的候选包哈希" }
      ];
      if (checks.some(item => !item.passed)) throw new Error("jervis_application_check_failed");
      return { path: artifactPath, sha256: hash(actual), packet_hash: prepared.packet_hash, summary: `候选比较方法已应用：${input.options.length} 个方案 × ${input.dimensions.length} 个维度；产物检查通过，等待独立验收`, checks };
    },
    async recordFeedback(use, run, note) {
      if (!["accepted", "rejected"].includes(run.status) || !run.reviewed_at || !["used", "feedback_recorded"].includes(use.state) || use.run_id !== run.id || use.node_id !== run.node_id) throw new Error("jervis_feedback_requires_reviewed_application");
      // Keep action source/content, full task prompts, and unrelated evidence out of Jervis feedback.
      const selectedEvidence = run.evidence.filter(item => use.evidence_ids.includes(item.id)).map(item => ({ id: item.id, kind: item.kind, path: item.path, sha256: item.sha256, passed: item.passed }));
      const request = { schema_version: 1, action: "record_feedback", project_root: resolve(projectRoot),
        use: { id: use.id, node_id: use.node_id, run_id: use.run_id, capability_id: use.capability_id, version: use.version, packet_hash: use.packet_hash, packet_path: use.packet_path, state: use.state, evidence_ids: use.evidence_ids },
        run: { id: run.id, node_id: run.node_id, status: run.status, reviewed_at: run.reviewed_at, review_note: run.review_note.slice(0, 8000), output_dir: run.output_dir, snapshot: { contract_key: run.snapshot.contract_key }, evidence: selectedEvidence }, note: note.slice(0, 8000) };
      const requestBytes = JSON.stringify(request);
      if (Buffer.byteLength(requestBytes) > 1_500_000) throw new Error("jervis_feedback_request_limit");
      const adapter = join(jervisRoot, "domains/designer/adapters/mirror_bridge.py");
      bounded(jervisRoot, adapter, 100_000);
      const response = await new Promise<JsonObject>((resolveResponse, reject) => {
        const child = spawn(python, [adapter], { cwd: jervisRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" } });
        let output = "", errors = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("jervis_feedback_timeout")); }, 10000);
        child.stdout.on("data", chunk => { output += chunk; if (output.length > 100000) child.kill(); });
        child.stderr.on("data", chunk => { errors += chunk; });
        child.stdin.on("error", () => { /* A rejected bounded request is reported by the process exit. */ });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => { clearTimeout(timer); if (code !== 0) { reject(new Error("jervis_feedback_failed:" + errors.trim().slice(0, 300))); return; } try { resolveResponse(object(JSON.parse(output))); } catch { reject(new Error("jervis_feedback_invalid_response")); } });
        child.stdin.end(requestBytes);
      });
      const receipt = text(response.receipt, "receipt", 2000), receiptHash = text(response.receipt_hash, "receipt_hash", 64);
      const receiptPath = join(jervisRoot, receipt);
      assertWithin(join(jervisRoot, "audit/mirror_project_feedback"), receiptPath);
      if (hash(bounded(jervisRoot, receiptPath)) !== receiptHash) throw new Error("jervis_receipt_readback_mismatch");
      return { receipt: receiptPath, receipt_hash: receiptHash };
    }
  };
}
