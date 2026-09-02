import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Move } from 'mineflayer-pathfinder';
import pkg from 'mineflayer-pathfinder';
import vec3pkg from 'vec3';
import type { Vec3 as MFVec3 } from 'vec3';
import type { DoorPassageRequest, GotoOptions, NavGoal } from '../adapter/NavigationAdapter.js';
import type { BoundNavigation, NavigationActions, NavigationBindingInput } from '../adapter/NavigationExecution.js';
import type { MovementOptions, NavResult, Vec3 } from '../adapter/types.js';
import { tuning } from '../v2/infra/tuning.js';
import { DoorTransparentMovements } from './doorTransparentMovements.js';
import { computeDoorAlignmentTarget, computeDoorPassageTarget, hasCrossedDoorPlane, isOrdinaryDoor } from './doorPassageGeometry.js';

const { goals } = pkg;
const Vec3Ctor = (vec3pkg as unknown as { Vec3: new (x: number, y: number, z: number) => MFVec3 }).Vec3
  ?? (vec3pkg as unknown as new (x: number, y: number, z: number) => MFVec3);
const vector = (p: Vec3) => new Vec3Ctor(p.x, p.y, p.z);
type Goal = import('mineflayer-pathfinder').goals.Goal;
interface PhysicsQueries {
  canStraightLine(path: Move[], sprint?: boolean): boolean;
  canSprintJump(path: Move[]): boolean;
  canWalkJump(path: Move[]): boolean;
}
const Physics = createRequire(import.meta.url)('mineflayer-pathfinder/lib/physics') as new (bot: Bot) => PhysicsQueries;
interface Placement extends Vec3 { dx: number; dy: number; dz: number; jump?: boolean; useOne?: boolean; returnPos?: Vec3 }
interface MovementRun { cancelled: boolean; goal: NavGoal; work: Promise<NavResult> }

/**
 * A* and physics queries are reused; the library's background movement executor is never started.
 * Waypoint centering/physics steering derive from mineflayer-pathfinder (MIT, see pathfinder-NOTICE).
 * Every physical operation and maintenance step is joined to this session's operation lifetime.
 */
export class MineflayerNavigationSession implements BoundNavigation {
  readonly actions: NavigationActions;
  private readonly physics: PhysicsQueries;
  private active: MovementRun | null = null;
  private path: Move[] = [];
  private mining = false;
  private building = false;
  private closed = false;
  private stopping: Promise<void> | null = null;
  private overrides: MovementOptions = {};
  private movementKey = '';
  private cachedMovements: DoorTransparentMovements | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly input: NavigationBindingInput,
    private readonly defaults: () => MovementOptions,
    private readonly isDeviceCurrent: () => boolean,
    private readonly emit: (event: string, value?: unknown) => void,
  ) {
    this.physics = new Physics(bot);
    this.actions = {
      goto: (goal, options) => this.start(goal, options),
      follow: (entityId, range) => this.start({ type: 'follow_entity', entityId, range }),
      guideThroughDoor: request => this.passDoor(request),
      replan: () => { this.check(); this.setPath([]); },
      stop: () => this.stopMovement(),
      setMovementOptions: options => { this.check(); this.overrides = { ...this.overrides, ...options }; },
      isMoving: () => this.path.length > 0,
      isFollowing: entityId => this.active?.goal.type === 'follow_entity'
        && (entityId === undefined || this.active.goal.entityId === entityId),
      isMining: () => this.mining, isBuilding: () => this.building,
      getCurrentGoal: () => this.active?.goal ?? null,
      getCurrentPath: () => this.path.map(({ x, y, z }) => ({ x, y, z })),
    };
  }

  private check(run?: MovementRun): void {
    this.input.scope.assertCurrent('navigation_step');
    if (this.closed || !this.isDeviceCurrent()) throw new Error('navigation_session_closed');
    if (run && (run.cancelled || this.active !== run)) throw new Error('navigation_cancelled');
  }

  private async step<T>(run: MovementRun, action: () => Promise<T>): Promise<T> {
    this.check(run);
    const result = await action();
    this.check(run);
    return result;
  }

  private start(goal: NavGoal, options?: GotoOptions): Promise<NavResult> {
    this.check();
    if (this.active) throw new Error('navigation_step_already_running');
    const run = { goal, cancelled: false } as MovementRun;
    this.active = run;
    run.work = Promise.resolve().then(() => this.navigate(run, options)).finally(async () => {
      // The operation retains the device until this finally and native work finish.
      if (!this.input.scope.signal.aborted && !this.closed && this.isDeviceCurrent()) {
        await this.input.game.actions.clearControlStates();
      }
      if (this.active === run) this.active = null;
      this.setPath([]);
      this.emit('goal_updated', null);
      this.emit('path_stop',run.cancelled || this.closed ? 'cancelled':'settled');
    });
    this.emit('goal_updated', goal);
    return run.work;
  }

  private async stopMovement(): Promise<void> {
    this.check();
    const run = this.active;
    if (!run) return;
    run.cancelled = true;
    await run.work;
    this.check();
  }

  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    const run = this.active;
    if (run) run.cancelled = true;
    this.stopping = (async () => {
      const results = await Promise.allSettled([this.input.game.stop(reason), ...(run ? [run.work] : [])]);
      // A failed move is an outcome; a failed device cleanup must keep the body quarantined.
      if (results[0].status === 'rejected') throw results[0].reason;
    })();
    return this.stopping;
  }

  private async navigate(run: MovementRun, options?: GotoOptions): Promise<NavResult> {
    const dynamic = run.goal.type === 'follow_entity';
    const deadline = dynamic ? Infinity : Date.now() + (options?.totalTimeout ?? tuning().navigationExecution.gotoTimeoutMs);
    let lastProgress = Date.now();
    try {
      let goal = this.goal(run.goal);
      if (!goal) return { ok: false, reason: 'target_not_found' };
      while (Date.now() < deadline) {
        this.check(run);
        if (dynamic && run.goal.type === 'follow_entity' && !this.bot.entities[run.goal.entityId]) {
          return { ok: false, reason: 'entity_not_found' };
        }
        if (!goal.isValid()) return { ok: false, reason: 'invalid_goal' };
        if (goal.hasChanged()) { this.setPath([]); goal = this.goal(run.goal)!; }
        if (this.atGoal(goal)) {
          if (!dynamic) { this.emit('goal_reached'); return { ok: true }; }
          if (this.path.length) {
            await this.step(run, () => this.input.game.actions.clearControlStates());
            this.setPath([]);
          }
          await this.step(run, () => this.input.scope.wait(tuning().navigationExecution.controlTickMs));
          continue;
        }
        const movements = this.movements();
        if (!this.path.length) {
          const planned = await this.plan(run, goal, movements, options);
          if (!planned.length) return { ok: false, reason: 'noPath' };
          this.setPath(planned);
          lastProgress = Date.now();
        }
        // Door/recovery work runs inside this operation, never as a detached heartbeat action.
        await this.step(run, () => this.input.maintain(this.actions));
        const node = this.path[0];
        if (!node) continue;
        if (node.toBreak.length || node.toPlace.length) {
          await this.nodeActions(run, node, movements);
          this.setPath([]);
          continue;
        }
        const position = this.bot.entity.position;
        const cfg = tuning().navigationExecution;
        if (Math.abs(node.x - position.x) <= cfg.waypointRange && Math.abs(node.z - position.z) <= cfg.waypointRange
          && Math.abs(node.y - position.y) < cfg.verticalTolerance) {
          this.path.shift(); this.emit('path_update', this.actions.getCurrentPath());
          lastProgress = Date.now();
          continue;
        }
        if (Date.now() - lastProgress > cfg.nodeTimeoutMs) {
          this.setPath([]);
          await this.step(run, () => this.input.game.actions.clearControlStates());
          continue;
        }
        await this.steer(run, movements);
        await this.step(run, () => this.input.scope.wait(tuning().navigationExecution.controlTickMs));
      }
      return { ok: false, reason: 'nav_timeout' };
    } catch (error) {
      return { ok: false, reason: this.closed || run.cancelled || this.input.scope.signal.aborted ? 'cancelled' : String(error) };
    }
  }

  private async plan(run: MovementRun, goal: Goal, movements: DoorTransparentMovements, options?: GotoOptions): Promise<Move[]> {
    // optimizePath=false keeps this generator independent from the library's live executor state.
    const iterator = this.bot.pathfinder.getPathFromTo(movements, this.bot.entity.position, goal, {
      optimizePath: false, timeout: options?.thinkTimeout ?? tuning().navigationExecution.thinkTimeoutMs,
      tickTimeout: options?.tickTimeout ?? tuning().navigationExecution.thinkSliceMs,
    });
    try {
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        this.check(run);
        if (next.value.result.path.length) return this.centerPath(next.value.result.path);
        if (String(next.value.result.status) !== 'partial') return [];
        await this.step(run, () => this.input.scope.wait(0));
      }
      return [];
    } finally { iterator.return?.(); }
  }

  private async steer(run: MovementRun, movements: DoorTransparentMovements): Promise<void> {
    const next = this.path[0], position = this.bot.entity.position;
    let jump = false, sprint = false, forward = true;
    if ((this.bot.entity as typeof this.bot.entity & { isInWater?: boolean }).isInWater) jump = true;
    else if (movements.allowSprinting && this.physics.canStraightLine(this.path, true)) sprint = true;
    else if (movements.allowSprinting && this.physics.canSprintJump(this.path)) { jump = true; sprint = true; }
    else if (this.physics.canStraightLine(this.path)) { /* Ordinary walking. */ }
    else if (this.physics.canWalkJump(this.path)) jump = true;
    else forward = false;
    await this.step(run, () => this.input.game.actions.look(Math.atan2(position.x - next.x, position.z - next.z), 0, true));
    for (const [key, value] of [['forward', forward], ['jump', jump], ['sprint', sprint]] as const) {
      await this.step(run, () => this.input.game.actions.setControlState(key, value));
    }
  }

  private async nodeActions(run: MovementRun, node: Move, movements: DoorTransparentMovements): Promise<void> {
    await this.step(run, () => this.input.game.actions.clearControlStates());
    for (const position of node.toBreak) {
      this.check(run);
      const block = this.bot.blockAt(vector(position));
      if (!block || block.boundingBox === 'empty') continue;
      if (!movements.canDig || movements.blocksCantBreak.has(block.type)) throw new Error('navigation_dig_not_allowed');
      this.mining = true;
      try {
        const tool = this.bot.pathfinder.bestHarvestTool(block);
        if (tool) await this.step(run, () => this.input.game.actions.equip(tool.name));
        await this.step(run, () => this.input.game.actions.dig(position));
      } finally { this.mining = false; }
    }
    for (const placement of node.toPlace as unknown as Placement[]) {
      if (placement.useOne) {
        await this.step(run, () => this.input.game.actions.interactBlock(placement));
        continue;
      }
      this.building = true;
      try {
        const item = movements.getScaffoldingItem();
        if (!item) throw new Error('no_scaffolding_blocks');
        const ref = this.input.game.view.getBlockAt(placement);
        if (!ref) throw new Error('placement_reference_unavailable');
        await this.step(run, () => this.input.game.actions.equip(item.name));
        if (tuning().navigationExecution.bridgeLineOfSight && placement.dy===0
          && placement.y===Math.floor(this.bot.entity.position.y)-1) {
          const edge={x:placement.x+placement.dx+0.5,y:placement.y+1,z:placement.z+placement.dz+0.5};
          const reached=await this.drive(run,edge,tuning().navigationExecution.bridgeApproachTimeoutMs,true,
            ()=>this.bot.entity.position.distanceTo(vector(edge))<=tuning().navigationExecution.bridgeEdgeRange);
          if (!reached) throw new Error('bridge_edge_unreachable');
          await this.step(run,()=>this.input.game.actions.clearControlStates());
        }
        if (placement.jump) {
          await this.step(run, () => this.input.game.actions.setControlState('jump', true));
          const deadline = Date.now() + tuning().navigationExecution.bridgeApproachTimeoutMs;
          while (this.bot.entity.position.y <= placement.y + 1 && Date.now() < deadline) {
            await this.step(run, () => this.input.scope.wait(tuning().navigationExecution.controlTickMs));
          }
          if (this.bot.entity.position.y <= placement.y + 1) throw new Error('bridge_jump_failed');
        }
        await this.step(run, () => this.input.game.actions.setControlState('sneak', true));
        await this.step(run, () => this.input.game.actions.placeBlock(ref, { x: placement.dx, y: placement.dy, z: placement.dz }));
        await this.step(run, () => this.input.game.actions.clearControlStates());
        if (tuning().navigationExecution.bridgeLineOfSight && placement.returnPos) {
          const target={x:placement.returnPos.x+0.5,y:placement.returnPos.y,z:placement.returnPos.z+0.5};
          const reached=await this.drive(run,target,tuning().navigationExecution.bridgeApproachTimeoutMs,true,
            ()=>this.bot.entity.position.distanceTo(vector(target))<=tuning().navigationExecution.waypointRange);
          if (!reached) throw new Error('bridge_return_unreachable');
          await this.step(run,()=>this.input.game.actions.clearControlStates());
        }
      } finally { this.building = false; }
    }
  }

  private async passDoor(request: DoorPassageRequest): Promise<NavResult> {
    const run = this.active;
    if (!run) return { ok: false, reason: 'no_active_navigation' };
    if (!isOrdinaryDoor(request.blockName)) return { ok: false, reason: 'unsupported_door_geometry' };
    const from = { ...this.input.game.view.getPosition() };
    const align = computeDoorAlignmentTarget(request, from), target = computeDoorPassageTarget(request, from);
    if (!align || !target) return { ok: false, reason: 'invalid_door_geometry' };
    await this.step(run, () => this.input.game.actions.clearControlStates());
    const cfg = tuning().navigationExecution;
    const aligned = await this.drive(run, align, cfg.doorAlignTimeoutMs, true,
      () => Math.hypot(this.bot.entity.position.x - align.x, this.bot.entity.position.z - align.z) <= tuning().navigationExecution.doorAlignRange);
    if (!aligned) {
      await this.step(run,()=>this.input.game.actions.clearControlStates());
      this.setPath([]);
      return { ok: false, reason: 'door_passage_alignment_failed' };
    }
    const crossed = await this.drive(run, target, cfg.doorCrossTimeoutMs, false,
      () => hasCrossedDoorPlane(request, from, this.input.game.view.getPosition()));
    await this.step(run, () => this.input.game.actions.clearControlStates());
    this.setPath([]);
    return crossed ? { ok: true } : { ok: false, reason: 'door_passage_not_crossed' };
  }

  private async drive(run: MovementRun, target: Vec3, duration: number, precise: boolean, reached: () => boolean): Promise<boolean> {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      this.check(run);
      if (reached()) return true;
      await this.step(run, () => this.input.game.actions.lookAt(target, true));
      await this.step(run, () => this.input.game.actions.setControlState('sneak', precise));
      await this.step(run, () => this.input.game.actions.setControlState('forward', true));
      await this.step(run, () => this.input.scope.wait(tuning().navigationExecution.controlTickMs));
    }
    return reached();
  }

  private movements(): DoorTransparentMovements {
    const options = { ...this.defaults(), ...this.overrides };
    const key = JSON.stringify(options);
    if (key === this.movementKey && this.cachedMovements) return this.cachedMovements;
    const movements = new DoorTransparentMovements(this.bot);
    if (options.canDig !== undefined) movements.canDig = options.canDig;
    if (options.allowParkour !== undefined) movements.allowParkour = options.allowParkour;
    if (options.allowSprinting !== undefined) movements.allowSprinting = options.allowSprinting;
    if (options.canPlace === false) movements.scafoldingBlocks = [];
    else if (options.scafoldingBlocks) movements.scafoldingBlocks = this.blockIds(options.scafoldingBlocks);
    for (const id of this.blockIds(options.blocksToAvoid ?? [])) movements.blocksToAvoid.add(id);
    if (options.allowedDigBlocks) {
      const allowed = new Set(this.blockIds(options.allowedDigBlocks));
      for (const block of this.bot.registry.blocksArray) if (!allowed.has(block.id)) movements.blocksCantBreak.add(block.id);
    }
    this.movementKey = key;
    this.cachedMovements = movements;
    return movements;
  }
  private blockIds(names: string[]): number[] { return names.flatMap(name => this.bot.registry.blocksByName[name]?.id ?? []); }
  private setPath(path: Move[]): void { this.path = path; this.emit('path_update', this.actions.getCurrentPath()); }
  private atGoal(goal: Goal): boolean {
    const position = this.bot.entity.position.floored();
    return goal.isEnd(position as unknown as Move) || goal.isEnd(position.offset(0, 1, 0) as unknown as Move);
  }
  private goal(goal: NavGoal): Goal | null {
    if (goal.type === 'block') return new goals.GoalNear(goal.position.x, goal.position.y, goal.position.z, goal.range ?? 1);
    if (goal.type === 'xz') return new goals.GoalXZ(goal.x, goal.z);
    const entity = goal.type === 'player' ? this.bot.players[goal.username]?.entity : this.bot.entities[goal.entityId];
    if (!entity) return null;
    if (goal.type === 'follow_entity') return new goals.GoalFollow(entity, goal.range);
    return new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, goal.range ?? 2);
  }
  private centerPath(path: Move[]): Move[] {
    for (const node of path) {
      if (node.toBreak.length || node.toPlace.length) break;
      const block = this.bot.blockAt(vector(node));
      if (block?.name === 'water' || block?.name === 'ladder' || block?.name === 'vine') {
        node.x = Math.floor(node.x) + 0.5; node.z = Math.floor(node.z) + 0.5;
        continue;
      }
      const top = standingPoint(block) ?? standingPoint(this.bot.blockAt(vector({ ...node, y: node.y - 1 })));
      node.x = top?.x ?? Math.floor(node.x) + 0.5;
      node.y = top?.y ?? node.y - 1;
      node.z = top?.z ?? Math.floor(node.z) + 0.5;
    }
    return path;
  }
}

function standingPoint(block: Block | null): Vec3 | null {
  if (!block?.shapes.length) return null;
  let height = 0, x = 0.5, z = 0.5, count = 1;
  for (const shape of block.shapes) {
    if (shape[4] < height) continue;
    if (shape[4] > height) { height = shape[4]; x = 0.5; z = 0.5; count = 1; }
    x += (shape[0] + shape[3]) / 2; z += (shape[2] + shape[5]) / 2; count++;
  }
  return { x: block.position.x + x / count, y: block.position.y + height, z: block.position.z + z / count };
}
