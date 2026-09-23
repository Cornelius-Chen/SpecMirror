import { describe, expect, it } from "vitest";
import { deriveEngineeringView } from "@epm/domain";
import { inspectorDocument, inspectorNode, inspectorRun } from "../../../../../tests/fixtures/project-inspector.ts";
import { projectResultHeadline } from "./result-headline.ts";

describe("project result headline", () => {
  it("does not call an unstarted draft project clear", () => {
    const view = deriveEngineeringView(inspectorDocument([inspectorNode("root", null), inspectorNode("one", "root"), inspectorNode("two", "root")]));
    expect(projectResultHeadline(view, "root")).toMatchObject({ state: "forming", label: "3 项待形成结果", total: 3, accepted: 0 });
  });

  it("prioritizes a result waiting for the human over background execution", () => {
    const doc = inspectorDocument([inspectorNode("root", null), inspectorNode("one", "root"), inspectorNode("two", "root")]);
    const review = inspectorRun(doc, "one", "review", "external"), running = inspectorRun(doc, "two", "running", "external");
    doc.runs.push(review, running);
    expect(projectResultHeadline(deriveEngineeringView(doc), "root")).toMatchObject({ state: "review", label: "1 项待你验收" });
  });

  it("reports the accepted project only when every active item is accepted", () => {
    const doc = inspectorDocument([inspectorNode("root", null, { status: "accepted" }), inspectorNode("one", "root", { status: "accepted" })]);
    expect(projectResultHeadline(deriveEngineeringView(doc), "root")).toMatchObject({ state: "accepted", label: "2/2 项已验收" });
  });
});
