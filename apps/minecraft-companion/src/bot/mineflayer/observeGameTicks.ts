import type { Bot } from 'mineflayer';
import type { GameTickResult, GameTickWait } from '../adapter/GameTickObservation.js';

/** Count Mineflayer physics ticks, not wall time. Never follow a reconnect or respawn. */
export function observeGameTicks(
  getBot: () => Bot | null, q: GameTickWait, isGenerationCurrent: () => boolean,
): Promise<GameTickResult> {
  const bot = getBot();
  const identity = bot?.entity;
  let invalidated = false;
  const stillCurrent = () => !invalidated && isGenerationCurrent() && !!identity && getBot() === bot && bot?.entity === identity
    && bot.username === q.actor && q.isCurrent() && !q.signal.aborted;
  let ticks = 0;
  const result = (kind: GameTickResult['kind']): GameTickResult => {
    const base = { kind, ticks, at: Date.now(), stillCurrent };
    if ((kind !== 'event' && kind !== 'elapsed') || !stillCurrent() || !bot?.entity.position || !bot.inventory) return base;
    const { position: { x, y, z }, yaw, pitch, onGround } = bot.entity;
    if (![x,y,z,yaw,pitch,bot.food,bot.health].every(Number.isFinite)) return base;
    const inventory = bot.inventory.items().map(({ name, count, slot }) => ({ name, count, slot }));
    return { ...base, self: { position: { x, y, z }, yaw, pitch, health: bot.health, food: bot.food, isOnGround: onGround }, inventory };
  };
  if (!bot || !stillCurrent() || !Number.isSafeInteger(q.maxTicks) || q.maxTicks < 1 || !Number.isFinite(q.deadlineAt)
    || (q.event !== undefined && q.event !== 'health')) return Promise.resolve(result('unavailable'));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    function cleanup() {
      clearTimeout(timer);
      bot!.off('physicsTick', tick).off('health', health).off('end', revoke).off('respawn', revoke).off('death', revoke);
      q.signal.removeEventListener('abort', revoke);
    }
    function finish(kind: GameTickResult['kind']) {
      if (settled) return;
      settled = true;
      cleanup();
      try { resolve(result(kind)); }
      catch (error) { reject(error); }
    }
    function failed(error: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function revoke() { invalidated = true; finish('revoked'); }
    function ready() {
      if (!stillCurrent()) { revoke(); return false; }
      if (Date.now() >= q.deadlineAt) { finish('expired'); return false; }
      return true;
    }
    function tick() {
      try {
        if (!ready()) return;
        ++ticks;
        if (q.arrived?.()) finish('event');
        else if (ticks >= q.maxTicks) finish('elapsed');
      } catch (error) { failed(error); }
    }
    function health() {
      try { if (ready()) finish('event'); }
      catch (error) { failed(error); }
    }
    function armDeadline() {
      try {
        if (ready()) timer = setTimeout(armDeadline, Math.min(q.deadlineAt - Date.now(), 2_147_483_647));
      } catch (error) { failed(error); }
    }
    bot.on('physicsTick', tick).on('end', revoke).on('respawn', revoke).on('death', revoke);
    if (q.event) bot.on('health', health);
    q.signal.addEventListener('abort', revoke, { once: true });
    armDeadline();
  });
}
