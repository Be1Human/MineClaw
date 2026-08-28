export function selectPreferredResourcePack(packs, { savedId = '', gameVersion = '' } = {}) {
  const compatible = pack => !gameVersion || pack.minecraftVersion === gameVersion;
  return packs.find(pack => pack.id === savedId && compatible(pack))
    ?? packs.find(pack => pack.source === 'mineclaw-original' && compatible(pack))
    ?? packs.find(compatible)
    ?? null;
}
