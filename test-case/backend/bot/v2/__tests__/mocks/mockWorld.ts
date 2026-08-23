/**
 * MockWorld — 可脚本化的世界状态
 *
 * 维护 self.position / health / inventory / entities[] / owner
 * 提供 addEntity / removeEntity / setHealth / setPosition / step(ms) API
 * 用于场景测试的时间线控制
 */

export interface MockSelf {
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  health: number;
  maxHealth: number;
  food: number;
  isOnGround: boolean;
}

export interface MockEntity {
  entityId: number;
  username?: string;
  type: 'player' | 'mob';
  category: 'hostile' | 'passive' | 'neutral' | 'player';
  name: string;
  position: { x: number; y: number; z: number };
  health?: number;
  metadata?: Record<string, unknown>;
}

export interface MockItem {
  name: string;
  count: number;
  slot: number;
  durability?: number;
  maxDurability?: number;
}

export class MockWorld {
  self: MockSelf = {
    position: { x: 0, y: 64, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 20,
    maxHealth: 20,
    food: 20,
    isOnGround: true,
  };

  entities: MockEntity[] = [];
  inventory: MockItem[] = [];
  /** 手持物品是 Adapter 可观测状态；装备不移除背包中的原始条目。 */
  heldItem: MockItem | null = null;
  dimension = 'overworld';
  timeOfDay = 6000;
  isRaining = false;

  /** owner entity (special player entity) */
  owner: { username: string; entityId: number } | null = null;

  private tickCount = 0;
  private scheduledEvents: Array<{ atMs: number; fn: () => void }> = [];

  addEntity(entity: MockEntity): void {
    this.entities.push(entity);
  }

  removeEntity(entityId: number): void {
    this.entities = this.entities.filter(e => e.entityId !== entityId);
  }

  setHealth(h: number): void {
    this.self.health = h;
  }

  setPosition(pos: { x: number; y: number; z: number }): void {
    this.self.position = pos;
  }

  setOwner(
    username: string,
    entityId: number,
    position: { x: number; y: number; z: number },
  ): void {
    this.owner = { username, entityId };
    // Also add as player entity
    const existing = this.entities.find(e => e.entityId === entityId);
    if (!existing) {
      this.entities.push({
        entityId,
        username,
        type: 'player',
        category: 'player',
        name: username,
        position,
      });
    }
  }

  addItem(item: MockItem): void {
    this.inventory.push(item);
  }

  removeItem(name: string): void {
    this.inventory = this.inventory.filter(i => i.name !== name);
  }

  /** Schedule a callback at a specific millisecond offset from now */
  scheduleAt(atMs: number, fn: () => void): void {
    this.scheduledEvents.push({ atMs: Date.now() + atMs, fn });
  }

  /** Process scheduled events up to current time */
  tick(): void {
    this.tickCount++;
    const now = Date.now();
    const due = this.scheduledEvents.filter(e => e.atMs <= now);
    this.scheduledEvents = this.scheduledEvents.filter(e => e.atMs > now);
    for (const e of due) e.fn();
  }

  get currentTick(): number {
    return this.tickCount;
  }
}
