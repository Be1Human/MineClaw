---
name: 农活种植
agent: goal
description: 耕地/播种/收割/补种循环。主人说"种麦子/打理田/收菜"时触发。支持一次性收割与持续循环两种模式。
category: task
triggers: [种, 播, 收, 打理, 浇水, 农]
uses: [decompose_task, start_task, update_task, create_plan, submit_goals, say, ask_master]
---

# 农活种植 · Skill

## 何时用我

主人要 bot 做农活：
- "种 3 亩麦子"
- "把田收了"
- "持续打理这片田"（continuous 模式）

## 执行步骤

1. **解析参数**：
   - `crop`：作物名（wheat / carrot / potato / beetroot）
   - `plots`：亩数，1 亩 ≈ 9×9（默认 1）
   - `mode`：`oneshot`（默认）一次性 / `continuous` 持续循环
2. **创建任务**：
   ```
   decompose_task({
     kind: "farm",
     crop, plots, mode
   })
   ```
3. **启动**：`start_task({taskId})`
4. **回应**：`say("好嘞，去打理 3 亩麦田～")`

## 持续模式（continuous）

主人说"持续打理 / 长期种" → `mode: "continuous"`。
- 状态机：planting → waiting_growth → 收割 → 补种 → ...
- 永远 partial，不会 complete
- 只有主人说"停" → 用「任务管理」cancel_task

## 失败兜底

- 没有种子 → 先 invoke_skill("合成造物") 或 ask_master 让主人提供
- 找不到田地 → ask_master 让主人指明位置

## 关联

- FEAT-L7-05 已实现的能力，本 skill 是 LLM 视角的接口
