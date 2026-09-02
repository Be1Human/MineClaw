import type { GameAdapter } from '../../../adapter/GameAdapter.js';
import type { Vec3 } from '../../../adapter/types.js';
import type { ChestTarget } from '../../task/goalAgent/production/containerTargetResolver.js';
import type { GoalAgentActionCandidate } from '../../task/goalAgent/ports/executionPort.js';
import type { WorldStateView } from '../../types.js';
import type { CapabilityManifestDefinition, CapabilityPackageDefinition } from '../types.js';
import { HarvestMatureCropsToChestBehavior } from './harvestToChestBehavior.js';
import { HarvestWorldFactProvider } from './harvestWorldFactProvider.js';

const PREDICATE_ID = 'agriculture.harvest_to_chest';

interface HarvestRunBaseline {
  initialMature: number;
  cropEvidenceRef: string;
  chestPos?: Vec3;
}

class HarvestRunLedger {
  private readonly baselines = new Map<number, HarvestRunBaseline>();

  ensure(since: number, initialMature: number, cropEvidenceRef: string): HarvestRunBaseline {
    const existing = this.baselines.get(since);
    if (existing) return existing;
    const created = { initialMature, cropEvidenceRef };
    this.baselines.set(since, created);
    return created;
  }

  bindChest(since: number, chestPos: Vec3): void {
    const baseline = this.baselines.get(since);
    if (baseline) baseline.chestPos = structuredClone(chestPos);
  }

  get(since: number): HarvestRunBaseline | null {
    return this.baselines.get(since) ?? null;
  }
}

export function createAgricultureCapabilityPackage(input: {
  game: GameAdapter;
  manifest: CapabilityManifestDefinition;
  resolveChestTargets: (requestText: string, world: WorldStateView) => ChestTarget[];
}): CapabilityPackageDefinition {
  const facts = new HarvestWorldFactProvider(input.game);
  const ledger = new HarvestRunLedger();
  const behaviors = [new HarvestMatureCropsToChestBehavior(facts)];
  return {
    manifest: input.manifest,
    behaviors,
    worldFactProviders: [facts],
    actionProviders: [{
      id: 'agriculture.harvest_action_candidates',
      list: ({ criteria, goalText, world, signal }) => {
        const criterion = criteria.find(value => value.type === 'predicate' && value.predicate === PREDICATE_ID);
        if (!criterion || typeof criterion.since !== 'number' || !Number.isFinite(criterion.since)) return [];
        const fact = facts.observe({ world, signal });
        if (!fact.complete || fact.truncated) return [];
        ledger.ensure(
          criterion.since,
          fact.value.matureCrops.length,
          fact.value.matureCrops[0]?.evidenceRef ?? fact.evidenceRefs[0]!,
        );
        if (fact.value.matureCrops.length === 0) return [];
        const chestTargets = input.resolveChestTargets(goalText, world);
        if (chestTargets.length === 0) return [];
        const target = chestTargets[0]!;
        ledger.bindChest(criterion.since, target.pos);
        return [behaviorCandidate(
          'harvest_mature_crops_to_chest',
          `Harvest all ${fact.value.matureCrops.length} visible mature wheat, collect drops, and store them in the ${target.relation} chest`,
          {
            chestPos: target.pos,
            radius: 32,
            cropLimit: 128,
            dropLimit: 128,
            maxHarvestActions: 256,
            maxPickupActions: 256,
          },
          [...fact.evidenceRefs, `container-target:${target.relation}:${positionKey(target.pos)}`],
        )];
      },
    }],
    predicateEvaluators: [{
      id: PREDICATE_ID,
      evaluate: ({ criterion, world, evidence }) => {
        const since = criterion.since;
        if (typeof since !== 'number' || !Number.isFinite(since)) return failed('harvest criterion missing acceptedAt baseline');
        const baseline = ledger.get(since);
        if (!baseline || baseline.initialMature < 1) return failed('no mature crop baseline was observed');
        if (!baseline.chestPos) return failed('harvest destination chest has not been bound');
        const fact = facts.observe({ world });
        if (!fact.complete || fact.truncated) return failed('harvest world fact is truncated');
        if (fact.value.matureCrops.length > 0) return failed(`${fact.value.matureCrops.length} mature crops remain`);
        if (fact.value.groundDrops.length > 0) return failed(`${fact.value.groundDrops.length} harvest drops remain`);
        if (fact.value.inventory.wheat > 0 || fact.value.inventory.wheat_seeds > 0) {
          return failed(`harvest items remain in inventory: wheat=${fact.value.inventory.wheat}, seeds=${fact.value.inventory.wheat_seeds}`);
        }
        const relevant = (evidence.deposits ?? []).filter(receipt =>
          receipt.at >= since && samePosition(receipt.position, baseline.chestPos!));
        const wheat = relevant.filter(value => value.item === 'wheat').reduce((sum, value) => sum + value.count, 0);
        const seeds = relevant.filter(value => value.item === 'wheat_seeds').reduce((sum, value) => sum + value.count, 0);
        if (wheat < baseline.initialMature) return failed(`deposited wheat ${wheat}/${baseline.initialMature}`);
        if (seeds < 1) return failed('no wheat seeds were deposited');
        return {
          ok: true,
          detail: `mature=0,drops=0,inventory=0,deposited_wheat=${wheat},deposited_seeds=${seeds}`,
          evidenceRefs: [
            baseline.cropEvidenceRef,
            `criterion:${PREDICATE_ID}:mature=0`,
            `criterion:${PREDICATE_ID}:deposited_wheat=${wheat}`,
            `criterion:${PREDICATE_ID}:deposited_seeds=${seeds}`,
            `criterion:${PREDICATE_ID}:residue=0`,
          ],
        };
      },
    }],
  };
}

function behaviorCandidate(
  behavior: string,
  description: string,
  behaviorParams: Record<string, unknown>,
  evidenceRefs: readonly string[],
): GoalAgentActionCandidate {
  return {
    id: `behavior:${behavior}`,
    kind: 'behavior',
    source: 'registered_behavior',
    action: 'invoke_behavior',
    description,
    fixedArgs: { behavior, behaviorParams },
    evidenceRefs: [...evidenceRefs],
  };
}

function failed(detail: string) {
  return { ok: false, detail };
}

function samePosition(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(value: Vec3): string {
  return `${value.x}:${value.y}:${value.z}`;
}
