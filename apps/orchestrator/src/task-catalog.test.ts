import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { TaskCatalog, registerTaskCatalogRoutes, taskMessage } from "./task-catalog.ts";
import type { JsonRpcTransport } from "./stdio-jsonrpc.ts";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
 const root=mkdtempSync(join(tmpdir(),"mirror-inbox-"));roots.push(root);mkdirSync(join(root,".project/engineering/recursive"),{recursive:true});writeFileSync(join(root,".project/engineering/recursive/document.yaml"),JSON.stringify({schema_version:1,nodes:[],runs:[]}));
 let version=100;const calls:Array<{method:string;params:Record<string,unknown>}>=[];
 const transport={request:async(method:string,params:Record<string,unknown>)=>{calls.push({method,params});const t={id:"task-1",name:"真实任务名",preview:"请求",updatedAt:version,cwd:"D:/project"};if(method==="thread/list")return {data:[t],nextCursor:params.cursor?null:"older"};if(method==="thread/read")return {thread:t};if(method==="thread/turns/list")return {data:[{id:"turn",status:"completed",items:[{type:"agentMessage",text:"完成回复"},{type:"commandExecution",output:"secret"}]}],nextCursor:null};throw Error("unexpected_write");},close:async()=>{},notify:async()=>{},onNotification:()=>()=>{}} as JsonRpcTransport;
 return {root,calls,catalog:new TaskCatalog(root,()=>transport),transport,update:()=>version++};
}
describe("Codex task inbox",()=>{
 it("extracts the current request from a referenced conversation wrapper",()=>{expect(taskMessage('## Referenced ChatGPT conversation\n{"messages":["unrelated quoted content"]}\n\n## My request:\n实现当前目标')).toBe("实现当前目标");});
 it("shows the user request without injected environment boilerplate and labels excerpts",()=>{expect(taskMessage('<in-app-browser-context source="ambient">noise</in-app-browser-context>\n## My request:\n把我的任务显示出来')).toBe("把我的任务显示出来");expect(taskMessage("a".repeat(100),10)).toContain("此处为节选");});
 it("recreates a failed transport on retry",async()=>{const f=fixture();let attempts=0;const catalog=new TaskCatalog(f.root,()=>++attempts===1?{...f.transport,request:async()=>{throw Error("pipe_closed");}}:f.transport);await expect(catalog.list({})).rejects.toThrow("pipe_closed");expect((await catalog.list({})).data).toHaveLength(1);expect(attempts).toBe(2);});
 it("pages all projects with server search and archive filtering, uses read-only metadata",async()=>{const f=fixture();const first=await f.catalog.list({search:"工程",archived:true});await f.catalog.list({cursor:first.nextCursor!});expect(f.calls[0]).toMatchObject({method:"thread/list",params:{useStateDbOnly:true,searchTerm:"工程",archived:true,limit:50}});expect(f.calls[1].params.cursor).toBe("older");expect(f.calls[0].params.cwd).toBeUndefined();expect(first.data[0].title).toBe("真实任务名");expect(first.data[0].received).toBe(false);});
 it("persists receipt of the inspected version and resurfaces updates",async()=>{const f=fixture();const d=await f.catalog.detail("task-1");await f.catalog.receive(d.id,d.version,d.token);expect((await new TaskCatalog(f.root,()=>f.transport).list({})).data[0].received).toBe(true);f.update();expect((await f.catalog.list({})).data[0].received).toBe(false);await expect(f.catalog.receive(d.id,d.version,d.token)).rejects.toThrow("新更新");});
 it("rejects forged and uninspected versions; does not expose command/reasoning content",async()=>{const f=fixture();await expect(f.catalog.receive("task-1","future","fake")).rejects.toThrow("先打开");const d=await f.catalog.detail("task-1");expect(d.turns[0].messages).toEqual([{role:"assistant",text:"完成回复"}]);expect(JSON.stringify(d)).not.toContain("secret");expect(f.calls.every(c=>["thread/list","thread/read","thread/turns/list"].includes(c.method))).toBe(true);});
 it("returns recoverable error rather than an empty successful directory",async()=>{const f=fixture();const app=Fastify();registerTaskCatalogRoutes(app,f.root,new TaskCatalog(f.root,()=>({...f.transport,request:async()=>{throw Error("offline");}})));const response=await app.inject({url:"/api/task-inbox"});expect(response.statusCode).toBe(503);expect(response.json().data).toBeUndefined();await app.close();});
 it("rejects agent-session receipt requests",async()=>{const f=fixture();const app=Fastify();registerTaskCatalogRoutes(app,f.root,f.catalog);const response=await app.inject({url:"/api/task-inbox/task-1/receive",method:"POST",headers:{"x-engineering-agent-session-id":"agent"},payload:{}});expect(response.statusCode).toBe(403);await app.close();});
});
