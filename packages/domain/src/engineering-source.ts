import { z } from "zod";

export const EngineeringSourceScopeSchema = z.object({
  root: z.string().trim().min(1).max(2000),
  allow: z.array(z.string().min(1).max(512)).min(1).max(100),
  deny: z.array(z.string().min(1).max(512)).max(100).default([]),
  checks: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), title: z.string().trim().min(1).max(200),
    program: z.literal("node"), args: z.array(z.string().max(16000)).min(1).max(100),
    timeout_ms: z.number().int().min(20).max(120000).optional()
  })).min(1).max(12)
});
export type EngineeringSourceScope = z.infer<typeof EngineeringSourceScopeSchema>;
export interface FrozenEngineeringSourceScope extends EngineeringSourceScope { contract_sha256: string }
export interface EngineeringSourceFile { path: string; sha256: string; bytes: number }
export interface EngineeringSourceExclusion { path: string; reason: "generated_or_runtime" | "git_ignored" | "external_project_reference" }
export interface EngineeringSourceBaseline {
  schema_version: 1; captured_at: string; scope: FrozenEngineeringSourceScope;
  manifest: EngineeringSourceFile[]; manifest_sha256: string; total_bytes: number;
  git: { repository: boolean; head_sha: string | null; preexisting_changes: Array<{ path: string; status: string }> };
  exclusions: EngineeringSourceExclusion[]; exclusion_rules: string[];
}
export interface EngineeringSourceChange {
  path: string; kind: "added" | "modified" | "deleted"; before_sha256: string | null; after_sha256: string | null;
  allowed: boolean; reason: "allowed" | "denied" | "outside_allow";
}
export interface EngineeringSourceCheckResult {
  id: string; title: string; program: "node"; args: string[]; command_sha256: string;
  status: "passed" | "failed" | "timeout" | "output_limit" | "spawn_error" | "not_run" | "cancelled";
  exit_code: number | null; duration_ms: number; output_sha256: string; output_bytes: number; error: string | null;
}
export interface EngineeringSourceProof {
  schema_version: 1; verification_mode: "post_execution"; verified_at: string;
  status: "passed" | "failed" | "blocked"; passed: boolean;
  root: string; contract_sha256: string; baseline_manifest_sha256: string; final_manifest_sha256: string | null;
  changes: EngineeringSourceChange[]; checks: EngineeringSourceCheckResult[];
  preexisting_changes: Array<{ path: string; status: string }>;
  exclusions: EngineeringSourceExclusion[]; exclusion_rules: string[];
  source_changed_during_checks: boolean; error: string | null;
}
