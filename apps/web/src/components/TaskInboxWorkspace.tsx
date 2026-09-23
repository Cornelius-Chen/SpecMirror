import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, Folder, Inbox, RefreshCw, Search } from "lucide-react";
import { fetchWithHumanApproval } from "../human-approval-client.ts";
import "../task-inbox.css";

type Task = {id:string;title:string;cwd:string;updatedAt:number;pinned:boolean;version:string;received:boolean;receivedAt:string|null};
type Detail = Task & {preview:string;token:string;historyUnavailable:boolean;nextCursor:string|null;nodes:Array<{id:string;title:string;status:string}>;turns:Array<{id:string;status:string;messages:Array<{role:string;text:string}>}>};
async function request<T>(url:string, signal?:AbortSignal, body?:unknown):Promise<T> {
  const init:RequestInit={signal,...(body ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {})};
  const response = body ? await fetchWithHumanApproval(url,init,{method:"POST",url,workspace:"host",body}) : await fetch(url,init);
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "读取失败，请重试。"); return result;
}
const project = (cwd:string) => /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/]/i.test(cwd) ? "独立任务" : cwd.split(/[\\/]/).filter(Boolean).at(-1) || "独立任务";
const date = (value:number) => new Date(value*1000).toLocaleString("zh-CN",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

export function TaskInboxWorkspace() {
  const [tasks,setTasks] = useState<Task[]>([]), [selected,setSelected] = useState(new URLSearchParams(location.search).get("task") ?? "");
  const [detail,setDetail] = useState<Detail>(), [search,setSearch] = useState(""), [query,setQuery] = useState(""), [archived,setArchived] = useState(false);
  const [cursor,setCursor] = useState<string|null>(null), [sync,setSync] = useState(""), [refresh,setRefresh] = useState(0);
  const [loading,setLoading] = useState(true), [reading,setReading] = useState(false), [saving,setSaving] = useState(false), [paging,setPaging] = useState(false);
  const [error,setError] = useState(""), [detailError,setDetailError] = useState(""), [notice,setNotice] = useState("");
  const generation = useRef(0), detailGeneration = useRef(0), selection = useRef(selected); selection.current = selected;
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    const controller=new AbortController(); const gen=++generation.current; setLoading(true);setPaging(false);setError("");setTasks([]);setCursor(null);
    const params=new URLSearchParams({search:query,archived:String(archived)});
    request<{data:Task[];nextCursor:string|null;syncedAt:string}>(`/api/task-inbox?${params}`,controller.signal).then(result=>{if(gen!==generation.current)return;setTasks(result.data);setCursor(result.nextCursor);setSync(result.syncedAt);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[query,archived,refresh]);
  useEffect(()=>{
    const gen=++detailGeneration.current;if(!selected){setDetail(undefined);return;} const controller=new AbortController();setReading(true);setDetail(undefined);setDetailError("");setNotice("");
    request<Detail>(`/api/task-inbox/${encodeURIComponent(selected)}`,controller.signal).then(result=>{if(gen===detailGeneration.current)setDetail(result);}).catch(e=>{if(!controller.signal.aborted)setDetailError(e.message);}).finally(()=>{if(!controller.signal.aborted)setReading(false);});
    return()=>controller.abort();
  },[selected,refresh]);
  async function more() {
    if(!cursor||paging)return;const gen=generation.current;setPaging(true);setError("");
    try {const result=await request<{data:Task[];nextCursor:string|null}>(`/api/task-inbox?${new URLSearchParams({cursor,search:query,archived:String(archived)})}`);if(gen!==generation.current)return;setTasks(current=>[...new Map([...current,...result.data].map(t=>[t.id,t])).values()]);setCursor(result.nextCursor);}
    catch(e){if(gen===generation.current)setError((e as Error).message);}finally{if(gen===generation.current)setPaging(false);}
  }
  async function receive() {
    if(!detail)return;const target=detail;setSaving(true);setDetailError("");
    try {const result=await request<{at:string}>(`/api/task-inbox/${encodeURIComponent(target.id)}/receive`,undefined,{version:target.version,token:target.token});setTasks(rows=>rows.map(t=>t.id===target.id&&t.version===target.version?{...t,received:true,receivedAt:result.at}:t));if(selection.current===target.id){setDetail(current=>current?.version===target.version?{...current,received:true,receivedAt:result.at}:current);setNotice("已查收此版本。后续有新更新时会再次提示。");}}
    catch(e){if(selection.current===target.id)setDetailError((e as Error).message);}finally{setSaving(false);}
  }
  async function older() {
    if(!detail?.nextCursor)return;const target=detail,gen=detailGeneration.current;setReading(true);setDetailError("");
    try {const result=await request<Detail>(`/api/task-inbox/${encodeURIComponent(target.id)}?${new URLSearchParams({cursor:target.nextCursor!})}`);if(result.historyUnavailable)throw Error("更早对话未能读取，请重试。");if(gen===detailGeneration.current)setDetail(current=>current?{...current,turns:[...current.turns,...result.turns.filter(t=>!current.turns.some(old=>old.id===t.id))],nextCursor:result.nextCursor}:current);}
    catch(e){if(gen===detailGeneration.current)setDetailError((e as Error).message);}finally{if(gen===detailGeneration.current)setReading(false);}
  }
  function select(id:string) {setSelected(id);const url=new URL(location.href);if(id)url.searchParams.set("task",id);else url.searchParams.delete("task");history.replaceState(null,"",url);}
  const groups = new Map<string,Task[]>();for(const task of tasks){const key=project(task.cwd)==="独立任务"?"":task.cwd;groups.set(key,[...(groups.get(key)??[]),task]);}
  return <main className={`task-inbox ${selected?"has-selection":""}`} aria-label="所有 Codex 任务">
    <header className="ti-header"><div><span className="ti-mark">映</span><strong>Mirror 映构</strong><span className="ti-divider">/</span><span>任务收件箱</span></div><a href="/?workspace=engineering">工程工作台 <ArrowUpRight size={15}/></a></header>
    <div className="ti-body"><aside className="ti-sidebar" aria-label="Codex 任务列表">
      <div className="ti-sidebar-head"><h1>我的任务</h1><button aria-label="刷新任务与内容" title="刷新任务与内容" onClick={()=>setRefresh(n=>n+1)} disabled={loading}><RefreshCw size={16}/></button></div>
      <label className="ti-search"><Search size={16}/><input aria-label="搜索全部任务标题" placeholder="搜索全部任务标题" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <div className="ti-segments" aria-label="任务范围"><button aria-pressed={!archived} onClick={()=>{setArchived(false);select("");}}>当前任务</button><button aria-pressed={archived} onClick={()=>{setArchived(true);select("");}}>已归档</button></div>
      <div className="ti-list" aria-busy={loading}>
        {loading&&<p className="ti-empty">正在读取 Codex 任务…</p>}
        {!loading&&!error&&!tasks.length&&<p className="ti-empty">{query?"没有找到匹配标题。":"此范围暂无任务。"}</p>}
        {[...groups].map(([cwd,rows])=><section key={cwd} className="ti-group"><h2 title={cwd}><Folder size={13}/>{project(cwd)}<span>{rows.length}</span></h2>{rows.map(task=><button className={`ti-task ${task.id===selected?"is-selected":""}`} key={task.id} aria-pressed={task.id===selected} onClick={()=>select(task.id)}><span className="ti-task-title">{task.pinned?"★ ":""}{task.title}</span><span className="ti-task-meta"><span className={task.received?"":"ti-unread"}>{task.received?"已查收":"待查收更新"}</span><time>{date(task.updatedAt)}</time></span></button>)}</section>)}
        {error&&<div className="ti-error" role="alert">{error}<button onClick={()=>cursor?void more():setRefresh(n=>n+1)}>重试</button></div>}
        {cursor&&<button className="ti-more" disabled={paging} onClick={()=>void more()}>{paging?"正在读取…":"加载更早任务"}</button>}
      </div>
      <footer className="ti-sidebar-footer">本机 Codex · 已载入 {tasks.length} 项{cursor?" · 还有更多":""}<br/>{sync?`同步于 ${new Date(sync).toLocaleTimeString("zh-CN")}`:"等待同步"}</footer>
    </aside><section className="ti-detail" aria-label="任务内容">
      {selected&&<button className="ti-back" onClick={()=>select("")}><ArrowLeft size={16}/>返回任务列表</button>}
      {!selected&&<div className="ti-welcome"><Inbox size={32} strokeWidth={1.3}/><h2>任务集中在这里，逐项查收</h2><p>从左侧选择任务，查看最近的请求与回复。<br/>查收记录会保留；任务更新后会重新提示。</p><div className="ti-workflow"><span>选择任务</span><span>→</span><span>核对内容</span><span>→</span><span>标记查收</span></div><p className="ti-note">工程任务的约束、执行和验收继续在工程工作台中管理。</p></div>}
      {reading&&!detail&&<p className="ti-empty">正在读取任务内容…</p>}
      {detailError&&<div role="alert" className="ti-error">{detailError}<button onClick={()=>setRefresh(n=>n+1)}>刷新内容</button></div>}
      {detail&&<><header className="ti-detail-head"><div className="ti-eyebrow">{project(detail.cwd)} · Codex 任务</div><h2>{detail.title}</h2><div className="ti-detail-actions"><span>更新于 {date(detail.updatedAt)}</span><button className="ti-primary" disabled={saving||detail.received} onClick={()=>void receive()}><Check size={15}/>{saving?"正在保存…":detail.received?"此版本已查收":"标记此版本已查收"}</button></div><p className="ti-note">查收表示你已查看此版本，不等于工程验收通过。这里显示历史记录，运行状态以 Codex 为准。</p>{notice&&<p role="status" className="ti-notice">{notice}</p>}</header>
      <div className="ti-content">
        {detail.nodes.length>0&&<section className="ti-linked"><h3>已关联的工程节点</h3>{detail.nodes.map(n=><a key={n.id} href={`/?workspace=engineering&node=${encodeURIComponent(n.id)}`}>{n.title} <ArrowUpRight size={14}/></a>)}</section>}
        {!detail.nodes.length&&<p className="ti-note">此任务尚无当前工程的节点关联，任务内容可独立查收。</p>}
        <details className="ti-context"><summary>查看任务最初的请求与工作目录</summary><p className="ti-text">{detail.cwd}</p><p className="ti-text">{detail.preview||"暂无请求摘要。"}</p></details>
        <h3>最近的对话 <small>从新到旧 · 仅显示请求与回复</small></h3>
        {detail.historyUnavailable&&<p className="ti-error" role="alert">暂时无法读取对话分页，请刷新重试。任务目录仍可用，完整结果也可在 Codex 中查看。</p>}
        {!detail.historyUnavailable&&!detail.turns.length&&<p className="ti-note">尚无已保存的对话内容。</p>}
        {detail.turns.map(turn=><section className="ti-turn" key={turn.id}><div className="ti-turn-status">{({completed:"本轮回复结束",inProgress:"本轮尚未结束",failed:"本轮失败",interrupted:"本轮已中断"} as Record<string,string>)[turn.status]??"历史对话"} · 非工程验收状态</div>{turn.messages.map((message,index)=><article key={index} className={`ti-message ${message.role}`}><h4>{message.role==="user"?"你的请求":"Agent 回复"}</h4><div className="ti-text">{message.text||"此条没有可显示的文本。"}</div></article>)}</section>)}
        {detail.nextCursor&&<button disabled={reading} onClick={()=>void older()}>{reading?"正在读取…":"查看更早对话"}</button>}
      </div></>}
    </section></div>
  </main>;
}
