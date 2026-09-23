import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import Fastify from "fastify";
import { describe,expect,it } from "vitest";
import { EngineeringNodeSchema, engineeringDirectPrerequisites } from "@epm/domain";
import { atomicWriteYaml,engineeringDocumentPath } from "@epm/spec-io";
import { EventBus } from "./events.ts";
import { registerHumanApprovalGuard, type HumanApprovalVerifier } from "./human-approval.ts";
import { TaskWorkspaces } from "./task-workspaces.ts";
import { registerEngineeringPlanImports } from "./engineering-plan-import.ts";

const draft=()=>({schema_version:1,source:{title:"实际写出的详细方案",reference:"docs/continuation-plan.md"},nodes:[
  {key:"phase",parent_key:null,kind:"task",title:"接续本轮任务",objective:"让实际工作与详细计划一致",method:"先核对来源，再分别实施和验收。",contributes_to:["result"],constraints:{rules:["不能把资料导入当成已执行。"]},criteria:[{id:"covered",text:"两项实际结果都可核对",kind:"manual"}]},
  {key:"one",parent_key:"phase",kind:"step",title:"核对实际来源",objective:"保留来源依据",method:"检查源文件后留证。",contributes_to:["covered"],constraints:{},criteria:[{id:"proof",text:"存在可核对的实际依据",kind:"manual"}]},
  {key:"two",parent_key:"phase",depends_on:["one"],kind:"step",title:"根据来源形成交付",objective:"按条件形成结果",method:"待来源验收后执行。",contributes_to:["covered"],constraints:{},criteria:[{id:"result",text:"结果可与来源核对",kind:"manual"}]}
]});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),"mirror-import-")),at=new Date().toISOString();
  const node=EngineeringNodeSchema.parse({id:"project",parent_id:null,kind:"project",title:"真实任务",order:0,revision:1,status:"draft",objective:"完成工程",constraints:{allow:["artifacts/**"]},criteria:[{id:"result",text:"结果可验收",kind:"manual"}],created_at:at,updated_at:at});
  atomicWriteYaml(engineeringDocumentPath(root),{schema_version:1,id:"doc",revision:1,root_id:node.id,created_at:at,updated_at:at,nodes:[node],runs:[],events:[],changes:[],capability_uses:[]});
  const workspaces=new TaskWorkspaces(root,new EventBus(),{source:async(id:string)=>({id,title:"另一实际来源",cwd:root,version:"v1",preview:"明确要求",updatedAt:1,pinned:false,received:false,receivedAt:null})});
  let approval=0;
  const humanApproval:HumanApprovalVerifier=async(_request,requirement)=>({kind:"authenticated_human_approval",principalId:"isolated-plan-import-test-owner",approvalId:"plan-import-approval-"+(++approval),requestDigest:requirement.requestDigest,expiresAt:Date.now()+60_000});
  const app=Fastify();registerHumanApprovalGuard(app,humanApproval);registerEngineeringPlanImports(app,workspaces);
  return{app,workspaces,root,approvalCalls:()=>approval,close:async()=>{await app.close();workspaces.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error("unsafe cleanup");rmSync(root,{recursive:true,force:true});}};
}
describe("detailed plan import is a scoped reviewed draft transaction",()=>{
  it("resolves all local relationship keys while deriving input prerequisites without duplicate depends_on",async()=>{
    const f=await fixture();try{
      const before=readFileSync(engineeringDocumentPath(f.root),"utf8"),plan=draft() as any;
      const delivery=(criterion:string)=>({included:["本项可交付成果"],excluded:[],no_extra_exclusions:true,outputs:[{id:"result",title:"成果",criterion_ids:[criterion]}],inputs:[] as any[]});
      delete plan.nodes[2].depends_on;
      plan.nodes[0].kind="project";
      plan.nodes[0].criteria.push({id:"whole",text:"来源与报告能够合并核对",kind:"manual"});
      plan.nodes[0].composition={summary:"来源、范围和报告共同构成可核对的交付",integration_criterion_ids:["whole"],scenario:"确定来源范围，形成报告，再回传核对结果"};
      plan.nodes[0].contribution={summary:"为整体工程交付可核对的报告"};
      plan.nodes[1].contribution={summary:"提供报告所依据的原始来源"};
      plan.nodes[2].contribution={summary:"把已确认来源形成报告"};
      plan.nodes[0].delivery=delivery("covered");plan.nodes[1].delivery=delivery("proof");plan.nodes[2].delivery=delivery("result");
      plan.nodes[2].delivery.inputs=[{id:"source",title:"来源依据",source_node_id:"one",source_output_id:"result",external_source:""}];
      plan.nodes.push({key:"scope",parent_key:"phase",kind:"task",title:"资料范围",objective:"明确允许使用的资料",method:"形成范围说明",contributes_to:["covered"],contribution:{summary:"为报告划定允许的资料范围"},constraints:{},criteria:[{id:"ready",text:"资料范围明确",kind:"manual"}],delivery:delivery("ready")});
      plan.nodes[2].prerequisites=[{id:"scope-ready",node_id:"scope",reason:"先明确允许使用的资料范围"}];
      plan.nodes[1].interactions=[{id:"provide-source",target_node_id:"two",source_output_id:"result",target_input_id:"source",purpose:"提供来源依据",scenario:"形成报告"}];
      plan.nodes[2].interactions=[{id:"return-review",target_node_id:"one",source_output_id:"result",target_input_id:"",purpose:"回传核对结果",scenario:"形成报告"}];
      // Runtime feedback may return to its source; it is not a reverse completion prerequisite.
      const response=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan}});
      expect(response.statusCode,response.body).toBe(200);const preview=response.json(),[phase,source,consumer,scope]=preview.nodes;
      expect(readFileSync(engineeringDocumentPath(f.root),"utf8")).toBe(before);
      expect(phase).toMatchObject({kind:"project",parent_id:"project",composition:plan.nodes[0].composition,contribution:plan.nodes[0].contribution});
      expect([source.parent_id,consumer.parent_id,scope.parent_id]).toEqual([phase.id,phase.id,phase.id]);
      expect(consumer.dependencies).toEqual([]);
      expect(consumer.delivery.inputs[0]).toEqual({...plan.nodes[2].delivery.inputs[0],source_node_id:source.id});
      expect(consumer.prerequisites).toEqual([{...plan.nodes[2].prerequisites[0],node_id:scope.id}]);
      expect(source.interactions).toEqual([{...plan.nodes[1].interactions[0],target_node_id:consumer.id}]);
      expect(consumer.interactions).toEqual([{...plan.nodes[2].interactions[0],target_node_id:source.id}]);
      expect(new Set(engineeringDirectPrerequisites(consumer))).toEqual(new Set([source.id,scope.id]));
      expect(engineeringDirectPrerequisites(source)).toEqual([]);
      for(const mutate of [(p:any)=>p.nodes[2].prerequisites[0].node_id="project",(p:any)=>p.nodes[1].interactions[0].target_node_id="project"]){
        const invalid=structuredClone(plan);mutate(invalid);
        expect((await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan:invalid}})).statusCode).toBe(400);
      }
      expect(readFileSync(engineeringDocumentPath(f.root),"utf8")).toBe(before);
      const committed=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/commit",payload:{token:preview.token,expected_revision:1,reason:"核对组成、范围、输入和运行配合"}});
      expect(committed.statusCode,committed.body).toBe(200);const doc=committed.json().document;
      expect(doc.nodes.slice(1)).toEqual(preview.nodes);expect(doc.runs).toEqual([]);
      expect(doc.nodes.slice(1).every((n:any)=>n.status==="draft"&&n.owner==="未分配")).toBe(true);
      expect(new Set(engineeringDirectPrerequisites(doc.nodes.find((n:any)=>n.id===consumer.id)))).toEqual(new Set([source.id,scope.id]));
    }finally{await f.close();}
  });
  it("resolves delivery source plan keys with dependencies and preserves the reviewed contract on commit",async()=>{
    const f=await fixture();try{
      const plan=draft() as any;
      const delivery=(criterion:string)=>({included:["本项可交付成果"],excluded:["不承担其他成果"],outputs:[{id:"result",title:"成果",criterion_ids:[criterion]}],inputs:[] as any[]});
      plan.nodes[0].delivery=delivery("covered");plan.nodes[1].delivery=delivery("proof");plan.nodes[2].delivery=delivery("result");
      plan.nodes[2].delivery.inputs=[{id:"source",title:"来源依据",source_node_id:"one",source_output_id:"result",external_source:""}];
      const response=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan}});
      expect(response.statusCode,response.body).toBe(200);const preview=response.json();
      expect(preview.nodes[2].delivery.inputs[0].source_node_id).toBe(preview.nodes[1].id);expect(preview.nodes[2].dependencies).toEqual([preview.nodes[1].id]);
      const committed=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/commit",payload:{token:preview.token,expected_revision:1,reason:"核对成果及输入关系"}});expect(committed.statusCode,committed.body).toBe(200);
      expect(committed.json().document.nodes[3].delivery).toEqual(preview.nodes[2].delivery);
    }finally{await f.close();}
  });
  it("rejects invented output references and persisted IDs masquerading as plan keys",async()=>{
    const f=await fixture();try{
      const before=readFileSync(engineeringDocumentPath(f.root),"utf8");
      for(const mutate of [(p:any)=>p.nodes[2].delivery.inputs[0].source_output_id="missing",(p:any)=>p.nodes[2].delivery.inputs[0].source_node_id="project"]){
        const plan=draft() as any;plan.nodes[1].delivery={included:["来源成果"],excluded:["其他成果"],outputs:[{id:"result",title:"依据",criterion_ids:["proof"]}],inputs:[]};
        plan.nodes[2].delivery={included:[],excluded:[],outputs:[],inputs:[{id:"source",title:"依据",source_node_id:"one",source_output_id:"result",external_source:""}]};mutate(plan);
        expect((await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan}})).statusCode).toBe(400);
      }
      expect(readFileSync(engineeringDocumentPath(f.root),"utf8")).toBe(before);
    }finally{await f.close();}
  });
  it("previews without writing, then atomically adds hierarchy and dependencies without inventing progress",async()=>{
    const f=await fixture();try{
      const before=readFileSync(engineeringDocumentPath(f.root),"utf8");
      const p=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan:draft()}});expect(p.statusCode).toBe(200);const preview=p.json();
      expect(readFileSync(engineeringDocumentPath(f.root),"utf8")).toBe(before);expect(preview.nodes).toHaveLength(3);
      expect(f.approvalCalls()).toBe(0);
      const c=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/commit",payload:{token:preview.token,expected_revision:1,reason:"把当前详细方案接回当前工程"}});expect(c.statusCode).toBe(200);const doc=c.json().document;
      expect(f.approvalCalls()).toBe(1);
      expect(doc.revision).toBe(2);expect(doc.nodes).toHaveLength(4);expect(doc.runs).toEqual([]);expect(doc.nodes.slice(1).every((n:any)=>n.status==="draft"&&n.owner==="未分配")).toBe(true);
      expect(doc.nodes[3].dependencies).toEqual([doc.nodes[2].id]);expect(doc.nodes[2].parent_id).toBe(doc.nodes[1].id);
      expect((await f.app.inject({method:"POST",url:"/api/engineering/plan-import/commit",payload:{token:preview.token,expected_revision:1,reason:"重复"}})).statusCode).toBe(409);
    }finally{await f.close();}
  });
  it("rejects cycles, fake accepted/owner fields and broken dependencies without partial nodes",async()=>{
    const f=await fixture();try{
      const before=readFileSync(engineeringDocumentPath(f.root),"utf8");
      for(const mutate of [(p:any)=>p.nodes[0].status="accepted",(p:any)=>p.nodes[0].owner="codex:fake",(p:any)=>p.nodes[1].depends_on=["missing"],(p:any)=>p.nodes[0].parent_key="one"]){const plan=draft();mutate(plan);const r=await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan}});expect(r.statusCode).toBe(400);}
      expect(readFileSync(engineeringDocumentPath(f.root),"utf8")).toBe(before);
    }finally{await f.close();}
  });
  it("binds preview to workspace and revision and refuses Agent bulk self-assignment",async()=>{
    const f=await fixture();try{
      const p=(await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",payload:{parent_id:"project",expected_revision:1,plan:draft()}})).json();
      const other=await f.workspaces.connect({thread_id:"actual-other",source_version:"v1",mode:"create"});
      expect((await f.app.inject({method:"POST",url:"/api/engineering/plan-import/commit",headers:{"x-mirror-workspace-id":other.id},payload:{token:p.token,expected_revision:1,reason:"错任务"}})).statusCode).toBe(409);
      expect((await f.app.inject({method:"POST",url:"/api/engineering/plan-import/preview",headers:{"x-engineering-agent-session-id":"actual-session"},payload:{parent_id:"project",expected_revision:1,plan:draft()}})).statusCode).toBe(403);
      f.workspaces.resolve().service.createNode({parent_id:"project",title:"另一已保存修改",expected_revision:1});
      expect((await f.app.inject({method:"POST",url:"/api/engineering/plan-import/commit",payload:{token:p.token,expected_revision:1,reason:"旧预览"}})).statusCode).toBe(409);
      expect(f.workspaces.resolve().service.view().document.nodes).toHaveLength(2);
    }finally{await f.close();}
  });
});
