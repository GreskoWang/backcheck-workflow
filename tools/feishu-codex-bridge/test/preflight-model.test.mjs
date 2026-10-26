import { fixturePath } from './fixture-paths.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PreflightModelError,
  classifyPreflightError,
  preflightModelCandidates,
  runWithCompatiblePreflightModel,
  validatePreflightCompatibility,
} from '../src/preflight-model.mjs';

const unsupported = new Error(JSON.stringify({
  status: 400,
  error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." },
}));

test('candidate models are explicit and never inherit a global account model', () => {
  assert.deepEqual(preflightModelCandidates({
    codexPreflightModel: 'gpt-6-sol',
    codexPreflightFallbackModel: 'gpt-5.6-luna',
    codexModel: 'gpt-6.1-sol',
  }), ['gpt-6-sol', 'gpt-5.6-luna']);
  assert.deepEqual(preflightModelCandidates({
    codexPreflightModel: 'gpt-6-sol', codexPreflightFallbackModel: 'gpt-6-sol',
  }), ['gpt-6-sol']);
});

test('unsupported primary model uses one compatible fallback without repeating the rejected call', async () => {
  const calls = [];
  const result = await runWithCompatiblePreflightModel({
    models: ['gpt-6.1-sol', 'gpt-6-sol'],
    runModel: async (model) => {
      calls.push(model);
      if (model === 'gpt-6.1-sol') throw unsupported;
      return { finalResponse: '{"ok":"yes"}' };
    },
    sleep: async () => { throw new Error('unsupported model must not be retried'); },
  });
  assert.deepEqual(calls, ['gpt-6.1-sol', 'gpt-6-sol']);
  assert.equal(result.model, 'gpt-6-sol');
});

test('transient failure gets exactly two backed-off retries before success', async () => {
  let attempts = 0;
  const delays = [];
  const result = await runWithCompatiblePreflightModel({
    models: ['gpt-6-sol'],
    runModel: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('503 temporarily unavailable');
      return { finalResponse: 'ok' };
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [1000, 3000]);
});

test('exhausted transient errors stop with an operator recovery action', async () => {
  let attempts = 0;
  const cause = new Error('ECONNRESET');
  await assert.rejects(runWithCompatiblePreflightModel({
    models: ['gpt-6-sol', 'gpt-5.6-luna'],
    runModel: async () => { attempts += 1; throw cause; },
    sleep: async () => {},
  }), (error) => {
    assert.ok(error instanceof PreflightModelError);
    assert.equal(error.code, 'temporary_retries_exhausted');
    assert.equal(error.category, 'temporary');
    assert.equal(error.cause, cause);
    assert.match(error.operatorAction, /retry the same request/u);
    return true;
  });
  assert.equal(attempts, 3);
});

test('authorization errors stop without model fallback or repeated calls', async () => {
  let attempts = 0;
  const cause = new Error('401 invalid authentication');
  await assert.rejects(runWithCompatiblePreflightModel({
    models: ['gpt-6-sol', 'gpt-5.6-luna'],
    runModel: async () => { attempts += 1; throw cause; },
  }), (error) => error.code === 'requires_operator_review' && error.cause === cause);
  assert.equal(attempts, 1);
  assert.equal(classifyPreflightError(unsupported), 'unsupported_model');
});

test('all unsupported models retain the last original error and cause chain', async () => {
  const transport = new Error('provider rejected model');
  const rejected = new Error('model not supported', { cause: transport });
  let attempts = 0;
  await assert.rejects(runWithCompatiblePreflightModel({
    models: ['primary', 'fallback'],
    async runModel() { attempts += 1; throw rejected; },
  }), error => {
    assert.equal(error.code, 'no_supported_model');
    assert.equal(error.category, 'unsupported_model');
    assert.equal(error.cause, rejected);
    assert.equal(error.cause.cause, transport);
    return true;
  });
  assert.equal(attempts, 2);
});

test('startup probe checks structured output through a read-only SDK thread', async () => {
  const options = [];
  let schema;
  const result = await validatePreflightCompatibility({
    config: { workspace: fixturePath('workspace'), codexPreflightModel: 'gpt-6-sol' },
    createCodex: () => ({ startThread(threadOptions) {
      options.push(threadOptions);
      return { async run(_prompt, turnOptions) {
        schema = turnOptions.outputSchema;
        return { finalResponse: '{"ok":"yes"}' };
      } };
    } }),
    sleep: async () => {},
  });
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(options[0].model, 'gpt-6-sol');
  assert.equal(options[0].sandboxMode, 'read-only');
  assert.equal(options[0].networkAccessEnabled, false);
  assert.equal(schema.required[0], 'ok');
});
