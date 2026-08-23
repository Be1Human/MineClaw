/** Machine-verifiable success criteria shared by GoalAgent and execution tools. */
export interface GoalSuccessCriterion {
  type: 'entity_dead' | 'inventory' | 'inventory_decrease' | 'item_delivered' | 'item_deposited' | 'block_placed' | 'reached' | 'predicate';
  entityId?: string;
  entityName?: string;
  item?: string;
  count?: number;
  from?: number;
  since?: number;
  position?: { x: number; y: number; z: number };
  radius?: number;
  relativeTo?: 'owner' | 'self';
  relation?: 'near' | 'right' | 'front' | 'at';
  predicate?: string;
}

/** Neutral executable goal value. It contains data only and owns no loop. */
export interface Goal {
  goalText: string;
  context?: string;
  successCriteria?: GoalSuccessCriterion[];
  constraints?: string;
}
