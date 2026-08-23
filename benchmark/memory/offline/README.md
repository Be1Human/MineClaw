# MineClaw Unified Memory Benchmark

> 统一入口：聊天事实、明确地点、自动发现地点、情景地点。quick/full 默认零外部 Token。

## 1. 快速使用

在 `apps/minecraft-companion` 目录执行：

```powershell
npm run test:memory-benchmark
npm run benchmark:memory:quick
```

完整基线：

```powershell
npm run benchmark:memory
```

报告生成在根目录 `benchmark/reports/memory/`。JSON 是机器事实源，Markdown 是同一报告的人类视图。

## 2. 如何理解退出码

| 退出码 | 含义 |
|---:|---|
| 0 | 框架执行完成且全部能力 Gate 通过 |
| 1 | 框架异常，或能力 Gate 如实失败 |

诊断时可加 `--allow-gate-fail` 继续生成报告，但不能据此声称通过：

```powershell
node benchmark/cli.mjs run --suite memory --profile quick -- --allow-gate-fail
```

## 3. 测什么

| 域 | Case | 被测生产路径 |
|---|---:|---|
| chat | full 130 / quick 9 | ChatMemoryService + 旧中文 Harness |
| explicit_place | 4 | `remember_place → MemoryV2.spatial` |
| auto_discovery | 4 | WorldScan/MineralProbe → MemoryV2.spatial |
| episode_location | 3 | EpisodeAssembler/Store → MemorySystem.deepRecall |

具体协议见 [BENCHMARK_SPEC.md](./BENCHMARK_SPEC.md)，评分见 [SCORING.md](./SCORING.md)。

## 4. 测评证据边界

- `test:memory-benchmark` 绿色，只证明 Benchmark 框架按规范工作。
- quick/full 报告的 `score.passed` 才代表离线确定性能力 Gate。
- chat 的 `context_evidence` 只证明正确证据进入上下文，不代表 LLM 最终回答正确。
- quick/full 不读取 API Key，不请求 DeepSeek，不下载模型。
- 训练服与真实语言质量必须使用未来的 live/judged Profile，不能借用本报告结论。

## 5. 目录

```text
benchmark/memory/offline/
├─ benchmark.config.json
├─ datasets/
├─ src/adapters/
├─ src/runner.ts
├─ src/scoring.ts
├─ BENCHMARK_SPEC.md
└─ SCORING.md
```

框架自测位于 `test-case/benchmark-framework/memory/offline/`，运行报告位于 `benchmark/reports/memory/`。

## 6. 新增 Case

1. 给 Case 分配永久唯一 ID 和 split。
2. 在版本化 JSON 中写 Fixture 与预期，不在生产代码读取 Case ID。
3. 只通过 Domain Adapter 调用公开生产接口。
4. 每个 Check 写清预期、实际、权重、critical 和证据。
5. 更新 Manifest 的版本/计数并补框架测试。

## 7. 报告审计

每次对比前核对：`benchmarkVersion`、`datasetVersion`、`datasetSha256`、`configSha256`、`gitCommit`、`profile`。

任一项不一致时只能作为不同实验分别展示，不能拼接平均或续跑。
