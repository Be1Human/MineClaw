/**
 * One authoritative Minecraft entity taxonomy for V2 perception consumers.
 *
 * Adapter-provided `type: hostile` is the primary fact: it also covers
 * server-added hostile entities without a MineClaw release.  The vanilla
 * registry below is a fallback for adapters which expose every creature as
 * `mob` (the shape used by several test and replay adapters).
 */
import type { RawEntity } from '../../adapter/types.js';
import type { EntityView } from '../types.js';

export type EntityCategory = EntityView['category'];

/** All combat-capable vanilla hostile living entities supported by the server protocol. */
export const VANILLA_HOSTILE_ENTITY_NAMES = Object.freeze([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creeper', 'drowned',
  'elder_guardian', 'enderman', 'endermite', 'evoker', 'ghast', 'giant',
  'guardian', 'hoglin', 'husk', 'illusioner', 'magma_cube', 'phantom',
  'piglin', 'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish',
  'skeleton', 'slime', 'stray', 'vex', 'vindicator', 'warden', 'witch',
  'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager',
  'zombified_piglin',
] as const);

const HOSTILE_NAMES = new Set<string>(VANILLA_HOSTILE_ENTITY_NAMES);
const PASSIVE_NAMES = new Set([
  'allay', 'axolotl', 'bat', 'camel', 'cat', 'chicken', 'cod', 'cow',
  'donkey', 'fox', 'frog', 'glow_squid', 'goat', 'horse', 'llama', 'mooshroom',
  'mule', 'ocelot', 'panda', 'parrot', 'pig', 'polar_bear', 'pufferfish',
  'rabbit', 'salmon', 'sheep', 'sniffer', 'snow_golem', 'squid', 'strider',
  'tadpole', 'trader_llama', 'tropical_fish', 'turtle', 'villager', 'wandering_trader',
]);
const NEUTRAL_NAMES = new Set([
  'bee', 'dolphin', 'goat', 'iron_golem', 'llama', 'panda', 'piglin',
  'polar_bear', 'spider', 'wolf', 'zombified_piglin',
]);

/** Classify a raw entity once; all upper layers must consume this category. */
export function categorizeEntity(entity: RawEntity): EntityCategory {
  const type = normalizeEntityId(entity.type);
  if (type === 'player') return 'player';
  if (entity.droppedItem || type === 'item') return 'item';

  // Mineflayer identifies every living enemy with this type, including
  // variants such as drowned. Trust that adapter fact before name fallbacks.
  if (type === 'hostile' || isHostileEntityName(entity.name)) return 'hostile';

  const name = normalizeEntityId(entity.name);
  if (PASSIVE_NAMES.has(name)) return 'passive';
  if (NEUTRAL_NAMES.has(name)) return 'neutral';
  return 'other';
}

/** Shared by perception and atomic safety checks; never duplicate enemy lists. */
export function isHostileEntityName(name: string): boolean {
  return HOSTILE_NAMES.has(normalizeEntityId(name));
}

function normalizeEntityId(value: string): string {
  return value.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
}
