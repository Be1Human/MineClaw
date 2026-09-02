import type { Bot } from 'mineflayer';
import vec3pkg from 'vec3';
import type { Vec3 as MFVec3 } from 'vec3';
import type { GameView } from '../adapter/GameAdapter.js';
import type { BoundGameActions, DeviceExecutionScope, GameActions } from '../adapter/GameActions.js';
import type { ChestOpResult, ControlKey, CraftResult, EquipDestination, RawBlock, SmeltResult, Vec3 } from '../adapter/types.js';
import { tuning } from '../v2/infra/tuning.js';

const Vec3Ctor = (vec3pkg as unknown as { Vec3: new (x: number, y: number, z: number) => MFVec3 }).Vec3
  ?? (vec3pkg as unknown as new (x: number, y: number, z: number) => MFVec3);
const vector = (p: Vec3) => new Vec3Ctor(p.x, p.y, p.z);
type Container = Awaited<ReturnType<Bot['openContainer']>>;
type WindowHandle = { close(): void };

/** One physical device and one operation lifetime. No priority arbitration or reconnection lookup. */
export class MineflayerActionSession implements BoundGameActions, GameActions {
  readonly actions: GameActions = this;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly windows = new Set<WindowHandle>();
  private closed = false;
  private controlsUsed = false;
  private digging = false;
  private usingItem = false;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly bot: Bot,
    readonly view: GameView,
    private readonly scope: DeviceExecutionScope,
    private readonly isDeviceCurrent: () => boolean,
  ) {}

  private check(): void {
    this.scope.assertCurrent('device_action');
    if (this.closed) throw new Error('device_session_closed');
    if (!this.isDeviceCurrent()) throw new Error('device_generation_changed');
  }

  /** Keep the actual native promise alive even when the operation has been cancelled. */
  private native<T>(run: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    const work = this.scope.effect(() => {
      this.check();
      return run();
    });
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  stop(_reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = this.drain();
    return this.stopping;
  }

  private async drain(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = (fn: () => void) => { try { fn(); } catch (error) { failures.push(error); } };
    // Interruption is not acknowledgement: consume/craft/window operations may still be pending.
    if (this.digging) attempt(() => this.bot.stopDigging());
    if (this.usingItem) attempt(() => this.bot.deactivateItem());
    if (this.controlsUsed) attempt(() => this.bot.clearControlStates());
    await Promise.allSettled([...this.pending]);
    // A window may finish opening after stop was requested. It still belongs to this session.
    for (const window of this.windows) attempt(() => this.closeWindow(window));
    if (failures.length) throw new AggregateError(failures, 'device_cleanup_failed');
  }

  private closeWindow(window: WindowHandle): void {
    if (!this.windows.has(window)) return;
    window.close();
    this.windows.delete(window);
  }

  private block(pos: Vec3) {
    this.check();
    const block = this.bot.blockAt(vector(pos));
    if (!block) throw new Error('block_unavailable');
    return block;
  }

  setControlState(key: ControlKey, value: boolean): Promise<void> {
    return this.native(() => { this.controlsUsed = true; this.bot.setControlState(key, value); });
  }
  clearControlStates(): Promise<void> {
    return this.native(() => { this.bot.clearControlStates(); this.controlsUsed = false; });
  }
  lookAt(target: Vec3, force?: boolean): Promise<void> { return this.native(() => this.bot.lookAt(vector(target), force)); }
  look(yaw: number, pitch: number, force?: boolean): Promise<void> { return this.native(() => this.bot.look(yaw, pitch, force)); }
  attack(entityId: number): Promise<void> {
    return this.native(() => {
      const target = this.bot.entities[entityId];
      if (!target) throw new Error('target_not_found');
      this.bot.attack(target);
    });
  }
  async dig(pos: Vec3): Promise<void> {
    const block = this.block(pos);
    try { await this.native(() => { this.digging = true; return this.bot.dig(block); }); }
    finally { this.digging = false; }
  }
  equip(itemName: string, destination: EquipDestination = 'hand'): Promise<void> {
    return this.native(() => {
      const item = this.bot.inventory.items().find(value => value.name === itemName);
      if (!item) throw new Error(`equip_failed: missing ${itemName}`);
      return this.bot.equip(item, destination);
    });
  }
  async toss(itemName: string, count?: number): Promise<number> {
    this.check();
    const stacks = this.bot.inventory.items().filter(item => item.name === itemName);
    const have = stacks.reduce((sum, item) => sum + item.count, 0);
    const want = count == null ? have : Math.max(0, Math.min(count, have));
    let tossed = 0;
    for (const stack of stacks) {
      if (tossed >= want) break;
      const amount = Math.min(stack.count, want - tossed);
      await this.native(() => this.bot.toss(stack.type, null, amount));
      tossed += amount;
    }
    return tossed;
  }
  activateItem(offHand?: boolean): Promise<void> {
    return this.native(() => { this.usingItem = true; this.bot.activateItem(offHand); });
  }
  deactivateItem(): Promise<void> {
    return this.native(() => { this.bot.deactivateItem(); this.usingItem = false; });
  }
  async interactBlock(pos: Vec3): Promise<void> {
    const block = this.block(pos);
    await this.lookAt({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }, true);
    await this.native(() => this.bot.activateBlock(block));
  }
  placeBlock(reference: RawBlock, face: Vec3): Promise<void> {
    const block = this.block(reference.position);
    return this.native(() => this.bot.placeBlock(block, vector(face)));
  }
  async consume(): Promise<boolean> {
    try { await this.native(() => { this.usingItem = true; return this.bot.consume(); }); return true; }
    finally { this.usingItem = false; }
  }
  sleep(pos: Vec3): Promise<void> { const block = this.block(pos); return this.native(() => this.bot.sleep(block)); }
  wake(): Promise<void> { return this.native(() => this.bot.wake()); }
  mount(entityId: number): Promise<void> {
    return this.native(() => {
      const entity = this.bot.entities[entityId];
      if (!entity) throw new Error('mount_target_not_found');
      this.bot.mount(entity);
    });
  }
  dismount(): Promise<void> { return this.native(() => this.bot.dismount()); }

  private openContainer(pos: Vec3): Promise<Container> {
    const block = this.block(pos);
    return this.native(async () => {
      const container = await this.bot.openContainer(block);
      this.windows.add(container);
      return container;
    });
  }

  depositToChest(pos: Vec3, itemName: string, count: number): Promise<ChestOpResult> {
    return this.transfer(pos, itemName, count, 'deposit');
  }
  withdrawFromChest(pos: Vec3, itemName: string, count: number): Promise<ChestOpResult> {
    return this.transfer(pos, itemName, count, 'withdraw');
  }
  private async transfer(pos: Vec3, itemName: string, count: number, direction: 'deposit' | 'withdraw'): Promise<ChestOpResult> {
    this.check();
    const definition = this.bot.registry.itemsByName[itemName];
    if (!definition) return { ok: false, moved: 0, reason: `unknown_item:${itemName}` };
    const container = await this.openContainer(pos);
    try {
      const items = direction === 'deposit' ? this.bot.inventory.items() : container.containerItems();
      const have = items.filter(item => item.name === itemName).reduce((sum, item) => sum + item.count, 0);
      const moved = Math.min(count, have);
      if (moved > 0) await this.native(() => container[direction](definition.id, null, moved));
      const contents = [...new Set(container.containerItems().map(item => item.name))];
      return { ok: moved > 0, moved, contents, ...(moved > 0 ? {} : { reason: direction === 'deposit' ? 'no_such_item_in_inventory' : 'no_such_item_in_chest' }) };
    } finally { this.closeWindow(container); }
  }

  async craft(itemName: string, count: number, tablePos: Vec3 | null): Promise<CraftResult> {
    this.check();
    const item = this.bot.registry.itemsByName[itemName];
    if (!item) return { ok: false, reason: `unknown_item:${itemName}` };
    const table = tablePos ? this.block(tablePos) : null;
    const recipes = this.bot.recipesFor(item.id, null, 1, table as unknown as null);
    if (!recipes.length) return { ok: false, reason: 'no_craftable_recipe' };
    await this.native(() => this.bot.craft(recipes[0], count, table ?? undefined));
    return { ok: true };
  }

  async smelt(pos: Vec3, input: string, fuel: string, count: number): Promise<SmeltResult> {
    this.check();
    const inputItem = this.bot.registry.itemsByName[input];
    const fuelItem = this.bot.registry.itemsByName[fuel];
    if (!inputItem || !fuelItem) return { ok: false, produced: 0, reason: `unknown_item:${!inputItem ? input : fuel}` };
    const block = this.block(pos);
    const furnace = await this.native(async () => {
      const opened = await this.bot.openFurnace(block);
      this.windows.add(opened);
      return opened;
    });
    try {
      const perFuel = fuel === 'coal_block' ? 80 : fuel === 'lava_bucket' ? 100 : /^(coal|charcoal)$/.test(fuel) ? 8 : 1.5;
      if (!furnace.fuelItem()) await this.native(() => furnace.putFuel(fuelItem.id, null, Math.max(1, Math.ceil(count / perFuel))));
      if (!furnace.inputItem()) await this.native(() => furnace.putInput(inputItem.id, null, count));
      let produced = 0;
      const cfg = tuning().deviceActions;
      const deadline = Date.now() + count * cfg.smeltItemTimeoutMs + cfg.smeltOverheadMs;
      while (produced < count && Date.now() < deadline) {
        await this.scope.wait(tuning().deviceActions.smeltPollMs);
        this.check();
        const output = furnace.outputItem();
        if (output && output.count > 0) {
          const amount = output.count;
          await this.native(() => furnace.takeOutput());
          produced += amount;
        }
      }
      return { ok: produced > 0, produced, ...(produced > 0 ? {} : { reason: 'smelt_timeout' }) };
    } finally { this.closeWindow(furnace); }
  }
}
