---
name: 感知世界
agent: goal
description: 从新鲜观察读取自身、主人、背包、环境和附近实体；不将摘要当作完整世界地图。
category: perception
triggers: [在哪, 背包, 血, 饥饿, 状态, 附近]
uses: [world_observe, plan_read]
---

# 感知世界

调用 world_observe 取得当前世界摘要，按问题提取必要信息；计划进度可用 plan_read 查看，但计划不是实际世界证据。

只读问题不创建动作目标、不移动。不凭历史回复猜当前位置，也不把附近实体摘要解释为任意方块或箱子库存查询。
观察过期、未加载或字段缺失时说明未知；没有相关变化不要反复刷新同一事实。

GoalAgent 输出事实，由 MainBrain 负责面向主人的表达；这里不提供独立发言工具。
