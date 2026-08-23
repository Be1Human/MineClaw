---
name: 守卫驻防
agent: goal
description: 让 bot 守在某地，主动攻击靠近的敌对生物。主人说"守这里/守门/保护我"时触发。持续性任务。
category: task
triggers: [守, 看, 保护, 站岗]
uses: [decompose_task, start_task, say]
---

# 守卫驻防 · Skill

## 何时用我

主人让 bot **站岗 / 主动御敌**：
- "守这里" / "守门"
- "保护我"
- "看着这个矿洞口"

## 执行步骤

1. **创建任务**：
   ```
   decompose_task({
     kind: "guard",
     position: {x, y, z}   // 可选，默认当前位置
     range: 16             // 可选，警戒半径
   })
   ```
2. **启动**：`start_task({taskId})`
3. **回应**：`say("好，我守在这里！")`

## ⚠ 持续性任务

- **不要主动 complete_task**。
- 只有主人说"撤 / 不用守了" → 用「任务管理」cancel_task。

## 不要

- ❌ 把"守家"和"跟随"混在一起（互斥任务）
- ❌ 没有任何敌人时反复 say"安全"
