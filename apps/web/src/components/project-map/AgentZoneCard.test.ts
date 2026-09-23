import { describe, expect, it } from "vitest";
import type { EngineeringView } from "@epm/domain";
import { agentZoneOwnerPresentations, agentZoneStatus, collaborationParallelStatus, type AgentZoneCardZone } from "./AgentZoneCard.tsx";

const zone = (id: string, state: AgentZoneCardZone["owner_state"], fields: Partial<AgentZoneCardZone> = {}): AgentZoneCardZone => ({
  id: `zone:${id}`,
  title: id,
  node_ids: [id],
  available_leaf_ids: state === "unassigned" ? [id] : [],
  runnable_leaf_ids: [id],
  authorized_leaf_ids: state === "single" ? [id] : [],
  claimable_leaf_ids: [],
  owner_state: state,
  agent_owners: state === "unassigned" ? [] : ["codex:a"],
  covenants: { rules: [], resources: [] },
  ...fields
});

const view = { derived: {} } as EngineeringView;

describe("Agent zone status wording", () => {
  it("maps effective owners to stable distinct tones and leaves unassigned or mixed zones neutral", () => {
    const zones = [
      zone("build", "single", { effective_agent_owner: "codex:atlas", agent_owners: ["codex:atlas"] }),
      zone("docs", "single", { effective_agent_owner: "codex:atlas", agent_owners: ["codex:atlas"] }),
      zone("verify", "single", { effective_agent_owner: "codex:beacon", agent_owners: ["codex:beacon"] }),
      zone("queue", "unassigned"),
      zone("mixed", "mixed", { effective_agent_owner: null, agent_owners: ["codex:atlas", "codex:beacon"] })
    ];
    const presentation = agentZoneOwnerPresentations(zones);
    expect(presentation.get("zone:build")).toMatchObject({ ownerKey: "codex:atlas", shortLabel: "A·atlas", ownerState: "single" });
    expect(presentation.get("zone:docs")?.tone).toBe(presentation.get("zone:build")?.tone);
    expect(presentation.get("zone:docs")?.hue).toBe(presentation.get("zone:build")?.hue);
    expect(presentation.get("zone:verify")?.tone).not.toBe(presentation.get("zone:build")?.tone);
    expect(presentation.get("zone:verify")?.hue).not.toBe(presentation.get("zone:build")?.hue);
    expect(presentation.get("zone:queue")).toMatchObject({ tone: "neutral", hue: null, shortLabel: "A·—" });
    expect(presentation.get("zone:mixed")).toMatchObject({ tone: "neutral", hue: null, shortLabel: "多 A" });
    const reordered = agentZoneOwnerPresentations(zones.slice().reverse());
    for (const item of zones) expect(reordered.get(item.id)?.tone).toBe(presentation.get(item.id)?.tone);
    const withEarlierOwner = agentZoneOwnerPresentations([zone("added", "single", { effective_agent_owner: "codex:aardvark", agent_owners: ["codex:aardvark"] }), ...zones]);
    for (const item of zones) {
      expect(withEarlierOwner.get(item.id)?.tone).toBe(presentation.get(item.id)?.tone);
      expect(withEarlierOwner.get(item.id)?.hue).toBe(presentation.get(item.id)?.hue);
    }
    const longOwners = agentZoneOwnerPresentations([
      zone("long-a", "single", { effective_agent_owner: "codex:019c77aa-shared-prefix-0001", agent_owners: ["codex:019c77aa-shared-prefix-0001"] }),
      zone("long-b", "single", { effective_agent_owner: "codex:019c77aa-shared-prefix-0002", agent_owners: ["codex:019c77aa-shared-prefix-0002"] })
    ]);
    expect(longOwners.get("zone:long-a")?.shortLabel).not.toBe(longOwners.get("zone:long-b")?.shortLabel);
    expect(longOwners.get("zone:long-a")?.accessibleLabel).not.toBe(longOwners.get("zone:long-b")?.accessibleLabel);
  });

  it("does not present unassigned runnable work as authorized parallel execution", () => {
    const zones = [zone("a", "unassigned"), zone("b", "unassigned")];
    expect(collaborationParallelStatus(zones, view, [])).toBe("2 区待分配 Agent");
    expect(zones.map(item => agentZoneStatus(item, view))).toEqual(["待分配", "待分配"]);
  });

  it("makes a mixed ownership boundary explicit", () => {
    const mixed = zone("mixed", "mixed", { agent_owners: ["codex:a", "codex:b"] });
    expect(agentZoneStatus(mixed, view)).toBe("边界待拆");
    expect(collaborationParallelStatus([mixed], view, [])).toBe("1 区负责人边界待拆");
  });

  it("counts only assigned runnable zones as parallel candidates", () => {
    const zones = [zone("a", "single"), zone("b", "single"), zone("c", "unassigned")];
    expect(collaborationParallelStatus(zones, view, [])).toBe("2 区具备并行条件");
  });

  it("distinguishes normal handoff waits from actual scope collisions", () => {
    const zones = [zone("a", "unassigned"), zone("b", "unassigned")];
    expect(collaborationParallelStatus(zones, view, [{ kind: "hard_dependency" }])).toBe("2 区待分配 Agent · 1 项交接等待");
    expect(collaborationParallelStatus(zones, view, [{ kind: "write_path_overlap" }])).toBe("1 处范围冲突需先拆开");
  });
});
