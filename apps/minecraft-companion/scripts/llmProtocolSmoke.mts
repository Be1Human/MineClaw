import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_LLM_API, isLlmApi, type LlmApi } from '../src/llm/api.js';
import { LLMClient } from '../src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMToolCallResult, LLMUsage } from '../src/bot/v2/cognitive/llm/types.js';

interface StoredConfig {
  id?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  api?: LlmApi;
}

interface Sample {
  ok: boolean;
  contractOk: boolean;
  durationMs: number;
  usage: LLMUsage | null;
  error?: string;
}

interface CliOptions {
  configFile: string;
  config: string;
  repeat: number;
  api?: LlmApi;
  model?: string;
}

const options = parseArgs(process.argv.slice(2));
const configs = JSON.parse(await readFile(resolve(options.configFile), 'utf8')) as unknown;
if (!Array.isArray(configs)) throw new Error('config file must contain an array');
const selected = configs.find(candidate => isRecord(candidate)
  && (candidate.id === options.config || candidate.name === options.config)) as StoredConfig | undefined;
if (!selected) throw new Error(`LLM config not found: ${options.config}`);
const api = options.api ?? selected.api ?? DEFAULT_LLM_API;
if (!isLlmApi(api)) throw new Error('selected config has an unsupported api');
const apiKey = requiredString(selected.apiKey, 'selected config API key');
const baseUrl = requiredString(selected.baseUrl, 'selected config base URL');
const model = options.model ?? requiredString(selected.model, 'selected config model');

const client = new LLMClient({
  routeId: selected.id?.trim() || selected.name?.trim() || 'protocol-smoke',
  apiKey,
  baseUrl,
  model,
  api,
}, () => undefined);

const ordinary: Sample[] = [];
const tool: Sample[] = [];
for (let index = 0; index < options.repeat; index += 1) {
  ordinary.push(await runSample(async () => {
    const result = await client.callWithTools({
      messages: [
        { role: 'system', content: 'You are a protocol smoke test. Follow the exact output contract.' },
        { role: 'user', content: 'Reply with exactly MINECLAW_SMOKE_OK and nothing else.' },
      ],
      tools: [],
      toolChoice: 'none',
      temperature: 0,
      // Responses models may spend part of the output budget on reasoning before
      // producing visible text. Keep enough headroom to test the wire protocol.
      maxTokens: 128,
      timeoutMs: 30_000,
    });
    return {
      result,
      ok: Boolean(result?.content.trim()) && result?.toolCalls.length === 0,
      contractOk: result?.content.trim() === 'MINECLAW_SMOKE_OK' && result.toolCalls.length === 0,
    };
  }));

  tool.push(await runSample(async () => {
    const result = await client.callWithTools({
      messages: [{
        role: 'user',
        content: 'Call echo_probe exactly once with marker MINECLAW_TOOL_OK. Do not answer in text.',
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'echo_probe',
          description: 'Returns a deterministic smoke-test marker.',
          parameters: {
            type: 'object',
            properties: { marker: { type: 'string' } },
            required: ['marker'],
            additionalProperties: false,
          },
        },
      }],
      toolChoice: { type: 'function', function: { name: 'echo_probe' } },
      temperature: 0,
      maxTokens: 64,
      timeoutMs: 30_000,
    });
    const matching = result?.toolCalls.filter(call => (
      call.name === 'echo_probe' && call.arguments.marker === 'MINECLAW_TOOL_OK'
    )) ?? [];
    return {
      result,
      ok: Boolean(result?.toolCalls.length),
      contractOk: matching.length === 1 && result?.toolCalls.length === 1,
    };
  }));
}

process.stdout.write(`${JSON.stringify({
  schema: 'mineclaw.llm-protocol-smoke/v1',
  route: {
    name: selected.name?.trim() || selected.id?.trim() || 'unnamed',
    api,
    baseUrlOrigin: safeOrigin(baseUrl),
    model,
  },
  repeat: options.repeat,
  ordinary: summarize(ordinary),
  tool: summarize(tool),
}, null, 2)}\n`);

async function runSample(
  execute: () => Promise<{ result: LLMToolCallResult | null; ok: boolean; contractOk: boolean }>,
): Promise<Sample> {
  const started = performance.now();
  try {
    const { result, ok, contractOk } = await execute();
    return {
      ok,
      contractOk,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      usage: result?.usage ? structuredClone(result.usage) : null,
      ...(!result ? { error: 'empty_result' } : ok ? {} : { error: 'protocol_mismatch' }),
    };
  } catch (error) {
    return {
      ok: false,
      contractOk: false,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      usage: null,
      error: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}

function summarize(samples: Sample[]) {
  const durations = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
  const successful = samples.filter(sample => sample.ok);
  const contractSuccessful = samples.filter(sample => sample.contractOk);
  return {
    successful: successful.length,
    total: samples.length,
    successRate: successful.length / samples.length,
    contractSuccessful: contractSuccessful.length,
    contractSuccessRate: contractSuccessful.length / samples.length,
    contractMismatches: samples.filter(sample => sample.ok && !sample.contractOk).length,
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    usage: {
      inputTokens: sumUsage(successful, 'inputTokens'),
      outputTokens: sumUsage(successful, 'outputTokens'),
      totalTokens: sumUsage(successful, 'totalTokens'),
      cachedInputTokens: sumUsage(successful, 'cachedInputTokens'),
      cacheWriteInputTokens: sumUsage(successful, 'cacheWriteInputTokens'),
      reasoningOutputTokens: sumUsage(successful, 'reasoningOutputTokens'),
      sources: [...new Set(successful.flatMap(sample => sample.usage?.source ? [sample.usage.source] : []))],
    },
    errors: samples.flatMap(sample => sample.error ? [sample.error] : []),
  };
}

function sumUsage(samples: Sample[], field: keyof LLMUsage): number | null {
  const values = samples.map(sample => sample.usage?.[field]).filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value)
  ));
  return values.length === samples.length && values.length > 0
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index]!;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw usageError();
    values.set(key.slice(2), value);
  }
  const configFile = values.get('config-file');
  const config = values.get('config');
  const repeat = Number(values.get('repeat') ?? '1');
  const api = values.get('api');
  const model = values.get('model')?.trim();
  if (!configFile || !config || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw usageError();
  if (api !== undefined && !isLlmApi(api)) throw usageError();
  if (values.has('model') && !model) throw usageError();
  return { configFile, config, repeat, ...(api ? { api } : {}), ...(model ? { model } : {}) };
}

function usageError(): Error {
  return new Error('usage: --config-file <path> --config <id-or-name> [--repeat 1..20] [--api openai-completions|openai-responses] [--model model-id]');
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing`);
  return value.trim();
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '<invalid-origin>';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
