import type { BenchmarkAdapter, BenchmarkDomain, UnifiedBenchmarkCase } from './types.js';

export class BenchmarkAdapterRegistry {
  private readonly adapters = new Map<BenchmarkDomain, BenchmarkAdapter>();

  register<TCase extends UnifiedBenchmarkCase>(adapter: BenchmarkAdapter<TCase>): this {
    if (this.adapters.has(adapter.domain)) throw new Error(`duplicate benchmark adapter: ${adapter.domain}`);
    this.adapters.set(adapter.domain, adapter as BenchmarkAdapter);
    return this;
  }

  get(domain: BenchmarkDomain): BenchmarkAdapter {
    const adapter = this.adapters.get(domain);
    if (!adapter) throw new Error(`missing benchmark adapter: ${domain}`);
    return adapter;
  }

  domains(): BenchmarkDomain[] {
    return [...this.adapters.keys()];
  }
}
