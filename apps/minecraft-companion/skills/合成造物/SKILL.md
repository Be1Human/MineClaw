---
name: 合成造物
agent: goal
description: 合成工具、武器、防具、家具等任意 minecraft 物品。主人说"做个/合成/造"某物时触发。会自动串联采料→工作台→合成全链。
category: task
triggers: [做, 合成, 造, 制作, 打造]
uses: [get_inventory, resolve_resource, decide_with_policy, decompose_task, start_task, create_plan, submit_goals, say, ask_master]
---

# 合成造物 · Skill

## 何时用我

主人要 bot **造一个具体物品**：工具（镐/斧/剑）/ 防具 / 火把 / 工作台 / 床 / 箱子 / 熔炉等。

典型说法：
- "做把木镐" / "合成一把铁剑"
- "造个工作台"
- "打造一套皮甲"

跟「采集材料」的区别：采集是只拿原料；合成是产出最终成品。采料和中间产物必须成为 Planner 中可见、可验真的前置里程碑，不能只藏在一次 craft 动作里。

## 执行步骤

1. **读取当前库存与配方里程碑**：已有材料直接裁剪；缺少的原料、中间产物和设施写入共享 PlanGraph
2. **逐个执行可验里程碑**：材料节点绑定 `gather_material`，可合成库存节点绑定 `craft_item`
   - 物品 id 用最常见的：`wooden_pickaxe` / `stone_pickaxe` / `iron_sword` / `crafting_table` / `furnace` / `bed` / `chest` / `torch` / `shield`
3. **受控启动**：Actor 从注册候选选择 `invoke_task`；TaskRuntime 负责跨 tick 探索、采集、递归合成、取消和结构化终态
4. **逐节点验真**：库存或放置判据成立后才推进下一节点；失败交给 Recovery 决定 retry 或 replan
5. **报告**：最终机器判据成立后再用友好语气告诉主人

## 失败兜底

- start_task 失败 `precondition_unmet` → say 解释卡哪了（如缺哪一项原料 + 现状）
- 物品名不存在 → ask_master 让主人换个说法
- 工具进阶链：木 → 石 → 铁 是自动的，主人说"铁镐"系统会先合成石镐再升铁

## 跟其他 skill 的关系

- Planner 必须显式保留「采集材料」的机器里程碑；具体探索和重复采集由 TaskRuntime 内部串联
- 与「资源决策」联动：缺料时 ProvisionStrategy 走 resolve_resource → decide_with_policy
