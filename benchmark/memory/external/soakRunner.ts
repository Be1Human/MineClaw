import { monitorEventLoopDelay } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { ChatMemoryService } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import {
  acquireSoakLock,
  atomicWriteSoak,
  finishSoak,
  heartbeatSoak,
  readSoakReport,
  resumeSoak,
  startNewSoak,
  type RunningSoakState,
} from './soakState.js';
import { EXTERNAL_REPORT_DIR } from './paths.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

const resumePath = value('--resume') ? resolve(value('--resume')!) : undefined;
const resumeSource = resumePath ? readSoakReport(resumePath) : undefined;
const explicitDuration = value('--duration-ms') ?? value('--duration-hours');
const targetDurationMs = explicitDuration
  ? value('--duration-ms')
    ? positiveNumber('--duration-ms', 24 * 60 * 60 * 1000)
    : positiveNumber('--duration-hours', 24) * 60 * 60 * 1000
  : resumeSource?.targetDurationMs ?? 24 * 60 * 60 * 1000;
const intervalMs = positiveNumber('--interval-ms', 1000);
const leaseTimeoutMs = positiveNumber('--lease-timeout-ms', Math.max(60_000, intervalMs * 30));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = resumePath ?? resolve(value('--report') ?? join(EXTERNAL_REPORT_DIR, `memory-soak-${stamp}.json`));
const activeReportPath = resolve(value('--active-report') ?? join(EXTERNAL_REPORT_DIR, 'memory-soak-active.json'));
const dbPath = resolve(value('--db-path') ?? resumeSource?.dbPath ?? join(EXTERNAL_REPORT_DIR, `memory-soak-${stamp}.db`));
const state: RunningSoakState = resumeSource
  ? resumeSoak(resumeSource, { nowMs: Date.now(), targetDurationMs, leaseTimeoutMs, dbPath, reportPath })
  : startNewSoak({ nowMs: Date.now(), targetDurationMs, leaseTimeoutMs, dbPath, reportPath });
const lock = acquireSoakLock(`${reportPath}.lock`, leaseTimeoutMs);
const report = state.report;
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

let profileA: ChatMemoryService;
let profileB: ChatMemoryService;
let profilesOpen = false;

function openProfiles(): void {
  profileA = new ChatMemoryService({ dbPath, profileId: 'soak-profile-a', autoCapture: true, flushThresholdChars: 256, promptBudgetChars: 6000 });
  profileB = new ChatMemoryService({ dbPath, profileId: 'soak-profile-b', autoCapture: true, flushThresholdChars: 256, promptBudgetChars: 6000 });
  profilesOpen = true;
}

function closeProfiles(): void {
  if (!profilesOpen) return;
  profileA.close();
  profileB.close();
  profilesOpen = false;
}

function persist(): void {
  heartbeatSoak(state, Date.now());
  lock.heartbeat();
  report.maxEventLoopDelayMs = Math.max(report.maxEventLoopDelayMs, eventLoop.max / 1_000_000);
  atomicWriteSoak(reportPath, report);
  if (activeReportPath !== reportPath) atomicWriteSoak(activeReportPath, report);
}

let stopping = false;
function stop(): void {
  stopping = true;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function main(): Promise<void> {
  openProfiles();
  if (report.iterations > 0) {
    const previous = report.iterations;
    if (profileA.getMessagesByIds([`soak-a-${previous}`]).length !== 1) report.dataLoss += 1;
    if (profileB.getMessagesByIds([`soak-b-${previous}`]).length !== 1) report.dataLoss += 1;
  }
  persist();
  let lastIterationAt = Date.now();
  try {
    while (!stopping && report.activeElapsedMs < report.targetDurationMs) {
      const iterationStartedAt = Date.now();
      if (iterationStartedAt - lastIterationAt > Math.max(intervalMs * 5, 10_000)) report.deadlockSignals += 1;
      lastIterationAt = iterationStartedAt;

      const n = report.iterations + 1;
      const topic = n % 20;
      const aId = `soak-a-${n}`;
      const bId = `soak-b-${n}`;
      const aText = `我喜欢耐久饮品A-${topic}`;
      const bText = `我喜欢耐久饮品B-${topic}`;
      profileA.recordMessage({ id: aId, sessionId: `soak-a-${Math.floor(n / 100)}`, role: 'owner', content: aText, timestamp: iterationStartedAt });
      profileB.recordMessage({ id: bId, sessionId: `soak-b-${Math.floor(n / 100)}`, role: 'owner', content: bText, timestamp: iterationStartedAt + 1 });
      report.messagesWritten += 2;
      report.profileSwitches += 2;

      const aRetrieved = profileA.searchFacts(`耐久饮品A-${topic}`, 5);
      const bRetrieved = profileB.searchFacts(`耐久饮品B-${topic}`, 5);
      report.retrievalChecks += 2;
      if (!aRetrieved.some(fact => fact.sourceMessageIds.includes(aId))) report.dataLoss += 1;
      if (!bRetrieved.some(fact => fact.sourceMessageIds.includes(bId))) report.dataLoss += 1;
      if (profileA.searchFacts(`耐久饮品B-${topic}`, 5).some(fact => fact.sourceMessageIds.some(id => id.startsWith('soak-b-')))) report.profileLeaks += 1;
      if (profileB.searchFacts(`耐久饮品A-${topic}`, 5).some(fact => fact.sourceMessageIds.some(id => id.startsWith('soak-a-')))) report.profileLeaks += 1;

      const sessionA = `soak-a-${Math.floor(n / 100)}`;
      const sessionB = `soak-b-${Math.floor(n / 100)}`;
      if (n % 25 === 0) {
        if (profileA.maybeFlush(sessionA)) report.flushes += 1;
        if (profileB.maybeFlush(sessionB)) report.flushes += 1;
      }
      if (profileA.buildPromptContext(`耐久饮品A-${topic}`).text.length > 6000) report.promptBudgetViolations += 1;
      if (profileB.buildPromptContext(`耐久饮品B-${topic}`).text.length > 6000) report.promptBudgetViolations += 1;

      report.iterations = n;
      if (n % 50 === 0) {
        closeProfiles();
        openProfiles();
        report.reopens += 1;
        if (profileA.getMessagesByIds([aId]).length !== 1 || profileB.getMessagesByIds([bId]).length !== 1) report.dataLoss += 1;
      }
      if (n % 10 === 0) persist();

      const remaining = intervalMs - (Date.now() - iterationStartedAt);
      if (remaining > 0) await sleep(remaining);
      heartbeatSoak(state, Date.now());
    }
    finishSoak(state, stopping ? 'cancelled' : 'completed', Date.now());
  } catch (error) {
    report.crashes += 1;
    report.errors.push({ at: new Date().toISOString(), message: error instanceof Error ? error.stack ?? error.message : String(error) });
    finishSoak(state, 'failed', Date.now());
    process.exitCode = 1;
  } finally {
    try {
      closeProfiles();
    } catch (error) {
      report.crashes += 1;
      report.errors.push({ at: new Date().toISOString(), message: `close failed: ${error instanceof Error ? error.message : String(error)}` });
      finishSoak(state, 'failed', Date.now());
      process.exitCode = 1;
    }
    eventLoop.disable();
    atomicWriteSoak(reportPath, report);
    if (activeReportPath !== reportPath) atomicWriteSoak(activeReportPath, report);
    lock.release();
    console.log(JSON.stringify(report, null, 2));
  }
}

await main();
