/**
 * EscapeStrategy · FEAT-CROSS-05 单测
 *
 * 证明两件事（不连服、确定性）：
 *   1. inPit 修正：走廊/关门方向能走出去 → 不是坑（根治迷宫误判）；四向全封死 → 真坑。
 *   2. 显式化：检测到真坑 → createTask('escape_pit') + startEmergency（注册紧急任务，不再直发请求）；
 *      驱动时发带 taskId 的 escape_pit 请求；脱困成功 → complete。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscapeStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/pitEscapeStrategy.js';

type Blk = { name: string; boundingBox: 'block' | 'empty' } | null;

/** 用一张 {x,y,z}->block 的图模拟世界 */
function makeGame(blocks: Record<string, Blk>) {
  return {
    getBlockAt: (p: { x: number; y: number; z: number }): Blk =>
      blocks[`${p.x},${p.y},${p.z}`] ?? { name: 'air', boundingBox: 'empty' },
  } as never;
}

function makeTasks() {
  const calls = { created: [] as string[], started: [] as string[], completed: [] as string[], failed: [] as string[] };
  let seq = 0;
  const tasks = {
    createTask: (kind: string) => { const id = `t${++seq}`; calls.created.push(`${kind}:${id}`); return { id, kind }; },
    startEmergency: (id: string) => { calls.started.push(id); return { ok: true }; },
    complete: (id: string) => { calls.completed.push(id); },
    fail: (id: string) => { calls.failed.push(id); },
  } as never;
  return { tasks, calls };
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    tick: 100,
    activeTaskId: null,
    activeTaskKind: null,
    activeTaskParams: null,
    world: { self: { position: { x: 0, y: 0, z: 0 }, isOnGround: true } },
    narrate: () => {},
    setPhase: () => {},
    ...over,
  } as never;
}

const STONE: Blk = { name: 'stone', boundingBox: 'block' };
const AIR: Blk = { name: 'air', boundingBox: 'empty' };
const DOOR: Blk = { name: 'oak_door', boundingBox: 'block' };

/** 四面脚位与头位均封死 + 脚下地面 = 真坑（只有一格墙属于可迈出的浅坑） */
function pitBlocks(): Record<string, Blk> {
  const b: Record<string, Blk> = {};
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    b[`${dx},0,${dz}`] = STONE;       // 脚位墙
    b[`${dx},1,${dz}`] = STONE;       // 头位墙
    b[`${dx},-1,${dz}`] = STONE;      // 地面
  }
  b['0,-1,0'] = STONE;
  return b;
}

function drive(strat: EscapeStrategy, game: never, tasks: never, blocks: Record<string, Blk>, ticks: number, activeId: string) {
  // 持续 tick 把它从"卡住计数"推到触发
  let last: unknown[] = [];
  for (let i = 0; i < ticks; i++) {
    last = strat.tick(ctx({ tick: 100 + i, activeTaskId: i >= 16 ? activeId : null, activeTaskKind: i >= 16 ? 'escape_pit' : null })) as unknown[];
  }
  return last;
}

test('inPit 修正 · 走廊（前后可走）→ 不是坑 · 卡再久也不起脱困任务', () => {
  // 走廊沿 x：+x/-x 脚位空+地面实心（可走），z 两侧是墙
  const b: Record<string, Blk> = { '0,-1,0': STONE };
  b['1,0,0'] = AIR;  b['1,-1,0'] = STONE;     // +x 能走出去
  b['-1,0,0'] = AIR; b['-1,-1,0'] = STONE;    // -x 能走出去
  b['0,0,1'] = STONE; b['0,0,-1'] = STONE;    // z 两侧墙
  const game = makeGame(b);
  const { tasks, calls } = makeTasks();
  const s = new EscapeStrategy(game, tasks);
  for (let i = 0; i < 30; i++) s.tick(ctx({ tick: 100 + i }));  // 一直站着不动
  assert.equal(calls.created.length, 0, '走廊不该起脱困任务');
});

test('inPit 修正 · 关门方向算"能出去" → 不是坑', () => {
  const b: Record<string, Blk> = { '0,-1,0': STONE };
  b['1,0,0'] = DOOR; b['1,-1,0'] = STONE;     // +x 是关着的门（可开）
  b['-1,0,0'] = STONE; b['0,0,1'] = STONE; b['0,0,-1'] = STONE; // 其余墙
  const game = makeGame(b);
  const { tasks, calls } = makeTasks();
  const s = new EscapeStrategy(game, tasks);
  for (let i = 0; i < 30; i++) s.tick(ctx({ tick: 100 + i }));
  assert.equal(calls.created.length, 0, '门方向能出去 → 不该判坑');
});

test('inPit 修正 · 一格浅坑可 step-up → 不起脱困任务', () => {
  const b: Record<string, Blk> = { '0,-1,0': STONE };
  b['1,0,0'] = STONE; b['1,1,0'] = AIR; b['1,2,0'] = AIR;
  b['-1,0,0'] = STONE; b['-1,1,0'] = STONE;
  b['0,0,1'] = STONE; b['0,1,1'] = STONE;
  b['0,0,-1'] = STONE; b['0,1,-1'] = STONE;
  const game = makeGame(b);
  const { tasks, calls } = makeTasks();
  const s = new EscapeStrategy(game, tasks);
  for (let i = 0; i < 30; i++) s.tick(ctx({ tick: 100 + i }));
  assert.equal(calls.created.length, 0, '一格台阶可迈出，不应判真坑');
});

test('真坑（四向全封死）· 卡够久 → 注册 escape_pit 紧急任务 + startEmergency', () => {
  const game = makeGame(pitBlocks());
  const { tasks, calls } = makeTasks();
  const s = new EscapeStrategy(game, tasks);
  // 站着不动累计 stuck（STUCK_TICKS=14）
  for (let i = 0; i < 20; i++) s.tick(ctx({ tick: 100 + i }));
  assert.equal(calls.created.length, 1, '真坑应注册 1 个紧急任务');
  assert.ok(calls.created[0].startsWith('escape_pit:'), `应是 escape_pit，实际 ${calls.created[0]}`);
  assert.equal(calls.started.length, 1, '应调 startEmergency 抢占');
});

test('驱动 · escape_pit 任务 active → 发带 taskId 的请求；脱困成功 → complete', () => {
  const game = makeGame(pitBlocks());
  const { tasks, calls } = makeTasks();
  const s = new EscapeStrategy(game, tasks);
  // 推到注册（前 ~16 tick 检测，之后任务 active）
  let reqs: unknown[] = [];
  for (let i = 0; i < 18; i++) {
    const active = calls.created.length > 0;
    const id = active ? calls.created[0].split(':')[1] : null;
    reqs = s.tick(ctx({ tick: 100 + i, activeTaskId: id, activeTaskKind: id ? 'escape_pit' : null })) as unknown[];
  }
  // 此时任务 active 且仍在坑里 → 应发 escape_pit 请求带 taskId
  const id = calls.created[0].split(':')[1];
  const r = s.tick(ctx({ tick: 200, activeTaskId: id, activeTaskKind: 'escape_pit' })) as Array<{ type: string; taskId?: string }>;
  assert.ok(r.length >= 1 && r[0].type === 'escape_pit', '应发 escape_pit 请求');
  assert.equal(r[0].taskId, id, '请求必须带 taskId 背书');

  // 脱困成功（不再在坑里：把 +x 脚位变空+地面）→ complete
  (game as { getBlockAt: (p: { x: number; y: number; z: number }) => Blk }).getBlockAt = (p) => {
    if (p.x === 1 && p.y === 0 && p.z === 0) return AIR;
    if (p.x === 1 && p.y === 1 && p.z === 0) return AIR;
    if (p.x === 1 && p.y === -1 && p.z === 0) return STONE;
    return pitBlocks()[`${p.x},${p.y},${p.z}`] ?? AIR;
  };
  s.tick(ctx({ tick: 201, activeTaskId: id, activeTaskKind: 'escape_pit' }));
  assert.deepEqual(calls.completed, [id], '脱困成功应 complete 紧急任务（触发自动恢复原任务）');
});

test('高优反射抢占后，恢复中的 lava_escape 被重新认领，不重复注册紧急任务', () => {
  const b: Record<string, Blk> = {
    '0,0,0': { name: 'lava', boundingBox: 'empty' },
    '1,0,0': AIR,
    '1,-1,0': STONE,
  };
  const game = makeGame(b);
  const { tasks, calls } = makeTasks();
  const s = new EscapeStrategy(game, tasks);

  s.tick(ctx({ tick: 100 }));
  const id = calls.created[0].split(':')[1];
  assert.equal(calls.created.length, 1);

  // 反射任务抢占期间，原 escape 任务不再是 active；策略不应新建任务。
  s.tick(ctx({ tick: 101, activeTaskId: 'reflex-1', activeTaskKind: 'reflex_react' }));
  assert.equal(calls.created.length, 1);

  // 抢占者结束后，TaskRuntime 恢复原任务。策略必须继续驱动原 id。
  const requests = s.tick(ctx({ tick: 102, activeTaskId: id, activeTaskKind: 'lava_escape' })) as Array<{ taskId?: string; type: string }>;
  assert.equal(calls.created.length, 1, '不得重复注册 lava_escape');
  assert.equal(requests[0]?.type, 'walk');
  assert.equal(requests[0]?.taskId, id);
});
