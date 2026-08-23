---
name: 资源决策
agent: goal
description: 当合成/任务卡在缺料、要决定用哪种替代品时使用。例：缺铁矿但有铜矿，让 policy 决定能不能替代。一般是其他 skill 内部串联调用，主人不会直接说"资源决策"。
category: meta
uses: [resolve_resource, decide_with_policy, ask_master, say]
---

# 资源决策 · Skill

## 何时用我

**通常被其他 skill 内部串联**，不是主人直接触发的：
- 合成卡在缺料 → 走本 skill 查替代品
- 多个候选不知道选哪个 → policy 帮你定

## 执行步骤

1. **找候选**：
   ```
   resolve_resource({
     kind: "item",
     name: "<物品名>",
     minDurability: 100   // 可选
   })
   ```
   返回 `candidates: [{summary, satisfaction:"full"/"partial"/"none", partialAmount?, estimatedCostSec}]`
2. **policy 决策**：`decide_with_policy({})`（无参数；policy 自动取上一次 resolve_resource 结果）
3. **按结果走**：
   - `kind: "auto"` → 用 `chosen`，调对应工具
   - `kind: "ask_master"` → 立即 `ask_master(question)` 反问主人
   - `kind: "escalate_llm"` → 自己从 candidates 里挑（看 estimatedCostSec 取小的）
   - `kind: "no_solution"` → say 告诉主人办不到

## 不要

- ❌ 跳过 resolve_resource 直接 ask_master（先看选项再决定）
- ❌ policy 说 ask_master 但你擅自决策（policy 优先于自我判断）
