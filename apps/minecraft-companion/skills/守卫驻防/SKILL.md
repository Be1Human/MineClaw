---
name: 守卫驻防
agent: goal
description: 查询守卫持续能力的实际接入状态，区分任务定义、心跳策略和固化数据策略；未接通不能假称开始站岗。
category: task
triggers: [守卫, 驻防, 站岗, 守门, 保护]
uses: [capability_search, capability_get, world_observe, owner_ask]
---

# 守卫驻防

守卫是持续任务。启动、巡逻、威胁切换与停止必须有真实运行时入口，不能只凭一份 YAML 判断支持。

## 接入检查

capability_search 搜守卫，capability_get 读取状态、范围参数和调用入口。
GuardStrategy 类名不是固化数据策略 ID；未注册状态必须报告，不尝试把类名交给动作执行器。
只有能力详情和当前工具 schema 明确提供了持续任务入口，才能按其合同发起；本说明不会新增那个入口。

范围缺少必要信息时 owner_ask；缺执行器时报告开发缺口，不让用户反复换说法。
已激活的持续任务不因暂时没有敌人而宣称永久完成，停止必须等待实际取消确认。
