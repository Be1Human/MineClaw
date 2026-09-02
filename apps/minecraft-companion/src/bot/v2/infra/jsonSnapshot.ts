/** Detached, deeply frozen JSON; rejects cycles/functions/non-finite values instead of dropping them. */
export function jsonSnapshot<T>(value: T): T {
  const active = new Set<object>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object') throw new Error('capability metadata must be finite JSON');
    if (active.has(item)) throw new Error('cyclic capability metadata');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('capability metadata must use plain JSON objects');
    }
    active.add(item);
    const result = Array.isArray(item) ? item.map(copy) : Object.fromEntries(Object.keys(item).sort().map(key => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`unsafe capability metadata key: ${key}`);
      return [key, copy((item as Record<string, unknown>)[key])];
    }));
    active.delete(item);
    return Object.freeze(result);
  };
  return copy(value) as T;
}
