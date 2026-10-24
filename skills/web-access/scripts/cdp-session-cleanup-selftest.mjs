// Offline regression for attachment cleanup after initialization exhausts its deadline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./cdp-proxy.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const functions = section('async function ensureSession(', 'function isSessionInvalidError(')
  + section('async function detachSessionOrRetire(', 'async function quarantineTimedOutTarget(');

async function scenario({ failEnable = true, failDetach = false, external = false } = {}) {
  const sessions = new Map(), targetsBySession = new Map();
  let attached = external, attaches = 0, retired = 0;
  const originalError = Object.assign(new Error('initialization timed out'), { code: 'cdp_timeout' });
  const deadline = { expired: false };
  const context = {
    sessions, targetsBySession, destroyedTargets: new Set(), BUDGETS: { metadata: 2000 },
    browserSocket: {}, isOpen: Boolean, BrokerError: Error,
    deadlineAfter: () => ({ expired: false }),
    assertTargetExists: async () => ({ targetId: 'page', attached }),
    assertNoExternalDebugger: info => { if (info.attached && !sessions.has('page')) throw Error('external_debugger_present'); },
    isSessionInvalidError: () => false,
    clearSessionByTarget: (target, reason, session) => { sessions.delete(target); targetsBySession.delete(session); },
    retireBrowserSocket: () => { attached = false; retired++; context.browserSocket = null; },
    sendCdp: async (method, params, options) => {
      if (options.deadline?.expired) throw Error('expired request deadline');
      if (method === 'Target.attachToTarget') { attached = true; attaches++; return { sessionId: 'owned-session' }; }
      if (method === 'Page.enable' && failEnable) { deadline.expired = true; throw originalError; }
      if (method === 'Target.detachFromTarget') {
        assert.equal(params.sessionId, 'owned-session');
        if (failDetach) throw Error('detach transport failed');
        attached = false;
      }
      return {};
    },
  };
  const ensure = vm.runInNewContext(functions + '\nensureSession', context);
  if (external) {
    await assert.rejects(ensure('page', deadline), /external_debugger_present/);
    assert.equal(attaches, 0);
    assert.equal(attached, true, 'must not disturb an external controller');
  } else if (failEnable) {
    await assert.rejects(ensure('page', deadline), error => error === originalError);
    assert.equal(attached, false, 'timed-out initialization must not strand its own attachment');
    assert.equal(sessions.size, 0);
    assert.equal(targetsBySession.size, 0);
    assert.equal(retired, failDetach ? 1 : 0);
    assert.equal(attaches, 1, 'cleanup must not silently retry initialization');
  } else {
    assert.equal(await ensure('page', deadline), 'owned-session');
    assert.equal(attached, true);
    assert.equal(sessions.size, 1);
    assert.equal(retired, 0);
  }
}
await scenario();
await scenario({ failDetach: true });
await scenario({ failEnable: false });
await scenario({ external: true });
console.log('Session cleanup PASS: expired deadline, failed detach, normal initialization, external owner preserved');
