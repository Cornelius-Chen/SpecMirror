import { describe, expect, it } from "vitest";
import { EngineeringNodeSchema, deriveEngineeringView, type EngineeringDocument } from "@epm/domain";
import { expireEngineeringObservations, hasActiveExternalEngineeringRun, removeEngineeringCriterion, selectEngineeringView } from "./workspace-state.ts";

const node = () => EngineeringNodeSchema.parse({ id: "root", parent_id: null, kind: "project", title: "项目", revision: 1, order: 0, status: "draft", constraints: {}, criteria: [{ id: "kept", text: "保留结果", kind: "manual" }, { id: "removed", text: "整体验收", kind: "manual" }], created_at: "before", updated_at: "before" });
const view = (revision = 1, observed?: string) => {
  const document: EngineeringDocument = { schema_version: 1, id: "project", root_id: "root", revision, created_at: "before", updated_at: "before", nodes: [node()], runs: [], changes: [], events: [], capability_uses: [] };
  const result = deriveEngineeringView(document);
  if (observed) result.observation = { captured_at: observed, source: "local-engineering-service", runs: {} };
  return result;
};

describe("workspace response ordering and observation expiry", () => {
  it("does not let an earlier GET erase a feedback mutation with a newer document revision", () => {
    const saved = view(8, "2026-09-06T12:01:00Z"), lateQuery = view(7, "2026-09-06T12:02:00Z");
    expect(selectEngineeringView(saved, lateQuery)).toBe(saved);
    expect(selectEngineeringView(lateQuery, saved)).toBe(saved);
  });
  it("keeps observations monotonic when document revision did not change", () => {
    const latest = view(8, "2026-09-06T12:02:00Z"), older = view(8, "2026-09-06T12:01:00Z");
    expect(selectEngineeringView(latest, older)).toBe(latest);
    expect(selectEngineeringView(latest, view(8))).toBe(latest);
    expect(selectEngineeringView(older, latest)).toBe(latest);
    expect(selectEngineeringView(undefined, latest)).toBe(latest);
  });
  it("expires external observations without fabricating new observation times or changing documents", () => {
    const current = view(8, "2026-09-06T12:00:00Z");
    current.document.runs = [
      { id: "external", node_id: "root", mode: "external", status: "running" },
      { id: "local", node_id: "other", mode: "controlled", status: "running" }
    ] as EngineeringDocument["runs"];
    current.derived.root.latest_run_id = "external";
    current.observation!.runs = {
      external: { state: "current", last_observed_at: "2026-09-06T12:00:00Z", message: "真实活动" },
      local: { state: "local", last_observed_at: "2026-09-06T12:00:00Z", message: "本机记录" }
    };
    expect(hasActiveExternalEngineeringRun(current)).toBe(true);
    expect(expireEngineeringObservations(current, Date.parse("2026-09-06T12:29:59Z"))).toBe(current);
    const expired = expireEngineeringObservations(current, Date.parse("2026-09-06T12:30:01Z"));
    expect(expired.observation?.runs.external.state).toBe("stale");
    expect(expired.observation?.runs.external.last_observed_at).toBe("2026-09-06T12:00:00Z");
    expect(expired.observation?.captured_at).toBe("2026-09-06T12:00:00Z");
    expect(expired.observation?.runs.local.state).toBe("local");
    expect(expired.document).toBe(current.document);
    expect(current.observation?.runs.external.state).toBe("current");
    current.derived.root.latest_run_id = "different";
    expect(hasActiveExternalEngineeringRun(current)).toBe(false);
  });
  it("does not treat malformed or implausibly future activity times as current", () => {
    const current = view(1, "2026-09-06T12:00:00Z");
    current.document.runs = [{ id: "external", mode: "external", node_id: "root", status: "running" }] as EngineeringDocument["runs"];
    current.observation!.runs.external = { state: "current", last_observed_at: "invalid", message: "活动" };
    expect(expireEngineeringObservations(current, Date.parse("2026-09-06T12:00:00Z")).observation?.runs.external.state).toBe("stale");
    current.observation!.runs.external.last_observed_at = "2026-09-06T13:00:00Z";
    expect(expireEngineeringObservations(current, Date.parse("2026-09-06T12:00:00Z")).observation?.runs.external.state).toBe("stale");
  });
  it("cleans this node's output and integration references together when deleting a criterion", () => {
    const before = node(); before.delivery = { included: [], excluded: [], inputs: [], outputs: [{ id: "result", title: "结果", criterion_ids: ["kept", "removed"] }] };
    before.composition = { summary: "组成", scenario: "场景", integration_criterion_ids: ["removed"] };
    before.contributes_to = ["parent-condition"];
    const after = removeEngineeringCriterion(before, "removed");
    expect(after.criteria.map(item => item.id)).toEqual(["kept"]);
    expect(after.delivery?.outputs[0].criterion_ids).toEqual(["kept"]);
    expect(after.composition?.integration_criterion_ids).toEqual([]);
    expect(after.contributes_to).toEqual(["parent-condition"]);
    expect(before.composition.integration_criterion_ids).toEqual(["removed"]);
  });
});
