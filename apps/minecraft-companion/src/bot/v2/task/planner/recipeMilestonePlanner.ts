import type { InventoryView } from '../../types.js';
import {
  RecipeResolver,
  fuelBurnUnits,
  type RecipeDataSource,
  type ResolveStep,
} from '../../knowledge/recipeResolver.js';
import type { ColdStartPlannerPort, PlannedStep } from './planGraphBuilder.js';
import type { ContextSignature, GoalContract } from './plannerContracts.js';

export interface RecipeMilestoneKnowledge extends RecipeDataSource {
  isFacilityNearby?(facility: 'crafting_table' | 'furnace'): boolean;
}

/**
 * Turns versioned Minecraft recipe knowledge into machine-verifiable cold-start
 * milestones. It is deliberately stateless and never calls execution APIs.
 */
export class RecipeMilestonePlanner implements ColdStartPlannerPort {
  constructor(
    private readonly knowledge: RecipeMilestoneKnowledge,
    private readonly maxTransitions = 64,
  ) {}

  plan(goal: GoalContract, context: ContextSignature): PlannedStep[] | null {
    const target = targetItem(goal);
    if (!target) return null;
    const deliveryCriteria = structuredCriteria(goal).filter(value=>value.type==='item_delivered');
    if (deliveryCriteria.length > 0) return [{
      stage:`deliver:${target}`,
      goalText:goal.goalText,
      successCriteria:deliveryCriteria.map(value=>JSON.stringify(value)),
      structuredSuccessCriteria:structuredClone(deliveryCriteria),
    }];
    const count = targetCount(goal, target);
    const state = new PlanningState(this.knowledge, context, this.maxTransitions);
    if (!state.obtain(target, count)) return null;
    const steps = state.steps;
    if (steps.length === 0) {
      return [{
        stage:`complete:${target}`,
        goalText:goal.goalText,
        successCriteria:goal.successCriteria,
        structuredSuccessCriteria:rootCriteria(goal, target, count),
      }];
    }
    const final = steps.at(-1);
    if (final?.stage !== `complete:${target}` && final?.stage !== `obtain:${target}`) {
      steps.push(stepFor(target, count, goal.goalText, true));
    } else if (final) {
      final.stage = `complete:${target}`;
      final.goalText = goal.goalText;
      final.successCriteria = goal.successCriteria.length ? [...goal.successCriteria] : final.successCriteria;
      final.structuredSuccessCriteria = rootCriteria(goal, target, count);
    }
    return steps;
  }
}

class PlanningState {
  readonly steps: PlannedStep[] = [];
  private readonly inventory = new Map<string, number>();
  private readonly resolver: RecipeResolver;
  private readonly facilities = new Set<'crafting_table' | 'furnace'>();
  private transitions = 0;

  constructor(
    private readonly knowledge: RecipeMilestoneKnowledge,
    context: ContextSignature,
    private readonly maxTransitions: number,
  ) {
    for (const [name, count] of Object.entries(context.inventory)) {
      if (count > 0) this.inventory.set(normalize(name), Math.floor(count));
    }
    for (const facility of ['crafting_table', 'furnace'] as const) {
      if (context.nearbyFacilities.includes(facility) || knowledge.isFacilityNearby?.(facility)) {
        this.facilities.add(facility);
      }
    }
    this.resolver = new RecipeResolver(knowledge);
  }

  obtain(target: string, count: number): boolean {
    const normalizedTarget = normalize(target);
    const targetCount = Math.max(1, Math.floor(count));
    while (this.count(normalizedTarget) < targetCount) {
      if (++this.transitions > this.maxTransitions) return false;
      const next = this.resolver.nextStep(normalizedTarget, targetCount, this.view());
      if (next.kind === 'blocked') return false;
      if (next.kind === 'done') return true;
      if (!this.apply(next)) return false;
    }
    return true;
  }

  private apply(next: Exclude<ResolveStep, { kind:'done' | 'blocked' }>): boolean {
    if (next.kind === 'gather') {
      this.add(next.material, next.count);
      this.recordGather(next.material, this.count(next.material), next.requiredTool);
      return true;
    }
    if (next.kind === 'craft') {
      if (next.needTable && !this.facilities.has('crafting_table')) {
        if (!this.ensureFacility('crafting_table')) return false;
        return true;
      }
      if (!this.consumeAll(next.ingredients)) return false;
      this.add(next.item, next.producedCount);
      this.record(next.item, this.count(next.item));
      return true;
    }
    if (!this.facilities.has('furnace')) {
      if (!this.ensureFacility('furnace')) return false;
      return true;
    }
    if (!this.consume(next.input, next.count)) return false;
    const fuelCount = Math.max(1, Math.ceil(next.count / Math.max(0.25, fuelBurnUnits(next.fuel))));
    if (!this.consume(next.fuel, fuelCount)) return false;
    this.add(next.item, next.count);
    this.record(next.item, this.count(next.item));
    return true;
  }

  private ensureFacility(facility: 'crafting_table' | 'furnace'): boolean {
    if (this.facilities.has(facility)) return true;
    if (!this.obtain(facility, 1) || !this.consume(facility, 1)) return false;
    this.facilities.add(facility);
    return true;
  }

  private record(item: string, count: number): void {
    const normalized = normalize(item);
    this.steps.push(stepFor(normalized, count, `获得至少 ${count} 个 ${normalized}，作为后续任务依赖`));
  }

  private recordGather(item: string, count: number, requiredTool: string | null): void {
    const normalized = normalize(item);
    const sourceBlock = normalize(this.knowledge.getItemSource(normalized)?.block ?? normalized);
    const toolHint = requiredTool ? `；使用 ${normalize(requiredTool)} 或更高等级同类工具` : '';
    const goalText = `采集或挖掘附近的 ${sourceBlock}，直到背包中至少有 ${count} 个 ${normalized}${toolHint}`;
    this.steps.push(stepFor(normalized, count, goalText));
  }

  private consumeAll(ingredients: Array<{ name:string; count:number }>): boolean {
    if (ingredients.some(value => this.count(value.name) < value.count)) return false;
    for (const ingredient of ingredients) this.consume(ingredient.name, ingredient.count);
    return true;
  }

  private consume(name: string, count: number): boolean {
    const normalized = normalize(name);
    const have = this.count(normalized);
    if (have < count) return false;
    this.inventory.set(normalized, have - count);
    return true;
  }

  private add(name: string, count: number): void {
    const normalized = normalize(name);
    this.inventory.set(normalized, this.count(normalized) + Math.max(0, count));
  }

  private count(name: string): number { return this.inventory.get(normalize(name)) ?? 0; }

  private view(): InventoryView {
    return {
      items:[...this.inventory.entries()].filter(([, count]) => count > 0)
        .map(([name, count], slot) => ({ name, count, slot })),
      held:null,
      freeSlots:36,
    };
  }
}

function stepFor(item: string, count: number, goalText: string, final = false): PlannedStep {
  const criterion = { type:'inventory', item:normalize(item), count:Math.max(1, Math.floor(count)) };
  return {
    stage:`${final ? 'complete' : 'obtain'}:${criterion.item}`,
    goalText,
    successCriteria:[JSON.stringify(criterion)],
    structuredSuccessCriteria:[criterion],
  };
}

function targetItem(goal: GoalContract): string | null {
  const value = goal.metadata?.targetId;
  if (typeof value !== 'string' || !value.trim()) return null;
  return normalize(value);
}

function targetCount(goal: GoalContract, target: string): number {
  const criterion = rootCriteria(goal, target, 1)[0];
  return typeof criterion?.count === 'number' ? criterion.count : 1;
}

function rootCriteria(goal: GoalContract, target: string, fallbackCount: number): Array<Record<string, unknown>> {
  const values = structuredCriteria(goal);
  const matching = values.filter(value => value.type === 'inventory'
    && typeof value.item === 'string' && normalize(value.item) === normalize(target));
  return matching.length ? structuredClone(matching) : [{ type:'inventory', item:normalize(target), count:fallbackCount }];
}

function structuredCriteria(goal:GoalContract):Array<Record<string,unknown>> {
  return Array.isArray(goal.metadata?.structuredSuccessCriteria)
    ? goal.metadata.structuredSuccessCriteria.filter(isRecord)
    : [];
}

function normalize(value: string): string { return value.trim().toLowerCase().replace(/^minecraft:/, ''); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
