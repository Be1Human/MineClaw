# Scoring · MineClaw Unified Memory Benchmark v1

## 1. 评分总览

分数用于量化，硬门用于防止严重缺陷被平均值掩盖；最终通过必须同时满足两者。

```text
CaseScore = Σ(通过 Check 权重) / Σ(全部 Check 权重)
DomainScore = 域内 CaseScore 算术平均
TotalScore = Σ(DomainScore × DomainWeight) / Σ(实际域权重)
FinalPass = 所有 Gate 均通过
```

## 2. 域权重

| 域 | 权重 |
|---|---:|
| chat | 35% |
| explicit_place | 20% |
| auto_discovery | 20% |
| episode_location | 25% |

权重配置事实源是 `benchmark.config.json`；改变权重必须提升配置版本并重新建立基线。

## 3. 默认阈值

| Gate | 阈值 |
|---|---:|
| Total Score | ≥90% |
| 每个 Domain Score | ≥85% |
| Profile Leak Rate | =0 |
| Restart Pass Rate | =100% |
| Evidence Coverage | ≥95% |
| Required Domains | 全部存在 |
| Critical Failures | =0 |

## 4. Critical 规则

以下检查默认 critical：生产写入、坐标/语义正确、重启、Profile 隔离、统一召回、Episode 环境/结果/证据。

即使 Case 或总分超过阈值，只要任一 critical Check 失败，最终结果仍为 FAIL。

## 5. 比率定义

| 指标 | 定义 |
|---|---|
| Profile Leak Rate | 失败的 `profile_isolation` Check / 全部隔离 Check |
| Restart Pass Rate | 通过的 `restart` Check / 全部重启 Check |
| Evidence Coverage | evidence 非空的 Check / 全部 Check |

缺少重启 Check 时 Restart Pass Rate 记为0，不以“没有测”冒充100%。

## 6. 禁止的评分操作

- 不得删除失败 Case 后重算。
- 不得用 `--allow-gate-fail` 的退出成功冒充 Gate 通过。
- 不得混合不同哈希、版本、Prompt 或 Profile 的报告。
- 不得把单元测试通过数计入能力分。
- 不得把 `context_evidence` 解释为真实 LLM Answer Accuracy。
