/**
 * MineflayerGameAdapter —— GameAdapter 的 mineflayer 实现
 *
 * 设计要点：
 * - BotGetter 返回 Bot | null（重连过渡期间为 null）
 * - 所有读方法：bot=null 时返回安全默认值（0 / [] / null）
 * - 身体写操作只通过固定 Bot 的 ActionSession；断连显式失败，不转发到新 Bot
 * - 本文件是 mineflayer 在项目中唯一允许直接成员访问 Bot 的地方之一
 */

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import type { Vec3 as MFVec3 } from 'vec3';
import vec3pkg from 'vec3';
const Vec3Ctor = (vec3pkg as unknown as { Vec3: new (x: number, y: number, z: number) => MFVec3 }).Vec3
  ?? (vec3pkg as unknown as new (x: number, y: number, z: number) => MFVec3);

import type { GameAdapter } from '../adapter/GameAdapter.js';
import type { BoundGameActions, DeviceExecutionScope } from '../adapter/GameActions.js';
import { MineflayerActionSession } from './MineflayerActionSession.js';
import { toMinecraftChatLine } from './minecraftChat.js';
import { BotSubscriptionRegistry } from './botSubscriptionRegistry.js';
import type {
  Vec3,
  RawBlock,
  RawEntity,
  RawItem,
  GameRegistrySnapshot,
  RawArmor,
  RawEffect,
  RawPlayer,
  ControlKey,
  EquipDestination,
  FindBlocksOptions,
  Unsubscribe,
  RecipeInfo,
  ItemSource,
  CraftResult,
  ChestOpResult,
  SmeltResult,
} from '../adapter/types.js';

type BotGetter = () => Bot | null;

const ZERO_VEC: Vec3 = { x: 0, y: 0, z: 0 };

export class MineflayerGameAdapter implements GameAdapter {
  private readonly subscriptions = new BotSubscriptionRegistry<Bot>();

  constructor(private readonly getBot: BotGetter) {}

  bind(scope: DeviceExecutionScope): BoundGameActions {
    const bot = this.getBot();
    if (!bot) throw new Error('game_body_unavailable');
    return new MineflayerActionSession(bot, new MineflayerGameAdapter(() => bot), scope, () => this.getBot() === bot);
  }

  /** Called by MineflayerConnection whenever the concrete Bot generation changes. */
  rebindSubscriptions(bot: Bot | null): void {
    this.subscriptions.rebind(bot);
  }

  get username(): string {
    return this.getBot()?.username ?? '';
  }

  // ── 自身状态（读方法：null 时返回安全默认值） ───
  getPosition(): Vec3 {
    const p = this.getBot()?.entity?.position;
    return p ? { x: p.x, y: p.y, z: p.z } : ZERO_VEC;
  }
  getOrientation() {
    const e = this.getBot()?.entity;
    return { yaw: e?.yaw ?? 0, pitch: e?.pitch ?? 0 };
  }
  getVelocity(): Vec3 {
    const v = this.getBot()?.entity?.velocity;
    return v ? { x: v.x, y: v.y, z: v.z } : ZERO_VEC;
  }
  isOnGround(): boolean { return this.getBot()?.entity?.onGround ?? false; }
  getHealth(): number { return this.getBot()?.health ?? 20; }
  getFood(): number { return this.getBot()?.food ?? 20; }
  getSaturation(): number { return this.getBot()?.foodSaturation ?? 5; }
  getExperienceLevel(): number { return this.getBot()?.experience?.level ?? 0; }
  getSelectedSlot(): number { return this.getBot()?.quickBarSlot ?? 0; }
  getGameMode(): string { return this.getBot()?.game?.gameMode ?? 'survival'; }
  getDimension(): string { return this.getBot()?.game?.dimension ?? 'overworld'; }
  getTimeOfDay(): number { return this.getBot()?.time?.timeOfDay ?? 0; }
  isRaining(): boolean { return this.getBot()?.isRaining ?? false; }
  isThundering(): boolean {
    const ts = (this.getBot() as unknown as { thunderState?: number } | null)?.thunderState;
    return (ts ?? 0) > 0;
  }

  // ── 世界查询 ──────────────────────────────────────
  getBlockAt(pos: Vec3, forceLoad?: boolean): RawBlock | null {
    const bot = this.getBot();
    // 断连/重连过渡期 bot 可能存在但方法已失效 → 防御性判断，避免崩进程
    if (!bot || typeof bot.blockAt !== 'function') return null;
    try {
      const block = bot.blockAt(toMFVec3(pos), forceLoad);
      return block ? toRawBlock(block) : null;
    } catch { return null; }
  }
  findBlocks(opts: FindBlocksOptions): Vec3[] {
    const bot = this.getBot();
    if (!bot || typeof bot.findBlocks !== 'function' || !bot.registry) return [];
    const names = Array.isArray(opts.names) ? opts.names : [opts.names];
    const ids: number[] = [];
    for (const n of names) {
      const def = bot.registry.blocksByName[n];
      if (def) ids.push(def.id);
    }
    if (ids.length === 0) return [];

    const point = opts.origin ? toMFVec3(opts.origin) : bot.entity?.position;
    if (!point) return [];

    const found = bot.findBlocks({
      point,
      matching: ids,
      maxDistance: opts.maxDistance,
      count: opts.count ?? 1,
    });
    return found.map(toVec3);
  }
  getEntities(): RawEntity[] {
    const bot = this.getBot();
    if (!bot || !bot.entities) return [];
    const list: RawEntity[] = [];
    try {
      for (const e of Object.values(bot.entities)) {
        if (e) list.push(toRawEntity(e, skinDataForEntity(bot, e)));
      }
    } catch { return []; }
    return list;
  }
  getEntityById(id: number): RawEntity | null {
    const bot = this.getBot();
    const e = bot?.entities?.[id];
    return e && bot ? toRawEntity(e, skinDataForEntity(bot, e)) : null;
  }
  getPlayers(): Record<string, RawPlayer> {
    const bot = this.getBot();
    if (!bot || !bot.players) return {};
    const out: Record<string, RawPlayer> = {};
    try {
      for (const [name, p] of Object.entries(bot.players)) {
        out[name] = toRawPlayer(name, p as PlayerSnapshot);
      }
    } catch { return {}; }
    return out;
  }
  getPlayer(name: string): RawPlayer | null {
    const p = this.getBot()?.players?.[name] as PlayerSnapshot | undefined;
    return p ? toRawPlayer(name, p) : null;
  }

  // ── 物品栏 ────────────────────────────────────────
  getInventoryItems(): RawItem[] {
    const bot = this.getBot();
    if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return [];
    try { return bot.inventory.items().map(toRawItem); } catch { return []; }
  }
  getRegistrySnapshot(): GameRegistrySnapshot | null {
    const bot = this.getBot();
    if (!bot?.registry) return null;
    try {
      const registry = bot.registry as unknown as McRegistry;
      const blockNames = new Set(Object.keys(registry.blocksByName ?? {}));
      const objects = Object.values(registry.itemsByName ?? {})
        .filter((item): item is McItemDef => !!item?.name)
        .map(item => ({
          registryId: `minecraft:${item.name}`,
          name: item.name,
          displayName: item.displayName ?? item.name.replaceAll('_', ' '),
          kind: 'item' as const,
          ...(blockNames.has(item.name) ? { isBlock: true } : {}),
        }));
      return { revision: `minecraft:${bot.version ?? 'unknown'}`, objects };
    } catch {
      return null;
    }
  }
  getHeldItem(): RawItem | null {
    const it = this.getBot()?.heldItem;
    return it ? toRawItem(it) : null;
  }
  getFreeSlotCount(): number {
    const inv = this.getBot()?.inventory;
    if (!inv || typeof inv.emptySlotCount !== 'function') return 0;
    try { return inv.emptySlotCount(); } catch { return 0; }
  }
  /** 盔甲槽（mineflayer 主物品窗口槽位：5=头 6=胸 7=腿 8=脚），bot.inventory.items() 不含这些 */
  getArmorItems(): RawArmor {
    const empty: RawArmor = { head: null, torso: null, legs: null, feet: null };
    const slots = this.getBot()?.inventory?.slots;
    if (!slots) return empty;
    const pick = (i: number): RawItem | null => {
      const it = slots[i];
      return it ? toRawItem(it) : null;
    };
    try { return { head: pick(5), torso: pick(6), legs: pick(7), feet: pick(8) }; }
    catch { return empty; }
  }
  /** 副手槽（主物品窗口槽位 45） */
  getOffhandItem(): RawItem | null {
    const it = this.getBot()?.inventory?.slots?.[45];
    return it ? toRawItem(it) : null;
  }
  /** 状态效果：bot.entity.effects（按 id 键控）→ 数组，名字查 registry */
  getEffects(): RawEffect[] {
    const bot = this.getBot();
    const raw = bot?.entity?.effects as Record<string, { id: number; amplifier: number; duration: number }> | undefined;
    if (!raw) return [];
    const reg = bot?.registry as unknown as { effects?: Record<number, { name?: string }> } | undefined;
    try {
      return Object.values(raw).map(e => ({
        id: e.id,
        name: reg?.effects?.[e.id]?.name ?? String(e.id),
        amplifier: e.amplifier ?? 0,
        duration: e.duration ?? 0,
      }));
    } catch { return []; }
  }
  /** 氧气：bot.oxygenLevel（满/陆地上为 undefined → 视作 20 满） */
  getOxygen(): number {
    const o = (this.getBot() as unknown as { oxygenLevel?: number } | undefined)?.oxygenLevel;
    return typeof o === 'number' ? o : 20;
  }
  chat(message: string): void {
    const line = toMinecraftChatLine(message);
    if (!line) return;
    try { this.getBot()?.chat(line); } catch { /* silenced */ }
  }
  getBlockProperties(pos: Vec3): Record<string, string> | null {
    const bot = this.getBot();
    if (!bot) return null;
    try {
      const block = bot.blockAt(toMFVec3(pos));
      if (!block) return null;
      const props = (block as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.();
      if (!props) return null;
      // 统一转 string
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(props)) out[k] = String(v);
      return out;
    } catch { return null; }
  }

  findBestFood(): string | null {
    const bot = this.getBot();
    if (!bot) return null;
    try {
      const foods = (bot.registry as unknown as {
        foodsByName?: Record<string, { foodPoints: number; saturation: number }>;
      }).foodsByName;
      if (!foods) return null;
      // 不主动吃的"坏食物"（有副作用 / 低收益）
      const BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'chorus_fruit']);
      let best: { name: string; score: number } | null = null;
      for (const it of bot.inventory.items()) {
        if (BAD.has(it.name)) continue;
        const f = foods[it.name];
        if (!f) continue;
        const score = f.foodPoints + f.saturation;
        if (!best || score > best.score) best = { name: it.name, score };
      }
      return best?.name ?? null;
    } catch { return null; }
  }

  findNearbyBed(maxDistance: number): Vec3 | null {
    const bot = this.getBot();
    if (!bot) return null;
    try {
      const block = bot.findBlock({
        matching: (b: Block) => !!b && typeof b.name === 'string' && b.name.endsWith('_bed'),
        maxDistance,
      });
      if (!block) return null;
      return { x: block.position.x, y: block.position.y, z: block.position.z };
    } catch { return null; }
  }

  getCraftRecipes(itemName: string, withTable: boolean): RecipeInfo[] {
    const bot = this.getBot();
    if (!bot) return [];
    try {
      const reg = bot.registry as unknown as McRegistry;
      const item = reg.itemsByName[itemName];
      if (!item) return [];
      const recipes = bot.recipesAll(item.id, null, withTable ? true : null);
      const out: RecipeInfo[] = [];
      for (const r of recipes as unknown as MfRecipe[]) {
        // delta: count<0 = 消耗的材料；正数 = 产物
        const merged = new Map<number, number>();
        for (const d of r.delta ?? []) {
          if (d.count < 0) merged.set(d.id, (merged.get(d.id) ?? 0) - d.count);
        }
        const ingredients: RecipeInfo['ingredients'] = [];
        for (const [id, cnt] of merged) {
          const name = reg.items[id]?.name;
          if (name) ingredients.push({ name, count: cnt });
        }
        const resultName = reg.items[r.result.id]?.name ?? itemName;
        out.push({
          result: { name: resultName, count: r.result.count },
          ingredients,
          requiresTable: !!r.requiresTable,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  getItemSource(itemName: string): ItemSource | null {
    const bot = this.getBot();
    if (!bot) return null;
    try {
      const reg = bot.registry as unknown as McRegistry;
      const item = reg.itemsByName[itemName];
      if (!item) return null;

      // 1) 同名方块（原木/泥土/沙子/矿石本体掉落自己）
      let blockName: string | null = null;
      if (reg.blocksByName[itemName]) {
        blockName = itemName;
      } else {
        // 2) 扫描所有方块的 drops，找掉落该物品的方块
        for (const b of reg.blocksArray) {
          if (blockDropsItem(b, item.id)) { blockName = b.name; break; }
        }
      }
      if (!blockName) return null;

      const blockDef = reg.blocksByName[blockName];
      const requiredTool = requiredToolFor(blockDef, reg);
      return { block: blockName, requiredTool };
    } catch {
      return null;
    }
  }

  // ── 事件订阅（断连时登记，下一 Bot 代次自动绑定） ──
  onChat(handler: (sender: string, message: string) => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'chat', (...args: unknown[]) => {
      const username = args[0] as string;
      const message = args[1] as string;
      if (username === this.getBot()?.username) return;
      handler(username, message);
    });
  }
  onWhisper(handler: (sender: string, message: string) => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'whisper', (...args: unknown[]) => {
      handler(args[0] as string, args[1] as string);
    });
  }
  onHealthChange(handler: (h: { health: number; food: number }) => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'health', () => {
      const bot = this.getBot();
      if (bot) handler({ health: bot.health, food: bot.food });
    });
  }
  onDeath(handler: () => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'death', handler);
  }
  onSpawn(handler: () => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'spawn', handler);
  }
}

// ─── minecraft-data registry 松类型（避免泄漏到接口层） ───
interface McItemDef { id: number; name: string; displayName?: string }
interface McBlockDef {
  id: number;
  name: string;
  drops?: unknown[];
  harvestTools?: Record<string, boolean>;
  material?: string;
}
interface McRegistry {
  itemsByName: Record<string, McItemDef | undefined>;
  items: Record<number, McItemDef | undefined>;
  blocksByName: Record<string, McBlockDef | undefined>;
  blocksArray: McBlockDef[];
}
interface MfRecipeItem { id: number; metadata: number | null; count: number }
interface MfRecipe {
  result: MfRecipeItem;
  delta?: MfRecipeItem[];
  requiresTable?: boolean;
}

/**
 * FEAT-MEM-06 · 从已打开的 chest 对象抓内容物名字（去重）。
 * 兼容 mineflayer chest 实现：containerItems() 可能不存在或为空。
 */
function readChestContents(chest: { containerItems?: () => { name: string; count: number }[] } | null): string[] | undefined {
  if (!chest || typeof chest.containerItems !== 'function') return undefined;
  try {
    const items = chest.containerItems();
    if (!Array.isArray(items)) return undefined;
    const set = new Set<string>();
    for (const it of items) {
      if (it && typeof it.name === 'string' && it.name) set.add(it.name);
    }
    return Array.from(set);
  } catch {
    return undefined;
  }
}

/** 判断方块的 drops 是否含某物品 id（兼容 number / {drop} / {item} / 嵌套对象 多种格式） */
function blockDropsItem(b: McBlockDef, itemId: number): boolean {
  const drops = b.drops;
  if (!Array.isArray(drops)) return false;
  for (const d of drops) {
    if (typeof d === 'number') {
      if (d === itemId) return true;
    } else if (d && typeof d === 'object') {
      const obj = d as Record<string, unknown>;
      const candidate = obj.drop ?? obj.item ?? obj.id;
      if (typeof candidate === 'number' && candidate === itemId) return true;
      if (candidate && typeof candidate === 'object') {
        const inner = (candidate as Record<string, unknown>).id;
        if (typeof inner === 'number' && inner === itemId) return true;
      }
    }
  }
  return false;
}

/** 工具档位优先级（从最便宜到最贵），用于挑选满足采集门槛的最低工具 */
const TOOL_TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

/** 返回采集该方块需要的最低工具物品名；徒手可采则 null */
function requiredToolFor(blockDef: McBlockDef | undefined, reg: McRegistry): string | null {
  if (!blockDef) return null;
  const ht = blockDef.harvestTools;
  if (!ht) return null;
  const toolNames = Object.keys(ht)
    .map(id => reg.items[Number(id)]?.name)
    .filter((n): n is string => !!n);
  if (toolNames.length === 0) return null;
  for (const tier of TOOL_TIERS) {
    const m = toolNames.find(n => n.startsWith(tier + '_'));
    if (m) return m;
  }
  return toolNames[0];
}

// ─── 内部转换工具 ─────────────────────────────────────

function toVec3(v: { x: number; y: number; z: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
function toMFVec3(v: Vec3): MFVec3 {
  return new Vec3Ctor(v.x, v.y, v.z);
}
function toRawItem(it: {
  name: string;
  count: number;
  slot: number;
  maxDurability?: number;
  durabilityUsed?: number;
}): RawItem {
  const out: RawItem = { name: it.name, count: it.count, slot: it.slot };
  if (typeof it.maxDurability === 'number' && it.maxDurability > 0) {
    out.maxDurability = it.maxDurability;
    const used = typeof it.durabilityUsed === 'number' ? it.durabilityUsed : 0;
    out.durability = Math.max(0, it.maxDurability - used);
  }
  return out;
}

function toRawBlock(b: Block): RawBlock {
  return {
    name: b.name,
    position: toVec3(b.position),
    boundingBox: b.boundingBox === 'block' ? 'block' : 'empty',
  };
}
interface PlayerSkinSnapshot {
  url: string;
  model: string | null;
}

interface PlayerSnapshot {
  entity?: Entity;
  skinData?: PlayerSkinSnapshot;
}

function skinDataForEntity(bot: Bot, entity: Entity): PlayerSkinSnapshot | undefined {
  const username = (entity as unknown as { username?: string }).username;
  if (!username) return undefined;
  return (bot.players?.[username] as PlayerSnapshot | undefined)?.skinData;
}

function toRawEntity(e: Entity, skinData?: PlayerSkinSnapshot): RawEntity {
  const dropped = e.getDroppedItem();
  const username = (e as unknown as { username?: string }).username;
  return {
    id: e.id,
    name: e.name ?? 'unknown',
    type: e.type ?? 'other',
    position: toVec3(e.position),
    velocity: e.velocity ? toVec3(e.velocity) : undefined,
    yaw: e.yaw,
    pitch: e.pitch,
    health: (e as unknown as { health?: number }).health,
    username,
    ...(username && skinData?.url ? {
      skinUrl: skinData.url,
      skinModel: skinData.model === 'slim' ? 'slim' as const : 'classic' as const,
    } : {}),
    ...(dropped ? { droppedItem: { name: dropped.name, count: dropped.count } } : {}),
  };
}
function toRawPlayer(name: string, p: PlayerSnapshot): RawPlayer {
  return {
    username: name,
    entity: p.entity ? toRawEntity(p.entity, p.skinData) : undefined,
  };
}
