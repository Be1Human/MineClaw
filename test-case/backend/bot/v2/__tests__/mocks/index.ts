export { MockWorld } from './mockWorld.js';
export { MockGameAdapter } from './mockGameAdapter.js';
export { MockNavigationAdapter } from './mockNavAdapter.js';

import { MockWorld } from './mockWorld.js';
import { MockGameAdapter } from './mockGameAdapter.js';
import { MockNavigationAdapter } from './mockNavAdapter.js';

export interface MockBot {
  world: MockWorld;
  game: MockGameAdapter;
  nav: MockNavigationAdapter;
}

export function createMockBot(): MockBot {
  const world = new MockWorld();
  const game = new MockGameAdapter(world);
  const nav = new MockNavigationAdapter();
  return { world, game, nav };
}
