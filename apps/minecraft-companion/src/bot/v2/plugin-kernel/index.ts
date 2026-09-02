/**
 * Plugin Host — the composition-root entry of the plugin kernel (design §5.1/§5.5).
 * Boot: discover → deterministic resolve → per-package transaction
 * (construct/stage/validate/prepareStart/commit). A failing package aborts to the
 * previous generation; already-published packages are not polluted. The host
 * itself holds no domain imports and no business branches.
 */
import { discoverPlugins, type BuiltinPluginIndex, type DiscoveredPluginPackage } from './discovery.js';
import { resolvePluginDependencies } from './dependency.js';
import { checkStaticDependencyPolicy, FIRST_PARTY_STATIC_POLICY, type StaticDependencyPolicy } from './permission.js';
import {
  bootstrapGeneration,
  createActivationGate,
  RegistrationTransaction,
  PublishedGenerationSlot,
  type ActiveGenerationRecord,
  type PluginActivationGate,
  type PublishedGenerationSet,
} from './registration.js';
import { toPluginFailure, type PluginFailureCode } from '../plugin-sdk/errors.js';
import { toDataContribution, type ManifestContribution } from '../plugin-sdk/contributions.js';
import type { PluginConstructionContext } from '../plugin-sdk/contracts/scopedContext.js';
import type { PluginFactory } from './discovery.js';

export interface PluginHostConfig {
  readonly hostApiVersion: string;
  readonly buildId: string;
  readonly builtinIndex: BuiltinPluginIndex;
  readonly dataPluginRoot?: string;
  readonly trustedSystemPlugins?: readonly string[];
  readonly staticDependencyPolicy?: StaticDependencyPolicy;
  /** entryKey → static import list collected by the build index generator. */
  readonly staticDependencyImports?: ReadonlyMap<string, readonly string[]>;
  /** Adapter/storage/LLM ports injected into release-builtin system plugins at construct time. */
  readonly systemPorts?: Readonly<Record<string, unknown>>;
  readonly onGenerationActivated?: (record: ActiveGenerationRecord) => void;
}

export interface PluginPackageFailure {
  readonly pluginId: string;
  readonly code: PluginFailureCode;
  readonly message: string;
}

export interface PluginHostBootResult {
  readonly slot: PublishedGenerationSlot;
  readonly gate: PluginActivationGate;
  readonly installed: readonly string[];
  readonly failures: readonly PluginPackageFailure[];
  /** Services published by activated plugins (system observation ports etc.), by dependency order. */
  readonly services: Readonly<Record<string, unknown>>;
}

export class PluginHost {
  private readonly config: PluginHostConfig;

  constructor(config: PluginHostConfig) {
    this.config = config;
  }

  async boot(): Promise<PluginHostBootResult> {
    const discovery = await discoverPlugins({
      builtinIndex: this.config.builtinIndex,
      dataPluginRoot: this.config.dataPluginRoot,
      hostApiVersion: this.config.hostApiVersion,
      trustedSystemPlugins: this.config.trustedSystemPlugins,
    });
    const slotInstance = new PublishedGenerationSlot(bootstrapGeneration(this.config.buildId));
    const gate = createActivationGate();
    const installed: string[] = [];
    const failures: PluginPackageFailure[] = discovery.failures.map((failure) => ({
      pluginId: failure.pluginId,
      code: failure.code as PluginFailureCode,
      message: failure.message,
    }));
    const services = new Map<string, unknown>();

    let resolved;
    try {
      resolved = resolvePluginDependencies(discovery.packages);
    } catch (error) {
      const failure = toPluginFailure(error);
      failures.push({ pluginId: '<resolution>', code: failure.code, message: failure.message });
      return Object.freeze({ slot: slotInstance, gate, installed: Object.freeze(installed), failures: Object.freeze(failures), services: Object.freeze({}) });
    }

    for (const pkg of resolved.order) {
      const tx = new RegistrationTransaction(pkg.manifest, {
        buildId: this.config.buildId,
        existingSlot: slotInstance,
      });
      try {
        this.checkStaticGate(pkg);
        const context = this.stagingContext(pkg, services);
        tx.construct(pkg.factory ?? dataPluginFactory(pkg), context);
        tx.stage();
        tx.validate();
        await tx.prepareStart(gate);
        const record = tx.commit(gate, slotInstance.read());
        installed.push(pkg.identity.pluginId);
        collectServices(record, services);
        this.config.onGenerationActivated?.(record);
      } catch (error) {
        await tx.abort().catch(() => undefined);
        const failure = toPluginFailure(error);
        failures.push({ pluginId: pkg.identity.pluginId, code: failure.code, message: failure.message });
      }
    }
    return Object.freeze({
      slot: slotInstance,
      gate,
      installed: Object.freeze(installed),
      failures: Object.freeze(failures),
      services: Object.freeze({ ...Object.fromEntries(services) }),
    });
  }

  private checkStaticGate(pkg: DiscoveredPluginPackage): void {
    if (pkg.factory === undefined) return;
    // Trusted system plugins are release-owned and may reach adapter ports; the gate protects domain plugins.
    if (pkg.manifest.kind === 'system') return;
    const imports = this.config.staticDependencyImports?.get(pkg.factory.entryKey) ?? [];
    checkStaticDependencyPolicy(
      pkg.identity.pluginId,
      pkg.factory.entryKey,
      imports,
      this.config.staticDependencyPolicy ?? FIRST_PARTY_STATIC_POLICY,
    );
  }

  private stagingContext(pkg: DiscoveredPluginPackage, services: ReadonlyMap<string, unknown>): PluginConstructionContext {
    return Object.freeze({
      host: { version: this.config.hostApiVersion, buildId: this.config.buildId },
      plugin: pkg.identity,
      ...(pkg.manifest.kind === 'system' && this.config.systemPorts !== undefined ? { systemPorts: this.config.systemPorts } : {}),
      ...(services.size > 0 ? { services: Object.freeze({ ...Object.fromEntries(services) }) } : {}),
      ...(pkg.manifest.kind === 'system' ? { signal: new AbortController().signal } : {}),
    });
  }
}

/** Publish integration services of a freshly committed generation to the host service table. */
function collectServices(record: ActiveGenerationRecord, services: Map<string, unknown>): void {
  for (const contribution of record.registry.byId.values()) {
    if (contribution.contribution.kind !== 'integration') continue;
    const integration = (contribution.contribution as { integration?: { services?: Readonly<Record<string, unknown>> } }).integration;
    for (const [key, service] of Object.entries(integration?.services ?? {})) services.set(key, service);
  }
}

/** Data plugins carry no factory: the loader turns knowledge/skill declarations into content contributions. */
function dataPluginFactory(pkg: DiscoveredPluginPackage): PluginFactory {
  const declarations = pkg.manifest.contributions.filter(
    (contribution) => contribution.kind === 'knowledge' || contribution.kind === 'skill',
  );
  return {
    entryKey: `data/${pkg.identity.pluginId}`,
    create: () => declarations.map((declaration) => toDataContribution(declaration as ManifestContribution & { kind: 'knowledge' | 'skill' })),
  };
}
