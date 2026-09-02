---
name: 去地标
agent: goal
description: 根据可验证的地标位置形成一次性到达目标；不能假定存在任意方块定位工具。
category: task
triggers: [走到, 去那, 地标, 那个箱子, 工作台旁边]
uses: [world_observe, memory_search, memory_get, capability_search, capability_get, goal_search_targets, goal_get_target, goal_create, action_list, action_execute, progress_verify, owner_ask]
---

# 去地标

这是到固定地点的一次性目标，不是持续追随主人。

先用 world_observe 和有来源的 memory_search / memory_get 获取位置线索；历史记忆必须考虑维度和时效。
capability_search 检查是否有适用的只读定位入口。world_observe 当前摘要不等于任意方块扫描，不能伪造不存在的定位结果。

位置明确后，按当前 goal_create 支持的规范目标和参数绑定，再从 action_list 选择并 action_execute。
progress_verify 确认到达。仅询问“在哪里”时不移动；多个同名地标无法消歧时 owner_ask，不擅自选择最近一个。
