/** 原子名 → 人话（任务树镜像节点展示用；铁律：不向主人暴露程序名词） */
const ATOM_ZH: Record<string, string> = {
  move_to: '移动到目标', goto_position: '走到坐标', walk: '行走', climb_up: '向上爬',
  pillar_up: '搭柱上升', dig_down: '向下挖', look_at: '转向',
  attack: '攻击', crit_jump_attack: '跳劈', kite: '风筝走位', bow_shoot: '射箭', block_with_shield: '举盾格挡',
  dig: '挖方块', mine_to: '挖到目标', place_block: '放置方块', craft: '合成', smelt: '熔炼',
  use_tool: '使用工具', equip: '装备', equip_best_armor: '换上最好护甲',
  eat: '进食', sleep: '睡觉', wake: '起床', escape_pit: '脱困', fish: '钓鱼',
  deposit: '存入容器', withdraw: '取出物品', mount: '骑乘', dismount: '下载具', vehicle_goto: '载具前往',
  follow_entity: '跟随', stop_follow: '停止跟随', stop: '停下',
  toss_item: '把物品交给主人',
};
const BEHAVIOR_ZH: Record<string, string> = {
  combat: '战斗',
  gather_block: '采集方块',
  farm_one_plot: '耕种一格',
  follow_owner: '跟随主人',
  flee: '撤离危险',
  craft_one: '合成物品',
};

/** 给任务树镜像子节点生成人话 label（带少量关键参数：数量/物品/坐标） */
export function atomDisplayLabel(atomic: string, args: Record<string, unknown>): string {
  if (atomic === 'invoke_behavior') {
    const beh = String((args.behavior ?? '') as string);
    return BEHAVIOR_ZH[beh] ?? '执行复合行为';
  }
  let base = ATOM_ZH[atomic] ?? '执行动作';
  const item = args.itemName ?? args.material ?? args.atomic;
  if (typeof item === 'string' && item) base += ` ${item}`;
  if (typeof args.count === 'number') base += ` ×${args.count}`;
  const pos = args.position as { x?: number; y?: number; z?: number } | undefined;
  if (pos && typeof pos.x === 'number') base += ` (${Math.round(pos.x)},${Math.round(pos.y ?? 0)},${Math.round(pos.z ?? 0)})`;
  return base;
}
