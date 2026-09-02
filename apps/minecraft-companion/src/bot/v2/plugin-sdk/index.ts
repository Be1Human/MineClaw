/**
 * Plugin SDK public surface (kernel design §5.2–§5.3).
 * This is the only contract layer a plugin may import. It must never re-export
 * legacy Capability Package types or expose arbitrary Registry access.
 */
export {
  PLUGIN_FAILURE_CODES,
  CONTRIBUTION_AVAILABILITY,
  PluginContractError,
  pluginError,
  toPluginFailure,
  type PluginFailureCode,
  type ContributionAvailability,
} from './errors.js';
export {
  PLUGIN_ID_PATTERN,
  pluginIdentityOf,
  contributionRefOf,
  refsEqual,
  type PluginIdentity,
  type ContributionRef,
  type RegistrySnapshotRef,
  type PluginGoalLease,
} from './identity.js';
export {
  parseSemVer,
  isValidSemVer,
  isValidVersionRange,
  apiVersionCompatible,
  versionInRange,
  type ParsedSemVer,
} from './semver.js';
export {
  parseDependencies,
  parseContributionRequirements,
  isPluginDependencyDeclaration,
  isContributionDependencyDeclaration,
  isContributionRequirement,
  type PluginDependencyDeclaration,
  type ContributionDependencyDeclaration,
  type PluginDependenciesDeclaration,
  type ContributionRequirement,
} from './dependencies.js';
export {
  PERMISSION_ACTIONS,
  SYSTEM_PERMISSION_NAMESPACES,
  parsePermissions,
  type PluginPermissionDeclaration,
} from './permissions.js';
export {
  validatePluginManifest,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_KINDS,
  type PluginManifestV1,
  type PluginKind,
  type PluginManifestValidationInput,
} from './manifest.js';
export {
  CONTRIBUTION_KINDS,
  DATA_PLUGIN_CONTRIBUTION_KINDS,
  parseContribution,
  contributionKindOf,
  type PluginContribution,
  type PluginContributionKind,
  type KnowledgeContribution,
  type SkillContribution,
  type ObservationContribution,
  type GoalContribution,
  type PlanningContribution,
  type VerificationContribution,
  type ExecutionContribution,
  type ResultContribution,
  type ProactiveContribution,
  type IntegrationContribution,
  type PluginGoalTargetDeclaration,
  type PluginOperationDeclaration,
} from './contributions.js';
export {
  verifyExecutionClosure,
  assertExecutionClosure,
  packageIncompleteError,
  type ClosureVerification,
  type ClosureRing,
} from './closure.js';
export {
  evaluateContributionAvailability,
} from './availability.js';
export {
  FACT_KINDS,
  type FactKind,
  type ClosedSchema,
  type PluginObservationDescriptor,
  type PluginObservationFact,
  type PluginObservationResult,
  type PluginObservationProvider,
  type PluginObservationProviderFactory,
  type ObservationCoverageDeclaration,
  type ObservationLimits,
  type ObservationEvidenceRef,
} from './contracts/observation.js';
export {
  type PluginPlanningInput,
  type PluginBindingResult,
  type PluginCandidateResult,
  type PluginProgressResult,
  type PluginBindingProvider,
  type PluginCandidateProvider,
  type PluginProgressProvider,
  type PluginPlanningStatus,
} from './contracts/planning.js';
export {
  type PluginPredicateEvaluator,
  type PluginPredicateInput,
  type PluginPredicateResult,
  type PluginPredicateVerdict,
} from './contracts/verification.js';
export {
  type PluginBehaviorFactory,
  type PluginBehaviorInstance,
  type PluginBehaviorContext,
  type PluginBehaviorResult,
  type PluginActivityFactory,
  type PluginActivityInstance,
  type PluginAtomicExecutor,
} from './contracts/execution.js';
export {
  type PluginResultProjection,
  type PluginResultProjectionInput,
  type PluginResultProjectionOutput,
  type PluginResultProjectionResult,
  type PluginGoalVerdict,
  type PluginResultEvidenceBundle,
} from './contracts/result.js';
export {
  type PluginSystemIntegration,
  type PluginSystemIntegrationStatus,
  type BoundedBlockObservationPort,
  type BoundedInventoryObservationPort,
} from './contracts/integration.js';
export {
  createScopedHostContext,
  createVoidResourceTracker,
  type ScopedHostContext,
  type ScopedResourceTracker,
  type PluginTrackedResource,
  type PluginActivationGate,
  type PluginConstructionContext,
  type PluginHostIdentity,
} from './contracts/scopedContext.js';
export {
  defaultSnapshot,
  defaultLease,
  defaultContrib,
  defaultScopedContext,
  observationProviderContract,
  predicateContract,
  planningContract,
  behaviorFactoryContract,
  resultProjectionContract,
  systemIntegrationContract,
  combine,
  type ContractSuiteResult,
  type ContractFailure,
} from './testing/sharedContractSuite.js';
