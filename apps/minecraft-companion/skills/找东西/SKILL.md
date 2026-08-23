---
name: 找东西
agent: both
description: 查"哪个箱子有 X / 附近有 X 矿吗 / 附近有金块吗"。矿物/箱子基于历史扫描；地标块用 locate_block 实时按需扫。只回答位置，不移动。
category: query
triggers: [找, 哪里有, 有没有, 矿, 箱子, 金块]
uses: [find_chest_with, find_mineral, locate_block, say]
---

# 找东西 · Skill

## 何时用我

主人 **查询**某物在哪：
- "钻石/铁矿/煤 在哪？" / "附近有 X 矿吗？"
- "哪个箱子里有铁块？" / "我的木板存哪了？"

## 执行步骤

### A · 找矿物

```
find_mineral({type: "diamond"|"iron"|"gold"|"copper"|"coal"|"redstone"|"lapis"|"emerald"|"netherite"})
```
返回 `{count, minerals: [{position, distance, blockName, scannedAt}]}`（按距离升序，最多 20 个）。

⚠ 数据来源：L2 周期性矿物探测（FEAT-L2-02）。**只对扫描过的区域有效**；从未走过的远处不会有结果。
⚠ scannedAt 越新越可靠（矿物会被挖光）。

### B · 找地标块（实时扫描）

主人问"附近有金块/羊毛/工作台/熔炉吗"——这类是**放置的方块**不是矿物，用：

```
locate_block({name: "金块"})    // 中英文都行，默认扫 32 格、返回最近 3 个
```
返回 `{found, blocks: [{position, distance, dir}]}`。found=false 就如实说"附近 32 格内没看到"。

⚠ 只**回答**位置（如「东边 8 格就有一块」），**不要移动**。主人要你过去 → 那是「去地标」skill 的活。

### C · 找箱子

```
find_chest_with({item: "iron_ingot"})
```
返回 `{count, chests: [{position, distance, items, scannedAt}]}`。

⚠ 数据来源：bot **开过的**箱子。没开过的箱子不会出现在结果里。

## 答复要简洁

- 报"距离 + 大致方向"，不是"原始 position"
- 例：「东边 12 格有块铁矿」、「家里的木箱子有 32 个铁锭」

## 不要

- ❌ 查不到时说"附近没有"（应说"我扫过的区域没看到"，差别很大）
- ❌ 不知道 type 时瞎猜（不在白名单里要 ask_master）
