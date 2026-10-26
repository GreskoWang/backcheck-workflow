import { fixtureFileUrl } from './fixture-paths.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexEnvironment } from '../src/codex-client.mjs';

test('Codex receives the local proxy without mutating the bridge environment', () => {
  const parent = {PATH: 'original', NO_PROXY: 'existing.internal', CODEX_HOME: 'kept'};
  const child = buildCodexEnvironment(parent, 'http://127.0.0.1:10808');
  assert.equal(child.HTTPS_PROXY, 'http://127.0.0.1:10808/');
  assert.equal(child.HTTP_PROXY, child.HTTPS_PROXY);
  assert.equal(child.no_proxy, child.NO_PROXY);
  assert.match(child.NO_PROXY, /existing\.internal,localhost,127\.0\.0\.1,::1,\.feishu\.cn,open\.feishu\.cn/u);
  assert.deepEqual(parent, {PATH: 'original', NO_PROXY: 'existing.internal', CODEX_HOME: 'kept'});
});
test('no configured proxy preserves the inherited environment', () => {
  const parent = {PATH:'original', HTTPS_PROXY:'existing'};
  assert.deepEqual(buildCodexEnvironment(parent, ''), parent);
});
test('unexpected external proxies and embedded credentials are rejected', () => {
  for (const route of ['https://example.com:443', 'http://user:password@localhost:10808', fixtureFileUrl('proxy')]) {
    assert.throws(() => buildCodexEnvironment({}, route), /local HTTP proxy/u);
  }
});
