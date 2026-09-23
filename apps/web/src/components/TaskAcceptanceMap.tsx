import { Check, ChevronDown, CircleAlert, CircleCheck, CircleDashed, ExternalLink, MessageSquareText, RotateCcw, SearchCheck, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import type { SupervisionDetail, SupervisionDocument, SupervisionProgress, SupervisionTask } from "../types.ts";

type TaskGroup = "review" | "active" | "done";

const groupLabels: Record<TaskGroup, string> = {
  review: "等我检查",
  active: "执行中",
  done: "已完成"
};

const statusCopy: Record<SupervisionDetail["status"], string> = {
  draft: "尚未开始",
  ready: "可以执行",
  assigned: "Agent 执行中",
  reviewing: "等你检查",
  accepted: "已通过",
  needs_revision: "需要修改"
};

let cachedDocument: SupervisionDocument | undefined;
let cachedProgress: SupervisionProgress | undefined;

function isPlaceholder(detail: SupervisionDetail) {
  return detail.status === "draft"
    && !detail.output
    && detail.acceptance.every((criterion) => criterion.startsWith("请补充") || criterion.startsWith("请改写"));
}

function taskGroup(task: SupervisionTask, details: SupervisionDetail[]): TaskGroup {
  if (details.length > 0 && details.every((detail) => detail.status === "accepted")) return "done";
  if (details.some((detail) => detail.output && detail.status !== "accepted")) return "review";
  if (task.status === "ready" || details.some((detail) => detail.status === "assigned" || detail.status === "ready")) return "active";
  return "review";
}

function evidenceState(detail: SupervisionDetail) {
  const checks = detail.output?.checks ?? [];
  const passed = checks.filter((check) => check.result === "pass").length;
  const incomplete = checks.filter((check) => check.result === "pending" || check.result === "partial").length;
  const failed = checks.filter((check) => check.result === "fail").length;
  if (!detail.output) return { tone: "empty", label: "尚无证据", passed, total: 0 };
  if (failed > 0) return { tone: "danger", label: `${failed} 项不符合`, passed, total: checks.length };
  if (incomplete > 0) return { tone: "waiting", label: `${incomplete} 项待补充`, passed, total: checks.length };
  return { tone: "pass", label: `${passed}/${checks.length} 项有证据`, passed, total: checks.length };
}

export function TaskAcceptanceMap({ refreshToken, onOpenSupervision, onOpenTechnical }: { refreshToken?: number; onOpenSupervision(): void; onOpenTechnical(): void }) {
  const [document, setDocument] = useState<SupervisionDocument | undefined>(cachedDocument);
  const [progress, setProgress] = useState<SupervisionProgress | undefined>(cachedProgress);
  const [activeTaskId, setActiveTaskId] = useState<string>();
  const [feedbackDetailId, setFeedbackDetailId] = useState<string>();
  const [feedback, setFeedback] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const nextDocument = await api.supervision();
      cachedDocument = nextDocument;
      setDocument(nextDocument);
      setError(undefined);
      setActiveTaskId((current) => {
        if (current && nextDocument.tasks.some((task) => task.id === current)) return current;
        const useful = nextDocument.tasks.filter((task) => {
          const details = nextDocument.details.filter((detail) => detail.task_id === task.id && !isPlaceholder(detail));
          return task.status !== "draft" || details.length > 0;
        });
        return [...useful].sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready") || a.order - b.order)[0]?.id;
      });
      void api.supervisionProgress().then((nextProgress) => {
        cachedProgress = nextProgress;
        setProgress(nextProgress);
      }).catch(() => {
        // Progress is supplementary. Keep the last snapshot and never block Plan review.
      });
    } catch (cause) {
      if (!cachedDocument) setError(cause instanceof Error ? cause.message : String(cause));
      else setMessage("正在显示最近一次 Plan；最新同步暂时不可用。");
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const usefulTasks = useMemo(() => document?.tasks.filter((task) => {
    const details = document.details.filter((detail) => detail.task_id === task.id && !isPlaceholder(detail));
    return task.status !== "draft" || details.length > 0;
  }) ?? [], [document]);

  const groupedTasks = useMemo(() => {
    const groups: Record<TaskGroup, SupervisionTask[]> = { review: [], active: [], done: [] };
    for (const task of usefulTasks) {
      const details = document?.details.filter((detail) => detail.task_id === task.id && !isPlaceholder(detail)) ?? [];
      groups[taskGroup(task, details)].push(task);
    }
    return groups;
  }, [document, usefulTasks]);

  const activeTask = usefulTasks.find((task) => task.id === activeTaskId) ?? usefulTasks[0];
  const activeDetails = document?.details.filter((detail) => detail.task_id === activeTask?.id && !isPlaceholder(detail)) ?? [];
  const acceptedCount = activeDetails.filter((detail) => detail.status === "accepted").length;

  async function review(detail: SupervisionDetail, verdict: "accepted" | "needs_revision", note: string) {
    setBusyId(detail.id);
    setMessage(undefined);
    try {
      const next = await api.reviewSupervisionDetail(detail.id, verdict, note);
      cachedDocument = next;
      setDocument(next);
      setFeedbackDetailId(undefined);
      setFeedback("");
      setMessage(verdict === "accepted" ? `“${detail.title}”已通过。` : `“${detail.title}”已退回，并保留了你的意见。`);
      const nextProgress = await api.supervisionProgress();
      cachedProgress = nextProgress;
      setProgress(nextProgress);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  if (error) return <section className="acceptance-map-state"><CircleAlert size={24} /><strong>暂时无法读取任务验收数据</strong><p>{error}</p><button onClick={() => void load()}>重新读取</button></section>;
  if (!document || !activeTask) return <section className="acceptance-map-state"><CircleDashed size={24} /><strong>正在整理当前 Plan…</strong></section>;

  return <section className="task-acceptance-map" aria-label="任务验收地图" data-testid="task-acceptance-map">
    <aside className="acceptance-task-nav" aria-label="有效任务">
      <header><span>当前 Plan</span><strong>只显示需要监督的任务</strong><small>{document.plan.version} · 已隐藏无产出的历史草案</small></header>
      <div className="acceptance-task-groups">
        {(["review", "active", "done"] as TaskGroup[]).map((group) => groupedTasks[group].length > 0 && <section key={group}>
          <h3><span className={`task-group-dot is-${group}`} />{groupLabels[group]}<b>{groupedTasks[group].length}</b></h3>
          {groupedTasks[group].map((task) => {
            const taskDetails = document.details.filter((detail) => detail.task_id === task.id && !isPlaceholder(detail));
            const taskAccepted = taskDetails.filter((detail) => detail.status === "accepted").length;
            const taskProgress = progress?.byTask[task.id]?.progress ?? 0;
            return <button key={task.id} className={task.id === activeTask.id ? "active" : ""} onClick={() => { setActiveTaskId(task.id); setFeedbackDetailId(undefined); setMessage(undefined); }} aria-label={`查看任务 ${task.title}`}>
              <span>{task.title}</span><small>{taskAccepted}/{taskDetails.length || 1} 已通过</small><em>{taskProgress}%</em>
            </button>;
          })}
        </section>)}
      </div>
      <footer><SearchCheck size={14} /><span>已过滤仅供机器使用的旧草案</span></footer>
    </aside>

    <main className="acceptance-main">
      <header className="acceptance-task-heading">
        <div><span>当前检查任务</span><h1>{activeTask.title}</h1><p>{activeTask.objective}</p></div>
        <div className="acceptance-task-count"><strong>{acceptedCount}/{activeDetails.length}</strong><span>分项已通过</span></div>
      </header>

      <div className="acceptance-reading-guide" aria-label="阅读顺序">
        <span>Plan 要求</span><i>→</i><span>Agent 产出</span><i>→</i><span>证据</span><i>→</i><span>你的结论</span>
      </div>

      <div className="acceptance-row-list">
        {activeDetails.length === 0 && <div className="acceptance-empty"><CircleDashed size={22} /><strong>这个任务还没有可检查的设计分项</strong><p>请先在设计监督中补充可判断的完成条件。</p></div>}
        {activeDetails.map((detail, index) => {
          const evidence = evidenceState(detail);
          const agentLabel = detail.output?.source === "mock" ? "模拟 Agent 回执" : detail.output?.source === "codex" ? "Codex 实际回执" : detail.output ? "当前 Agent 实际回执" : "尚未执行";
          const outputSummary = detail.output?.source === "mock" ? "Agent 已返回这项分支的演示结果；它只能证明流程可以运行，不能证明功能已经完成。" : detail.output?.summary ?? "Agent 尚未返回可以检查的产出。";
          const isFeedbackOpen = feedbackDetailId === detail.id;
          return <article className={`acceptance-row ${detail.status === "accepted" ? "is-accepted" : detail.status === "needs_revision" ? "is-revision" : ""}`} key={detail.id}>
            <div className="acceptance-row-grid">
              <section className="acceptance-plan-cell"><span className="acceptance-index">{String(index + 1).padStart(2, "0")}</span><div><small>Plan 设计分项</small><strong>{detail.title}</strong><p>{detail.intent}</p><details><summary>查看 {detail.acceptance.length} 条完成条件 <ChevronDown size={13} /></summary><ol>{detail.acceptance.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol></details></div></section>
              <section className="acceptance-output-cell"><small>Agent 实际产出</small><strong>{agentLabel}</strong><p>{outputSummary}</p>{detail.output?.source === "mock" && <span className="mock-evidence-label">演示产出，不计作完成</span>}</section>
              <section className="acceptance-evidence-cell"><small>可检查证据</small><span className={`evidence-pill is-${evidence.tone}`}>{evidence.tone === "pass" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}{evidence.label}</span>{detail.output?.artifact_ref && <a href={detail.output.artifact_ref} target="_blank" rel="noreferrer">查看证据 <ExternalLink size={12} /></a>}<details><summary>查看逐条证据</summary><ul>{detail.output?.checks.map((check) => <li key={check.criterion} className={`is-${check.result}`}><b>{check.result === "pass" ? "满足" : check.result === "fail" ? "不符合" : "待补充"}</b><span>{check.criterion}</span><p>{check.note}</p></li>) ?? <li>等待 Agent 回挂证据。</li>}</ul></details></section>
              <section className="acceptance-verdict-cell"><small>你的结论</small><span className={`verdict-pill status-${detail.status}`}>{statusCopy[detail.status]}</span>{detail.output && detail.status !== "accepted" && <div className="acceptance-actions"><button disabled={busyId === detail.id} className="accept" onClick={() => void review(detail, "accepted", "逐条检查后通过。") }><Check size={14} />通过</button><button disabled={busyId === detail.id} className="revise" onClick={() => { setFeedbackDetailId(detail.id); setFeedback(detail.output?.reviewer_note ?? ""); }}><RotateCcw size={13} />退回</button>{evidence.tone === "waiting" && <button disabled={busyId === detail.id} className="evidence-request" onClick={() => void review(detail, "needs_revision", "请补充与 Plan 完成条件逐条对应的可检查证据。")}>要求补证据</button>}</div>}{!detail.output && <span className="verdict-help">先等待 Agent 产出，再进行结论判断。</span>}</section>
            </div>
            {isFeedbackOpen && <div className="acceptance-feedback"><label>说明哪里不符合<textarea autoFocus rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="只写需要修改的部分，例如：手机截图缺失，不要改动数据逻辑。" /></label><div><button onClick={() => setFeedbackDetailId(undefined)}>取消</button><button className="confirm" disabled={!feedback.trim() || busyId === detail.id} onClick={() => void review(detail, "needs_revision", feedback.trim())}><MessageSquareText size={14} />确认退回本分项</button></div></div>}
          </article>;
        })}
      </div>

      <footer className="acceptance-footer-tools"><button onClick={onOpenSupervision}><MessageSquareText size={14} />修改 Prompt</button><button onClick={onOpenTechnical}><ShieldCheck size={14} />查看技术依据</button>{message && <span role="status">{message}</span>}</footer>
    </main>
  </section>;
}
