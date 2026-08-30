export function selectBuiltinResourcePack(packs, { gameVersion = '' } = {}) {
  return packs.find(pack => pack.source === 'mineclaw-original'
    && isCompatibleMinecraftVersion(pack.minecraftVersion, gameVersion))
    ?? null;
}

export function isCompatibleMinecraftVersion(packVersion, gameVersion) {
  if (!gameVersion || packVersion === gameVersion) return true;
  const pack = parseMinecraftVersion(packVersion);
  const game = parseMinecraftVersion(gameVersion);
  if (!pack || !game || pack.major !== game.major || pack.minor !== game.minor) return false;
  return pack.patch == null || game.patch == null;
}

function parseMinecraftVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] == null ? null : Number(match[3]),
  };
}
