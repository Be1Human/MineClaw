---
name: 跟随主人
agent: goal
description: 让 bot 跟着主人走 / 来到主人身边 / 去某个坐标。主人说"跟我走/来我这里/到 X,Y,Z"时触发。持续性任务，到达后不要主动结束。
category: task
triggers: [跟, 跟着, 来, 过来, 跟我, 到]
uses: [decompose_task, start_task, say]
---

# 跟随主人 · Skill

## 何时用我

主人让 bot **靠近他**：
- "跟着我" / "跟我走"
- "来我这里" / "来找我"
- "到 -87 107 126" / "去 X,Y,Z"

## 执行步骤

1. **解析目标位置**：
   - 主人话里出现了**任何坐标数字**（"我在 0,0,0"/"到 -87 107 126"）→ **必须**把它填进 `targetPosition`
   - 主人没给数字 → 不传，默认跟随当前主人位置
2. **创建任务**：
   ```
   decompose_task({
     kind: "follow_owner",
     ownerName: "<主人玩家名>",
     targetPosition: { x, y, z }   // 主人给了坐标就【必填】！
   })
   ```
3. **启动**：`start_task({taskId})`
4. **回应**：`say("好的，过来了～" / "马上到！")`

## 🔴 铁律：坐标必须进入工具入参

- ❌ **错误示范（真实事故）**：思考写"主人给了坐标 0,0,0 我直接跑过去"，入参却只传 `{"kind":"follow_owner"}` —— 坐标只在你脑子里，系统拿不到，bot 原地不动，主人暴怒。
- ✅ 正确：`decompose_task({"kind":"follow_owner","ownerName":"qxy","targetPosition":{"x":0,"y":0,"z":0}})`
- 你**嘴上说的目的地必须和入参一致**。说"跑向 X" 而入参没 X = 欺骗主人。

## ⚠ 重要：这是【持续性任务】

- **到达身边 ≠ 完成**。bot 会持续跟随，直到主人明确说停。
- **禁止主动 complete_task**。即便看到"已到达"也不要结束任务。
- 只有主人说"停 / 别跟了 / 取消" → 用「任务管理」skill 走 `cancel_task`。

## 主人问"到了吗/在哪"

不要重启任务！正确做法：
1. invoke_skill("感知世界") 看 `activeTasks` + 当前位置
2. 直接 say 报告（如"在路上，快到了"）

## 不要

- ❌ 每次主人说"跟着我"都重新建任务（已经有 follow 任务在跑就别建第二个）
- ❌ 到达后调 complete_task
- ❌ 没传 ownerName（必填）
