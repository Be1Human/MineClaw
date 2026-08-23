import assert from 'node:assert/strict';
import test from 'node:test';

import { TASKS, type Ctx } from '../../../../benchmark/engineering/experience/tasks.js';

const scenario = TASKS.find(task => task.id === 'T27');
if (!scenario) throw new Error('T27 is missing');

function context(input: {
  coal?: number;
  remaining?: number;
  died?: boolean;
} = {}): { ctx: Ctx; commands: string[] } {
  const commands: string[] = [];
  const coalVein = Array.from({ length: 6 }, (_, index) => ({ x: 2016, y: index < 3 ? -60 : -59, z: 7 + (index % 3) }));
  const remaining = input.remaining ?? 6;
  const ctx: Ctx = {
    cmd: async command => { commands.push(command); return ''; },
    say: async () => {},
    botName: 'LanYi',
    X: 2000,
    botPos: async () => ({ x: 2000, y: -60, z: 0 }),
    botFood: async () => 20,
    botHealth: async () => 20,
    botInv: async () => ({ ...(input.coal ? { coal: input.coal } : {}), stone_pickaxe: 1 }),
    chestItems: async () => ({}),
    isBlock: async (x, y, z, block) => block === 'minecraft:coal_ore'
      && coalVein.slice(0, remaining).some(value => value.x === x && value.y === y && value.z === z),
    countEntities: async () => 0,
    findBlocks: async () => [],
    daytime: async () => 1000,
    botDied: () => input.died ?? false,
    elapsed: () => 0,
    botMessages: () => [],
    botSaid: () => false,
    log: () => {},
    state: { coalVein },
  };
  return { ctx, commands };
}

test('T27 是无坐标的正式矿洞搜索采集 Case', () => {
  assert.equal(scenario.layer ?? 'experience', 'experience');
  assert.equal(scenario.expectedTerminal, 'success');
  assert.match(scenario.instruction, /找找.*煤矿.*收集四块煤/u);
  assert.doesNotMatch(scenario.instruction, /-?\d+\s*[,， ]\s*-?\d+/u);
  assert.deepEqual(scenario.ownerPos, { dx: 1, dz: 1 });
});

test('T27 setup 固化转角矿洞、六块煤矿脉和无煤石镐初态', async () => {
  const { ctx, commands } = context();
  ctx.state = {};
  await scenario.setup(ctx);

  const firstSetup = [...commands];
  commands.length = 0;
  await scenario.setup(ctx);

  assert.equal((ctx.state.coalVein as unknown[]).length, 6);
  assert.equal(commands.filter(command => /setblock .* minecraft:coal_ore$/u.test(command)).length, 6);
  assert.ok(commands.includes('clear LanYi minecraft:coal'));
  assert.ok(commands.includes('give LanYi minecraft:stone_pickaxe 1'));
  assert.equal(commands.some(command => /gold_block|yellow_concrete/u.test(command)), false);
  assert.deepEqual(commands, firstSetup, '连续 setup 必须得到相同场景命令');
});

test('T27 Judge 必须同时满足矿脉减少、煤入背包和存活', async () => {
  assert.equal((await scenario.judge(context({ coal: 4, remaining: 2 }).ctx)).pass, true);
  assert.equal((await scenario.judge(context({ coal: 4, remaining: 6 }).ctx)).pass, false, '只注入煤不得通过');
  assert.equal((await scenario.judge(context({ coal: 0, remaining: 2 }).ctx)).pass, false, '只挖矿未拾取不得通过');
  assert.equal((await scenario.judge(context({ coal: 4, remaining: 2, died: true }).ctx)).pass, false, '死亡不得通过');
});

test('T27 cleanup 清理掉落物、洞体并恢复地面', async () => {
  const { ctx, commands } = context();
  await scenario.cleanup?.(ctx);
  const firstCleanup = [...commands];
  commands.length = 0;
  await scenario.cleanup?.(ctx);
  assert.equal(commands.some(command => command.startsWith('kill @e[type=minecraft:item')), true);
  assert.equal(commands.some(command => command.endsWith('minecraft:air')), true);
  assert.equal(commands.some(command => command.endsWith('minecraft:grass_block')), true);
  assert.deepEqual(commands, firstCleanup, '连续 cleanup 必须保持幂等');
});
