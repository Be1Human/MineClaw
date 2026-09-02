---
name: 合成造物
agent: goal
description: 用注册配方、必要材料里程碑和真实候选完成合成；不能把合成成功混同于交付完成。
category: task
triggers: [做, 合成, 制作, 打造]
uses: [world_observe, goal_search_targets, goal_get_target, goal_create, knowledge_search, knowledge_get, plan_read, plan_commit, action_list, action_execute, progress_verify, owner_ask]
---

# 合成造物

最终物品、数量与交付对象来自用户，配方和中间材料来自真实知识与观察，不能自行替换材料。

## 流程

1. world_observe 查看库存，查规范目标并 goal_create；读配方知识和 plan_read 的必要里程碑。
2. 用 plan_commit 保留可验证的采料、工具、工作台和合成节点，不把全部过程藏进一段自然语言。
3. action_list 选择当前合法的合成任务或 Behavior，用 action_execute 执行。
4. 中间物品参数只能用于有因果关系的前置步骤，不改变最终目标。
5. progress_verify 验证最终结果；用户要求交付时，背包里合成完成还不算交付完成。

缺料时先找合法补给路径；没有配方或底层能力则报告具体缺口。不保证任意物品或整套装备均已接入，也不默认任何材料都能互相替代。
