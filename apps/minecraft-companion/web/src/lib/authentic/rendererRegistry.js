export class PerceptionRendererRegistry {
  constructor(context = {}) {
    this.context = context;
    this.factories = new Map();
    this.instances = new Map();
    this.activeId = null;
    this.active = null;
    this.activationEpoch = 0;
  }

  register(id, factory) {
    if (!id || typeof factory !== 'function') throw new Error('renderer registration requires id and factory');
    if (this.factories.has(id)) throw new Error(`renderer already registered: ${id}`);
    this.factories.set(id, factory);
    return this;
  }

  has(id) {
    return this.factories.has(id);
  }

  async activate(id) {
    const epoch = ++this.activationEpoch;
    if (id === this.activeId) return this.active;
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`renderer not registered: ${id}`);
    let candidate = this.instances.get(id);
    if (!candidate) {
      candidate = factory(this.context);
      this.instances.set(id, candidate);
      await candidate.mount?.(this.context);
    }
    await candidate.activate?.(this.context);
    if (epoch !== this.activationEpoch) {
      candidate.deactivate?.(this.context);
      return this.active;
    }
    const previous = this.active;
    this.active = candidate;
    this.activeId = id;
    previous?.deactivate?.(this.context);
    return candidate;
  }

  update(payload) {
    this.active?.update?.(payload, this.context);
  }

  tick(frame) {
    this.active?.tick?.(frame, this.context);
  }

  async dispose() {
    this.active?.deactivate?.(this.context);
    for (const instance of this.instances.values()) await instance.dispose?.(this.context);
    this.instances.clear();
    this.active = null;
    this.activeId = null;
    this.activationEpoch += 1;
  }
}
