export interface FactRegion {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

/** An observation is evidence, not authorization to modify the observed region. */
export interface WorldFact<TValue = unknown> {
  readonly providerId: string;
  /** Required for versioned predicates; old v1 Providers may omit it. */
  readonly version?: string;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly bounds: Readonly<Record<string, unknown>>;
  readonly value: TValue;
  readonly evidenceRefs: readonly string[];
}

/** Code-owned prerequisite bound from already schema-validated predicate arguments. */
export interface WorldFactRequirement {
  readonly providerId: string;
  readonly version: string;
  readonly dimension: string;
  readonly worldId?: string;
  readonly region?: FactRegion;
}

export interface WorldFactRequest {
  readonly providerId: string;
  readonly version: string;
  readonly params: Readonly<Record<string, unknown>>;
}
