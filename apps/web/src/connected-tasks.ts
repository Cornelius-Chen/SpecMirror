export type ConnectedTask = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  archive_status: "unknown";
};

export type ConnectedTasks = { data: ConnectedTask[]; partial: boolean };

/** A connection is a navigation candidate, not an execution or archive state. */
export async function loadConnectedTasks(signal?: AbortSignal): Promise<ConnectedTasks> {
  const response = await fetch("/api/task-inbox/connections", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("连接任务暂时无法读取");
  const value = await response.json() as Partial<ConnectedTasks>;
  if (!Array.isArray(value.data) || value.data.length > 20 || typeof value.partial !== "boolean"
    || value.data.some(row => !row || typeof row.id !== "string" || !row.id || typeof row.title !== "string"
      || typeof row.cwd !== "string" || !Number.isFinite(row.updatedAt) || row.archive_status !== "unknown")) {
    throw new Error("连接任务记录无效");
  }
  return { data: value.data, partial: value.partial };
}

export function visibleConnectedTasks(rows: readonly ConnectedTask[], listedIds: readonly string[], search: string) {
  const seen = new Set(listedIds), query = search.trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return !query || row.title.toLocaleLowerCase().includes(query);
  });
}
