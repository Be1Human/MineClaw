import type { Express, Request } from 'express';
import {
  PlannerEvolutionReadService,
  type PlannerEvolutionGraphRequest,
} from './plannerEvolutionReadService.js';
import type { EvolutionNodeType } from '../bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerExperienceExporter, type PlannerAuditScope } from './plannerExperienceExporter.js';
import { resolveRuntimePersistencePaths } from '../bot/runtimePersistence.js';

const NODE_TYPES = new Set<EvolutionNodeType>([
  'goal_pattern', 'task_schema', 'plan_fragment', 'plan_recovery_pattern',
  'meta_policy', 'failure_pattern', 'episode', 'policy', 'candidate', 'evidence', 'context',
  'plan_graph', 'plan_node', 'selection_manifest', 'experience_rejection',
]);

export function registerPlannerEvolutionRoutes(
  app: Express,
  options: { dataDir: string; hasProfile: (botId: string) => boolean },
): void {
  const service = new PlannerEvolutionReadService(options.dataDir);
  const exporter = new PlannerExperienceExporter();

  app.get('/api/bots/:botId/planner-evolution/summary', (req, res) => {
    if (!options.hasProfile(req.params.botId)) {
      res.status(404).json({ error: 'profile not found' });
      return;
    }
    res.json(service.summary(req.params.botId));
  });

  app.get('/api/bots/:botId/planner-evolution/graph', (req, res) => {
    if (!options.hasProfile(req.params.botId)) {
      res.status(404).json({ error: 'profile not found' });
      return;
    }
    const request = parseGraphRequest(req);
    if ('error' in request) {
      res.status(400).json({ error: request.error });
      return;
    }
    res.json(service.graph(req.params.botId, request));
  });

  app.get('/api/bots/:botId/planner-evolution/dashboard', (req, res) => {
    if (!options.hasProfile(req.params.botId)) { res.status(404).json({ error:'profile not found' }); return; }
    res.json(service.dashboard(req.params.botId));
  });

  app.get('/api/bots/:botId/planner-evolution/export', (req, res) => {
    if (!options.hasProfile(req.params.botId)) { res.status(404).json({ error:'profile not found' }); return; }
    const scope=parseAuditScope(req);
    if('error'in scope){res.status(400).json({error:scope.error});return;}
    try{
      const paths=resolveRuntimePersistencePaths(options.dataDir,req.params.botId);
      const result=exporter.export({profileId:req.params.botId,dbPath:paths.plannerEvolutionDbPath,jsonlPath:paths.plannerExecutionFactsPath,scope,includeRawFacts:singleQuery(req.query.includeRawFacts)==='true'});
      res.setHeader('content-type',result.contentType);
      res.setHeader('content-disposition',`attachment; filename="${result.fileName}"`);
      res.setHeader('cache-control','no-store');
      res.send(result.buffer);
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:String(error)});}
  });

  app.post('/api/bots/:botId/planner-evolution/policies/:policyId/disable', (req, res) => {
    if (!options.hasProfile(req.params.botId)) { res.status(404).json({ error:'profile not found' }); return; }
    const input=parseGovernance(req.body);
    if('error' in input){res.status(400).json({error:input.error});return;}
    try{res.json({policy:service.disablePolicy(req.params.botId,req.params.policyId,input.expectedRevision,input.reason),appliesTo:'next_planning_session'});}
    catch(error){res.status(conflict(error)?409:400).json({error:error instanceof Error?error.message:String(error)});}
  });

  app.post('/api/bots/:botId/planner-evolution/policies/:policyId/rollback', (req, res) => {
    if (!options.hasProfile(req.params.botId)) { res.status(404).json({ error:'profile not found' }); return; }
    const input=parseGovernance(req.body);
    if('error' in input){res.status(400).json({error:input.error});return;}
    try{res.json({policy:service.rollbackPolicy(req.params.botId,req.params.policyId,input.expectedRevision,input.reason),appliesTo:'next_planning_session'});}
    catch(error){res.status(conflict(error)?409:400).json({error:error instanceof Error?error.message:String(error)});}
  });
}

function parseAuditScope(req:Request):PlannerAuditScope|{error:string}{
  const type=singleQuery(req.query.scope)??'full';const id=singleQuery(req.query.id)?.trim();
  if(type==='full')return{type:'full'};
  if(!['policy','plan_run','episode'].includes(type))return{error:'scope must be full, policy, plan_run or episode'};
  if(!id)return{error:'id is required for local scope'};
  return{type:type as 'policy'|'plan_run'|'episode',id};
}

function parseGovernance(value:unknown):{expectedRevision:number;reason:string}|{error:string}{
  if(typeof value!=='object'||value===null||Array.isArray(value))return{error:'body must be an object'};
  const body=value as Record<string,unknown>,expectedRevision=Number(body.expectedRevision),reason=typeof body.reason==='string'?body.reason.trim():'';
  if(!Number.isInteger(expectedRevision)||expectedRevision<1)return{error:'expectedRevision must be a positive integer'};
  if(!reason)return{error:'reason is required'};
  return{expectedRevision,reason};
}
function conflict(error:unknown):boolean{return error instanceof Error&&/revision conflict|changed concurrently/i.test(error.message);}

function parseGraphRequest(req: Request): PlannerEvolutionGraphRequest | { error: string } {
  const types = splitQuery(req.query.type);
  if (types.some(type => !NODE_TYPES.has(type as EvolutionNodeType))) {
    return { error: 'unknown evolution node type' };
  }
  const at = singleQuery(req.query.at);
  if (at && Number.isNaN(Date.parse(at))) return { error: 'at must be an ISO timestamp' };
  return {
    roots: splitQuery(req.query.root).slice(0, 24),
    types: types as EvolutionNodeType[],
    states: splitQuery(req.query.state).slice(0, 12),
    search: singleQuery(req.query.search)?.slice(0, 160),
    at,
    depth: integerQuery(req.query.depth),
    maxNodes: integerQuery(req.query.maxNodes),
    maxEdges: integerQuery(req.query.maxEdges),
  };
}

function splitQuery(value: unknown): string[] {
  const text = singleQuery(value);
  return text ? [...new Set(text.split(',').map(item => item.trim()).filter(Boolean))] : [];
}

function singleQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integerQuery(value: unknown): number | undefined {
  const text = singleQuery(value);
  if (text == null || text === '') return undefined;
  const number = Number(text);
  return Number.isInteger(number) ? number : undefined;
}
