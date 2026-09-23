import { useEffect, useState } from "react";
import { loadConnectedTasks, visibleConnectedTasks, type ConnectedTasks } from "../connected-tasks.ts";

export function ConnectedTaskList({ refresh, listedIds, search, selected, accepts, onSelect }: {
  refresh: number;
  listedIds: readonly string[];
  search: string;
  selected: string;
  accepts: (id: string) => boolean;
  onSelect: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ConnectedTasks>();
  const [failure, setFailure] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(false);
    void loadConnectedTasks(controller.signal).then(next => {
      if (!controller.signal.aborted) setSnapshot(next);
    }).catch(() => {
      if (!controller.signal.aborted) { setSnapshot(undefined); setFailure(true); }
    });
    return () => controller.abort();
  }, [refresh, retry]);
  const rows = visibleConnectedTasks(snapshot?.data ?? [], listedIds, search).filter(row => accepts(row.id));
  if (!rows.length && !failure && !snapshot?.partial) return null;
  return <section className="uw-task-group uw-connected-tasks" aria-label="最近连接的任务">
    <h2>最近连接<span>{rows.length || ""}</span></h2>
    {rows.map(row => <button type="button" key={row.id} className={`uw-task ${selected === row.id ? "is-selected" : ""}`}
      title={row.cwd} aria-pressed={selected === row.id} onClick={() => onSelect(row.id)}>
      <span className="uw-task-title">{row.title}</span>
      <span className="uw-task-meta">{row.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "独立任务"}<span>打开任务 →</span></span>
    </button>)}
    {rows.length > 0 && <p className="uw-group-path">连接记录不代表正在执行；归档状态未核对。</p>}
    {(failure || snapshot?.partial) && <p className="uw-group-path" role="status">{failure ? "连接任务暂时无法读取。" : "部分连接任务未能核对。"}<button type="button" onClick={() => setRetry(value => value + 1)}>重试读取连接任务</button></p>}
  </section>;
}
