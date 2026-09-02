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

    let resolved;
    try {
      resolved = resolvePluginDependencies(discovery.packages);
    } catch (error) {
      const failure = toPluginFailure(error);
      failures.push({ pluginId: '<resolution>', code: failure.code, message: failure.message });
      return Object.freeze({ slot: slotInstance, gate, installed: Object.freeze(installed), failures: Object.freeze(failures) });
    }

    for (const pkg of resolved.order) {
      const tx = new RegistrationTransaction(pkg.manifest, {
        buildId: this.config.buildId,
        existingSlot: slotInstance,
      });
      try {
        this.checkStaticGate(pkg);
        const context = this.stagingContext(pkg);
        tx.construct(pkg.factory ?? dataPluginFactory(pkg), context);
        tx.stage();
        tx.validate();
        await tx.prepareStart(gate);
        const record = tx.commit(gate, slotInstance.read());
        installed.push(pkg.identity.pluginId);
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
    });
  }

  private checkStaticGate(pkg: DiscoveredPluginPackage): void {
    if (pkg.factory === undefined) return;
    const imports = this.config.staticDependencyImports?.get(pkg.factory.entryKey) ?? [];
    checkStaticDependencyPolicy(
      pkg.identity.pluginId,
      pkg.factory.entryKey,
      imports,
      this.config.staticDependencyPolicy ?? FIRST_PARTY_STATIC_POLICY,
    );
  }

  private stagingContext(pkg: DiscoveredPluginPackage): PluginConstructionContext {
    return Object.freeze({
      host: { version: this.config.hostApiVersion, buildId: this.config.buildId },
      plugin: pkg.identity,
    });
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
