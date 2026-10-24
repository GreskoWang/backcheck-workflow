import assert from 'node:assert/strict';
import test from 'node:test';

import { isNewDispatchMessage } from '../src/activation-boundary.mjs';

test('fresh listener accepts only messages created at or after its durable activation', () => {
  const activation = Date.parse('2026-10-04T14:30:00.500Z');
  assert.equal(isNewDispatchMessage({ createTime: activation }, activation), true);
  assert.equal(isNewDispatchMessage({ createTime: activation + 1 }, activation), true);
  assert.equal(isNewDispatchMessage({ createTime: activation - 1 }, activation), false);
  assert.equal(isNewDispatchMessage({ createTime: 'invalid' }, activation), false);
  assert.equal(isNewDispatchMessage({}, activation), false);
  assert.equal(isNewDispatchMessage({ createTime: activation }, undefined), false);
});
