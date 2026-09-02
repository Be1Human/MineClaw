---
name: 跟随主人
agent: goal
description: 区分持续跟随和一次性到达；持续跟随通过专门生命周期路由，一次性到达通过目标与动作候选。
category: task
triggers: [跟我, 跟随, 跟着, 来我这里, 过来]
uses: [capability_search, capability_get, world_observe, goal_search_targets, goal_get_target, goal_create, action_list, action_execute, progress_verify, owner_ask]
---

# 跟随主人

“跟着我”是持续跟随，“到这里来一次”是到达目标，不能混用终态。

持续跟随由上游 GoalCapabilityRouter 的 follow_owner 路由负责；用 capability_get 了解入口，不在 GoalAgent 中凭空创建重复任务。
如果持续请求误入普通规划且没有对应工具，报告路由问题，不用一次性到达冒充持续跟随。

一次性到达：观察真实主人位置，查目标、goal_create，然后 action_list / action_execute，最后 progress_verify。
用户给出的坐标必须进入实际目标绑定，不能只写在推理或回复中。找不到主人且无法绑定目标时才询问必要位置。
