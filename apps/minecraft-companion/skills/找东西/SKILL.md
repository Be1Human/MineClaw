---
name: 找东西
agent: goal
description: 通过观察、记忆和已接入的只读能力查找物品位置；区分没记录、没观察到和确定不存在。
category: query
triggers: [找, 哪里有, 有没有, 矿, 箱子, 金块]
uses: [world_observe, memory_search, memory_get, capability_search, capability_get, owner_ask]
---

# 找东西

用户只问位置时只读，不为查找而移动、挖掘或打开未授权容器。

先查看新鲜观察和相关记忆，再查询是否有已接入的特定定位能力。
历史矿物位置与箱子库存只是线索，必须保留时效；扫描服务存在不代表其所有结果都暴露为模型工具。

当前工具不包含专门的矿物、箱子或任意方块扫描调用。只有实际工具 schema 提供了入口才可使用；不可拿类名当工具名。
查不到时说“目前可用证据没有找到”，不宣称全区域不存在。目标有歧义才 owner_ask。
