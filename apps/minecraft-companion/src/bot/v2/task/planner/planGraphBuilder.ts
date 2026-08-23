import { randomUUID } from 'node:crypto';
import type { ContextSignature, GoalContract, PlanGraph, PlanNode } from './plannerContracts.js';
import type { PlannerExperienceBundle } from './experience/plannerExperienceProvider.js';

export interface PlannedStep {
  stage: string;
  goalText: string;
  successCriteria: string[];
  structuredSuccessCriteria?: Array<Record<string, unknown>>;
}

/** 通用冷启动知识端口；只产规划里程碑，不控制执行。 */
export interface ColdStartPlannerPort {
  plan(goal: GoalContract, context: ContextSignature): PlannedStep[] | null;
}

export class PlanGraphBuilder {
  constructor(private readonly coldStartPlanner?:ColdStartPlannerPort) {}

  planFrozen(goal:GoalContract,context:ContextSignature,bundle:PlannerExperienceBundle|null,planId=`plan-${randomUUID()}`):PlanGraph {
    const normalized={...goal,taskFamily:goal.taskFamily??inferFamily(goal.goalText)};
    const experiencedSteps=bundle ? stepsFromExperience(bundle,normalized) : null;
    // A failure-only candidate commonly contains recovery knowledge but no
    // machine-verifiable task structure.  Treating its generic stage labels as
    // a complete plan used to collapse a rich cold-start graph into one final
    // leaf.  Keep the deterministic cold-start decomposition in that case and
    // apply only the candidate's recovery/meta knowledge around it.
    const usesExperiencedStructure=experiencedSteps ? hasExecutableExperienceStructure(experiencedSteps) : false;
    const proposedSteps=usesExperiencedStructure
      ? experiencedSteps!
      : this.coldStartPlanner?.plan(normalized,context) ?? fallbackSteps(normalized);
    const parentCriteria=structuredCriteria(normalized.metadata?.structuredSuccessCriteria);
    const steps=executableSteps(proposedSteps,parentCriteria);
    const schemaRefs=usesExperiencedStructure
      ? bundle?.selectionManifest.selected.filter(value=>value.type==='task_schema').map(value=>value.experienceId)??[]
      : [];
    const metaRefs=bundle?.selectionManifest.selected.filter(value=>value.type==='meta_policy').map(value=>value.experienceId)??[];
    const nodes:PlanNode[]=steps.map((step,index)=>{
      const fragmentRefs=bundle&&usesExperiencedStructure
        ? (steps.length===1 ? allSelectedFragmentRefs(bundle) : fragmentExperienceRefs(bundle,step.stage))
        : [];
      const experienceRefs=[...new Set([...schemaRefs,...fragmentRefs,...metaRefs])];
      const metadata={
        ...(normalized.metadata?structuredClone(normalized.metadata):{}),
        structuredSuccessCriteria:structuredClone(step.structuredSuccessCriteria??[]),
        planningStages:proposedSteps.map(value=>({stage:value.stage,goalText:value.goalText})),
      };
      return {id:`node-${index+1}`,goal:{id:`${normalized.id}:${index+1}`,goalText:step.goalText,successCriteria:step.successCriteria,taskFamily:normalized.taskFamily,metadata},state:index===0?'ready':'pending',preconditions:index===0?[]:[`node-${index} satisfied`],postconditions:step.successCriteria,planRecoveryRefs:recoveryRefs(bundle),estimatedCost:{actions:1,durationMs:30_000,llmRounds:0,risk:context.dangerLevel},provenance:bundle?[bundle.policySnapshotId,...experienceRefs]:['novel_planner'],experienceRefs};
    });
    return {id:planId,goalId:normalized.id,...(bundle?{policySnapshotId:bundle.policySnapshotId,bundleId:bundle.bundleId,contentHash:bundle.contentHash,selectionManifestId:bundle.selectionManifestId}:{}),nodes,edges:nodes.slice(1).map((node,index)=>({from:nodes[index].id,to:node.id,type:'requires' as const})),budget:{maxNodes:Math.max(8,nodes.length),maxGraphReplans:2},provenance:bundle?[bundle.policySnapshotId,bundle.bundleId,bundle.selectionManifestId,...bundle.evidenceRefs]:['novel_planner']};
  }
}

function stepsFromExperience(bundle:PlannerExperienceBundle,goal:GoalContract):PlannedStep[] {
  const schema=bundle.taskSchemas.find(isRecord);
  const rawStages=Array.isArray(schema?.stages)?schema.stages:[];
  const rawValues=rawStages.length?rawStages:bundle.planFragments.filter(isRecord);
  if(rawValues.length===0) return [{goalText:goal.goalText,successCriteria:goal.successCriteria,stage:'execute'}];
  return rawValues.flatMap((value,index):PlannedStep[]=>{
    const record=isRecord(value)?value:null;
    const stage=typeof value==='string'?value:String(record?.id??record?.stage??record?.action??'').trim();
    if(!stage)return [];
    const fragment=record??matchingFragment(bundle,stage);
    const machineCriteria=structuredCriteria(fragment?.structuredSuccessCriteria??fragment?.successCriteria);
    const textCriteria=stringCriteria(fragment?.postconditions??fragment?.successCriteria);
    const final=index===rawValues.length-1;
    return [{
      stage,
      goalText:typeof fragment?.goalText==='string'?fragment.goalText:humanize(stage,goal.goalText),
      successCriteria:textCriteria.length?textCriteria:(final&&goal.successCriteria.length?goal.successCriteria:[`阶段完成：${stage}`]),
      ...(machineCriteria.length?{structuredSuccessCriteria:machineCriteria}:{}),
    }];
  });
}
function recoveryRefs(bundle:PlannerExperienceBundle|null):string[]{return bundle?.planRecoveryPatterns.filter(isRecord).map(item=>String(item.id??'')).filter(Boolean)??[];}
function humanize(stage:string,goal:string):string { const labels:Record<string,string>={inspect_recipe:`调查“${goal}”的配方`,prepare_facilities:'准备所需设施',prepare_materials:'准备所需材料',craft:`制作目标：${goal}`,verify_inventory:`验证库存中已获得目标：${goal}`,inspect_context:'调查当前情境',plan_dependencies:'确认任务依赖',execute:goal,verify:`验证任务结果：${goal}`};return labels[stage]??stage; }
function inferFamily(goal:string):string{return /造|制作|craft|铁轨|工具/i.test(goal)?'crafting':/建|build/i.test(goal)?'building':/找|探索|explore/i.test(goal)?'exploration':'general';}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function fallbackSteps(goal:GoalContract):PlannedStep[]{return [
  {goalText:`调查完成“${goal.goalText}”所需的依赖、设施和材料`,successCriteria:['依赖、设施和材料已确认'],stage:'inspect_context'},
  {goalText:goal.goalText,successCriteria:goal.successCriteria.length?goal.successCriteria:[`世界状态确认：${goal.goalText} 已完成`],stage:'execute'},
  {goalText:`验证“${goal.goalText}”的最终结果`,successCriteria:goal.successCriteria.length?goal.successCriteria:[`最终判据成立：${goal.goalText}`],stage:'verify'},
];}
function fragmentExperienceRefs(bundle:PlannerExperienceBundle,stage:string):string[]{
  const selected=new Map(bundle.selectionManifest.selected.map(value=>[value.experienceId,value]));
  return bundle.planFragments.flatMap((value,index)=>{
    if(!isRecord(value)) return [];
    const id=typeof value.id==='string'?value.id:`${bundle.policyId}:plan_fragment:${index+1}`;
    const marker=String(value.stage??value.action??'');
    return (!marker||marker===stage||stage.includes(marker)||marker.includes(stage))&&selected.has(id)?[id]:[];
  });
}

function allSelectedFragmentRefs(bundle:PlannerExperienceBundle):string[]{
  return bundle.selectionManifest.selected.filter(value=>value.type==='plan_fragment').map(value=>value.experienceId);
}

function executableSteps(steps:PlannedStep[],parentCriteria:Array<Record<string,unknown>>):PlannedStep[]{
  if(steps.length===0) return [];
  const lastIndex=steps.length-1;
  return steps.flatMap((step,index):PlannedStep[]=>{
    const own=step.structuredSuccessCriteria??[];
    if(own.length===0&&index!==lastIndex)return [];
    const criteria=own.length?own:parentCriteria;
    return [{...step,structuredSuccessCriteria:criteria}];
  });
}

function hasExecutableExperienceStructure(steps:PlannedStep[]):boolean{
  return steps.some(step=>(step.structuredSuccessCriteria?.length??0)>0);
}

function matchingFragment(bundle:PlannerExperienceBundle,stage:string):Record<string,unknown>|null{
  return bundle.planFragments.filter(isRecord).find(value=>{
    const marker=String(value.stage??value.action??value.id??'');
    return marker===stage||marker.includes(stage)||stage.includes(marker);
  })??null;
}

function structuredCriteria(value:unknown):Array<Record<string,unknown>>{
  return Array.isArray(value)?value.filter(isRecord).map(item=>structuredClone(item)):[];
}

function stringCriteria(value:unknown):string[]{
  return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
}
