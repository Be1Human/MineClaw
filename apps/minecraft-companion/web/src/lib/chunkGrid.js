/**
 * FEAT-WEBUI-07 · 3D 场景增量分块渲染 — chunk 网格纯函数
 *
 * 从 PerceptionScene3D.vue 抽出的可单测逻辑：
 * - 方块坐标 → chunkKey（XZ 平面 16×16 列分组，Y 不分层）
 * - 方块整数坐标 key
 * - 脏 chunk 限量出队（每帧重建上限，防首载几十 chunk 同帧重建卡死）
 */

/** 方块坐标 → 所属 chunk 的 key（"cx,cz"） */
export function chunkKeyOf(x, z, size = 16) {
  return Math.floor(x / size) + ',' + Math.floor(z / size);
}

/** 方块整数坐标 key（"x,y,z"） */
export function blockKey(x, y, z) {
  return `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
}

/**
 * 从脏集合中取出最多 max 个 chunkKey（同时从集合移除），剩余留给后续帧。
 * @param {Set<string>} dirtySet
 * @param {number} max
 * @returns {string[]}
 */
export function takeDirtyChunks(dirtySet, max) {
  const out = [];
  for (const key of dirtySet) {
    out.push(key);
    dirtySet.delete(key);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * BUG-WEBUI-04 · 选出应淘汰的方块 key（防 worldBlockMap 无限累积越玩越卡）。
 * ① 超出 EVICT 半径的远块全淘汰；② 若剩余仍超 maxBlocks，按距离从最远开始补砍到上限内。
 * 纯函数：输入块数组 + bot 坐标 + 配置，输出待删 key 数组（不改入参）。
 *
 * @param {Array<{key:string,x:number,y:number,z:number}>} blocks
 * @param {{x:number,y:number,z:number}} bot
 * @param {{radiusXZ:number,radiusY:number,maxBlocks:number}} cfg
 * @returns {string[]} 待淘汰的 key
 */
export function selectEvictions(blocks, bot, cfg) {
  const { radiusXZ, radiusY, maxBlocks } = cfg;
  const evict = [];
  const kept = [];
  for (const b of blocks) {
    if (Math.abs(b.x - bot.x) > radiusXZ ||
        Math.abs(b.z - bot.z) > radiusXZ ||
        Math.abs(b.y - bot.y) > radiusY) {
      evict.push(b.key);
    } else {
      kept.push(b);
    }
  }
  if (kept.length > maxBlocks) {
    kept.sort((a, c) => {
      const da = (a.x - bot.x) ** 2 + (a.y - bot.y) ** 2 + (a.z - bot.z) ** 2;
      const dc = (c.x - bot.x) ** 2 + (c.y - bot.y) ** 2 + (c.z - bot.z) ** 2;
      return dc - da; // 最远在前
    });
    for (let i = 0; i < kept.length - maxBlocks; i++) evict.push(kept[i].key);
  }
  return evict;
}
