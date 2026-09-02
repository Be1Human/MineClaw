export type FailureOrigin =
  | 'decision'
  | 'contract'
  | 'atomic'
  | 'behavior'
  | 'navigation'
  | 'perception'
  | 'environment'
  | 'infra'
  | 'safety';

export type FailureStage = 'deciding' | 'preparing' | 'executing' | 'observing' | 'verifying';

export type FailureCategory =
  | 'contract'
  | 'precondition'
  | 'resource'
  | 'navigation'
  | 'environment'
  | 'transient'
  | 'timeout'
  | 'cancelled'
  | 'fatal';

export interface FailureEnvelope {
  code: string;
  origin: FailureOrigin;
  stage: FailureStage;
  category: FailureCategory;
  retryable: boolean;
  ownerActionable: boolean;
  evidenceRefs: string[];
  detail?: string;
}
