#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalRcon } from './local-rcon.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..', '..');
const botId = '515bba55-5241-415f-8917-b2a6af4179a8';
const botName = 'X';
const hubUrl = 'http://127.0.0.1:3001';
const serverDir = resolve(repoRoot, 'mc-server');
const instruction = '请在斗兽场内处理掉一只正在移动的僵尸。你现在生命值和饱食度都很低，请先与僵尸保持安全距离，吃面包补充饱食度并等待自然回血，再使用石剑击杀它。保护好自己，不要破坏斗兽场方块，只按实际结果报告。';
const samples = [
  [45, -60, 15, 'stone_bricks'], [45, -60, 29, 'stone_bricks'],
  [59, -60, 15, 'stone_bricks'], [59, -60, 29, 'stone_bricks'],
  [45, -59, 16, 'stone_bricks'], [59, -59, 28, 'stone_bricks'],
  [52, -60, 21, 'chiseled_stone_bricks'], [52, -60, 22, 'chiseled_stone_bricks'],
];

const runId = `combat-low-health-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const evidencePath = resolve(repoRoot, 'benchmark', 'reports', 'capability', 'combat-survival', `${runId}.jsonl`);
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, '');
const record = (type, payload = {}) => appendFileSync(evidencePath, `${JSON.stringify({ at: new Date().toISOString(), type, ...payload })}\n`);
const rcon = commands => executeLocalRcon({ serverDir, commands });
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

try {
  await postJson(`${hubUrl}/api/bots/${botId}/tasks/cancel-active`, { reason: 'low_health_formal_reset' });
  const baseline = await getStatus();
  const baselineRuns = new Set(goalExec(baseline).map(task => task.planRunId).filter(Boolean));
  record('baseline', { status: summarize(baseline), baselineRuns: [...baselineRuns] });

  const setup = await rcon([
    'kill @e[tag=mineclaw_test]',
    'gamerule doMobSpawning false',
    'gamerule doDaylightCycle false',
    'gamerule doWeatherCycle false',
    'gamerule keepInventory true',
    'gamerule naturalRegeneration false',
    'time set day',
    'weather clear',
    `gamemode adventure ${botName}`,
    `tp ${botName} 48.5 -60 22.5`,
    `effect clear ${botName}`,
    `attribute ${botName} minecraft:generic.max_health base set 20`,
    `effect give ${botName} minecraft:instant_health 1 10 true`,
    `effect give ${botName} minecraft:hunger 20 100 true`,
  ]);
  record('setup_started', { responses: setup });
  const hungerDeadline = Date.now() + 15_000;
  let hungerStatus = await getStatus();
  while (Date.now() < hungerDeadline && hungerStatus.world.self.food > 8) {
    await delay(100);
    hungerStatus = await getStatus();
  }
  if (hungerStatus.world.self.food > 8 || hungerStatus.world.self.food <= 0) {
    throw new Error(`controlled hunger precondition missing: food=${hungerStatus.world.self.food}`);
  }
  const lowHealthSetup = await rcon([
    `effect clear ${botName} minecraft:hunger`,
    `attribute ${botName} minecraft:generic.max_health base set 6`,
  ]);
  await delay(500);
  const frozenSetup = await rcon([
    `attribute ${botName} minecraft:generic.max_health base set 20`,
    `give ${botName} minecraft:stone_sword 1`,
    `give ${botName} minecraft:bread 8`,
    `execute at ${botName} run summon minecraft:zombie ~8 ~ ~ {Tags:["mineclaw_test"],NoAI:1b,Invulnerable:1b,Silent:1b,PersistenceRequired:1b,CanPickUpLoot:0b,Health:20.0f}`,
  ]);
  await delay(500);
  const staged = await getStatus();
  const beforeBlocks = await sampleBlocks();
  record('scenario_frozen', { responses: [...lowHealthSetup, ...frozenSetup], status: summarize(staged), blocks: beforeBlocks });
  if (staged.automaticDefenseEnabled !== false) throw new Error('automatic defense must be disabled for active combat attribution');
  if (staged.world.self.health > 8 || staged.world.self.food > 8 || staged.world.self.food <= 0) throw new Error(`low-health precondition missing: ${staged.world.self.health}/${staged.world.self.food}`);
  if (hostiles(staged).length !== 1) throw new Error('expected exactly one frozen zombie');

  const submittedAt = Date.now();
  const chat = await postJson(`${hubUrl}/api/bots/${botId}/chat`, { message: instruction, sender: 'kb_official_2003' });
  record('chat_submitted', { instruction, response: chat });

  let planRunId = null;
  const goalDeadline = Date.now() + 45_000;
  while (Date.now() < goalDeadline && !planRunId) {
    const status = await getStatus();
    const task = goalExec(status).find(value => value.createdAt >= submittedAt - 1_000 && !baselineRuns.has(value.planRunId));
    record('waiting_for_goal_exec', { status: summarize(status) });
    planRunId = task?.planRunId ?? null;
    if (!planRunId) await delay(250);
  }
  if (!planRunId) throw new Error('new goal_exec was not created before timeout');

  const release = await rcon([
    'gamerule naturalRegeneration true',
    'data merge entity @e[type=minecraft:zombie,tag=mineclaw_test,limit=1,sort=nearest] {NoAI:0b,Invulnerable:0b,Silent:0b}',
  ]);
  record('zombie_released', { planRunId, responses: release });

  const timeline = [];
  let terminal = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await getStatus();
    const task = goalExec(status).find(value => value.planRunId === planRunId) ?? null;
    const sample = summarize(status);
    timeline.push(sample);
    record('sample', { planRunId, task, status: sample });
    if (task && ['completed', 'failed', 'cancelled'].includes(task.state)) { terminal = task; break; }
    await delay(500);
  }

  const finalStatus = await getStatus();
  const afterBlocks = await sampleBlocks();
  const initial = timeline[0] ?? summarize(staged);
  const final = summarize(finalStatus);
  const minHealth = Math.min(initial.health, ...timeline.map(value => value.health));
  const maxFood = Math.max(initial.food, ...timeline.map(value => value.food));
  const maxHealthAfterLow = Math.max(initial.health, ...timeline.map(value => value.health));
  const minBread = Math.min(initial.bread, ...timeline.map(value => value.bread));
  const result = {
    planRunId,
    terminal,
    initial,
    final,
    minHealth,
    maxFood,
    maxHealthAfterLow,
    minBread,
    ate: minBread < initial.bread,
    foodRecovered: maxFood > initial.food,
    healthRecovered: maxHealthAfterLow > initial.health,
    cleared: final.hostiles.length === 0,
    survived: final.health > 0,
    blocksUnchanged: JSON.stringify(beforeBlocks) === JSON.stringify(afterBlocks),
  };
  record('result', { ...result, blocksBefore: beforeBlocks, blocksAfter: afterBlocks });
  console.log(JSON.stringify({ runId, evidencePath, result }, null, 2));
  if (terminal?.state !== 'completed' || !result.ate || !result.foodRecovered || !result.healthRecovered || !result.cleared || !result.survived || !result.blocksUnchanged) process.exitCode = 2;
} catch (error) {
  record('failed', { error: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function getStatus() {
  const response = await fetch(`${hubUrl}/api/bots/${botId}/v2/status`);
  if (!response.ok) throw new Error(`status failed: ${response.status}`);
  return response.json();
}
async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
function goalExec(status) {
  return (status.tasks ?? []).filter(task => task.kind === 'goal_exec').map(task => ({
    state: task.state, createdAt: Number(task.createdAt ?? 0),
    planRunId: task.params?.plannerContext?.planRunId ?? null, failure: task.failure ?? null,
  }));
}
function hostiles(status) { return (status.world?.entities ?? []).filter(entity => entity.category === 'hostile'); }
function summarize(status) {
  const inventory = status.world?.inventory ?? {};
  const bread = (inventory.items ?? []).filter(item => item.name === 'bread').reduce((sum, item) => sum + item.count, 0);
  return {
    tick: status.tick, automaticDefenseEnabled: status.automaticDefenseEnabled,
    position: status.world?.self?.position, health: status.world?.self?.health, food: status.world?.self?.food,
    held: inventory.held?.name ?? null, bread,
    hostiles: hostiles(status).map(entity => ({ id: entity.id, name: entity.name, distance: entity.distance, position: entity.position })),
    goalExec: goalExec(status),
  };
}
async function sampleBlocks() {
  const commands = samples.map(([x, y, z, block]) => `execute if block ${x} ${y} ${z} minecraft:${block} run time query daytime`);
  const responses = await rcon(commands);
  return responses.map((entry, index) => ({ sample: samples[index], present: entry.response.length > 0 }));
}
