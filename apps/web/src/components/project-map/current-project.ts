export const CURRENT_PROJECT_KEY = "mirror.current-project.v1";
type ProjectEntry = { id: string; thread_id: string | null; kind: "existing" | "managed" };
const taskFor = (entry: ProjectEntry) => entry.thread_id || (entry.kind === "existing" ? "@existing" : "");

/** A browsing preference is only a hint. The loaded project catalog owns identity. */
export function restoreCurrentProject(entries: readonly ProjectEntry[], saved: string | null) {
  try {
    const value = saved ? JSON.parse(saved) : null;
    if (value?.version === 1 && typeof value.workspaceId === "string" && typeof value.taskId === "string") {
      const match = entries.find(entry => entry.id === value.workspaceId && taskFor(entry) === value.taskId);
      if (match) return taskFor(match);
    }
  } catch { /* A corrupt browsing preference cannot hide the real project. */ }
  const existing = entries.filter(entry => entry.kind === "existing");
  if (existing.length === 1) return taskFor(existing[0]);
  return entries.length === 1 ? taskFor(entries[0]) : "";
}

export function readCurrentProject() {
  try { return window.localStorage.getItem(CURRENT_PROJECT_KEY); } catch { return null; }
}

export function rememberCurrentProject(entry: ProjectEntry) {
  if (!taskFor(entry)) return;
  try {
    // Never cache engineering revisions, approval states, or credentials here.
    window.localStorage.setItem(CURRENT_PROJECT_KEY, JSON.stringify({ version: 1, workspaceId: entry.id, taskId: taskFor(entry) }));
  } catch { /* Browsing still works when persistent storage is unavailable. */ }
}
