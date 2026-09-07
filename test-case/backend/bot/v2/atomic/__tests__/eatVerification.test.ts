import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATOM_VERIFIERS } from '../../../../../../apps/minecraft-companion/src/bot/v2/atomic/verifiers.js';
import type { GameView } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function game(state: { food: number; health: number; goldenApples: number }): GameView {
  return {
    getFood: () => state.food,
    getHealth: () => state.health,
    getInventoryItems: () => state.goldenApples > 0 ? [{ name: 'golden_apple', count: state.goldenApples, slot: 0 }] : [],
  } as unknown as GameView;
}

const request: ActionRequest = {
  id: 'eat-emergency', source: 'test', type: 'eat', priority: 1, interrupt_level: 'soft', resource: [],
  target: { emergency: true }, preconditions: [], timeout_ms: 1_000,
};

test('emergency eat at full hunger requires physical consumption instead of auto-passing', () => {
  const verifier = ATOM_VERIFIERS.eat!;
  const state = { food: 20, health: 10, goldenApples: 1 };
  const before = verifier.snapshot!(request, game(state));
  assert.equal(verifier.verify(request, game(state), before).status, 'fail');

  state.goldenApples = 0;
  assert.equal(verifier.verify(request, game(state), before).status, 'pass');
});
