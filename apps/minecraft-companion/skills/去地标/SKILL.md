---
name: 去地标
agent: goal
description: 主人用方块名指代地点让你过去："走到金块那里 / 去那个箱子 / 到工作台旁边"。先 locate_block 定位坐标，再 goto_position 走过去。
category: task
triggers: [走到, 去那, 过去, 到那, 金块, 那个箱子, 那里]
uses: [locate_block, decompose_task, start_task, say, ask_master]
---

# 去地标 · Skill

## 何时用我

主人用**方块名**指代一个地点，让你走过去：
- "走到金块那里" / "去那个箱子" / "到工作台旁边" / "去羊毛那块"

> ⚠ 与「跟随主人」区分：跟随是贴着主人走（持续）；这里是去一个**固定地标**然后停下（一次性）。
> ⚠ 与「找东西」区分：找东西只**回答**在哪；这里要**真走过去**。

## 执行步骤

### 1 · 定位地标

```
locate_block({ name: "金块" })          // 中英文都行："gold block"/"chest"/"箱子"
// 可选：maxDistance（默认 32 格）、count（默认 3 个）
```

返回 `{ found, blocks: [{position, distance, dir}] }`（按距离升序，dir=东/西/南/北）。

### 2 · 分两种结果

**found=true** → 取 `blocks[0]`（最近那个），创建走路任务：

```
decompose_task({ kind: "goto_position", targetPosition: blocks[0].position })
start_task({ taskId })
say("好嘞！8 格外东边就有块金块，我这就过去～")   // 带距离方向，自然点
```

**found=false** → 如实告知，**绝不假装出发**：

```
say("我附近 32 格内没看到金块诶，你能带我去或给我个坐标吗？")
```

### 3 · 到达后

goto_position 是终态任务：走到 ≤3 格自动完成，系统会发事件。你不用守着。

## 不要

- ❌ **不要用 follow_owner 代替 goto_position**——follow 是追主人，不是去坐标
- ❌ found=false 时假装"已经在路上"（没坐标走不了，要诚实）
- ❌ 自己编坐标——坐标只能来自 locate_block 的返回值
- ❌ 主人只是**问**"附近有金块吗"（没让你去）→ 那是「找东西」的活，只答不动
