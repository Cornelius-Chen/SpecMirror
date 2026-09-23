/** Recent lifecycle observation permits handoff; it does not mean a task has been received. */
export const ENGINEERING_AGENT_FRESHNESS_MS = 30 * 60 * 1000;

export function isRecentAgentSession(lastSeenAt: string, at = Date.now()) {
  const age = at - Date.parse(lastSeenAt);
  return Number.isFinite(age) && age >= -60_000 && age <= ENGINEERING_AGENT_FRESHNESS_MS;
}
