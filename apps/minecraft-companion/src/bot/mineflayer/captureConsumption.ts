import type { Bot } from 'mineflayer';
import type { ConsumptionObservation } from '../adapter/ConsumptionObservation.js';

/** Own-player consumption plus inventory events, from one concrete Bot only. */
export function captureConsumption(getBot: () => Bot | null, item: string, signal: AbortSignal, isGenerationCurrent: () => boolean): ConsumptionObservation | null {
  const bot = getBot();
  if (!bot?.entity || !bot.inventory || !bot._client || signal.aborted || !isGenerationCurrent()) return null;
  const actor = bot.username;
  const dimension = bot.game.dimension;
  const entityId = bot.entity.id;
  const count = (): number | null => {
    try {
      const items = bot.inventory.items();
      return items.every(value => Number.isInteger(value.count) && value.count >= 0)
        ? items.filter(value => value.name === item).reduce((total, value) => total + value.count, 0) : null;
    } catch { return null; }
  };
  let beforeCount: number | null = null;
  let armed = false;
  let closed = false;
  let invalid = false;
  let consumptionEvents = 0;
  let inventoryEvents = 0;
  const current = () => !invalid && isGenerationCurrent() && getBot() === bot && bot.entity?.id === entityId
    && bot.username === actor && bot.game.dimension === dimension;
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (armed && current() && packet.entityId === entityId && packet.entityStatus === 9) consumptionEvents++;
  };
  const slot = (_slot: number, before: { name?: string } | null, after: { name?: string } | null) => {
    if (armed && current() && (before?.name === item || after?.name === item)) inventoryEvents++;
  };
  const ended = () => { invalid = true; };
  const close = () => {
    if (closed) return;
    closed = true;
    bot._client.removeListener('entity_status', status);
    bot.inventory.removeListener('updateSlot', slot);
    bot.removeListener('end', ended);
    bot.removeListener('death', ended);
    signal.removeEventListener('abort', ended);
  };
  bot._client.on('entity_status', status);
  bot.inventory.on('updateSlot', slot);
  bot.on('end', ended);
  bot.on('death', ended);
  signal.addEventListener('abort', ended, { once: true });
  return Object.freeze({
    arm: () => {
      if (closed || !current() || signal.aborted || bot.heldItem?.name !== item) return false;
      beforeCount = count();
      armed = beforeCount !== null && beforeCount > 0;
      consumptionEvents = 0;
      inventoryEvents = 0;
      return armed;
    },
    read: () => {
      const afterCount = current() ? count() : null;
      return { status: armed && !closed && current() && afterCount !== null ? 'observed' as const : 'unknown' as const,
        actor, dimension, item, beforeCount, afterCount, consumptionEvents, inventoryEvents };
    },
    close,
  });
}
