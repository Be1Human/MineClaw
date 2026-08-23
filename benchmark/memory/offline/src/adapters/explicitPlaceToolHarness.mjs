import { memoryTools } from '../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/defs/memoryTools.ts';
import { MemoryV2 } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.ts';

const input = JSON.parse(process.argv[2] ?? '{}');
const memory = new MemoryV2(input.dbPath);
try {
  const tool = memoryTools.find(item => item.name === 'remember_place');
  if (!tool) throw new Error('remember_place tool is not registered');
  const result = tool.execute({ kind: input.kind, name: input.name }, {
    game: { getPosition: () => input.position },
    memory,
  });
  const immediateRows = memory.query('spatial', { kind: input.kind }).length;
  process.stdout.write(`${JSON.stringify({ ...result, immediateRows })}\n`);
} finally {
  memory.close();
}
