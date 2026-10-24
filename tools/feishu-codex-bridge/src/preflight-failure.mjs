import { DispatchScopeValidationError } from './dispatch-scope.mjs';
import { PreflightModelError } from './preflight-model.mjs';

// Only a verified response-validation failure is request-local. Authentication,
// unavailable models, exhausted transport retries and unknown failures retain
// the global startup gate; message text must never decide that boundary.
export function classifyScopePreflightFailure(error) {
  if (error instanceof DispatchScopeValidationError) {
    return {
      scope: 'request',
      blocksQueue: false,
      category: 'invalid_dispatch_scope',
      operatorAction: 'review this request and its preflight response before authorized same-request recovery',
    };
  }
  return {
    scope: 'system',
    blocksQueue: true,
    category: error instanceof PreflightModelError ? error.category : 'needs_attention',
    operatorAction: error instanceof PreflightModelError
      ? error.operatorAction : 'review preflight authentication, configuration and unexpected failure before recovery',
  };
}

export function recordScopePreflightFailure({
  store, requestId, error, errorSummary, now = () => new Date(),
}) {
  const failure = classifyScopePreflightFailure(error);
  const at = now().toISOString();
  store.updateJob(requestId, {
    status: 'failed',
    stage: 'preflight_blocked',
    completedAt: at,
    errorSummary,
    preflightFailureScope: failure.scope,
    preflightFailureClass: failure.category,
    preflightRecoveryAction: failure.operatorAction,
    preflightRequiresOperatorReview: true,
  });
  store.setRuntime({
    lastPreflightFailureRequestId: requestId,
    lastPreflightFailureAt: at,
    lastPreflightFailureScope: failure.scope,
    operatorAttentionRequired: true,
    ...(failure.blocksQueue ? {
      preflightStatus: 'blocked',
      preflightError: errorSummary,
    } : {}),
  });
  return failure;
}
