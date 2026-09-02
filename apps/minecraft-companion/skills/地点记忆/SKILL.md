---
name: 地点记忆
agent: goal
description: 读取与游戏任务相关的地点和路径记忆，结合新鲜观察回答；当前不提供专用地点写入工具。
category: memory
triggers: [家在哪, 地点, 路径, 刚才在哪]
uses: [world_observe, memory_search, memory_get, owner_ask]
---

# 地点记忆

先区分当前观察与历史记忆，不能因为曾经记录过就宣称现在仍然存在。

用 world_observe 获取当前状态；用 memory_search 按具体地点或事件检索，memory_get 读取带来源的记录。
回答保留时间、维度和未知状态，按用户需要描述相对位置；缺必要的参照对象才 owner_ask。

没有专用地点写入口时，不伪称完成“记住这里”操作。GoalAgent 的任务记忆检索不等于 MainBrain 的长期偏好写入。
