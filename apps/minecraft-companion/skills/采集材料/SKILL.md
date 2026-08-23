---
name: 采集材料
agent: goal
description: 砍木头、挖矿石、收集任意定量材料的任务。主人说"砍 N 个 X"/"挖一组 Y"/"弄点 Z"时触发。
category: task
triggers: [砍, 挖, 采, 收集, 弄点, 拿, 搞]
uses: [get_inventory, decompose_task, start_task, update_task, create_plan, submit_goals, say, ask_master]
---

# 采集材料 · Skill

## 何时用我

主人想让 bot **定量采集**某种 minecraft 材料：木头 / 石头 / 矿石 / 草 / 沙子 / 食物等。

典型说法：
- "砍 3 个橡木"
- "挖一组铁矿"
- "弄点煤"
- "搞 20 个圆石"

如果主人说的是「合成 / 做个 / 造」某物品 → 用「合成造物」skill，不是这个。

## 执行步骤

1. **解析参数**：
   - `material`：minecraft 物品 ID 或别名（"橡木" → `oak_log`，"铁矿" → `iron_ore`/`deepslate_iron_ore` 都算）
   - `count`：明确数量；主人说"一组"= 64，"半组"= 32，"几个"= 3-5（拿不准就 ask_master）
2. **可选先看背包**（`get_inventory`）：若已经有足量该材料，直接 `say` 告诉主人不用再采。
3. **创建任务**：调 `decompose_task({kind: "gather_material", material, count})` 拿 taskId。
4. **立刻启动**：调 `start_task({taskId})`。
   - 若 `ok: false`：看 `error` 字段。
     - 找不到附近资源 → `ask_master` 要不要走远点找
     - 缺工具（"need_pickaxe"）→ `say` 告诉主人，建议先合成对应工具
5. **报告**：调 `say` 用中文友好语气告诉主人开始干活了（如"好嘞，去砍 3 个橡木～"）。

## 失败兜底

- 解析不出 `material` 或 `count` → `ask_master("你要采什么？数量多少？")`
- start_task 返回 `precondition_unmet`(reason) → say 解释卡在哪
- 如果同一 turn 已经连续 2 次失败 → say 说明并停手，不要无限重试

## 错误样例

不要：
- ❌ 调 `decompose_task` 后忘了 `start_task`
- ❌ 把"砍木头"翻译成 `material: "wood"`（应当是 `oak_log` 或 `birch_log` 等具体子类型）
- ❌ 没有 say 就结束 turn（用户体验差）

## 关联

- 「合成造物」：合成需要采集时，本 skill 是被它隐式串联的下游
- 「找东西」：主人问"附近有 X 矿吗" → 先用「找东西」skill 查，再决定要不要采
