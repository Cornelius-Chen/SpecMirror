import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, type EngineeringDocument } from "./engineering.ts";
import { EngineeringFeedbackCreateSchema, engineeringFeedbackScopeValid } from "./engineering-feedback.ts";

const request = { expected_revision: 1, base_node_revision: 1, target: { kind: "node", node_id: "project" }, kind: "requirement_change", note: "这两处职责重复，请重新划分" };
function document(): EngineeringDocument {
  return { schema_version: 1, id: "scope-test", root_id: "project", revision: 1, created_at: "now", updated_at: "now", runs: [], changes: [], events: [], capability_uses: [],
    nodes: [["project", null], ["module", "project"], ["one", "module"], ["two", "module"], ["other", "project"]].map(([id, parent]) => EngineeringNodeSchema.parse({
      id, parent_id: parent, kind: parent ? "task" : "project", title: id, objective: "成果", order: 0, constraints: { allow: [], deny: [], rules: [], resources: [] }, revision: 1, status: "draft", created_at: "now", updated_at: "now"
    })) };
}

describe("precise engineering feedback selection contract", () => {
  it("keeps single-target requests compatible and bounds distinct multi-node selections", () => {
    expect(EngineeringFeedbackCreateSchema.safeParse(request).success).toBe(true);
    expect(EngineeringFeedbackCreateSchema.safeParse({ ...request, scope_node_ids: ["one", "two"] }).success).toBe(true);
    for (const ids of [[], ["one"], ["one", "one"], ["one", "../outside"], Array.from({ length: 81 }, (_, i) => "node-" + i)]) {
      expect(EngineeringFeedbackCreateSchema.safeParse({ ...request, scope_node_ids: ids }).success).toBe(false);
    }
    expect(EngineeringFeedbackCreateSchema.safeParse({ ...request, scope_node_ids: ["one", "two"], target: { kind: "criterion", node_id: "module", id: "check" } }).success).toBe(false);
  });

  it("requires active real members under the stated common ancestor", () => {
    const doc = document(), target = { kind: "node" as const, node_id: "module" };
    expect(engineeringFeedbackScopeValid(doc, target, ["one", "two"])).toBe(true);
    expect(engineeringFeedbackScopeValid(doc, target, ["module", "one"])).toBe(true);
    expect(engineeringFeedbackScopeValid(doc, target, ["one", "other"])).toBe(false);
    expect(engineeringFeedbackScopeValid(doc, target, ["one", "unknown"])).toBe(false);
    doc.nodes.find(node => node.id === "two")!.status = "archived";
    expect(engineeringFeedbackScopeValid(doc, target, ["one", "two"])).toBe(false);
    doc.nodes.find(node => node.id === "module")!.status = "archived";
    expect(engineeringFeedbackScopeValid(doc, { kind: "node", node_id: "project" }, ["one", "other"])).toBe(false);
  });
});
