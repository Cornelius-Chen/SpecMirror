import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteYaml, engineeringDocumentPath } from "@epm/spec-io";
import { attentionDocument } from "../../../tests/fixtures/attention-document.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { EventBus } from "./events.ts";

describe("workspace attention counts cover every engineering level", () => {
  for (const stage of ["parent-review", "root-review", "parent-paused"] as const) it(`${stage} remains actionable after every leaf is accepted`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mirror-attention-")); let workspaces: TaskWorkspaces | undefined;
    try {
      atomicWriteYaml(engineeringDocumentPath(root), attentionDocument(stage));
      workspaces = new TaskWorkspaces(root, new EventBus(), { source: async () => { throw new Error("source catalog is not needed to summarize an existing scope"); } });
      const result = workspaces.summary("host");
      expect(result.counts).toEqual({ total: 1, accepted: 1, review: 0, running: 0, blocked: 0 });
      expect(result.attention_counts).toEqual(stage === "parent-paused" ? { review: 0, running: 0, blocked: 1 } : { review: 1, running: 0, blocked: 0 });
      expect(result.status).toBe(stage === "root-review" ? "review" : "draft");
    } finally {
      workspaces?.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
