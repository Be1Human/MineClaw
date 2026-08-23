# Capability Benchmark

这里保存玩家可观察能力的场景、自然语言指令、世界 Gate 与真服运行器。

配置预检不会产生能力通过结论：

```bash
node benchmark/cli.mjs run --suite short-capability --profile canary -- --preflight
node benchmark/cli.mjs run --suite combat-survival --profile full -- --preflight
```

真服执行必须使用 `local-loop-test` 完成“准备场景 → `/chat` 指令 → 轨迹/任务终态 → 世界实物 → 用户反馈”闭环。战斗的自动 canary 位于 `combat-survival/scripts/`；任何预检报告的 `capabilityPassed` 都固定为 `null`。
