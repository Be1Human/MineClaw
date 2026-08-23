import type { PlanGraph } from './plannerContracts.js';

export interface PlanVerification { ok:boolean; errors:string[] }

export class PlanVerifier {
  verify(plan:PlanGraph):PlanVerification {
    const errors:string[]=[];
    if(!plan.id||!plan.goalId) errors.push('plan_identity_missing');
    if(plan.nodes.length===0) errors.push('plan_has_no_nodes');
    if(plan.nodes.length>plan.budget.maxNodes) errors.push('plan_node_budget_exceeded');
    if(plan.budget.maxGraphReplans<0) errors.push('plan_replan_budget_invalid');
    const ids=new Set<string>();
    for(const node of plan.nodes){
      if(ids.has(node.id)) errors.push(`duplicate_node:${node.id}`); else ids.add(node.id);
      if(!node.goal.goalText.trim()) errors.push(`goal_text_missing:${node.id}`);
      if(node.goal.successCriteria.length===0||node.postconditions.length===0) errors.push(`success_criteria_missing:${node.id}`);
      if(node.provenance.some(value=>/PreparedAction|execution\.command/i.test(value))) errors.push(`forbidden_execution_provenance:${node.id}`);
    }
    for(const edge of plan.edges) if(!ids.has(edge.from)||!ids.has(edge.to)) errors.push(`dangling_edge:${edge.from}->${edge.to}`);
    if(hasCycle(plan)) errors.push('plan_cycle_detected');
    return {ok:errors.length===0,errors};
  }
}

function hasCycle(plan:PlanGraph):boolean {
  const adjacency=new Map<string,string[]>();
  for(const node of plan.nodes) adjacency.set(node.id,[]);
  for(const edge of plan.edges.filter(edge=>edge.type==='requires')) adjacency.get(edge.from)?.push(edge.to);
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string):boolean=>{if(visiting.has(id))return true;if(visited.has(id))return false;visiting.add(id);for(const next of adjacency.get(id)??[])if(visit(next))return true;visiting.delete(id);visited.add(id);return false;};
  return plan.nodes.some(node=>visit(node.id));
}
