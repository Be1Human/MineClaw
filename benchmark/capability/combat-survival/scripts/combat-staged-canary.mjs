#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalRcon } from './local-rcon.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..', '..');
const BOT_NAME = /^[A-Za-z0-9_]{1,16}$/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = resolve(scriptDir, '..', 'fixtures', `${args.scenario}.json`);
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  if (scenario.id !== args.scenario) throw new Error('Scenario id does not match file name');
  if (!BOT_NAME.test(args.botName)) throw new Error('Invalid bot name');
  const render = commands => commands.map(command => command.replaceAll('{{bot}}', args.botName));
  const setupCommands = render(scenario.setupCommands);
  const releaseCommands = render(scenario.releaseCommands);
  const sampleCommands = render(scenario.sampleCommands);

  if (args.dryRun) {
    console.log(JSON.stringify({ scenario: scenario.id, setupCommands, releaseCommands, sampleCommands }, null, 2));
    return;
  }

  const runId = `combat-canary-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const evidencePath = resolve(repoRoot, 'benchmark', 'reports', 'capability', 'combat-survival', `${runId}.jsonl`);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, '');
  const record = (type, payload) => appendFileSync(evidencePath, `${JSON.stringify({ at:new Date().toISOString(), type, ...payload })}\n`);

  const statusBefore = await getJson(`${args.hubUrl}/api/bots/${args.botId}/v2/status`);
  const baselinePlanRuns = new Set(goalExecTasks(statusBefore).map(task => task.planRunId).filter(Boolean));
  record('baseline', { status: summarizeStatus(statusBefore), baselinePlanRuns:[...baselinePlanRuns] });

  const setupResponses = await executeLocalRcon({ serverDir:args.serverDir, commands:setupCommands });
  const frozenStatus = await waitForFrozenStatus({ hubUrl:args.hubUrl, botId:args.botId, expectedCount:scenario.expectedZombieCount ?? null });
  const frozenHostiles = (frozenStatus.world?.entities ?? []).filter(entity => entity.category === 'hostile');
  record('scenario_frozen', {
    scenario:scenario.id,
    expectedZombieCount:scenario.expectedZombieCount ?? null,
    observedHostiles:frozenHostiles,
    responses:setupResponses,
  });
  if (Number.isInteger(scenario.expectedZombieCount) && frozenHostiles.length !== scenario.expectedZombieCount) {
    record('failed', { reason:'frozen_hostile_count_mismatch', expected:scenario.expectedZombieCount, observed:frozenHostiles.length, zombieReleased:false });
    throw new Error(`Frozen hostile count mismatch: expected ${scenario.expectedZombieCount}, observed ${frozenHostiles.length}. Evidence: ${evidencePath}`);
  }

  const chatStartedAt = Date.now();
  const chatResponse = await postJson(`${args.hubUrl}/api/bots/${args.botId}/chat`, {
    message: args.instruction,
    sender: args.sender,
  });
  record('chat_submitted', { sender:args.sender, instruction:args.instruction, response:chatResponse });

  const deadline = chatStartedAt + args.timeoutMs;
  let activePlanRunId = null;
  while (Date.now() < deadline && !activePlanRunId) {
    const status = await getJson(`${args.hubUrl}/api/bots/${args.botId}/v2/status`);
    const task = goalExecTasks(status).find(value => value.createdAt >= chatStartedAt - 1_000 && !baselinePlanRuns.has(value.planRunId));
    record('waiting_for_goal_exec', { status:summarizeStatus(status) });
    if (task?.planRunId) activePlanRunId = task.planRunId;
    else await delay(args.sampleIntervalMs);
  }
  if (!activePlanRunId) {
    record('failed', { reason:'goal_exec_not_created_before_timeout', zombieReleased:false });
    throw new Error(`No new goal_exec PlanRun before timeout; zombie remains frozen. Evidence: ${evidencePath}`);
  }

  const releaseResponses = await executeLocalRcon({ serverDir:args.serverDir, commands:releaseCommands });
  record('zombie_released', { planRunId:activePlanRunId, responses:releaseResponses });

  let terminal = false;
  while (Date.now() < deadline && !terminal) {
    const [status, rcon] = await Promise.all([
      getJson(`${args.hubUrl}/api/bots/${args.botId}/v2/status`),
      executeLocalRcon({ serverDir:args.serverDir, commands:sampleCommands }),
    ]);
    const task = goalExecTasks(status).find(value => value.planRunId === activePlanRunId);
    record('sample', { planRunId:activePlanRunId, status:summarizeStatus(status), rcon });
    terminal = Boolean(task && ['completed','failed','cancelled'].includes(task.state));
    if (!terminal) await delay(args.sampleIntervalMs);
  }
  record(terminal ? 'terminal_observed' : 'failed', {
    planRunId:activePlanRunId,
    reason:terminal ? 'goal_exec_terminal' : 'goal_exec_terminal_timeout',
  });
  console.log(JSON.stringify({ runId, scenario:scenario.id, planRunId:activePlanRunId, terminal, evidencePath }, null, 2));
  if (!terminal) process.exitCode = 2;
}

function goalExecTasks(status) {
  return (status.tasks ?? []).filter(task => task.kind === 'goal_exec').map(task => ({
    state:task.state,
    createdAt:Number(task.createdAt ?? 0),
    planRunId:task.params?.plannerContext?.planRunId ?? null,
  }));
}

function summarizeStatus(status) {
  const self = status.world?.self ?? {};
  const inventory = status.world?.inventory ?? {};
  const count = name => (inventory.items ?? []).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  return {
    tick:status.tick,
    automaticDefenseEnabled:status.automaticDefenseEnabled,
    position:self.position,
    health:self.health,
    food:self.food,
    held:inventory.held?.name ?? null,
    bread:count('bread'),
    rottenFlesh:count('rotten_flesh'),
    hostiles:(status.world?.entities ?? []).filter(entity => entity.category === 'hostile').map(entity => ({
      id:entity.id,name:entity.name,position:entity.position,distance:entity.distance,
    })),
    goalExec:goalExecTasks(status),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return await response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function parseArgs(argv) {
  const args = {
    hubUrl:'http://127.0.0.1:3001',
    scenario:'zombie-single-mobile-staged-v1',
    sender:'kb_official_2003',
    instruction:'处理掉一只正在移动的僵尸。使用石剑，保护自己，低血量时吃面包，不要破坏斗兽场方块；只按实际结果报告。',
    timeoutMs:90_000,
    sampleIntervalMs:500,
    dryRun:false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--server-dir') args.serverDir = argv[++index];
    else if (token === '--hub-url') args.hubUrl = argv[++index];
    else if (token === '--bot-id') args.botId = argv[++index];
    else if (token === '--bot-name') args.botName = argv[++index];
    else if (token === '--sender') args.sender = argv[++index];
    else if (token === '--scenario') args.scenario = argv[++index];
    else if (token === '--instruction') args.instruction = argv[++index];
    else if (token === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (token === '--sample-ms') args.sampleIntervalMs = Number(argv[++index]);
    else if (token === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.serverDir || !args.botId || !args.botName) throw new Error('--server-dir, --bot-id and --bot-name are required');
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(args.hubUrl)) throw new Error('Hub URL must be loopback');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 5_000) throw new Error('Invalid timeout');
  if (!Number.isFinite(args.sampleIntervalMs) || args.sampleIntervalMs < 100) throw new Error('Invalid sample interval');
  return args;
}

function delay(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }

async function waitForFrozenStatus({ hubUrl, botId, expectedCount }) {
  const deadline = Date.now() + 5_000;
  let status = await getJson(`${hubUrl}/api/bots/${botId}/v2/status`);
  while (expectedCount !== null && Date.now() < deadline) {
    const hostiles = (status.world?.entities ?? []).filter(entity => entity.category === 'hostile');
    if (hostiles.length === expectedCount) return status;
    await delay(250);
    status = await getJson(`${hubUrl}/api/bots/${botId}/v2/status`);
  }
  return status;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
