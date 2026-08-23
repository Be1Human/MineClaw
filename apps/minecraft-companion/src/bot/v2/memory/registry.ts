import type { MemorySourceAdapter, MemoryViewBuilder } from './contracts.js';

/** Extension registry: adding a source or consumer view never changes the facade. */
export class MemoryRegistry {
  private readonly sources = new Map<string, MemorySourceAdapter>();
  private readonly views = new Map<string, MemoryViewBuilder>();

  registerSource(adapter: MemorySourceAdapter): this {
    registerUnique(this.sources, adapter.id, adapter, 'source');
    return this;
  }

  registerView(builder: MemoryViewBuilder): this {
    registerUnique(this.views, builder.id, builder, 'view');
    return this;
  }

  source(id: string): MemorySourceAdapter {
    const adapter = this.sources.get(id);
    if (!adapter) throw new Error(`[MemoryRegistry] unknown source: ${id}`);
    return adapter;
  }

  view<TView = unknown>(id: string): MemoryViewBuilder<TView> {
    const builder = this.views.get(id);
    if (!builder) throw new Error(`[MemoryRegistry] unknown view: ${id}`);
    return builder as MemoryViewBuilder<TView>;
  }

  listSources(): MemorySourceAdapter[] {
    return [...this.sources.values()];
  }

  listViews(): MemoryViewBuilder[] {
    return [...this.views.values()];
  }
}

function registerUnique<T>(registry: Map<string, T>, id: string, value: T, kind: string): void {
  const normalized = id.trim();
  if (!normalized) throw new Error(`[MemoryRegistry] ${kind} id must not be empty`);
  if (registry.has(normalized)) throw new Error(`[MemoryRegistry] duplicate ${kind}: ${normalized}`);
  registry.set(normalized, value);
}
