import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve,sep} from "node:path";
import Fastify from "fastify";
import {afterEach,expect,it} from "vitest";
import {atomicWriteYaml,engineeringDocumentPath} from "@epm/spec-io";
import {EngineeringNodeSchema} from "@epm/domain";
import {EventBus} from "./events.ts";
import {registerEngineeringRoutes} from "./engineering-routes.ts";
import {registerEngineeringRestructure,structureProposalVersionPath} from "./engineering-restructure.ts";
import {registerEngineeringPlanImports} from "./engineering-plan-import.ts";
import type {TaskWorkspaces} from "./task-workspaces.ts";

const fixtures:Array<{root:string;app:ReturnType<typeof Fastify>}> = [];
afterEach(async()=>{for(const {root,app} of fixtures.splice(0)){await app.close();const absolute=resolve(root);if(!absolute.startsWith(resolve(tmpdir())+sep)||!absolute.includes("mirror-human-approval-test-"))throw Error("unsafe_test_path");rmSync(absolute,{recursive:true,force:true});}});
it("real engineering routes reject headerless adoption and reviews without writing any project bytes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"mirror-human-approval-test-")),app=Fastify();fixtures.push({root,app});
  const service=registerEngineeringRoutes(app,root,new EventBus());
  const workspaces={resolve:()=>({root,service,record:{id:"host"}})} as unknown as TaskWorkspaces;
  registerEngineeringRestructure(app,workspaces);registerEngineeringPlanImports(app,workspaces);
  const view=service.view(),path=engineeringDocumentPath(root);atomicWriteYaml(path,view.document);
  const rootNode=view.document.nodes.find(node=>node.id===view.document.root_id)!;
  const proposalId="proposal-integration",proposalPath=structureProposalVersionPath(root,proposalId);mkdirSync(dirname(proposalPath),{recursive:true});
  const child=EngineeringNodeSchema.parse({...rootNode,id:"proposal-child",parent_id:rootNode.id,kind:"task",title:"具体成果",owner:"未分配",status:"draft",revision:1,legacy_ref:undefined});
  writeFileSync(proposalPath,JSON.stringify({schema_version:1,proposal_id:proposalId,created_at:"2026-09-07T09:00:00.000Z",title:"待审查结构",reason:"只用于验证预览与应用边界",expected_revision:view.document.revision,root:rootNode,nodes:[child]}));
  const before=readFileSync(path);
  for(const headers of [{},{"x-engineering-agent-session-id":"agent","x-engineering-cwd":encodeURIComponent(root)}]){
    const preview=await app.inject({method:"POST",url:"/api/engineering/structure-proposal/preview",headers,payload:{proposal_id:proposalId}});
    expect(preview.statusCode,preview.body).toBe(200);expect(preview.json()).toMatchObject({proposal_id:proposalId,approval_configured:false});expect(readFileSync(path)).toEqual(before);
  }
  for(const url of ["/api/engineering/structure-proposal/commit","/api/engineering/plan-import/commit",`/api/engineering/nodes/${view.document.root_id}/ready`,"/api/engineering/runs/nonexistent/review","/api/engineering/feedback-items/nonexistent/update"]){
    const response=await app.inject({method:"POST",url,payload:{proposal_id:proposalId,expected_revision:view.document.revision,verdict:"accepted",token:"claimed-owner-approval"}});
    expect(response.statusCode,url).toBe(403);expect(response.json().code).toBe("human_approval_required");expect(readFileSync(path)).toEqual(before);
  }
  expect((await app.inject({method:"GET",url:"/api/engineering"})).statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:"/api/governance/authentication"})).json()).toMatchObject({configured:false,default:"deny",header_absence_is_human:false,ratification_is_reusable_approval:false});
});
