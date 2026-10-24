import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_PATTERN = /(?:429|50[0-4]|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket disconnected|network error|timed out|timeout|rate limit|temporarily unavailable|aborterror)/iu;
const UNSUPPORTED_PATTERN = /(?:model.{0,100}not supported|unsupported model|model_not_found|does not have access to model)/iu;

export class PreflightModelError extends Error {
  constructor(code, models, { category, operatorAction, cause } = {}) {
    super(`dispatch preflight ${code} for ${models.join(', ')}`,
      cause === undefined ? {} : { cause });
    this.name = 'PreflightModelError';
    this.code = code;
    this.category = category;
    this.operatorAction = operatorAction;
    this.models = models;
  }
}

export function preflightModelCandidates(config) {
  return [...new Set([
    config.codexPreflightModel,
    config.codexPreflightFallbackModel,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

export function classifyPreflightError(error) {
  const parts = [];
  for (let current = error, depth = 0; current && depth < 3; depth += 1) {
    parts.push(String(current.name || ''));
    parts.push(String(current.message || current));
    current = current.cause;
  }
  const message = parts.join(' ');
  if (UNSUPPORTED_PATTERN.test(message)) return 'unsupported_model';
  if (TRANSIENT_PATTERN.test(message)) return 'temporary';
  return 'needs_attention';
}

export async function runWithCompatiblePreflightModel({
  models,
  runModel,
  maxTransientRetries = 2,
  backoffMs = [1000, 3000],
  sleep = (ms) => delay(ms),
}) {
  if (!Array.isArray(models) || !models.length || typeof runModel !== 'function') {
    throw new TypeError('dispatch preflight requires model candidates and a runner');
  }
  const attemptedModels = [];
  let lastUnsupportedError;
  for (const model of [...new Set(models)]) {
    attemptedModels.push(model);
    for (let retry = 0; retry <= maxTransientRetries; retry += 1) {
      try {
        return { model, result: await runModel(model), attempts: retry + 1 };
      } catch (error) {
        const category = classifyPreflightError(error);
        if (category === 'unsupported_model') {
          lastUnsupportedError = error;
          break;
        }
        if (category === 'temporary' && retry < maxTransientRetries) {
          await sleep(backoffMs[Math.min(retry, backoffMs.length - 1)]);
          continue;
        }
        throw new PreflightModelError(
          category === 'temporary' ? 'temporary_retries_exhausted' : 'requires_operator_review',
          attemptedModels,
          {
            category,
            cause: error,
            operatorAction: category === 'temporary'
              ? 'review connectivity and retry the same request after checking side effects'
              : 'review Codex authentication or request configuration',
          },
        );
      }
    }
  }
  throw new PreflightModelError('no_supported_model', attemptedModels, {
    category: 'unsupported_model',
    cause: lastUnsupportedError,
    operatorAction: 'validate a supported structured-output model for this account',
  });
}

export const STARTUP_PROBE_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ok: { type: 'string', enum: ['yes'] } },
  required: ['ok'],
  additionalProperties: false,
});

export async function validatePreflightCompatibility({
  config,
  createCodex,
  models = preflightModelCandidates(config),
  timeoutMs = 45_000,
  sleep,
}) {
  const result = await runWithCompatiblePreflightModel({
    models,
    sleep,
    runModel: async (model) => {
      const codex = createCodex();
      const thread = codex.startThread({
        workingDirectory: config.workspace,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        modelReasoningEffort: 'medium',
        model,
        threadSource: 'feishu_dispatch_preflight_health',
      });
      const turn = await thread.run(
        'Return only JSON with ok set to yes. Do not use tools or read files.',
        { outputSchema: STARTUP_PROBE_SCHEMA, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (JSON.parse(turn.finalResponse)?.ok !== 'yes') {
        throw new Error('structured preflight probe returned an invalid response');
      }
      return turn;
    },
  });
  return { model: result.model, validatedAt: new Date().toISOString() };
}
