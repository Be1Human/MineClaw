import type { PlannerExperienceBundle } from './experience/plannerExperienceProvider.js';
import type { ContextSignature, GoalContract } from './plannerContracts.js';

export interface PlannerExperienceSource { retrieve(): PlannerExperienceBundle | null }
export interface RetrievedPlannerExperience extends PlannerExperienceBundle { truncated:boolean }

export class PlannerRetriever {
  constructor(private readonly source:PlannerExperienceSource, private readonly maxItems=24) {}

  retrieve(goal:GoalContract, context:ContextSignature):RetrievedPlannerExperience|null {
    const bundle=this.source.retrieve();
    if(!bundle) return null;
    const applicable=bundle.applicability.length===0 || bundle.applicability.some(rule=>matches(rule,goal,context));
    if(!applicable) return null;
    let remaining=this.maxItems;
    const take=(values:readonly unknown[])=>{const result=values.slice(0,Math.max(0,remaining));remaining-=result.length;return result;};
    const taskSchemas=take(bundle.taskSchemas), planFragments=take(bundle.planFragments), planRecoveryPatterns=take(bundle.planRecoveryPatterns), metaPolicies=take(bundle.metaPolicies);
    const used=taskSchemas.length+planFragments.length+planRecoveryPatterns.length+metaPolicies.length;
    return {...bundle,taskSchemas,planFragments,planRecoveryPatterns,metaPolicies,applicability:bundle.applicability.slice(0,8),truncated:used < bundle.taskSchemas.length+bundle.planFragments.length+bundle.planRecoveryPatterns.length+bundle.metaPolicies.length};
  }
}

function matches(value:unknown,goal:GoalContract,context:ContextSignature):boolean {
  if(!isRecord(value)) return false;
  if(typeof value.taskFamily==='string' && value.taskFamily!==goal.taskFamily) return false;
  if(typeof value.goalContains==='string' && !goal.goalText.toLowerCase().includes(value.goalContains.toLowerCase())) return false;
  if(typeof value.requiresCapability==='string' && !context.capabilities.includes(value.requiresCapability)) return false;
  if(typeof value.maxDangerLevel==='number' && context.dangerLevel>value.maxDangerLevel) return false;
  return true;
}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
