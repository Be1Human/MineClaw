import 'dotenv/config';
import { createHubServer } from './hub/server.js';

// ─────────────────────────────────────────────────────────────
// BUG-INFRA-01 · 全局异常兜底（防单点错误崩溃整个后端，保证在线可持续测试）
// 根因：某些错误来自 mineflayer / prismarine-physics 内部事件回调（如进水时物理层
// 对越界/空方块调用 .offset），抛在我们无法 try/catch 的异步上下文 → 进程直接退出 →
// 后端崩溃、所有 bot 掉线、测试中断。
// 对策：捕获 uncaughtException / unhandledRejection，记录后【不退出】。bot 的重连逻辑
// 会自行恢复。这是安全网，不替代根因修复，但能让"严格在线测试"不被偶发崩溃打断。
// ─────────────────────────────────────────────────────────────
let lastFatalAt = 0;
let fatalCount = 0;
function handleFatal(kind: string, err: unknown): void {
  const now = Date.now();
  if (now - lastFatalAt < 1000) { fatalCount++; } else { fatalCount = 1; }
  lastFatalAt = now;
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(`\n🛡 [全局兜底·${kind}] 已捕获并继续运行（第 ${fatalCount} 次）：\n${msg}\n`);
  // 极端：1 秒内连环崩溃 >50 次 → 说明陷入死循环，此时才真正退出（让外层重启）
  if (fatalCount > 50) {
    console.error('🛑 短时间连环异常过多，退出以便重启');
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

const config = {
  port: parseInt(process.env.HUB_PORT ?? '3000', 10),
  host: process.env.HUB_HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? './data',
};

const defaultLlm = {
  apiKey: process.env.LLM_API_KEY ?? '',
  baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
};

async function main() {
  const hub = createHubServer(config, defaultLlm);
  await hub.listen();

  const profiles = hub.profileStore.list();
  if (profiles.length === 0) {
    console.log('  💡 暂无角色配置，打开 Web UI 创建');
  } else {
    console.log(`  📂 已加载 ${profiles.length} 个角色配置`);
  }

  if (defaultLlm.apiKey) {
    console.log(`  🤖 LLM: ${defaultLlm.model} @ ${defaultLlm.baseUrl}`);
  } else {
    console.log('  ⚠️  未配置 LLM_API_KEY，仅支持关键词模式');
  }
  console.log('');
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
