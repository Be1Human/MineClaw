# Engineering Benchmark · 原子任务评测体系（FEAT-CROSS-02 · 阶段〇）

把"修没修好"变成**数字**。连真服跑一组原子任务场景，输出每场景成功率 / 均时长 / 失败原因 / watchdog 强拆次数，并与基线比对。

> 面向产品发布的统一入口是 `npm run benchmark`。本目录原有命令继续作为 Body 层独立诊断工具；
> `benchmark/engineering/experience/` 提供真实聊天体验层，`benchmark/engineering/` 只做编排、规范化、评分和报告。

## 统一工程 Benchmark

```bash
npm run benchmark -- --list                 # 默认 release 清单，不连服
npm run benchmark -- --profile smoke        # 关键链路快跑
npm run benchmark                           # release：17 Body + 26 体验/可靠性
npm run benchmark -- --profile full         # release + 15 Body 矩阵
npm run benchmark -- --case T22             # 单 Case 调试
npm run benchmark -- --repeat 3             # Gym 场景重复 3 次
npm run test:benchmark                       # 统一层离线单测
```

统一报告写到 `benchmark/reports/engineering/benchmark-*.json/.md`。假完成、Crash、Hang、终态矛盾、
Incomplete 和 Watchdog 都是硬门；子 Runner 没生成新证据时不能读取旧报告代替。

> 本目录**独立于 `src/`**，不进线上 build（主 `tsconfig.json` 只 include `src/**`）。
> 阶段〇 全程**零线上代码改动**：只用 V2Runtime / MineflayerConnection 现有公开接口。

---

## 架构

```
runner.ts ── 编排：连双 bot → 逐场景×repeat → 汇总 → 写报告
  ├─ director.ts   导演 bot（op）：/fill /setblock /give /tp /summon + pathfinder 走折线
  ├─ subject.ts    被测 bot：MineflayerConnection + V2Runtime（LLM 关，任务直注）
  ├─ scenarios/    17 个固定场景：nav / recover / gather / craft / follow / survival / combat
  └─ report.ts     JSON + MD 报告，自动 vs reports/baseline.json 比对
```

**两个 bot**：
- **导演（EvalDirector）**：需 **op 权限**，负责摆场（建结构/发物资/控环境）+ 在跟随场景里当"主人"走路。
- **被测（EvalSubject）**：装配线上同款 `V2Runtime`，但 **LLM 关闭**、任务经 `taskRuntime` 直注 / `move_to` 直 submit，保证确定性。

**坐标**：所有场景用局部坐标，由 `anchor`（默认 `(1000,120,1000)`）平移到世界坐标。每个场景跑前 `prepareArena` 重建 96×96 石台，抹掉上一场景遗留。

---

## 前置条件

1. 本地服 `127.0.0.1:25565` 已开，`online-mode=false`（offline 鉴权）。Runner 默认让 mineflayer 自动协商协议版本；不要沿用旧文档强制写死 `1.20.4`。
2. 导演用户名在服务器 `ops.json` 里（有 op）。首次可在服务器控制台执行：`op EvalDirector`。
3. `gamerule` 由 runner 自动设置（关刷怪/锁日间/晴天）。

---

## 用法

```bash
# 完整套件（17 个钉名实例 = 原 13 + SURV/COMB·4，每场景 repeat 5）
npm run eval

# 快跑冒烟（仅 quick 标记场景，repeat 3）—— SMOKE-6
npm run eval:quick

# 矩阵套件（模板参数全量展开，repeat 2，按需大覆盖扫描）
npm run eval:matrix

# 离线列出全部展开实例（不连服）
npm run eval:list

# 单场景（钉名或矩阵 ID 均可）
node --import tsx/esm ../../benchmark/engineering/core/runner.ts --scenario NAV-02
node --import tsx/esm ../../benchmark/engineering/core/runner.ts --scenario GATHER-M07

# 跑完存为基线（阶段〇产出 reports/baseline.json）
node --import tsx/esm ../../benchmark/engineering/core/runner.ts --suite full --save-baseline

# 仅类型检查（不连服）
npm run eval:check
```

### 纯聊天记忆验收辅助

```bash
# 生成 Gate 2 的 Capture 50 题非实现者盲审包
npm run eval:memory:capture-blind-review

# 在 MAB Summary Answer/Judge 均完整且同源后，生成 Gate 4 的 50 题一致性盲审包
npm run eval:memory:summary-judge-blind-review -- --report <answer.json> --judge <judge.json>
```

外部 Runner 的 Fatal/Checkpoint 恢复机制可以在不消耗真实模型额度的情况下，使用本机 OpenAI-compatible 故障注入服务完成全量协议验收：

```bash
npm run eval:memory:recovery-acceptance
npm run eval:memory:judge-recovery-acceptance
```

第一条命令在官方 MemoryAgentBench Answer 全量数据上制造“首题成功、第二题 HTTP 402”，保存 Partial Checkpoint，再让同一 Endpoint 恢复 HTTP 200 并续跑到 `failed=0`。第二条命令对官方 300 个 LongMem Judge Case 执行同类故障注入，并验证重复 `qa_pair_id` 的复合身份与 300/300 恢复。固定 Answer/Judge 响应只证明恢复机制，不参与记忆质量或 Gate 4 分数。

两套盲审相互独立。生成器会把审阅表与答案键分开；Summary Judge 生成器对部分报告、失败报告、重复 ID 和错源报告 fail closed，不能用旧的 50/100 Judge checkpoint 生成正式验收证据。

### 套件分层（FEAT-CROSS-03）

| 套件 | 内容 | 用途 |
|------|------|------|
| `quick` | quick 标记实例（NAV-01/02） | 冒烟，时长红线 |
| `full` | 17 个钉名实例（原 13 + SURV/COMB·4，ID/判据稳定） | 基线比对（AC1） |
| `matrix` | 模板参数轴笛卡尔积全量（NAV-FLAT×3 + GATHER×12…） | 大覆盖扫描，按需跑 |

> 场景由「模板 + 参数轴 + pinned」展开（`benchmark/engineering/core/template.ts`）：钉名实例保留原 ID+suite（基线兼容），
> 矩阵实例 ID=`前缀-M01..`、suite=matrix。新增场景 = 写模板，runner/report 无感知（OCP）。

**环境变量**（可选，写 `.env`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `EVAL_HOST` | `localhost` | 服务器地址 |
| `EVAL_PORT` | `25565` | 端口 |
| `EVAL_VERSION` | 空（自动协商） | 仅在确认服务端精确版本时覆盖；错误版本会在握手阶段断连 |
| `EVAL_DIRECTOR` | `EvalDirector` | 导演用户名（需 op） |
| `EVAL_SUBJECT` | `EvalSubject` | 被测用户名 |
| `EVAL_ANCHOR_X/Y/Z` | `1000/120/1000` | 竞技场原点 |
| `EVAL_VERBOSE` | — | 设非空则打印被测 v2 全量日志 |

---

## 场景集（17 · P0 痛点全覆盖）

| ID | 场景 | 成功判据 |
|----|------|---------|
| NAV-01 | 平地走 20 格 | 30s 内水平距目标 <2 |
| NAV-02 | 穿过 1 扇木门 | 45s 内到门对侧 |
| NAV-03 | 障碍穿行 40 格 | 60s 内到达 |
| NAV-04 | 上 5 格台阶坡 | 45s 内爬升 ≥4 格 |
| NAV-05 | 目标不可达(封闭房) | move_to 在 timeout 内**失败放弃**（非卡死） |
| REC-01 | 2 格坑脱困(有方块) | 60s 内 y 回地表 |
| REC-02 | 2 格坑脱困(无方块) | 90s 内 y 回地表 |
| REC-03 | 贴墙角卡死恢复 | 30s 内位移 >3 |
| GATHER-01 | 单树采 1 原木 | 90s 内库存 oak_log ≥1 |
| GATHER-02 | 半径找树采 4 原木 | 180s 内库存 oak_log ≥4 |
| CRAFT-01 | 原木合成木镐 | 60s 内库存 wooden_pickaxe ≥1 |
| FOLLOW-01 | 走 50 格折线跟随 | ≥80% 采样点距离 ≤6 |
| FOLLOW-02 | 穿门跟随 | 60s 内越门且距导演 ≤4 |
| SURV-01 | 饥饿进食 | 120s 内 food 回升 ≥18 |
| SURV-02 | 夜晚受袭存活 | 撑满 90s 且 HP ≥10（中途死亡判负） |
| COMB-01 | 保卫主人(guard) | 60s 内警戒区 zombie 清零 |
| COMB-02 | 自卫反击 | 60s 内 zombie 清零且被测存活 |

> SURV/COMB 需 `/difficulty normal`（默认服可能 peaceful），场景 teardown 自动清怪 + 还原难度/时间。
> 新增成功模型：`failFast`（提前死亡判负）+ `endCheck`（撑到 timeout 存活判胜）。

---

## 基线维护规则

- **基线 = 改造前的成绩单**。阶段一/二/三任何执行层改动，必须先有基线、改完再跑对照。
- 采集基线：`node --import tsx/esm ../../benchmark/engineering/core/runner.ts --suite full --save-baseline` → 写 `benchmark/baselines/engineering/baseline.json`。
- 此后 `npm run eval` 自动与基线逐场景比对，**任一场景成功率低于基线即标 ⚠️（违反 AC5 门禁）**。
- 基线随真服/版本变化可能漂移；重大环境变更后需重采并在 commit 说明。

---

## 阶段进度

- ✅ **阶段〇**（本目录）：评测地基 + 13 场景 + 基线采集。零线上改动。
- ⏳ 阶段一：MotorService（含 `check:motor` 脚本）。
- ⏳ 阶段二：StuckSentinel + RecoveryCoordinator。
- ⏳ 阶段三：NavBudget。

> `check:motor`（运动控制直写防护）按设计 §4 属于**阶段一**——当前迁移未做，现在建会满屏违规，故本阶段不落地。
