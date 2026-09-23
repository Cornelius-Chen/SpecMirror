export type TransitionMap = Readonly<Record<string, readonly string[]>>;

export const transitions = {
  idea: {
    captured: ["triaged", "later", "rejected"], triaged: ["promoted", "later", "rejected"],
    promoted: [], later: ["triaged", "rejected"], rejected: []
  },
  claim: {
    unknown: ["unsupported", "partially_supported", "supported", "contradicted"],
    unsupported: ["partially_supported", "supported", "contradicted", "retired"],
    partially_supported: ["supported", "contradicted", "retired"], supported: ["contradicted", "retired"],
    contradicted: ["partially_supported", "retired"], retired: []
  },
  decision: {
    proposed: ["accepted", "rejected", "superseded"], accepted: ["proposed", "superseded"],
    rejected: ["proposed", "superseded"], superseded: []
  },
  evidence: {
    candidate: ["accepted", "rejected"], accepted: ["stale"], rejected: ["candidate"],
    stale: ["candidate", "accepted", "rejected"]
  },
  design: {
    draft: ["approved", "blocked", "failed", "superseded"], approved: ["verified", "blocked", "failed", "superseded"],
    verified: ["guarded", "blocked", "failed", "superseded"], guarded: ["superseded"],
    blocked: ["draft", "approved", "failed", "superseded"], failed: ["draft", "superseded"], superseded: []
  },
  goal: {
    compiled: ["planning", "blocked", "failed", "stopped", "superseded"], planning: ["implementing", "blocked", "failed", "stopped"],
    implementing: ["reviewing", "blocked", "failed", "stopped"], reviewing: ["implementing", "integrating", "blocked", "failed", "stopped"],
    integrating: ["verified", "blocked", "failed", "stopped"], verified: [], blocked: ["planning", "implementing", "stopped", "superseded"],
    failed: ["planning", "superseded"], superseded: [], stopped: ["planning", "integrating", "superseded"]
  },
  change: {
    draft: ["compiled", "failed"], compiled: ["running", "blocked", "failed"],
    running: ["reviewing", "integrating", "blocked", "failed"], reviewing: ["running", "integrating", "blocked", "failed"],
    integrating: ["verified", "blocked", "failed"], blocked: ["compiled", "running", "integrating", "failed"], failed: ["compiled"], verified: []
  },
  supervision: {
    draft: ["ready"], ready: ["assigned", "draft"], assigned: ["reviewing", "needs_revision"],
    reviewing: ["accepted", "needs_revision", "assigned", "ready"], accepted: ["needs_revision", "ready"], needs_revision: ["ready", "assigned"]
  },
  supervisionRun: {
    queued: ["running", "failed", "stopped"], running: ["reviewing", "failed", "stopped"],
    reviewing: ["accepted", "needs_revision"], accepted: [], needs_revision: ["running"],
    failed: ["running"], stopped: ["running"]
  },
  permission: {
    proposed: ["approved", "revoked", "expired"], approved: ["revoked", "expired"], revoked: ["proposed"], expired: ["proposed"]
  }
} as const satisfies Record<string, TransitionMap>;

export function canTransition(machine: keyof typeof transitions, from: string, to: string): boolean {
  const map = transitions[machine] as TransitionMap;
  return Boolean(map[from]?.includes(to));
}

export function assertTransition(machine: keyof typeof transitions, from: string, to: string): void {
  if (!canTransition(machine, from, to)) throw new Error(`Invalid ${machine} transition: ${from} -> ${to}`);
}
