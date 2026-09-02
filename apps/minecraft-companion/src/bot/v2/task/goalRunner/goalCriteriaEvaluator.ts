import type { WorldStateView } from '../../types.js';
import type { Goal, GoalSuccessCriterion } from '../contracts/goalTypes.js';
import type { WorldFact, WorldFactRequirement } from '../contracts/worldFact.js';
import type { GoalScopeBinding } from '../contracts/goalDraft.js';
import { evaluateRegisteredPredicate } from './goalPredicateEvaluation.js';

export interface GoalCriteriaEvaluation {
  ok: boolean;
  detail: string;
  evidenceRefs?: string[];
}

export interface GoalPredicateVerdict {
  status: 'satisfied' | 'unsatisfied' | 'unknown';
  detail: string;
  evidenceRefs?: string[];
}

export interface GoalCriterionEvidence {
  deliveries?: Array<{ item:string; count:number; at:number; ref?:string }>;
  deposits?: Array<{
    item:string; count:number; at:number;
    position:{x:number;y:number;z:number}; ref?:string;
  }>;
  placements?: Array<{
    item:string; count:number; at:number;
    position:{x:number;y:number;z:number};
    relativeTo:'owner'|'self';
    referencePosition:{x:number;y:number;z:number};
    referenceYaw?:number;
    relation:'near'|'right'|'front'|'at';
    ref?:string;
  }>;
  predicateEvaluators?: readonly GoalPredicateEvaluator[];
  worldFacts?: readonly WorldFact[];
  /** Injected by tests/clock-owning callers, never taken from model arguments. */
  now?: number;
}

export interface GoalPredicateEvaluator {
  readonly id: string;
  readonly version?: string;
  readonly argumentSchema?: Readonly<Record<string, unknown>>;
  readonly factRequirements?: (args: Readonly<Record<string, unknown>>) => readonly WorldFactRequirement[];
  /** Optional code-owned authorization for predicates beyond exact required binding predicates. */
  readonly authorizeGoal?: (input: { criterion: GoalSuccessCriterion; bindings: readonly GoalScopeBinding[] }) => boolean;
  evaluate(input: {
    readonly criterion: GoalSuccessCriterion;
    readonly world: WorldStateView;
    readonly evidence: GoalCriterionEvidence;
    readonly facts?: readonly WorldFact[];
  }): GoalCriteriaEvaluation | GoalPredicateVerdict;
}

/**
 * Goal 终态机器验证器。
 * 只允许当前真正实现的结构化判据；任何缺失或无法执行的协议字段都 fail closed。
 */
export function evaluateGoalCriteria(
  goal: Goal,
  world: WorldStateView | null,
  evidence: GoalCriterionEvidence = {},
): GoalCriteriaEvaluation {
  const result = evaluateGoalCriteriaState(goal, world, evidence);
  // Legacy bool consumers can only succeed on a positive three-state verdict.
  return result.status === 'satisfied'
    ? { ok: true, detail: result.detail, evidenceRefs: result.evidenceRefs }
    : failed(result.detail);
}

export function evaluateGoalCriteriaState(
  goal: Goal, world: WorldStateView | null, evidence: GoalCriterionEvidence = {},
): GoalPredicateVerdict {
  const criteria = goal.successCriteria ?? [];
  if (criteria.length === 0) return { status: 'unknown', detail: '缺少机器成功判据', evidenceRefs: [] };
  if (!world) return { status: 'unknown', detail: '无世界快照，无法验证成功判据', evidenceRefs: [] };

  const evidenceRefs: string[] = [];
  const failures: GoalPredicateVerdict[] = [];
  for (const [index, criterion] of criteria.entries()) {
    let result: GoalPredicateVerdict;
    try {
      if (criterion.type === 'predicate') result = evaluateRegisteredPredicate(criterion, world, evidence);
      else {
        const legacy = evaluateCriterion(criterion, world, evidence);
        result = { status: legacy.ok ? 'satisfied' : 'unsatisfied', detail: legacy.detail, evidenceRefs: legacy.evidenceRefs };
      }
    } catch (error) {
      result = { status: 'unknown', detail: error instanceof Error ? error.message : String(error), evidenceRefs: [] };
    }
    if (result.status !== 'satisfied') failures.push({ ...result, detail: `判据 ${index + 1}：${result.detail}` });
    else evidenceRefs.push(...(result.evidenceRefs?.length ? result.evidenceRefs : [criterionEvidenceRef(criterion)]));
  }
  const failedResult = failures.find(value => value.status === 'unsatisfied') ?? failures[0];
  if (failedResult) return failedResult;
  return {
    status: 'satisfied',
    detail: `verified ${evidenceRefs.join(', ')}`,
    evidenceRefs,
  };
}

function evaluateCriterion(
  criterion: GoalSuccessCriterion,
  world: WorldStateView,
  evidence: GoalCriterionEvidence,
): GoalCriteriaEvaluation {
  switch (criterion.type) {
    case 'inventory': {
      const item = criterion.item?.trim();
      const count = criterion.count ?? 1;
      if (!item || !isPositiveFinite(count)) return failed('inventory 字段非法，无法验证');
      const have = world.inventory.items
        .filter(entry => entry.name === item)
        .reduce((sum, entry) => sum + entry.count, 0);
      return have >= count ? passed() : failed(`背包 ${item} ${have}/${count}`);
    }
    case 'inventory_decrease': {
      const item = criterion.item?.trim();
      const count = criterion.count ?? 1;
      const from = criterion.from;
      if (!item || !isPositiveFinite(count) || typeof from !== 'number' || !Number.isFinite(from) || from < count) {
        return failed('inventory_decrease 字段非法，无法验证');
      }
      const have = world.inventory.items.filter(entry=>entry.name===item).reduce((sum,entry)=>sum+entry.count,0);
      const target = from - count;
      return have <= target ? passed() : failed(`背包 ${item} 尚未减少：${have} > ${target}（基线 ${from}）`);
    }
    case 'item_delivered': {
      const item=criterion.item?.trim();const count=criterion.count??1;const since=criterion.since;
      if(!item||!isPositiveFinite(count)||typeof since!=='number'||!Number.isFinite(since))return failed('item_delivered 字段非法，无法验证');
      const delivered=(evidence.deliveries??[]).filter(value=>value.item===item&&value.at>=since).reduce((sum,value)=>sum+value.count,0);
      return delivered>=count?passed():failed(`尚无 toss_item 成功证据：${item} ${delivered}/${count}`);
    }
    case 'item_deposited': {
      const item=criterion.item?.trim();const count=criterion.count??1;const since=criterion.since;
      if(!item||!isPositiveFinite(count)||typeof since!=='number'||!Number.isFinite(since))return failed('item_deposited 字段非法，无法验证');
      const deposited=(evidence.deposits??[]).filter(value=>value.item===item&&value.at>=since).reduce((sum,value)=>sum+value.count,0);
      return deposited>=count?passed():failed(`尚无 deposit 成功证据：${item} ${deposited}/${count}`);
    }
    case 'block_placed': {
      const item=criterion.item?.trim();const count=criterion.count??1;const since=criterion.since;
      const relation=canonicalPlacementRelation(criterion.relation);const radius=criterion.radius??1.5;
      if(!item||!isPositiveFinite(count)||typeof since!=='number'||!Number.isFinite(since)
        ||!relation||(criterion.relativeTo!=='owner'&&criterion.relativeTo!=='self')||!isPositiveFinite(radius))return failed('block_placed 字段非法，无法验证');
      const placed=(evidence.placements??[]).filter(value=>value.item===item&&value.at>=since
        &&value.relativeTo===criterion.relativeTo
        &&placementMatches(value,relation,radius)).reduce((sum,value)=>sum+value.count,0);
      return placed>=count?passed():failed(`尚无满足位置的放置成功证据：${item} ${placed}/${count}`);
    }
    case 'entity_dead': {
      const entityId = criterion.entityId?.trim();
      const entityName = criterion.entityName?.trim();
      if (!entityId && !entityName) return failed('entity_dead 缺少目标身份，无法验证');
      const alive = world.entities.some(entity =>
        (!!entityId && String(entity.id) === entityId)
        || (!!entityName && entity.name === entityName));
      return alive ? failed(`目标 ${entityName ?? entityId} 还活着`) : passed();
    }
    case 'reached': {
      const target = criterion.position
        ?? (criterion.relativeTo === 'owner' ? world.owner?.position : undefined);
      const radius = criterion.radius ?? 2;
      if (!target || !finitePosition(target) || !isPositiveFinite(radius)) {
        return failed('reached 字段非法，无法验证');
      }
      const self = world.self?.position;
      if (!self || !finitePosition(self)) return failed('自身位置缺失，无法验证 reached');
      const distance = Math.hypot(self.x - target.x, self.y - target.y, self.z - target.z);
      return distance <= radius ? passed() : failed(`距目标点 ${distance.toFixed(1)} > ${radius}`);
    }
    case 'predicate': {
      const verdict = evaluateRegisteredPredicate(criterion, world, evidence);
      return { ok: verdict.status === 'satisfied', detail: verdict.detail, evidenceRefs: verdict.evidenceRefs };
    }
    default:
      return failed(`不支持的判据类型：${String((criterion as { type?: unknown }).type)}`);
  }
}

function finitePosition(position: { x: number; y: number; z: number }): boolean {
  return [position.x, position.y, position.z].every(Number.isFinite);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function passed(): GoalCriteriaEvaluation {
  return { ok: true, detail: '' };
}

function failed(detail: string): GoalCriteriaEvaluation {
  return { ok: false, detail };
}

function criterionEvidenceRef(criterion: GoalSuccessCriterion): string {
  switch (criterion.type) {
    case 'inventory':
      return `criterion:inventory:${criterion.item ?? 'unknown'}:${criterion.count ?? 1}`;
    case 'inventory_decrease':
      return `criterion:inventory_decrease:${criterion.item ?? 'unknown'}:${criterion.count ?? 1}`;
    case 'item_delivered':
      return `criterion:item_delivered:${criterion.item ?? 'unknown'}:${criterion.count ?? 1}`;
    case 'item_deposited':
      return `criterion:item_deposited:${criterion.item ?? 'unknown'}:${criterion.count ?? 1}`;
    case 'block_placed':
      return `criterion:block_placed:${criterion.item ?? 'unknown'}:${criterion.count ?? 1}:${criterion.relation ?? 'near'}`;
    case 'entity_dead':
      return `criterion:entity_dead:${criterion.entityName ?? criterion.entityId ?? 'unknown'}`;
    case 'reached': {
      const position = criterion.position;
      return position
        ? `criterion:reached:${position.x},${position.y},${position.z}:${criterion.radius ?? 2}`
        : criterion.relativeTo === 'owner'
          ? `criterion:reached:owner:${criterion.radius ?? 2}`
        : 'criterion:reached:unknown';
    }
    case 'predicate':
      return `criterion:predicate:${criterion.predicate ?? 'unknown'}`;
    default:
      return `criterion:unknown:${String((criterion as { type?: unknown }).type)}`;
  }
}

function placementMatches(
  receipt: NonNullable<GoalCriterionEvidence['placements']>[number],
  relation: 'near'|'right'|'front'|'at',
  radius: number,
): boolean {
  const dx=receipt.position.x+0.5-receipt.referencePosition.x;
  const dy=receipt.position.y-receipt.referencePosition.y;
  const dz=receipt.position.z+0.5-receipt.referencePosition.z;
  if(Math.hypot(dx,dy,dz)>radius)return false;
  if(relation==='near'||relation==='at')return true;
  if(typeof receipt.referenceYaw!=='number'||!Number.isFinite(receipt.referenceYaw))return false;
  const forward={x:-Math.sin(receipt.referenceYaw),z:Math.cos(receipt.referenceYaw)};
  const axis=relation==='front'?forward:{x:-forward.z,z:forward.x};
  return dx*axis.x+dz*axis.z>0.25;
}

function canonicalPlacementRelation(value: unknown): 'near'|'right'|'front'|'at'|null {
  if (value === undefined || value === 'underfoot') return 'near';
  return value === 'near' || value === 'right' || value === 'front' || value === 'at'
    ? value
    : null;
}
