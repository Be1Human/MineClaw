/**
 * adapter 层 barrel —— 上层 import 唯一入口
 *
 * 用法：
 *   import type { GameAdapter, NavigationAdapter, Vec3 } from '../adapter/index.js';
 *
 * 严禁从 mineflayer 直接 import 类型；如果发现下游代码这么做，是重构未完成。
 */

export type { GameAdapter } from './GameAdapter.js';
export type { NavigationAdapter, NavGoal, GotoOptions } from './NavigationAdapter.js';
export type {
  VisualWorldSource,
  VisualWorldSnapshotOptions,
  VisualWorldBootstrap,
  VisualWorldDelta,
  VisualSection,
  VisualBlockState,
  VisualEntity,
  VisualEnvironment,
} from './VisualWorldSource.js';
export { NullGameAdapter } from './NullGameAdapter.js';
export { NullNavAdapter } from './NullNavAdapter.js';
export { SwitchableGameAdapter } from './SwitchableGameAdapter.js';
export { SwitchableNavAdapter } from './SwitchableNavAdapter.js';
export type {
  Vec3,
  RawBlock,
  RawEntity,
  RawItem,
  RawPlayer,
  ControlKey,
  EquipDestination,
  FindBlocksOptions,
  MovementOptions,
  NavResult,
  Unsubscribe,
} from './types.js';
