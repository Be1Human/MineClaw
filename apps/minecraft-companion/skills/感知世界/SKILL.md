---
name: 感知世界
agent: both
description: 查询 bot 自身位置/血量/食物/活跃任务/背包/附近实体。主人问"你在哪/在干嘛/背包有啥/血还多吗"时触发。
category: perception
triggers: [在哪, 哪里, 干嘛, 在做, 背包, 物品, 血, 饥饿, 状态]
uses: [get_world_state, get_inventory, say]
---

# 感知世界 · Skill

## 何时用我

主人问 bot **自身状态**或**当前环境**：
- "你在哪？" / "你在干嘛？"
- "背包里有什么？" / "弹药还够吗？"
- "你血还多吗？" / "饿不饿？"
- "周围有啥怪物/玩家？"

## 执行步骤

1. 主人问位置/任务/附近实体 → `get_world_state`，返回含 `self.position` / `activeTasks` / `entities`
2. 主人问背包 → `get_inventory`（更精简，仅物品列表）
3. **不要重复调用** —— 一个 turn 内最多调一次 get_world_state + 一次 get_inventory
4. 拿到结果后**直接 `say`** 用自然语言报告，不要再多调工具

## 答复样例

- 位置："我在 -36, 78, 8，正在执行采集橡木任务（still running）"
- 背包："背包里有 3 个橡木、1 把木镐、64 个圆石"
- 没事干："我在 -36, 78, 8，啥也没干，等你指挥呢"

## 不要

- ❌ 重复轮询（已经知道位置后还反复调 get_world_state）
- ❌ 把整个 worldState 原样背给主人（信息过载）
- ❌ 不调工具凭空回答（位置是会变的）
