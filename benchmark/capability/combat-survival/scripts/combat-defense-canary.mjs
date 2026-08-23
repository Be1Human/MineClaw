#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalRcon } from './local-rcon.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..', '..');
const botId = '515bba55-5241-415f-8917-b2a6af4179a8';
const hubUrl = 'http://127.0.0.1:3001';
const serverDir = resolve(repoRoot, 'mc-server');
const runId = `combat-defense-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const evidencePath = resolve(repoRoot, 'benchmark', 'reports', 'capability', 'combat-survival', `${runId}.jsonl`);
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, '');
const record = (type, payload = {}) => appendFileSync(evidencePath, `${JSON.stringify({ at: new Date().toISOString(), type, ...payload })}\n`);
const rcon = commands => executeLocalRcon({ serverDir, commands });
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

try {
  await post(`${hubUrl}/api/bots/${botId}/tasks/cancel-active`, { reason: 'automatic_defense_canary_reset' });
  const before = await status();
  if (before.automaticDefenseEnabled !== true) throw new Error('automatic defense must be enabled');
  record('baseline', { status: summarize(before) });
  const setup = await rcon([
    'kill @e[tag=mineclaw_test]',
    'gamerule doMobSpawning false',
    'gamerule naturalRegeneration true',
    'time set day',
    'weather clear',
    'gamemode adventure X',
    'tp X 48.5 -60 22.5',
    'effect give X minecraft:saturation 1 10 true',
    'effect give X minecraft:instant_health 1 10 true',
    'give X minecraft:stone_sword 1',
    'execute at X run summon minecraft:zombie ~4 ~ ~ {Tags:["mineclaw_test"],NoAI:0b,Invulnerable:0b,Silent:0b,PersistenceRequired:1b,CanPickUpLoot:0b,Health:20.0f}',
  ]);
  record('released', { responses: setup });
  let seenHostile = false;
  const appearDeadline = Date.now() + 5_000;
  while (Date.now() < appearDeadline && !seenHostile) {
    await delay(100);
    const appeared = await status();
    const sample = summarize(appeared);
    seenHostile = sample.hostiles.length === 1;
    record('waiting_for_hostile', { status: sample });
  }
  if (!seenHostile) throw new Error('spawned zombie was never observed by the world snapshot');
  let sawDefenseMode = false;
  let cleared = false;
  let last = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    last = await status();
    const sample = summarize(last);
    sawDefenseMode ||= !['safe', 'combat_managed'].includes(sample.mode);
    cleared = sample.hostiles.length === 0;
    record('sample', { status: sample });
    if (cleared) break;
    await delay(500);
  }
  const final = summarize(last ?? await status());
  const result = { seenHostile, sawDefenseMode, cleared, survived: final.health > 0, final };
  record('result', result);
  console.log(JSON.stringify({ runId, evidencePath, result }, null, 2));
  if (!seenHostile || !sawDefenseMode || !cleared || final.health <= 0) process.exitCode = 2;
} catch (error) {
  record('failed', { error: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function status() {
  const response = await fetch(`${hubUrl}/api/bots/${botId}/v2/status`);
  if (!response.ok) throw new Error(`status failed: ${response.status}`);
  return response.json();
}
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`POST failed: ${response.status}`);
}
function summarize(value) {
  return {
    tick: value.tick,
    automaticDefenseEnabled: value.automaticDefenseEnabled,
    health: value.world?.self?.health,
    food: value.world?.self?.food,
    position: value.world?.self?.position,
    held: value.world?.inventory?.held?.name ?? null,
    mode: value.strategies?.find(strategy => strategy.id === 'survival_strategy')?.view?.mode ?? null,
    hostiles: (value.world?.entities ?? []).filter(entity => entity.category === 'hostile').map(entity => ({ id: entity.id, name: entity.name, distance: entity.distance, position: entity.position })),
  };
}
