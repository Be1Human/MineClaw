---
name: 主人记忆
agent: main
description: MainBrain 保存关于主人的长期偏好与约定；这不是 GoalAgent 的游戏执行工具。
category: memory
triggers: [记住, 我喜欢, 我讨厌, 以后, 我叫, 习惯, 约定]
uses: [save_memory, say]
---

# 主人记忆

只属于 MainBrain。GoalAgent 不应通过 Skill 获取人格或长期偏好写权限。

关于主人的长期信息用 save_memory 保存，必要时用 say 确认；一条记录表达一个可独立理解的事实。
不把临时游戏动作当作长期偏好，不把“已接到要求”说成“已完成游戏任务”。
