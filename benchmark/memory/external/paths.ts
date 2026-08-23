import { resolve } from 'node:path';

export const EXTERNAL_DATASET_DIR = resolve(import.meta.dirname, 'datasets');
export const MEMORY_AGENT_BENCH_DATA_DIR = resolve(EXTERNAL_DATASET_DIR, 'memory-agent-bench-data');
export const EXTERNAL_REPORT_DIR = resolve(import.meta.dirname, '..', '..', 'reports', 'memory', 'external');
