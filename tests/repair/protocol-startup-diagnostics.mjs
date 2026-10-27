// Test-only startup diagnostics. No browser discovery, retry, or production code.
import { performance } from 'node:perf_hooks';

export function errorRecord(error) {
  if (!error) return null;
  return { name: error.name || 'Error', code: error.code || null,
    message: String(error.message || error), stack: error.stack || null,
    ...(error.cause ? { cause: { name: error.cause.name || null,
      code: error.cause.code || null, message: String(error.cause.message || error.cause) } } : {}) };
}

export function makeTimeline() {
  const epoch = Date.now();
  const monotonic = performance.now();
  const value = { startedAt: new Date(epoch).toISOString(), stages: [], events: [], omittedEvents: 0 };
  return {
    value,
    elapsed: () => Math.round((performance.now() - monotonic) * 1000) / 1000,
    mark(event, fields = {}) {
      const entry = { event, at: new Date().toISOString(),
        elapsedMs: Math.round((performance.now() - monotonic) * 1000) / 1000, ...fields };
      if (value.events.length < 256) value.events.push(entry);
      else value.omittedEvents += 1;
      return entry;
    },
  };
}

export function observeChild(child, timeline, { maxOutputBytes = 64 * 1024 } = {}) {
  // Read both pipes immediately, as the original harness already did. Bound
  // retained output explicitly; total bytes and truncation remain observable.
  const state = {
    child, stdout: [], stderr: [], outputBytes: { stdout: 0, stderr: 0 },
    outputTruncated: { stdout: false, stderr: false },
    spawned: false, spawnError: null, childError: null, exitStatus: null, closeStatus: null,
    stdoutEnded: false, stderrEnded: false, listeningObserved: false, publishedListeningAddress: null,
  };
  const onData = (name, chunk) => {
    state.outputBytes[name] += Buffer.byteLength(chunk, 'utf8');
    let retained = Buffer.from(state[name].join('') + chunk, 'utf8');
    if (retained.length > maxOutputBytes) {
      state.outputTruncated[name] = true;
      retained = retained.subarray(retained.length - maxOutputBytes);
    }
    state[name] = [retained.toString('utf8')];
    const listening = name === 'stdout' && state[name][0].match(/\[Edge CDP Broker\] listening (http:\/\/127\.0\.0\.1:(\d+))\r?\n/u);
    if (listening && !state.listeningObserved) {
      state.listeningObserved = true;
      state.publishedListeningAddress = { url: listening[1], address: '127.0.0.1', port: Number(listening[2]) };
      timeline.mark('broker_listening_message', { address: state.publishedListeningAddress });
    }
  };
  for (const name of ['stdout', 'stderr']) {
    child[name]?.setEncoding('utf8');
    child[name]?.on('data', (chunk) => onData(name, chunk));
    child[name]?.once('end', () => {
      state[`${name}Ended`] = true;
      timeline.mark(`child_${name}_end`);
    });
  }
  child.once('spawn', () => {
    state.spawned = true;
    timeline.mark('child_spawn', { pid: child.pid });
  });
  let settleExit;
  state.exit = new Promise((resolve) => { settleExit = resolve; });
  child.once('error', (error) => {
    state.childError = errorRecord(error);
    if (!state.spawned) state.spawnError = state.childError;
    timeline.mark('child_error', { error: state.childError });
    // A failed spawn may not emit exit; close still carries pipe completion.
    if (state.spawnError) settleExit({ code: null, signal: null, error: state.spawnError });
  });
  child.once('exit', (code, signal) => {
    state.exitStatus = { code, signal, at: new Date().toISOString(), elapsedMs: timeline.elapsed() };
    timeline.mark('child_exit', { code, signal });
    settleExit(state.exitStatus);
  });
  state.close = new Promise((resolve) => child.once('close', (code, signal) => {
    state.closeStatus = { code, signal, at: new Date().toISOString(), elapsedMs: timeline.elapsed() };
    timeline.mark('child_close', { code, signal });
    resolve(state.closeStatus);
  }));
  state.assertAlive = () => {
    if (!state.childError && state.exitStatus === null && child.exitCode === null && child.signalCode === null) return;
    const error = new Error(state.childError
      ? `Broker child process error: ${state.childError.message}`
      : `Broker child exited before readiness: code=${child.exitCode}, signal=${child.signalCode}`);
    error.code = state.spawnError ? 'HARNESS_CHILD_SPAWN_ERROR' : state.childError ? 'HARNESS_CHILD_ERROR' : 'HARNESS_CHILD_EXIT';
    error.fatal = true;
    throw error;
  };
  state.snapshot = () => ({
    pid: child.pid || null, spawned: state.spawned, spawnError: state.spawnError, childError: state.childError,
    exitCode: child.exitCode, signalCode: child.signalCode,
    exit: state.exitStatus, close: state.closeStatus,
    stdout: state.stdout.join(''), stderr: state.stderr.join(''),
    outputBytes: { ...state.outputBytes }, outputTruncated: { ...state.outputTruncated },
    stdoutEnded: state.stdoutEnded, stderrEnded: state.stderrEnded,
    listeningObserved: state.listeningObserved, publishedListeningAddress: state.publishedListeningAddress,
  });
  return state;
}

export async function waitForStage(check, {
  timeoutMs = 8000, intervalMs = 30, label = 'condition', timeline = makeTimeline(),
} = {}) {
  const started = performance.now();
  const startedAt = Date.now();
  const stage = { name: label, startedAt: new Date(startedAt).toISOString(),
    startedElapsedMs: timeline.elapsed(), timeoutMs,
    deadlineAt: new Date(startedAt + timeoutMs).toISOString(),
    deadlineElapsedMs: timeline.elapsed() + timeoutMs,
    attempts: 0, lastError: null, status: 'running' };
  timeline.value.stages.push(stage);
  const controller = new AbortController();
  const timeoutError = new Error(`Timed out waiting for ${label} within ${timeoutMs}ms`);
  timeoutError.code = 'HARNESS_STAGE_TIMEOUT';
  timeoutError.stage = label;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const polling = (async () => {
    while (!controller.signal.aborted) {
      stage.attempts += 1;
      try {
        const value = await check({ signal: controller.signal,
          remainingMs: Math.max(0, timeoutMs - (performance.now() - started)), attempt: stage.attempts });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (value) return value;
      } catch (error) {
        stage.lastError = errorRecord(error);
        if (controller.signal.aborted || error?.fatal) throw error;
      }
      await new Promise((resolve) => {
        const pause = setTimeout(done, Math.min(intervalMs, Math.max(0, timeoutMs - (performance.now() - started))));
        function done() { clearTimeout(pause); controller.signal.removeEventListener('abort', done); resolve(); }
        controller.signal.addEventListener('abort', done, { once: true });
        if (controller.signal.aborted) done();
      });
    }
    throw controller.signal.reason;
  })();
  try {
    const value = await Promise.race([polling, expired]);
    stage.status = 'passed';
    return value;
  } catch (error) {
    stage.status = error?.code === 'HARNESS_STAGE_TIMEOUT' ? 'timeout' : 'failed';
    stage.error = errorRecord(error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error('Stage finished'));
    stage.finishedAt = new Date().toISOString();
    stage.elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  }
}

export async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
