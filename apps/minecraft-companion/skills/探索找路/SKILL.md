---
name: 探索找路
agent: goal
description: 检查实际探索与观察能力，在明确范围内规划；没有探索执行和验真入口时如实报告。
category: task
triggers: [探索, 找路, 看看, 转转]
uses: [capability_search, capability_get, world_observe, goal_search_targets, goal_get_target, goal_create, plan_read, plan_commit, action_list, action_execute, progress_verify, owner_ask]
---

# 探索找路

方向、范围和期望结果必须有界，不能仅凭 outcome 中有 explore 就声称探索任务已经实现。

先查能力及世界事实；明确坐标的到达可按已支持的目标通道执行。
没有对应探索目标、候选或结果判据时报告缺口，不凭空创建一个名为 explore 的任务。
需要用户决定方向或活动范围时 owner_ask；不默认一个大距离，也不为探索擅自破坏地形。

可执行时使用合法目标、计划与 action_list / action_execute；progress_verify 的真实结果才决定是否完成。
