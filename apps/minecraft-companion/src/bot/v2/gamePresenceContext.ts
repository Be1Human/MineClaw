import type { WorldStateView } from './types.js';

export type OwnerObservationState = 'observed' | 'not_observed' | 'unknown';

export interface GamePresenceState {
  embodied: boolean;
  ownerObservation: OwnerObservationState;
}

/**
 * Separate the bot's body connection from whether the configured player is
 * visible in the latest world snapshot. These are independent facts.
 */
export function gamePresenceFromWorld(
  embodied: boolean,
  world: Pick<WorldStateView, 'owner'> | null | undefined,
): GamePresenceState {
  if (!embodied) return { embodied: false, ownerObservation: 'unknown' };
  if (!world) return { embodied: true, ownerObservation: 'unknown' };
  return {
    embodied: true,
    ownerObservation: world.owner ? 'observed' : 'not_observed',
  };
}

/** Machine-fact prompt shared by MainBrain and GoalAgent. */
export function buildGamePresenceContext(state: GamePresenceState): string {
  if (!state.embodied) {
    return [
      'MinecraftBodyState=unembodied.',
      'You are an AI player with Minecraft capabilities, but your game body is not currently connected to or observing a live Minecraft world.',
      'An offline or empty world snapshot describes your unavailable game body; it does not prove the configured player is offline.',
    ].join(' ');
  }

  const ownerFact = state.ownerObservation === 'observed'
    ? 'The configured player is currently observed in the fresh world snapshot.'
    : state.ownerObservation === 'not_observed'
      ? 'The configured player is not currently observed or tracked; owner=null does not prove the player is offline.'
      : 'The configured player observation state is not yet known; do not infer that the player is offline.';

  return [
    'You are an embodied AI player operating inside a live Minecraft game world.',
    ownerFact,
    'Use fresh world observations for player, inventory, position, and nearby-entity facts.',
  ].join(' ');
}
