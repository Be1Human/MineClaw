---
name: 采集材料
agent: goal
description: 根据真实目标、资源来源和动作候选定量采集材料，缺工具时规划必要前置步骤并验证库存结果。
category: task
triggers: [砍, 挖, 采集, 收集, 弄点]
uses: [world_observe, goal_search_targets, goal_get_target, goal_create, knowledge_search, knowledge_get, plan_read, plan_commit, action_list, action_execute, progress_verify, owner_ask]
---

# 采集材料

先明确用户要新增采集、凑够库存还是交付，不把背包已有材料自动当作所有要求已完成。

## 流程

1. world_observe 读取库存和环境；goal_search_targets / goal_get_target 获取规范物品，保留用户数量和范围。
2. 按 goal_create 的当前 schema 创建目标；无法创建时报告缺少的目标表达或验真能力，不伪造 registryId。
3. plan_read 检查必要材料和工具里程碑，必要时 plan_commit；配方与工具需求来自 knowledge_search / knowledge_get。
4. action_list 可能返回采集任务、采集 Behavior 或拾取候选；用 action_execute 的 candidateHandle 执行 ready 候选，不能直接调用任务类名。只有 mutableArgumentPaths 允许的业务参数可调整。
5. progress_verify 验证库存或交付。失败先读结构化原因和新鲜事实；只有用户必须决定范围或对象才 owner_ask。

未知资源不能报告为不存在，未授权区域不能为了补材料自动扩大。没有合法执行路径时报告缺口，不反复执行同一失败动作。
