import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGamePresenceContext,
  gamePresenceFromWorld,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/gamePresenceContext.js';

describe('BUG-CROSS-82 · game presence context', () => {
  it('unembodied describes the bot body and does not infer player offline', () => {
    const state = gamePresenceFromWorld(false, { owner: null });
    assert.deepEqual(state, { embodied: false, ownerObservation: 'unknown' });
    const context = buildGamePresenceContext(state);
    assert.match(context, /MinecraftBodyState=unembodied/);
    assert.match(context, /your game body is not currently connected/);
    assert.match(context, /does not prove the configured player is offline/);
    assert.doesNotMatch(context, /^You are an embodied AI player/);
  });

  it('embodied owner=null means not observed rather than offline', () => {
    const state = gamePresenceFromWorld(true, { owner: null });
    assert.deepEqual(state, { embodied: true, ownerObservation: 'not_observed' });
    const context = buildGamePresenceContext(state);
    assert.match(context, /^You are an embodied AI player operating inside a live Minecraft game world/);
    assert.match(context, /owner=null does not prove the player is offline/);
  });

  it('embodied owner data records an observed player', () => {
    const state = gamePresenceFromWorld(true, { owner: {} as never });
    assert.deepEqual(state, { embodied: true, ownerObservation: 'observed' });
    assert.match(buildGamePresenceContext(state), /player is currently observed/);
  });
});
