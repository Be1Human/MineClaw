export interface ContextSignature {
  inventory: Record<string, number>;
  capabilities: string[];
  nearbyFacilities: string[];
  nearbyResources: string[];
  biome?: string;
  timeBucket: 'day' | 'night' | 'unknown';
  dangerLevel: number;
  positionRegion: string;
  worldRevision: string;
}

export interface GoalContract {
  id: string;
  goalText: string;
  successCriteria: string[];
  taskFamily?: string;
  metadata?: Record<string, unknown>;
}

export type AgentGoalOutcome = 'obtain' | 'deliver' | 'deposit' | 'place' | 'reach' | 'build' | 'defeat' | 'explore' | 'survive';
export type ParentGoalTargetKind = 'item' | 'entity' | 'location' | 'structure' | 'state';

export interface CommittedAgentGoal {
  requestId: string;
  objective: string;
  outcome: AgentGoalOutcome;
  target: {
    kind: ParentGoalTargetKind;
    surface: string;
    registryId: string;
    quantity: number;
  };
  constraints: string[];
  successCriteria: Array<Record<string, unknown>>;
}

export interface GoalSignature {
  key: string;
  outcome: AgentGoalOutcome;
  targetKind: ParentGoalTargetKind;
  targetId: string;
  quantity: number;
  constraintsHash: string;
  compatibleTaskFamilies: readonly string[];
  schemaVersion: 1;
}

export interface PlanNode {
  id: string;
  goal: GoalContract;
  state: 'pending' | 'ready' | 'dispatched' | 'satisfied' | 'failed' | 'skipped' | 'needs_replan';
  preconditions: string[];
  postconditions: string[];
  planRecoveryRefs: string[];
  estimatedCost: { actions: number; durationMs: number; llmRounds: number; risk: number };
  provenance: string[];
  experienceRefs?: string[];
}

export interface PlanGraph {
  id: string;
  goalId: string;
  policySnapshotId?: string;
  bundleId?: string;
  contentHash?: string;
  selectionManifestId?: string;
  nodes: PlanNode[];
  edges: Array<{ from:string; to:string; type:'requires'|'blocks'|'fallback' }>;
  budget: { maxNodes:number; maxGraphReplans:number; overallDeadlineMs?:number };
  provenance: string[];
}

export interface GoalExecutionTerminalEvent {
  outcome: 'succeeded' | 'failed' | 'cancelled';
  handoff: 'none' | 'graph_replan_required';
  verdict: { ok:boolean; detail:string; evidenceRefs?:string[] };
}

export interface PlanNodeExecutionPort {
  execute(input: { planId:string; nodeId:string; goal:GoalContract; provenance:string[] }): Promise<GoalExecutionTerminalEvent>;
}
