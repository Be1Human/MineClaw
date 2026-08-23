# Engineering Experience · 健身房行为结果 Benchmark

> 本目录同时维护健身房行为结果评测的可执行契约与用例。
> 独立于 `src/`，零线上代码改动。Body 测确定性原子能力（LLM 关），Experience 测**完整生产链路**（LLM 开，指令走玩家聊天）。

## 架构

```
runner.ts ── 编排：每任务 = 基线环境→tp/清背包→快照→搭场→qxy聊天下指令→轮询机判→落档→清场
  ├─ rcon.ts    RCON 客户端（25575）：/fill /give /summon 搭场 + data get / execute if 机判
  ├─ tasks.ts   20 个既有任务 + 6 个可靠性任务（场地/话术/PASS 判据）
  └─ 主人 bot   mineflayer 以 owner 名 qxy 登录（creative 观察位）→ 聊天触发 chat.from_owner
```

- **被测对象**：线上跑着的 LanYi（V2Runtime + LLM 全开），不另起实例。
- **判定**：纯行为结果——RCON 读坐标/背包/容器/实体计数，qxy bot 本地世界扫描方块（门/火把/遮蔽）。
- **落档**：本地 `benchmark/reports/engineering/experience/RUN-*/Txx/`：result.json + runtime.log 切片 + snapshot.md + chat.log；崩溃记 💥 并自动经 Hub API 拉起。

## 用法

```bash
# 在 apps/minecraft-companion 下
node --import tsx/esm ../../benchmark/engineering/experience/runner.ts --run RUN-20260612-0300 --tasks T01,T02,T03
node --import tsx/esm ../../benchmark/engineering/experience/runner.ts --run RUN-20260612-0300
```

T21～T26 覆盖主动澄清、中途改派、不可达求助、完成反馈一致、进度反馈和上下文复用。
发布验收优先通过 `npm run benchmark` 调用，本 Runner 保留为单层调试入口。

可用环境变量：`GYM_BOT`、`GYM_OWNER`、`GYM_HOST`、`GYM_PORT`、`GYM_AUTH`、
`GYM_RCON_HOST`、`GYM_RCON_PORT`、`GYM_RCON_PASSWORD`、`BENCHMARK_BACKEND_URL`。

前置：本地服 127.0.0.1:25565（Paper 1.21，enable-rcon）+ 后端 3000 + LanYi 在线。
