---
name: 资源决策
agent: goal
description: 缺材料或工具时，从观察、配方与可用操作形成有因果关系的补给步骤；不擅自替换物品或扩大资源权限。
category: meta
triggers: [缺料, 缺工具, 材料不足, 补给]
uses: [world_observe, knowledge_search, knowledge_get, capability_search, capability_get, plan_read, plan_commit, action_list, action_execute, progress_verify, owner_ask]
---

# 资源决策

程序负责执行授权，模型只在已知操作和真实资源证据之间选择路径。

读取新鲜库存、相关配方和能力详情，区分缺材料、缺工具、缺位置与根本没有执行能力。
通过 plan_read / plan_commit 表达必要前置步骤，再从 action_list 选择候选执行并验真，不改小最终目标。
容器必须有授权，采料不能无界扩大范围，替代配方须有知识依据；铜不能因为看起来也是金属就替代铁。

确需用户选择目标或授权范围时 owner_ask；缺框架能力则准确报告，不能无限请求用户换说法。
