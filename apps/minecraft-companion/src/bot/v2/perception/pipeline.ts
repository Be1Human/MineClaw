/**
 * 👁 基础设施 #3 · Perception 感知管线
 *
 * 4 段管线：
 *   ① SensorAdapter   · 把 GameAdapter 原始 Raw* 标准化
 *   ② StateInterpreter · 语义解释（"血 18→12" = "受到伤害 6"）
 *   ③ EventDetector ★ · 前后帧对比 · 检出引擎不主动报的事件 → EventBus
 *   ④ WorldStateBuilder · 汇总不可变 WorldStateView
 *
 * 输出双路：
 *   名词态 WorldStateView → 写入 WorldState Store（所有层 query）
 *   动词态 BusEvent       → publish 到 EventBus（Supervisor / Reflex / Memory）
 */

import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { Vec3, RawEntity } from '../../adapter/types.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type {
  WorldStateView,
  OwnerView,
  SelfView,
  EnvironmentView,
  EntityView,
  InventoryView,
  InventoryItemView,
} from '../types.js';

export interface PerceptionConfig {
  /** 主人玩家名 · 用来识别 owner */
  ownerName: string;
  /** 主人别名列表（游戏 ID / Web 用户名等）· 任一匹配即视为 owner */
  ownerAliases?: string[];
}

interface PrevSnapshot {
  health: number;
  ownerDistance: number;
  ownerVisible: boolean;
  /** 上 tick 的 hoe 状态 · 用来检测 tool_broken */
  heldDurability: number | null;
  heldName: string | null;
  /** 最近收到的 chat（用于 chat-from-owner 事件） */
  pendingChats: Array<{ sender: string; message: string }>;
}

export class PerceptionPipeline {
  private prev: PrevSnapshot = {
    health: 20,
    ownerDistance: Infinity,
    ownerVisible: false,
    heldDurability: null,
    heldName: null,
    pendingChats: [],
  };
  private latest: WorldStateView | null = null;
  private tickCounter = 0;
  /** 所有主人名字（ownerName + ownerAliases 合并去重） */
  private readonly ownerNames: Set<string>;

  constructor(
    private readonly game: GameAdapter,
    private readonly bus: EventBusV2,
    private readonly cfg: PerceptionConfig,
  ) {
    this.ownerNames = new Set([cfg.ownerName, ...(cfg.ownerAliases ?? [])]);
    // 把 chat 信号收集起来，下一个 tick 的 ① Perceive 时 emit 一次 BusEvent
    this.game.onChat((sender, message) => {
      this.prev.pendingChats.push({ sender, message });
    });
  }

  /** 判断 username 是否是主人（支持多别名） */
  private isOwner(username: string): boolean {
    return this.ownerNames.has(username);
  }

  /** Heartbeat ① Perceive · 一次 tick · 返回新的 WorldStateView 并 publish 检测出的事件 */
  perceive(): WorldStateView {
    this.tickCounter += 1;

    // ① SensorAdapter · 从 GameAdapter 拿原始数据
    const selfPos = this.game.getPosition();
    const orient = this.game.getOrientation();
    const health = this.game.getHealth();
    const food = this.game.getFood();
    const entitiesRaw = this.game.getEntities();

    // ② StateInterpreter · 语义解释
    const self: SelfView = {
      position: selfPos,
      yaw: orient.yaw,
      pitch: orient.pitch,
      health,
      maxHealth: 20,
      food,
      isOnGround: this.game.isOnGround(),
      heldSlot: this.game.getSelectedSlot(),
      xpLevel: this.game.getExperienceLevel(),
      oxygen: this.game.getOxygen(),
      effects: this.game.getEffects(),
    };

    const owner = this.interpretOwner(selfPos, entitiesRaw);

    const env: EnvironmentView = {
      dimension: this.game.getDimension(),
      timeOfDay: this.game.getTimeOfDay(),
      isDay: this.isDay(this.game.getTimeOfDay()),
      isRaining: this.game.isRaining(),
    };

    // 先 map 全量实体（计算距离 + 分类），再按优先级截取前 32 个。
    // 优先级：player > hostile > 距离近的其它。避免大量被动生物把玩家挤出列表。
    // 排除 bot 自身（mineflayer 的 bot.entities 含自己）
    const botUsername = this.game.username;
    const allEntities: EntityView[] = entitiesRaw
      .filter(e => !(e.type === 'player' && e.username === botUsername))
      .map(e => ({
        id: e.id,
        // 玩家实体用 username 作为显示名（mineflayer entity.name 对玩家只是 "player"）
        name: e.type === 'player' && e.username ? e.username : e.name,
        type: e.type,
        position: e.position,
        distance: dist3(selfPos, e.position),
        category: categorize(e),
        yaw: e.yaw,
        ...(e.droppedItem ? { droppedItem: structuredClone(e.droppedItem) } : {}),
      }));

    // 分桶：player 和 hostile 保证入选，其余按距离排序后截取
    const players = allEntities.filter(e => e.category === 'player');
    const hostiles = allEntities.filter(e => e.category === 'hostile');
    const others = allEntities
      .filter(e => e.category !== 'player' && e.category !== 'hostile')
      .sort((a, b) => a.distance - b.distance);

    const entities: EntityView[] = [
      ...players,
      ...hostiles.sort((a, b) => a.distance - b.distance),
      ...others,
    ].slice(0, 32);

    // inventory
    const itemsRaw = this.game.getInventoryItems();
    const heldRaw = this.game.getHeldItem();
    const armorRaw = this.game.getArmorItems();
    const offhandRaw = this.game.getOffhandItem();
    const inventory: InventoryView = {
      items: itemsRaw.map(toInvItem),
      held: heldRaw ? toInvItem(heldRaw) : null,
      armor: {
        head: armorRaw.head ? toInvItem(armorRaw.head) : null,
        torso: armorRaw.torso ? toInvItem(armorRaw.torso) : null,
        legs: armorRaw.legs ? toInvItem(armorRaw.legs) : null,
        feet: armorRaw.feet ? toInvItem(armorRaw.feet) : null,
      },
      offhand: offhandRaw ? toInvItem(offhandRaw) : null,
      freeSlots: this.game.getFreeSlotCount(),
    };

    // ③ EventDetector · 前后帧对比 → publish
    this.detectEvents(health, owner, inventory);

    // ④ WorldStateBuilder
    const view: WorldStateView = {
      tick: this.tickCounter,
      timestamp: Date.now(),
      self,
      owner,
      environment: env,
      entities,
      inventory,
      taskContext: null, // L6 会在 ⑤ TaskSched 步骤后写
    };

    // 更新 prev（注意：health/ownerDist 用当前值，下一 tick 再做对比）
    this.prev.health = health;
    this.prev.ownerDistance = owner?.distance ?? Infinity;
    this.prev.ownerVisible = owner?.isVisible ?? false;
    this.prev.heldDurability = inventory.held?.durability ?? null;
    this.prev.heldName = inventory.held?.name ?? null;

    this.latest = view;
    return view;
  }

  /** 所有层都通过这个口子读 WorldState，禁止直接读 L0/L1 */
  getWorldState(): WorldStateView | null {
    return this.latest;
  }

  // ────────────────────────── private ──────────────────────────

  private interpretOwner(selfPos: Vec3, entities: RawEntity[]): OwnerView | null {
    // 尝试所有 owner 别名，找到第一个在线的
    for (const name of this.ownerNames) {
      const ownerEntity = entities.find(
        e => e.type === 'player' && e.username === name,
      );
      if (ownerEntity) {
        const pos = ownerEntity.position;
        return {
          username: name,
          position: pos,
          distance: dist3(selfPos, pos),
          entityId: ownerEntity.id,
          isVisible: true,
          yaw: ownerEntity.yaw,
        };
      }
    }
    // 都不在视野内，尝试通过 getPlayer API 查
    for (const name of this.ownerNames) {
      const player = this.game.getPlayer(name);
      if (player) {
        return {
          username: name,
          position: null,
          distance: Infinity,
          entityId: null,
          isVisible: false,
        };
      }
    }
    return null;
  }

  private detectEvents(
    health: number,
    owner: OwnerView | null,
    inventory: InventoryView,
  ): void {
    // A. 受伤检测（health 下降 ≥ 1 → critical · 由 EventBus 二次仲裁）
    if (health < this.prev.health) {
      const delta = this.prev.health - health;
      const level = health <= 6 || delta >= 6 ? 'critical' : 'recoverable';
      this.bus.publish('under_attack', level, {
        prevHealth: this.prev.health,
        currHealth: health,
        damage: delta,
      });
    }

    // B. owner 从不可见 → 可见
    if (owner?.isVisible && !this.prev.ownerVisible) {
      this.bus.publish('owner_appeared', 'info', {
        ownerId: owner.entityId,
        distance: owner.distance,
      });
    }

    // C. owner 进入 / 离开 follow 半径
    const ENTER_RANGE = 8;
    const prevDist = this.prev.ownerDistance;
    const currDist = owner?.distance ?? Infinity;
    if (prevDist > ENTER_RANGE && currDist <= ENTER_RANGE) {
      this.bus.publish('owner_in_range', 'info', { distance: currDist });
    }
    if (prevDist <= ENTER_RANGE && currDist > ENTER_RANGE) {
      this.bus.publish('owner_left_range', 'info', { distance: currDist });
    }

    // D. 收 chat → emit chat.from_owner（如果是 owner 说的）
    const chats = this.prev.pendingChats;
    if (chats.length > 0) {
      for (const c of chats) {
        const isOwner = this.isOwner(c.sender);
        this.bus.publish(
          isOwner ? 'chat.from_owner' : 'chat.from_other',
          isOwner ? 'suggestion' : 'info',
          { sender: c.sender, message: c.message },
        );
      }
      this.prev.pendingChats = [];
    }

    // E. 工具坏了：手持工具耐久从 >0 → 0，或上一帧持有工具但这一帧没了
    const held = inventory.held;
    const heldName = held?.name ?? null;
    const heldDur = held?.durability ?? null;
    const sameItem = this.prev.heldName === heldName;
    if (sameItem && this.prev.heldDurability != null && this.prev.heldDurability > 0) {
      if (heldDur === 0) {
        this.bus.publish('tool_broken', 'recoverable', {
          name: heldName,
          slot: held?.slot,
        });
      } else if (heldDur != null && heldDur <= 3 && this.prev.heldDurability > 3) {
        // 即将耗尽预警
        this.bus.publish('tool_low_durability', 'info', {
          name: heldName,
          durability: heldDur,
        });
      }
    }
  }

  private isDay(timeOfDay: number): boolean {
    // MC time: 0 = sunrise, 12000 = sunset
    return timeOfDay < 13000 && timeOfDay > 0;
  }
}

function toInvItem(it: {
  name: string;
  count: number;
  slot: number;
  durability?: number;
  maxDurability?: number;
}): InventoryItemView {
  return {
    name: it.name,
    count: it.count,
    slot: it.slot,
    durability: it.durability,
    maxDurability: it.maxDurability,
  };
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function categorize(e: RawEntity): EntityView['category'] {
  if (e.type === 'player') return 'player';
  if (e.droppedItem) return 'item';
  const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman'];
  if (hostiles.some(h => e.name.includes(h))) return 'hostile';
  const passives = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
  if (passives.some(p => e.name.includes(p))) return 'passive';
  return 'other';
}
