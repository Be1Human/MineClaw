---
name: 任务管理
agent: main
description: 取消/暂停/手动完成正在运行的任务。主人说"停下/取消/暂停/算了"时触发。
category: task
triggers: [停, 取消, 暂停, 算了, 别, 不要]
uses: [get_world_state, cancel_task, pause_task, complete_task, say]
---

# 任务管理 · Skill

## 何时用我

主人要 **中止或调整**正在执行的任务：
- "停下！" / "别跟了" / "算了，不挖了"
- "暂停一下"
- 偶尔："这件事做完了"（手动 complete）

## 执行步骤

1. **看当前任务**：先 `get_world_state`，找 `activeTasks` 里 running/paused 的任务
2. **匹配主人意图到具体任务**：
   - "别跟了" → kind=follow_owner 的任务 → cancel
   - "停下挖矿" → kind=gather_material 且 material 含相关词的任务 → cancel
   - "都停了" → 遍历所有 running 任务 cancel
3. **执行**：
   ```
   cancel_task({taskId, reason: "主人要求"})
   或
   pause_task({taskId})
   或
   complete_task({taskId})
   ```
4. **回应**：`say("好，停了" / "暂停了～需要继续叫我")`

## 找不到匹配任务怎么办

- 没有任何 running 任务 → say("我现在没在干啥呢～")
- 多个候选不确定哪个 → ask_master("是停 X 还是 Y？")

## 不要

- ❌ 主人没说停就主动 cancel/complete（持续任务设计就是要持续）
- ❌ 凭空猜 taskId（一定要从 activeTasks 里取）
