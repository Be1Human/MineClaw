<p align="right">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <img src="apps/minefriend-site/public/brand/mineclaw-mark.svg" alt="MineClaw 标志" width="128" height="128" />
</p>

<h1 align="center">MineClaw</h1>

<p align="center">
  <strong>一个真正住进 Minecraft 世界、能聊天、能行动、能与你共同成长的具身 AI 伙伴。</strong>
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white" />
  <img alt="Minecraft Java Edition" src="https://img.shields.io/badge/Minecraft-Java%20Edition-62B47A" />
  <img alt="项目状态：持续开发" src="https://img.shields.io/badge/status-active%20development-F59E0B" />
</p>

<p align="center">
  <a href="#why-mineclaw">为什么是 MineClaw</a> ·
  <a href="#capabilities">核心能力</a> ·
  <a href="#architecture">架构</a> ·
  <a href="#quick-start">快速开始</a> ·
  <a href="#development">开发与验证</a> ·
  <a href="#contributing">参与贡献</a>
</p>

---

<a id="why-mineclaw"></a>

## 为什么是 MineClaw

MineClaw 想验证一个简单的想法：AI 伙伴不应该只存在于聊天框里。她应该和玩家共享同一个世界，理解自然语言目标，真正采取行动，观察行动结果，并诚实地说明发生了什么。

项目把 Mineflayer 游戏身体、LLM 驱动的伙伴与目标循环、本地可观测控制台，以及可重复运行的测试和 Benchmark 组合在一起。最终得到的不是一次性命令工具，而是一个可以日常聊天、进入 Minecraft 陪伴玩家，并共同推动世界发生真实变化的伙伴。

<p align="center">
  <img src="apps/minefriend-site/public/media/images/live-perception.jpg" alt="MineClaw 本地控制台展示伙伴对 Minecraft 世界的实时感知" width="900" />
</p>

<a id="capabilities"></a>

## 核心能力

MineClaw 围绕可验证的伙伴循环构建，而不是只执行一次命令就结束。

| 能力 | 含义 |
|---|---|
| 伙伴式对话 | 保持独立人格与表达方式，并区分日常聊天和游戏任务执行。 |
| Minecraft 具身控制 | 通过 Mineflayer 身体读取实时位置、生命值、背包、附近方块与实体。 |
| 目标驱动行动 | 理解玩家目标、规划步骤、调用可复用能力，并在世界状态不符合计划时调整。 |
| 世界状态验真 | 在报告成功前，使用背包、方块、容器、距离等游戏事实核对结果。 |
| 记忆与可复用技能 | 记录有价值的经历，为后续目标检索相关知识与策略。 |
| 本地可观测性 | 在控制台中展示对话、任务进展、模型调用、事件和完成证据。 |
| 可重复评测 | 用版本化的功能测试与能力 Benchmark 持续验证产品表现。 |

> MineClaw 仍在持续开发。实际能力覆盖会受到 Minecraft 版本、服务器配置、现场材料和模型提供商影响。

<a id="architecture"></a>

## 架构

运行时把对话、目标执行、游戏控制、结果证据与可观测性连接在一起，同时避免把所有职责塞进一个巨型 Agent。

```text
玩家
  │
  ├── 日常对话 ──────> MainBrain ───────────────┐
  │                                              │
  └── 游戏目标 ──────> GoalAgent 循环            │
                         │                        │
                         ├── 规划 / 恢复          │
                         ├── 技能 / 策略          │
                         ├── 原子能力             │
                         └── 世界状态验真         │
                                  │               │
                                  v               v
Minecraft 服务器 <──> Mineflayer 适配器       记忆与轨迹
                                  │               │
                                  └──────> 本地 Web 控制台
```

仓库主要目录如下：

```text
MineClaw/
├── apps/
│   ├── minecraft-companion/      # 运行时、Electron 外壳与 Vue 控制台
│   └── minefriend-site/          # 独立产品宣传站
├── test-case/                    # 功能测试与回归测试工作区
├── benchmark/                    # 能力与工程质量评测套件
├── scripts/                      # 发布和工作区验证工具
├── AGENTS.md                     # 面向开发者和 Agent 的公开协作规则
├── CONTRIBUTING.md               # 贡献流程
└── SECURITY.md                   # 安全问题报告策略
```

<a id="quick-start"></a>

## 快速开始

### 环境要求

- Node.js 22 或更高版本
- 可访问的 Minecraft Java Edition 服务器
- OpenAI 兼容的 LLM 接口和 API Key

仓库不会包含 Minecraft 世界、服务器程序、账号凭据、本地数据库、运行日志或 Agent 记忆。

### 1. 启动伙伴运行时

```bash
cd apps/minecraft-companion
npm ci
cp .env.example .env
npm run dev
```

Windows PowerShell 用户可使用以下命令创建环境文件：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，填入你自己的 Minecraft 服务器与模型提供商配置。不要提交该文件。

### 2. 启动本地控制台

在第二个终端中运行：

```bash
cd apps/minecraft-companion/web
npm ci
npm run dev
```

伙伴运行时和控制台是两个独立的开发进程。使用浏览器控制界面时，请保持两者同时运行。

### 3. 启动产品宣传站

MineClaw 宣传站不依赖 Bot 或 Minecraft 服务器，可以独立开发：

```bash
cd apps/minefriend-site
npm ci
npm run dev
```

<a id="development"></a>

## 开发与验证

### 质量检查

先运行仓库边界检查，再执行与你的改动相关的构建：

```bash
node scripts/check-release.mjs

cd apps/minecraft-companion && npm run build
cd web && npm run build

cd ../../minefriend-site && npm run build
```

修改后端行为时，还应运行对应的 `npm run test:v2` 子集或完整适用测试。能力与工程评测位于 [`benchmark/`](benchmark/)，功能和回归测试位于 [`test-case/`](test-case/)。

### 仓库边界

本仓库只包含可公开发布的源码、测试、Benchmark、配置模板和网站资源。以下内容必须保留在版本控制之外：

- `.env` 文件与凭据
- Minecraft 世界、玩家数据、服务器程序和 RCON 信息
- 运行数据库、日志、缓存、构建产物和 Agent 记忆
- 私有工作区元数据或内部文档

[`scripts/check-release.mjs`](scripts/check-release.mjs) 会自动检查公开发布边界。

<a id="contributing"></a>

## 参与贡献

开始修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。每次贡献应保持单一目标，增加或更新相关测试，并说明用户可见结果与已执行的验证。

仓库专属的开发者与 Agent 规则位于 [AGENTS.md](AGENTS.md)。报告漏洞或敏感问题时，请遵循 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中发布密钥或私有服务器信息。

<a id="license"></a>

## 许可证

本仓库目前尚未提供开源许可证授权。在项目所有者正式添加许可证前，源码可以查看，但不得将其视为开源项目进行复制、分发或复用。

---

<p align="center">
  <strong>MineClaw——分享同一个世界，而不只是同一个聊天框。</strong>
</p>
