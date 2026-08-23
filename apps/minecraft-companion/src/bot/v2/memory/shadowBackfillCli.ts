import { resolve } from 'node:path';
import { runProfileShadowBackfill } from './shadowBackfill.js';

const args = parseArgs(process.argv.slice(2));
const profileId = args.get('profile-id');
if (!profileId) {
  console.error('Usage: tsx shadowBackfillCli.ts --profile-id <id> [--data-dir <path>] [--batch-size <n>] [--max-batches <n>]');
  process.exitCode = 2;
} else {
  const dataDir = resolve(args.get('data-dir') ?? './data');
  const batchSize = positiveInt(args.get('batch-size'));
  const maxBatchesPerSource = positiveInt(args.get('max-batches'));
  try {
    const result = await runProfileShadowBackfill({
      dataDir,
      profileId,
      ...(batchSize == null ? {} : { batchSize }),
      ...(maxBatchesPerSource == null ? {} : { maxBatchesPerSource }),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null || value.startsWith('--')) continue;
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got: ${value}`);
  return parsed;
}
