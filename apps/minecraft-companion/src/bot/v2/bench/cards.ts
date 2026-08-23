/** FEAT-CROSS-04：TestBench 阶梯卡；setup/judge 字段与 eval 场景契约保持同型。 */
export type TestTier = 'T0' | 'T1' | 'T2' | 'T3';
export type JudgeSpec =
  | { type: 'inventory_gte'; item: string; count: number }
  | { type: 'position_reached'; position: { x: number; y: number; z: number }; range: number }
  | { type: 'event_seen'; event: string };

export interface TestCard {
  id: string;
  tier: TestTier;
  title: string;
  setup: string[];
  launch: { type: 'action'; action: string; args: Record<string, unknown> } | { type: 'task'; kind: string; params: Record<string, unknown> };
  judge: JudgeSpec;
  timeoutMs: number;
}

const action = (id: string, tier: TestTier, title: string, name: string, args: Record<string, unknown>, judge: JudgeSpec): TestCard =>
  ({ id, tier, title, setup: ['/time set day', '/clear @s'], launch: { type: 'action', action: name, args }, judge, timeoutMs: 30_000 });
const task = (id: string, tier: TestTier, title: string, kind: string, params: Record<string, unknown>, judge: JudgeSpec): TestCard =>
  ({ id, tier, title, setup: ['/time set day', '/clear @s'], launch: { type: 'task', kind, params }, judge, timeoutMs: 90_000 });

export const TEST_CARDS: readonly TestCard[] = [
  action('walk_to_10', 'T0', '走到目标点', 'move_to', { position: { x: 10, y: 64, z: 0 } }, { type: 'position_reached', position: { x: 10, y: 64, z: 0 }, range: 1.5 }),
  action('through_door', 'T0', '穿过门', 'move_to', { position: { x: 4, y: 64, z: 0 } }, { type: 'position_reached', position: { x: 4, y: 64, z: 0 }, range: 1.5 }),
  action('dig_one', 'T0', '挖掘一个方块', 'dig', { position: { x: 2, y: 64, z: 0 } }, { type: 'event_seen', event: 'atomic.dig.success' }),
  action('look_use', 'T0', '观察并使用物品', 'use_tool', { itemName: 'stick' }, { type: 'event_seen', event: 'atomic.use_tool.success' }),
  action('climb_slope_10', 'T1', '攀爬斜坡', 'move_to', { position: { x: 10, y: 70, z: 0 } }, { type: 'position_reached', position: { x: 10, y: 70, z: 0 }, range: 2 }),
  task('gather_1_log', 'T1', '采集一根原木', 'gather_material', { material: 'oak_log', count: 1 }, { type: 'inventory_gte', item: 'oak_log', count: 1 }),
  action('pickup_drop', 'T1', '拾取掉落物', 'move_to', { position: { x: 3, y: 64, z: 0 } }, { type: 'event_seen', event: 'atomic.move_to.end' }),
  task('craft_planks', 'T1', '合成木板', 'craft_item', { itemName: 'oak_planks', count: 4 }, { type: 'inventory_gte', item: 'oak_planks', count: 4 }),
  task('gather_8_wood_clean', 'T2', '无干扰采集八根原木', 'gather_material', { material: 'oak_log', count: 8 }, { type: 'inventory_gte', item: 'oak_log', count: 8 }),
  task('gather_8_wood_hostile', 'T2', '有威胁采集八根原木', 'gather_material', { material: 'oak_log', count: 8 }, { type: 'inventory_gte', item: 'oak_log', count: 8 }),
  task('craft_wooden_pickaxe', 'T2', '合成木镐', 'craft_item', { itemName: 'wooden_pickaxe', count: 1 }, { type: 'inventory_gte', item: 'wooden_pickaxe', count: 1 }),
  task('idle_gather_loop', 'T3', '自主采集闭环', 'gather_material', { material: 'oak_log', count: 2 }, { type: 'inventory_gte', item: 'oak_log', count: 2 }),
  task('backoff_on_fail', 'T3', '连续失败后退避', 'gather_material', { material: 'unobtainium', count: 1 }, { type: 'event_seen', event: 'task.failed' }),
];

export function getTestCard(id: string): TestCard | undefined { return TEST_CARDS.find(card => card.id === id); }
