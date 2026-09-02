---
name: 农活种植
agent: goal
description: 处理“帮我把这个田种一下”：先查真实农业能力，再定位已有田块、选择作物、补齐合法种子来源并逐格验真。发现能力不代表已经接通执行。
category: task
triggers: [种田, 种一下, 播种, 补种, 农活]
uses: [capability_search, capability_get, world_observe, goal_search_targets, goal_get_target, goal_create, plan_read, plan_commit, action_list, action_execute, progress_verify, knowledge_search, knowledge_get, owner_ask]
---

# 农活种植

先确认可执行操作、观察入口和成功判据；本说明不授权新工具，也不承诺开荒、灌溉或持续收割。

## 判断与计划

1. 用 capability_search 搜播种，capability_get 读取可用性与调用入口。只有任务定义或内部资源不等于可以启动。
2. 根据实际可用的观察证据绑定“这个田”，不能编造玩家视线或默认自身前方一格。唯一候选自主选择；确实有歧义才 owner_ask。
3. 作物依据依次是明确要求、田块唯一已有作物、背包唯一受支持种植物；缺依据或冲突时询问。
4. 保留初始空耕地集合和已有作物保护范围。未知、截断和未加载不能当成田块边界。
5. 缺种子先查合法来源；只能对已授权且有库存依据的容器规划取料，不擅自收割、打草或找未知箱子。

## 执行与结果

按当前 goal_create schema 创建合法目标，用 plan_read / plan_commit 表达必要前置步骤。
只执行 action_list 返回且 authorization 为 ready 的 candidateHandle；Behavior ID 或策略类名不是顶层工具。句柄过期先重新查询，不自行拼装。
执行后用 progress_verify 验真；逐格区分新增、原有、受阻和未知，不能把部分完成说成整田完成。

缺播种执行器、定位观察或验真器时，准确报告开发缺口，不循环换词搜索，也不要求用户替系统提供动作脚本。
成熟作物收割归仓是另一项能力，不能以收割冒充播种。
