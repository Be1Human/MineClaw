---
name: 成熟农田归仓
agent: goal
description: 收割附近已经成熟的农田，拾取小麦和种子，并把产物存入玩家住宅附近的箱子。
category: task
triggers: [收割农田, 收田, 收庄稼, 收菜, 收麦子, 收稻田, 收麦田, harvest]
uses: [goal_search_targets, goal_create, world_observe, plan_commit, action_list, action_execute, progress_verify]
---

# 成熟农田归仓

玩家要求把眼前已经成熟的农田收掉并归仓时使用本 Skill。

## 目标接入

1. 用 `goal_search_targets` 搜索玩家原话中的“农田 / 稻田 / 麦田 / 庄稼 / 收割”。
2. 选择 `mineclaw:mature_crops_to_chest`。
3. 用 `goal_create` 创建 `outcome=obtain`、`quantity=1` 的根目标。这里的 quantity 只是目标协议必填字段，真正数量由首次有界作物事实建立机器基线。
4. `plan_commit` 必须原样复制 `goal_create` 返回的 `predicate=agriculture.harvest_to_chest` 判据，不自行改写数量或 invent 新判据。

## 执行循环

反复使用 `action_list → action_execute → world_observe → progress_verify`。已注册农业包会根据新鲜事实依次只暴露当前可做的阶段：

1. `harvest_mature_crops`：分批挖掉成熟小麦，不碰未成熟作物。
2. `collect_harvest_drops`：拾取地面上的小麦和种子。
3. `store_harvest`：把背包里的小麦和种子存入绑定的住宅箱。

一个阶段完成但根判据未通过时，继续下一轮 `action_list`，不要把单次 Behavior 成功当成整项任务完成。

## 完成门

只有机器判据同时确认以下事实才能完成：首次观察的成熟小麦全部归零；地面无小麦/种子残留；Bot 背包无小麦/种子残留；同一任务开始后，绑定箱子的真实 deposit 收据包含不少于初始成熟株数的小麦且种子大于零。

如果方块或掉落事实被截断、找不到唯一可绑定箱子、动作失败或判据未通过，保持同一 GoalAgent Session 继续观察/恢复；不得口头宣称完成。
