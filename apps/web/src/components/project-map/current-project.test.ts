import { describe, expect, it } from "vitest";
import { restoreCurrentProject } from "./current-project.ts";

const host = { id: "host", thread_id: "current-task", kind: "existing" as const };
const other = { id: "other", thread_id: "other-task", kind: "managed" as const };
const saved = (workspaceId: string, taskId: string) => JSON.stringify({ version: 1, workspaceId, taskId });

describe("restore the current project after loading the real catalog", () => {
  it("opens the existing host on a bare first visit, without an onboarding or approval flag", () => {
    expect(restoreCurrentProject([host, other], null)).toBe("current-task");
  });
  it("restores the last matching project and task pair", () => {
    expect(restoreCurrentProject([host, other], saved("other", "other-task"))).toBe("other-task");
  });
  it("ignores removed projects, changed task links, and corrupt preferences", () => {
    for (const value of [saved("gone", "other-task"), saved("host", "old-task"), "{broken", "null"]) {
      expect(restoreCurrentProject([host, other], value)).toBe("current-task");
    }
  });
  it("keeps genuinely empty or ambiguous catalogs at project selection", () => {
    expect(restoreCurrentProject([], null)).toBe("");
    expect(restoreCurrentProject([other, { ...other, id: "third", thread_id: "third-task" }], null)).toBe("");
  });
  it("retains a real unlinked existing project without creating a task association", () => {
    expect(restoreCurrentProject([{ ...host, thread_id: null }], null)).toBe("@existing");
  });
  it("does not derive revision, incident status, or approval authority from browser storage", () => {
    const before = JSON.stringify([host, other]);
    const value = JSON.stringify({ version: 1, workspaceId: "other", taskId: "other-task", revision: 117, incident: "unresolved", approved: true });
    expect(restoreCurrentProject([host, other], value)).toBe("other-task");
    expect(JSON.stringify([host, other])).toBe(before);
  });
});
