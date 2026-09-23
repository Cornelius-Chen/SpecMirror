import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { EngineeringNodeSchema, engineeringContractKey, validateEngineeringDocument, type EngineeringNode } from "@epm/domain";
import { EngineeringServiceError } from "./engineering-service.ts";
import { requestWorkspaceId, type TaskWorkspaces } from "./task-workspaces.ts";
import { registerHumanApprovalGuard } from "./human-approval.ts";

const fields = EngineeringNodeSchema.pick({ title:true, kind:true, objective:true, method:true, architecture:true, constraints:true, criteria:true, actions:true, capabilities:true, contributes_to:true, source_scope:true, delivery:true, composition:true, contribution:true, prerequisites:true, interactions:true }).strict();
function fail(message:string, code="engineering_import_invalid", status=400):never { throw new EngineeringServiceError(code,message,status); }
const object = (value:unknown):Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : fail("需要详细计划JSON对象。");
const string = (value:unknown, maximum=12000):string => typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : fail("计划字段为空或过长。");
export interface PlanImportInput { parent_id:string; expected_revision:number; plan:unknown }
interface Prepared { token:string; workspace_id:string; parent_id:string; expected_revision:number; nodes:EngineeringNode[]; source:{title:string;reference:string}; warnings:string[]; invalidated_run_ids:string[]; expires_at:number }

export class EngineeringPlanImports {
  private readonly previews = new Map<string,Prepared>();
  constructor(readonly workspaces:TaskWorkspaces) {}
  preview(workspaceId:string,input:PlanImportInput) {
    const {service}=this.workspaces.resolve(workspaceId), view=service.view(), doc=view.document;
    if(input.expected_revision!==doc.revision)fail("工程已更新，请重新预览导入。","engineering_revision_conflict",409);
    const parent=doc.nodes.find(node=>node.id===input.parent_id);
    if(!parent || parent.status==="archived")fail("请选择活动的上级任务。");
    const plan=object(input.plan);
    if(Object.keys(plan).some(key=>!["schema_version","source","nodes"].includes(key)) || plan.schema_version!==1)fail("仅支持版本1的详细计划；不能导入状态、负责人或运行历史。");
    const source=object(plan.source);
    if(Object.keys(source).some(key=>!["title","reference"].includes(key)))fail("来源只接受标题与引用。");
    if(!Array.isArray(plan.nodes) || !plan.nodes.length || plan.nodes.length>100)fail("每次导入1到100个步骤。");
    const rows=plan.nodes.map(object), keys=new Map<string,string>(), at=new Date().toISOString();
    for(const row of rows){ const key=string(row.key,160); if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(key)||keys.has(key))fail("步骤key无效或重复。"); keys.set(key,"node-"+randomUUID()); }
    const orders=new Map<string,number>();
    const nodes=rows.map(row=>{
      const {key,parent_key,depends_on=[],...draft}=row;
      if(!Array.isArray(depends_on) || depends_on.some(key=>typeof key!=="string"||!keys.has(key)))fail("前置依赖必须指向本批计划中的步骤key。");
      const parentId=parent_key===null ? parent.id : typeof parent_key==="string" ? keys.get(parent_key) : undefined;
      if(!parentId)fail("每个步骤都须明确parent_key；顶层使用null。");
      const order=orders.get(parentId) ?? doc.nodes.filter(node=>node.parent_id===parentId).length;
      orders.set(parentId,order+1);
      let parsed; try { parsed=fields.parse(draft); } catch { return fail("步骤字段无效；仅接受方案、交付约定、约束、验收、动作与能力，不能预置状态或负责人。"); }
      // In an imported plan, source_node_id is always a plan key, never a saved node ID.
      // This matches depends_on and cannot accidentally bind an unrelated existing task.
      if(parsed.delivery)for(const input of parsed.delivery.inputs)if(input.source_node_id!==null){
        const sourceId=keys.get(input.source_node_id);
        if(!sourceId)fail("交付输入的source_node_id必须指向本批计划的key；外部资料使用external_source。");
        input.source_node_id=sourceId;
      }
      for(const prerequisite of parsed.prerequisites ?? []) {
        const sourceId = keys.get(prerequisite.node_id);
        if(!sourceId) fail("开工前提的node_id必须指向本批计划的key。");
        prerequisite.node_id = sourceId;
      }
      for(const interaction of parsed.interactions ?? []) {
        const targetId = keys.get(interaction.target_node_id);
        if(!targetId) fail("运行配合的target_node_id必须指向本批计划的key。");
        interaction.target_node_id = targetId;
      }
      return EngineeringNodeSchema.parse({...parsed,id:keys.get(key as string),parent_id:parentId,order,dependencies:depends_on.map(key=>keys.get(key)!),status:"draft",owner:"未分配",revision:1,created_at:at,updated_at:at});
    });
    // All branches must descend from the selected parent, including a disconnected cycle.
    const all=new Map(nodes.map(node=>[node.id,node]));
    for(const node of nodes){ const visited=new Set<string>(); let current=node; while(current.parent_id!==parent.id){if(visited.has(current.id))fail("计划父子关系存在循环。");visited.add(current.id); const next=all.get(current.parent_id!);if(!next)fail("计划有未连接到当前上级的步骤。");current=next;} }
    const combined={...doc,nodes:[...doc.nodes,...nodes]}, problems=validateEngineeringDocument(combined);
    if(problems.length)fail(problems.join("\n"));
    const invalidated=doc.runs.filter(run=>["queued","running","review","accepted"].includes(run.status) && engineeringContractKey(combined,run.node_id)!==engineeringContractKey(doc,run.node_id)).map(run=>run.id);
    const prepared:Prepared={token:randomUUID(),workspace_id:workspaceId,parent_id:parent.id,expected_revision:doc.revision,nodes,source:{title:string(source.title,500),reference:typeof source.reference==="string"?source.reference.slice(0,2000):""},warnings:["导入只新增草稿，不预先分配Agent，不产生执行或验收通过。",...(invalidated.length?["已有上级或依赖的运行证据会失效，原记录保留。"]:[])],invalidated_run_ids:invalidated,expires_at:Date.now()+10*60*1000};
    for(const [key,value] of this.previews)if(value.expires_at<Date.now())this.previews.delete(key);
    if(this.previews.size>=100)this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(prepared.token,prepared);
    return structuredClone(prepared);
  }
  commit(workspaceId:string,input:{token:string;expected_revision:number;reason:string}) {
    const prepared=this.previews.get(input.token);
    if(!prepared || prepared.workspace_id!==workspaceId || prepared.expires_at<Date.now())fail("导入预览不存在、已过期或属于其他任务，请重新预览。","engineering_import_preview_required",409);
    if(input.expected_revision!==prepared.expected_revision)fail("导入版本不一致，请重新预览。","engineering_revision_conflict",409);
    const reason=string(input.reason), service=this.workspaces.resolve(workspaceId).service;
    const result=service.appendDraftNodes(prepared.parent_id,prepared.nodes,prepared.expected_revision,`${reason}\n计划来源：${prepared.source.title}${prepared.source.reference?" · "+prepared.source.reference:""}`);
    this.previews.delete(prepared.token);
    return result;
  }
}

export function registerEngineeringPlanImports(app:FastifyInstance,workspaces:TaskWorkspaces) {
  registerHumanApprovalGuard(app);
  const imports=new EngineeringPlanImports(workspaces);
  for(const action of ["preview","commit"] as const) app.post(`/api/engineering/plan-import/${action}`,async(request,reply)=>{
    try {
      if(request.headers["x-engineering-agent-session-id"]!==undefined || request.headers["x-engineering-cwd"]!==undefined)fail("整份计划须由监督者核对后导入，Agent只能修改自己明确所属的步骤。","engineering_human_action_required",403);
      const scope=requestWorkspaceId(request);
      return action==="preview" ? imports.preview(scope,request.body as PlanImportInput) : imports.commit(scope,request.body as {token:string;expected_revision:number;reason:string});
    } catch(error) { const known=error instanceof EngineeringServiceError;return reply.code(known?error.status:400).send({error:error instanceof Error?error.message:"导入未完成。",code:known?error.code:"engineering_import_invalid"}); }
  });
  return imports;
}
