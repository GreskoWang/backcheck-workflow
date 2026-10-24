import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import pty from 'node-pty';
import { detectTrustConfirmation, detectUpdateConfirmation } from './terminal-observer.mjs';

const require = createRequire(import.meta.url);
const codexPackagePath = require.resolve('@openai/codex/package.json');
const codexPackage = JSON.parse(fs.readFileSync(codexPackagePath, 'utf8'));
const codexSdkPackagePath = path.resolve(
  path.dirname(codexPackagePath), '..', 'codex-sdk', 'package.json',
);
const codexSdkPackage = JSON.parse(fs.readFileSync(codexSdkPackagePath, 'utf8'));
const ptyPackage = JSON.parse(
  fs.readFileSync(require.resolve('node-pty/package.json'), 'utf8'),
);
const CODEX_CLI_VERSION = '0.158.0';
const CODEX_SDK_VERSION = '0.158.0';
const NODE_PTY_VERSION = '1.1.0';
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_MS = 250;
const EXIT_GRACE_MS = 15_000;
const PROMPT_SETTLE_MS = 750;
const PROMPT_ECHO_TIMEOUT_MS = 10_000;
const SESSION_DISCOVERY_MS = 20_000;
const MAX_TERMINAL_CHARS = 200_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

if (
  codexPackage.version !== CODEX_CLI_VERSION ||
  codexSdkPackage.version !== CODEX_SDK_VERSION ||
  ptyPackage.version !== NODE_PTY_VERSION
) {
  throw new Error(
    'visible thread bootstrap dependency mismatch: ' +
    `CLI ${codexPackage.version}, SDK ${codexSdkPackage.version}, PTY ${ptyPackage.version}`,
  );
}

const codexEntrypoint = path.join(path.dirname(codexPackagePath), 'bin', 'codex.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createStandaloneCodexEnv(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => {
    const upper = key.toUpperCase();
    if (!upper.startsWith('CODEX_')) return true;
    return upper === 'CODEX_HOME';
  }));
  if (!Object.keys(env).some((key) => key.toUpperCase() === 'CODEX_HOME')) {
    env.CODEX_HOME = path.join(os.homedir(), '.codex');
  }
  return env;
}

function codexHomeFromEnv(env) {
  const configured = Object.entries(env)
    .find(([key]) => key.toUpperCase() === 'CODEX_HOME')?.[1];
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

function listSessionFiles(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) return [];
  const files = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files;
}

function readShared(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (['EBUSY', 'EACCES', 'EPERM'].includes(error?.code)) return null;
    throw error;
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isVisibleCliSessionMeta(meta, {
  workspace,
  expectedCliVersion = CODEX_CLI_VERSION,
} = {}) {
  return Boolean(
    meta &&
    meta.source === 'cli' &&
    meta.originator === 'codex-tui' &&
    meta.cli_version === expectedCliVersion &&
    THREAD_ID_PATTERN.test(String(meta.id || '')) &&
    workspace &&
    normalizedPath(meta.cwd) === normalizedPath(workspace),
  );
}

function parseSession(filePath, marker) {
  const text = readShared(filePath);
  if (text == null || !text.includes(marker)) return null;

  let meta = null;
  let taskComplete = null;
  let taskFailure = null;
  const turnContexts = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session_meta' && !meta) meta = event.payload;
    if (event.type === 'turn_context') turnContexts.push(event.payload);
    if (event.type === 'event_msg' && event.payload?.type === 'task_complete') {
      taskComplete = event.payload;
    }
    if (event.type === 'event_msg' && event.payload?.type === 'task_failed') {
      taskFailure = event.payload;
    }
  }
  return { filePath, text, meta, taskComplete, taskFailure, turnContexts };
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new Error(`visible thread bootstrap aborted: ${String(signal.reason || 'shutdown')}`);
  }
}

async function waitForSession({ baseline, sessionsRoot, marker, workspace, deadline, signal, getExitEvent, getTerminalText, onProtectedDetected }) {
  while (performance.now() < deadline) {
    assertNotAborted(signal);
    if (getTerminalText) assertNoProtectedScreen(getTerminalText(), onProtectedDetected);
    if (getExitEvent?.()) {
      throw new Error('Codex CLI exited before a marked session was created');
    }
    const marked = [];
    for (const filePath of listSessionFiles(sessionsRoot)) {
      if (baseline.has(filePath)) continue;
      const parsed = parseSession(filePath, marker);
      if (!parsed?.meta) continue;
      if (!isVisibleCliSessionMeta(parsed.meta, { workspace })) {
        throw new Error(
          `bootstrap marker appeared in a non-visible or wrong-version Codex session: ${filePath}`,
        );
      }
      marked.push(parsed);
    }
    if (marked.length > 1) {
      throw new Error(`bootstrap marker appeared in ${marked.length} Codex sessions`);
    }
    if (marked.length === 1) return marked[0];
    await sleep(POLL_MS);
  }
  throw new Error('timed out waiting for the source=cli session marker');
}

async function waitForExactBootstrapReply({ sessionPath, marker, expectedReply, deadline, signal, getExitEvent, getTerminalText, onProtectedDetected }) {
  while (performance.now() < deadline) {
    assertNotAborted(signal);
    if (getTerminalText) assertNoProtectedScreen(getTerminalText(), onProtectedDetected);
    if (getExitEvent?.()) throw new Error('Codex CLI exited before the bootstrap confirmation');
    const parsed = parseSession(sessionPath, marker);
    if (parsed?.taskFailure) throw new Error('Codex CLI bootstrap turn failed');
    const response = parsed?.taskComplete?.last_agent_message;
    if (response != null) {
      if (String(response).trim() !== expectedReply) {
        throw new Error('Codex CLI bootstrap returned an unexpected confirmation');
      }
      return parsed;
    }
    await sleep(POLL_MS);
  }
  throw new Error('timed out waiting for the Codex CLI bootstrap confirmation');
}

function cleanTerminalText(value) {
  return String(value || '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/gu, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
}

export function classifyCliStartup(value) {
  if (detectUpdateConfirmation(value)) return 'update_confirmation';
  if (detectTrustConfirmation(value)) return 'trust_confirmation';
  const terminal = cleanTerminalText(value);
  if (/sign\s*in|device\s*code|provide\s+your\s+own\s+api\s+key|登录/iu.test(terminal)) {
    return 'sign_in';
  }
  if (/Ask Codex to do anything/iu.test(terminal)) return 'composer';
  return 'loading';
}

function assertNoProtectedScreen(value, onProtectedDetected) {
  const state = classifyCliStartup(value);
  if (!['update_confirmation', 'trust_confirmation', 'sign_in'].includes(state)) return;
  onProtectedDetected?.(state);
  if (state === 'trust_confirmation') {
    throw new Error('Codex CLI folder trust confirmation is required before a session can start');
  }
  throw new Error(`Codex CLI ${state} requires manual user action`);
}

async function waitForComposer(getText, deadline, signal, getExitEvent) {
  while (performance.now() < deadline) {
    assertNotAborted(signal);
    if (getExitEvent?.()) throw new Error('Codex CLI exited before its composer was ready');
    const state = classifyCliStartup(getText());
    if (state === 'sign_in') throw new Error('Codex CLI sign-in is required before bootstrap');
    if (state === 'trust_confirmation') throw new Error('Codex CLI workspace trust confirmation is required before bootstrap');
    if (state === 'update_confirmation') throw new Error('Codex CLI update choice requires manual user action');
    if (state === 'composer') return;
    await sleep(POLL_MS);
  }
  throw new Error('timed out waiting for the Codex CLI composer');
}

async function waitForPromptEchoToSettle({
  getText, getLastDataAt, startOffset, requestId, deadline, signal, getExitEvent,
}) {
  const echoDeadline = Math.min(deadline, performance.now() + PROMPT_ECHO_TIMEOUT_MS);
  let echoSeen = false;
  while (performance.now() < echoDeadline) {
    assertNotAborted(signal);
    if (getExitEvent?.()) throw new Error('Codex CLI exited while receiving the bootstrap prompt');
    const state = classifyCliStartup(getText());
    if (state === 'sign_in' || state === 'trust_confirmation' || state === 'update_confirmation') {
      throw new Error(`Codex CLI ${state} interrupted bootstrap prompt entry`);
    }
    if (cleanTerminalText(getText().slice(startOffset)).includes(requestId)) echoSeen = true;
    if (echoSeen && performance.now() - getLastDataAt() >= PROMPT_SETTLE_MS) return;
    await sleep(POLL_MS);
  }
  throw new Error('Codex CLI did not echo and settle the bootstrap prompt');
}

async function waitForTerminalInputToSettle(getLastDataAt, writtenAt) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const now = performance.now();
    if (now - writtenAt >= PROMPT_SETTLE_MS && now - getLastDataAt() >= PROMPT_SETTLE_MS) {
      return;
    }
    await sleep(POLL_MS);
  }
}

async function waitForTerminalText(getText, pattern, startOffset, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const raw = getText();
    const offset = Math.min(startOffset, raw.length);
    if (pattern.test(cleanTerminalText(raw.slice(offset)))) return true;
    await sleep(100);
  }
  return false;
}

async function tryRenameThread(child, getTerminalText, getLastDataAt, threadTitle) {
  try {
    await sleep(500);
    const modalStart = getTerminalText().length;
    const slashWrittenAt = performance.now();
    child.write('/rename');
    await waitForTerminalInputToSettle(getLastDataAt, slashWrittenAt);
    child.write('\r');
    const modalReady = await waitForTerminalText(
      getTerminalText,
      /Name thread[\s\S]{0,400}Type a name and press Enter/iu,
      modalStart,
      8_000,
    );
    if (!modalReady) throw new Error('rename modal did not open');

    const submitStart = getTerminalText().length;
    const titleWrittenAt = performance.now();
    child.write(threadTitle);
    await waitForTerminalInputToSettle(getLastDataAt, titleWrittenAt);
    child.write('\r');
    const composerReturned = await waitForTerminalText(
      getTerminalText,
      /Ask Codex to do anything/iu,
      submitStart,
      8_000,
    );
    if (!composerReturned) throw new Error('rename modal did not close');
    return true;
  } catch {
    // Title failure is explicitly non-blocking. Escape any open modal so the
    // verified CLI thread can still exit and be resumed by the SDK.
    try {
      child.write('\x1b');
      await sleep(150);
    } catch {}
    return false;
  }
}

async function stopCli(child, exitPromise, getLastDataAt = () => -Infinity) {
  const slashWrittenAt = performance.now();
  child.write('/exit');
  await waitForTerminalInputToSettle(getLastDataAt, slashWrittenAt);
  child.write('\r');
  let event = await Promise.race([exitPromise, sleep(EXIT_GRACE_MS).then(() => null)]);
  if (event) return { event, method: '/exit' };

  child.write('\x03');
  event = await Promise.race([exitPromise, sleep(2_000).then(() => null)]);
  if (event) return { event, method: 'Ctrl+C' };

  child.kill();
  event = await Promise.race([exitPromise, sleep(2_000).then(() => null)]);
  return { event, method: 'pty.kill fallback' };
}

export class VisibleThreadBootstrapper {
  constructor({ spawn = pty.spawn, sessionsRoot = null } = {}) {
    this.spawn = spawn;
    this.sessionsRoot = sessionsRoot;
    this.active = new Set();
    this.stopping = false;
  }

  async bootstrap({
    requestId,
    threadTitle,
    workspace,
    model,
    reasoningEffort = 'low',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    inputMode = 'interactive',
    onStatus,
    onTerminalData,
  }) {
    if (this.stopping) throw new Error('visible thread bootstrapper is shutting down');
    if (!String(requestId || '').trim()) throw new Error('visible thread bootstrap requires requestId');
    if (!String(threadTitle || '').trim()) throw new Error('visible thread bootstrap requires a title');
    if (!String(workspace || '').trim()) throw new Error('visible thread bootstrap requires a workspace');
    if (!['interactive', 'startup_argument_no_keys'].includes(inputMode)) {
      throw new Error('unsupported visible thread bootstrap input mode');
    }
    if (!fs.existsSync(codexEntrypoint)) {
      throw new Error(`Codex CLI entrypoint was not found: ${codexEntrypoint}`);
    }

    const standaloneEnv = createStandaloneCodexEnv();
    const sessionsRoot = this.sessionsRoot || path.join(codexHomeFromEnv(standaloneEnv), 'sessions');
    const baseline = new Set(listSessionFiles(sessionsRoot));
    const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const marker = `FEISHU_BATCH_${requestId}_${nonce}`;
    const expectedReply = `BATCH_THREAD_READY_${nonce}`;
    const safeTitle = String(threadTitle).replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
    // The default path submits through the TUI composer. The isolated probe
    // passes this as an argv prompt and sends no PTY input; some CLI versions
    // may leave argv prompts idle, in which case that probe must fail closed.
    const prompt = [
      `飞书背调批次 ${requestId}；对话标题 ${safeTitle}；唯一标记 ${marker}；`,
      `不要调用任何工具，只回复一行 ${expectedReply}`,
    ].join('').replace(/[\r\n]+/gu, ' ');
    const args = [
      codexEntrypoint,
      '--no-alt-screen',
      '--no-daemon',
      '-C',
      workspace,
      '-s',
      'read-only',
      '-a',
      inputMode === 'startup_argument_no_keys' ? 'on-request' : 'never',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    ];
    if (model) args.push('-m', model);
    if (inputMode === 'startup_argument_no_keys') {
      args.push('-c', 'approvals_reviewer="user"');
      args.push('-c', 'mcp_servers.node_repl.enabled=false');
      args.push('-c', 'mcp_servers.feishu.enabled=false');
      args.push('-c', 'notify=[]');
      args.push('-c', 'web_search="disabled"');
      args.push(prompt);
    }

    let terminalText = '';
    let lastTerminalDataAt = performance.now();
    let promptEchoSettled = false;
    let enterSent = false;
    const protectedStatusesSent = new Set();
    const notifyProtected = (state) => {
      if (protectedStatusesSent.has(state)) return;
      protectedStatusesSent.add(state);
      onStatus?.(`${state}_detected`);
    };
    let exitResolve;
    const exitPromise = new Promise((resolve) => { exitResolve = resolve; });
    const controller = new AbortController();
    const record = { child: null, controller, exitPromise };
    this.active.add(record);

    const deadline = performance.now() + timeoutMs;
    let child;
    let dataSubscription;
    let exitSubscription;
    let cliExit;
    let earlyExitEvent = null;
    try {
      child = this.spawn(process.execPath, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: workspace,
        env: { ...standaloneEnv, TERM: 'xterm-256color', NO_COLOR: '1' },
        useConpty: true,
        useConptyDll: true,
      });
      record.child = child;
      dataSubscription = child.onData((chunk) => {
        terminalText = (terminalText + chunk).slice(-MAX_TERMINAL_CHARS);
        lastTerminalDataAt = performance.now();
        try { onTerminalData?.(chunk); } catch {}
      });
      exitSubscription = child.onExit((event) => {
        earlyExitEvent = event;
        exitResolve(event);
      });
      onStatus?.('cli_spawned');

      if (inputMode === 'interactive') {
        await waitForComposer(
          () => terminalText, deadline, controller.signal, () => earlyExitEvent,
        );
        onStatus?.('composer_ready');
        const promptStartOffset = terminalText.length;
        child.write(prompt);
        onStatus?.('prompt_written');
        await waitForPromptEchoToSettle({
          getText: () => terminalText,
          getLastDataAt: () => lastTerminalDataAt,
          startOffset: promptStartOffset,
          requestId,
          deadline,
          signal: controller.signal,
          getExitEvent: () => earlyExitEvent,
        });
        promptEchoSettled = true;
        onStatus?.('prompt_echo_settled');
        assertNoProtectedScreen(terminalText, notifyProtected);
        child.write('\r');
        enterSent = true;
        onStatus?.('enter_sent');
      } else {
        onStatus?.('prompt_passed_as_argument');
      }

      const session = await waitForSession({
        baseline,
        sessionsRoot,
        marker,
        workspace,
        deadline: Math.min(deadline, performance.now() + SESSION_DISCOVERY_MS),
        signal: controller.signal,
        getExitEvent: () => earlyExitEvent,
        getTerminalText: () => terminalText,
        onProtectedDetected: notifyProtected,
      });
      onStatus?.('session_discovered');
      const completed = await waitForExactBootstrapReply({
        sessionPath: session.filePath,
        marker,
        expectedReply,
        deadline,
        signal: controller.signal,
        getExitEvent: () => earlyExitEvent,
        getTerminalText: () => terminalText,
        onProtectedDetected: notifyProtected,
      });
      if (inputMode === 'startup_argument_no_keys' &&
          (completed.turnContexts.length !== 1 ||
           completed.turnContexts[0]?.approval_policy !== 'on-request' ||
           completed.turnContexts[0]?.approvals_reviewer !== 'user' ||
           completed.turnContexts[0]?.sandbox_policy?.type !== 'read-only' ||
           !completed.turnContexts[0]?.cwd ||
           normalizedPath(completed.turnContexts[0]?.cwd) !== normalizedPath(workspace))) {
        throw new Error('CLI bootstrap runtime permissions did not match the reviewed settings');
      }
      onStatus?.('confirmation_received');
      const titleApplied = inputMode === 'interactive' ? await tryRenameThread(
        child, () => terminalText, () => lastTerminalDataAt, safeTitle,
      ) : false;
      if (inputMode === 'startup_argument_no_keys') {
        child.kill();
        cliExit = {
          event: await Promise.race([exitPromise, sleep(2_000).then(() => null)]),
          method: 'pty.kill after verified response',
        };
      } else {
        cliExit = await stopCli(child, exitPromise, () => lastTerminalDataAt);
      }
      onStatus?.('cli_stopped');
      if (inputMode === 'interactive' && (!cliExit.event || cliExit.event.exitCode !== 0)) {
        throw new Error(`Codex CLI bootstrap did not exit cleanly via ${cliExit.method}`);
      }

      return {
        threadId: completed.meta.id,
        source: completed.meta.source,
        originator: completed.meta.originator,
        cliVersion: completed.meta.cli_version,
        sessionPath: completed.filePath,
        marker,
        titleApplied,
        cliExitMethod: cliExit.method,
      };
    } catch (error) {
      const cleanedTerminal = cleanTerminalText(terminalText);
      const startupState = classifyCliStartup(terminalText);
      if (['trust_confirmation', 'update_confirmation', 'sign_in'].includes(startupState)) {
        notifyProtected(startupState);
      }
      const terminal = cleanedTerminal.slice(-800).trim();
      if (terminal) error.bootstrapTerminalSummary = terminal;
      let newSessionFileCount = null;
      try {
        newSessionFileCount = listSessionFiles(sessionsRoot)
          .filter((filePath) => !baseline.has(filePath)).length;
      } catch {}
      error.bootstrapDiagnostics = {
        newSessionFileCount,
        sessionsRootExists: fs.existsSync(sessionsRoot),
        codexHomeExplicitlySet: Object.keys(process.env)
          .some((key) => key.toUpperCase() === 'CODEX_HOME'),
        codexHomePinned: true,
        cliStartupState: startupState,
        inputMode,
        cliUiReady: startupState === 'composer',
        requestVisibleInTerminal: cleanedTerminal.includes(requestId),
        loginPromptSeen: startupState === 'sign_in',
        trustConfirmationSeen: startupState === 'trust_confirmation',
        updateConfirmationSeen: startupState === 'update_confirmation',
        cliExitedBeforeSession: Boolean(earlyExitEvent),
        promptEchoSettled,
        enterSent,
        terminalCharacterCount: cleanedTerminal.length,
      };
      throw error;
    } finally {
      if (child && !cliExit) {
        // A failed bootstrap may be on a protected trust/authorization picker.
        // Never send /exit followed by Enter there: Enter could accept Trust.
        try { child.kill(); } catch {}
        cliExit = { event: await Promise.race([exitPromise, sleep(2_000).then(() => null)]), method: 'pty.kill on failure' };
      }
      dataSubscription?.dispose?.();
      exitSubscription?.dispose?.();
      this.active.delete(record);
    }
  }

  async shutdown(reason = 'bridge shutdown') {
    this.stopping = true;
    const pending = [];
    for (const record of this.active) {
      record.controller.abort(reason);
      try { record.child?.kill(); } catch {}
      pending.push(Promise.race([record.exitPromise, sleep(2_000)]));
    }
    await Promise.allSettled(pending);
  }
}

export const visibleThreadBootstrapper = new VisibleThreadBootstrapper();

export function bootstrapVisibleThread(options) {
  return visibleThreadBootstrapper.bootstrap(options);
}

export function shutdownVisibleThreadBootstraps(reason) {
  return visibleThreadBootstrapper.shutdown(reason);
}

export const visibleThreadVersions = Object.freeze({
  cli: CODEX_CLI_VERSION,
  sdk: CODEX_SDK_VERSION,
  pty: NODE_PTY_VERSION,
});
