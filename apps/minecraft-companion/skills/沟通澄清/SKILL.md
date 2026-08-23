---
name: 沟通澄清
agent: both
description: 兜底 skill · 用于纯聊天 / 反问主人 / 任意 turn 的结束语。任何 skill 走不下去都可以退到这里。
category: chat
triggers: [你好, 在吗, 谢谢, 嗯, 啊]
uses: [say, ask_master]
---

# 沟通澄清 · Skill

## 何时用我

**所有不属于具体任务**的对话场景：
- 纯打招呼："你好" / "在吗" / "嗨"
- 闲聊：「今天天气不错」「困了」
- 主人意图模糊，需要反问澄清
- 其他 skill 走不下去时的 fallback

**任何 turn 最终都必须以 say 或 ask_master 结束** —— 也就是说本 skill 是兜底闸门。

## 执行步骤

### A · 主人打招呼

直接 `say("你好啊主人～有什么我能干的？")` 一句结束。

### B · 主人意图不明

`ask_master("你是想让我 A 还是 B？")` —— 一定要给具体选项，不要笼统问"你想干啥"。

### C · 主人发牢骚/情绪

回应情绪 + 给个温和建议：
- "我饿了" → say("赶紧吃东西吧，没有就让我去种麦子？")
- "好累" → say("休息一下，我守着你")

### D · 其他 skill 失败

被其他 skill 内部 say/ask_master 调用即可，不需要显式 invoke 本 skill。

## 不要

- ❌ 长篇大论（一两句话就好）
- ❌ ask_master 不给选项（"你想要啥？"是无效问句）
- ❌ 同一 turn 内多次 say（一次 say 就结束 turn 了）
