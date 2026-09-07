export const EMPTY_LAN_WORLD_SNAPSHOT = Object.freeze({ state: 'idle', worlds: [] });

function safeText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maxLength);
}

export function projectLanWorldSnapshot(value) {
  const state = ['idle', 'listening', 'unavailable'].includes(value?.state) ? value.state : 'idle';
  const byId = new Map();
  for (const candidate of Array.isArray(value?.worlds) ? value.worlds : []) {
    const id = safeText(candidate?.id, '', 80);
    const host = safeText(candidate?.host, '', 255);
    const port = Number(candidate?.port);
    const lastSeenAt = Number(candidate?.lastSeenAt);
    if (!id || !host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    byId.set(id, {
      id,
      motd: safeText(candidate?.motd, 'Minecraft LAN World', 240),
      host,
      port,
      lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : 0,
    });
  }
  return {
    state,
    worlds: [...byId.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id)),
    ...(state === 'unavailable' ? { error: safeText(value?.error, '局域网发现暂不可用', 240) } : {}),
  };
}

