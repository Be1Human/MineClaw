export class PerceptionRendererRegistry {
  constructor(context = {}) {
    this.context = context;
    this.factories = new Map();
    this.instances = new Map();
    this.activeId = null;
    this.active = null;
    this.activationEpoch = 0;
    this.pendingActivation = null;
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
    if (id === this.activeId) {
      // A request for the already-visible renderer means the user has chosen to
      // stay here. Invalidate an older transition to a different renderer so it
      // cannot take over after its asynchronous first frame finishes.
      if (this.pendingActivation && this.pendingActivation.id !== id) this.activationEpoch += 1;
      return this.active;
    }
    if (this.pendingActivation?.id === id) return this.pendingActivation.promise;
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`renderer not registered: ${id}`);
    const epoch = ++this.activationEpoch;
    const promise = this.activateCandidate(id, factory, epoch);
    this.pendingActivation = { id, promise };
    try {
      return await promise;
    } finally {
      if (this.pendingActivation?.promise === promise) this.pendingActivation = null;
    }
  }

  async activateCandidate(id, factory, epoch) {
    let candidate = this.instances.get(id);
    if (!candidate) {
      candidate = factory(this.context);
      this.instances.set(id, candidate);
      await candidate.mount?.(this.context);
    }
    await candidate.activate?.(this.context);
    if (epoch !== this.activationEpoch) {
      // Multiple callers may share the same renderer instance. A stale caller
      // must never deactivate an instance already adopted by a newer request.
      if (this.active !== candidate) candidate.deactivate?.(this.context);
      return this.active;
    }
    const previous = this.active;
    this.active = candidate;
    this.activeId = id;
    if (previous && previous !== candidate) previous.deactivate?.(this.context);
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
    this.pendingActivation = null;
    this.activationEpoch += 1;
  }
}
