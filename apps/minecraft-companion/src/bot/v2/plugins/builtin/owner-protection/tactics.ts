import type { PluginActivityWorld } from '../../../plugin-sdk/contracts/execution.js';

export type Position = Readonly<{ x: number; y: number; z: number }>;

export type ProtectionConfig = Readonly<{
  loopIntervalMs: number;
  ownerProtectionFollowDistance: number;
  ownerProtectionThreatRadius: number;
  ownerProtectionEngagementRange: number;
  ownerProtectionAttackRange: number;
  ownerProtectionMoveCooldownMs: number;
  ownerProtectionMovementSliceMs: number;
  ownerProtectionFollowSliceMs: number;
  ownerProtectionHealthThreshold: number;
  ownerProtectionRecoveryCooldownMs: number;
  ownerProtectionLoadoutPickupRadius: number;
  ownerProtectionLoadoutRetryMs: number;
}>;

type Threat = Readonly<{ id: string | number; position: Position }>;
type LoadoutRecovery =
  | Readonly<{ kind: 'pickup'; itemName: string; position: Position }>
  | Readonly<{ kind: 'armor' }>
  | Readonly<{ kind: 'weapon'; itemName: string }>;

/**
 * The only policy authority for owner-protection.  It is deliberately pure:
 * observations enter here, one mutually exclusive tactical step leaves here,
 * and the activity is responsible only for submitting that step to the body.
 */
export type ProtectionStep =
  | Readonly<{ kind: 'wait_for_owner' }>
  | Readonly<{ kind: 'strike'; target: Threat }>
  | Readonly<{ kind: 'intercept'; target: Threat }>
  | Readonly<{ kind: 'self_recover' }>
  | Readonly<{ kind: 'loadout_recover'; recovery: LoadoutRecovery }>
  | Readonly<{ kind: 'follow'; entityId: number }>
  | Readonly<{ kind: 'wait' }>;

export function decideProtectionStep(
  world: PluginActivityWorld,
  config: ProtectionConfig,
  allowLoadoutRecovery: boolean,
): ProtectionStep {
  const owner = world.owner;
  if (!owner?.isVisible || !owner.position) return { kind: 'wait_for_owner' };

  // A protection-area threat owns this turn.  No pickup, armour or follow
  // branch may run ahead of it; that rule is structural instead of being an
  // exception scattered through the asynchronous activity loop.
  const threat = nearestThreatToOwner(world, owner.position, config.ownerProtectionThreatRadius);
  if (threat) {
    if (distance(world.self.position, threat.position) <= config.ownerProtectionAttackRange) {
      return { kind: 'strike', target: threat };
    }
    return { kind: 'intercept', target: threat };
  }

  if (world.self.health < config.ownerProtectionHealthThreshold) return { kind: 'self_recover' };
  if (allowLoadoutRecovery) {
    const recovery = selectLoadoutRecovery(world, config.ownerProtectionLoadoutPickupRadius);
    if (recovery) return { kind: 'loadout_recover', recovery };
  }
  if (distance(world.self.position, owner.position) > config.ownerProtectionFollowDistance) {
    // Follow targets the live entity instead of a point-in-time position.
    // A missing entity id is an observation gap: wait for the next snapshot
    // rather than creating a static coordinate fallback.
    if (owner.entityId != null) return { kind: 'follow', entityId: owner.entityId };
  }
  return { kind: 'wait' };
}

function nearestThreatToOwner(world: PluginActivityWorld, owner: Position, radius: number): Threat | null {
  const ranked = world.entities
    .filter(entity => entity.category === 'hostile' && distance(entity.position, owner) <= radius)
    .map(entity => ({ entity, ownerDistance: distance(entity.position, owner), selfDistance: distance(entity.position, world.self.position) }))
    .sort((left, right) => left.ownerDistance - right.ownerDistance
      || left.selfDistance - right.selfDistance
      || String(left.entity.id).localeCompare(String(right.entity.id)));
  const nearest = ranked[0]?.entity;
  return nearest ? { id: nearest.id, position: nearest.position } : null;
}

function selectLoadoutRecovery(world: PluginActivityWorld, pickupRadius: number): LoadoutRecovery | null {
  const weapon = strongestMeleeWeapon(world);
  const missingArmor = armorNeedsUpgrade(world);
  const held = world.inventory.held?.name ?? null;
  const wantedDrops = world.entities
    .filter(entity => entity.category === 'item' && entity.droppedItem && entity.distance <= pickupRadius)
    .filter(entity => entity.droppedItem && improvesLoadout(world, entity.droppedItem.name))
    .sort((left, right) => left.distance - right.distance);
  const drop = wantedDrops[0];
  if (drop?.droppedItem) return { kind: 'pickup', itemName: drop.droppedItem.name, position: drop.position };
  if (missingArmor && hasArmorInInventory(world)) return { kind: 'armor' };
  if (weapon && held !== weapon) return { kind: 'weapon', itemName: weapon };
  return null;
}

function strongestMeleeWeapon(world: PluginActivityWorld): string | null {
  const candidates = world.inventory.items
    .filter(item => item.count > 0)
    .map(item => ({ name: item.name, score: meleeScore(item.name) }))
    .filter(item => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return candidates[0]?.name ?? null;
}

function hasArmorInInventory(world: PluginActivityWorld): boolean {
  return world.inventory.items.some(item => armorSlot(item.name) !== null);
}

function armorNeedsUpgrade(world: PluginActivityWorld): boolean {
  return (['head', 'torso', 'legs', 'feet'] as const).some(slot => {
    const worn = world.inventory.armor[slot]?.name ?? null;
    const best = world.inventory.items
      .filter(item => armorSlot(item.name) === slot)
      .reduce((score, item) => Math.max(score, armorScore(item.name)), -1);
    return best > armorScore(worn);
  });
}

function improvesLoadout(world: PluginActivityWorld, itemName: string): boolean {
  const weaponScore = meleeScore(itemName);
  if (weaponScore >= 0) return weaponScore > meleeScore(strongestMeleeWeapon(world));
  const slot = armorSlot(itemName);
  return slot !== null && armorScore(itemName) > armorScore(world.inventory.armor[slot]?.name ?? null);
}

function meleeScore(itemName: string | null): number {
  const score: Readonly<Record<string, number>> = {
    netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7,
    netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4,
  };
  return itemName ? (score[itemName] ?? -1) : -1;
}

function armorSlot(itemName: string): 'head' | 'torso' | 'legs' | 'feet' | null {
  if (itemName.endsWith('_helmet')) return 'head';
  if (itemName.endsWith('_chestplate')) return 'torso';
  if (itemName.endsWith('_leggings')) return 'legs';
  if (itemName.endsWith('_boots')) return 'feet';
  return null;
}

function armorScore(itemName: string | null): number {
  if (!itemName) return -1;
  if (itemName.startsWith('netherite_')) return 5;
  if (itemName.startsWith('diamond_')) return 4;
  if (itemName.startsWith('iron_')) return 3;
  if (itemName.startsWith('chainmail_')) return 2;
  if (itemName.startsWith('golden_') || itemName.startsWith('leather_')) return 1;
  return -1;
}

function distance(left: Position, right: Position): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
