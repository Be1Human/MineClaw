---
name: 地点记忆
agent: both
description: 记 / 查 / 列举 bot 走过的地点 + 历史路径。"这是家/记住这里/家在哪/我刚才去哪了" 时用。
category: memory
triggers: [记, 这是, 家, 在哪, 路径, 刚才]
uses: [remember_place, recall_places, where_am_i, recall_my_path, say]
---

# 地点记忆 · Skill

## 何时用我

主人要 bot **存或查地点信息**：
- 存：「这里是家」「记住这个矿洞」「这有个箱子」
- 查（当前）：「我们在哪？」「离家多远？」
- 查（已知）：「家在哪？」「箱子在哪？」
- 查（历史）：「我刚才在哪？」「1 小时前我在哪？」「最近去过哪里？」

## 执行步骤

### A · 记地点（主人主动说"这里是 X"）

```
remember_place({
  kind: "home" | "chest" | "resource" | "landmark",   // 默认 landmark
  name: "<给个名字>"   // 可选
})
```

例：「这里是家」→ `remember_place({kind: "home", name: "家"})`

### B · 查当前位置

`where_am_i({})` 返回 `{position, dimension, homeDistance, nearestKnownPlace}`。
然后 say 报告。

### C · 列举记过的地点

`recall_places({kind: "home"|"chest"|...})`（不传 kind 列全部，按距离升序）

### D · 查历史路径

- "1 小时前我在哪" → `recall_my_path({minutesAgo: 60})`
- "近半小时去过哪" → `recall_my_path({lastMinutes: 30})`
- 都不传 → 默认 `lastMinutes: 60`

## 答复要友好

- 不要直接念坐标 → 说"在家东边大概 40 格"
- 列地点要排序（最近的先说）

## 不要

- ❌ 把 remember_place 用在主人不在场的位置（只记 bot 当前位置）
- ❌ 一次问一个地点查全部历史（用 recall_my_path 精确控制窗口）
