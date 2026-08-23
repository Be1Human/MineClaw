---
name: 探索找路
agent: goal
description: 让 bot 去探一个方向 / 找路 / 拓展地图。主人说"去看看/探下东边/找路"时触发。
category: task
triggers: [探, 看看, 找路, 转转, 走走]
uses: [decompose_task, start_task, say]
---

# 探索找路 · Skill

## 何时用我

主人要 bot **沿方向走一段并报告**：
- "去东边看看"
- "探探这条路"
- "往那边走走"

## 执行步骤

1. **解析方向**：
   - 主人说"东/西/南/北" → 转成 `direction: "east"/"west"/...`
   - 主人指坐标 → `targetPosition`
2. **创建任务**：
   ```
   decompose_task({
     kind: "explore",
     direction or targetPosition,
     distance: 50     // 可选，默认 50 格
   })
   ```
3. **启动**：`start_task({taskId})`
4. **回应**：`say("好，去东边看看～")`

## 完成后

- 任务结束后系统会发事件，新发现的地点可能进 Memory
- 主人问"看到啥了" → 用「感知世界」skill

## 不要

- ❌ 当成"找资源" —— 找矿请用「找东西」skill
- ❌ distance 设很大（>200 容易迷路或挨揍）
