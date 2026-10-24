import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import pty from 'node-pty';

import { createStandaloneCodexEnv, isVisibleCliSessionMeta } from './visible-thread-bootstrap.mjs';
import { detectAuthSensitiveScreen, detectConfirmedAuthScreen, detectTrustConfirmation, detectUpdateConfirmation, ProbeTerminalObserver, renderAnsiScreen } from './terminal-observer.mjs';

const require = createRequire(import.meta.url);
const cliPackagePath = require.resolve('@openai/codex/package.json');
const cliEntrypoint = path.join(path.dirname(cliPackagePath), 'bin', 'codex.js');
const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const active = new Set();

function defaultSessionsRoot() {
  const env = createStandaloneCodexEnv();
  const home = Object.entries(env).find(([key]) => key.toUpperCase() === 'CODEX_HOME')?.[1] ||
    path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replaceAll('/', '\\').toLowerCase();
  return normalize(left) === normalize(right);
}

function records(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
  if (lines.at(-1) !== '') lines.pop(); // Ignore a concurrent, incomplete JSONL write.
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

export function digestCliSessionRecords(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function matchingSessionFiles(root, threadId) {
  const matches = [];
  if (!fs.existsSync(root)) return matches;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) matches.push(file);
    }
  }
  return matches;
}

function inputText(item) {
  return item.type === 'response_item' && item.payload?.role === 'user'
    ? (item.payload.content || []).filter((part) => part.type === 'input_text')
      .map((part) => part.text).join('\n') : null;
}

function isInjectedEnvironmentContext(item, workspace) {
  if (item.type !== 'response_item' || item.payload?.type !== 'message' ||
      item.payload?.role !== 'user' || item.payload.content?.length !== 1 ||
      item.payload.content[0]?.type !== 'input_text') return false;
  const metadata = item.payload.internal_chat_message_metadata_passthrough;
  if (typeof metadata?.turn_id !== 'string' ||
      !Number.isFinite(metadata?.create_time) ||
      !Array.isArray(metadata?.content_item_kinds)) return false;
  const value = item.payload.content[0].text;
  if (typeof value !== 'string' || value.length > 8192) return false;
  const normalized = value.replace(/\r\n/gu, '\n');
  return normalized.startsWith('<environment_context>\n') &&
    normalized.endsWith('\n</environment_context>') &&
    normalized.includes('<current_date>') &&
    normalized.includes('<timezone>') &&
    normalized.includes('<filesystem>') && normalized.includes(workspace);
}

function failure(message, code = 'CLI_EXECUTION_REVIEW_REQUIRED', reasonCode = 'CLI_UNVERIFIED') {
  const error = new Error(message);
  error.code = code;
  error.reasonCode = reasonCode;
  return error;
}

export function classifyProtectedCliScreen(raw) {
  if (detectTrustConfirmation(raw)) return 'trust_confirmation';
  if (detectUpdateConfirmation(raw)) return 'update_confirmation';
  if (detectConfirmedAuthScreen(raw)) return 'sign_in';
  const screen = renderAnsiScreen(raw).join(' ').replace(/\s+/gu, ' ');
  if (/(?:Would you like to run|Do you want to approve|Approval required)/iu.test(screen) &&
      /(?:Yes, proceed|Approve|Allow|Deny|No,? (?:cancel|do not))/iu.test(screen)) {
    return 'approval_required';
  }
  return null;
}

export function classifyCliScreen(raw) {
  const protectedKind = classifyProtectedCliScreen(raw);
  if (protectedKind) return protectedKind;
  if (!raw) return 'empty';
  if (detectAuthSensitiveScreen(raw)) return 'auth_sensitive_text';
  const visible = renderAnsiScreen(raw).join(' ').replace(/\s+/gu, ' ');
  if (/Ask Codex to do anything/iu.test(visible)) return 'composer';
  if (/\b(?:Working|Thinking|Generating|Processing)\b/iu.test(visible)) {
    return 'working_or_thinking';
  }
  return 'loading_or_other';
}

export function buildProductionResumeArgs({
  threadId, workspace, prompt, model, reasoningEffort = 'max', sandboxMode = 'workspace-write',
}) {
  if (!THREAD_ID.test(threadId) || !workspace || !prompt) throw failure('invalid CLI continuation inputs');
  if (sandboxMode !== 'workspace-write') {
    throw failure('CLI execution requires reviewed workspace-write sandbox settings');
  }
  const args = [
    cliEntrypoint, 'resume', '--no-alt-screen', '--no-daemon',
    '-C', workspace, '-s', 'workspace-write', '-a', 'on-request',
    '-c', 'approvals_reviewer="user"',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
  ];
  if (model) args.push('-m', model);
  args.push(threadId, prompt);
  return args;
}

export function inspectBoundCliSession({ sessionPath, threadId, requestId, workspace, sessionsRoot }) {
  if (!sessionPath || !THREAD_ID.test(threadId) || !requestId || !workspace ||
      !fs.lstatSync(sessionPath).isFile() ||
      !samePath(fs.realpathSync.native(sessionPath), sessionPath) ||
      !path.basename(sessionPath).includes(threadId)) {
    throw failure('CLI session path or thread identity is invalid');
  }
  const relative = path.relative(sessionsRoot, sessionPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw failure('CLI session is outside the Codex sessions directory');
  }
  const matches = matchingSessionFiles(sessionsRoot, threadId);
  if (matches.length !== 1 || !samePath(matches[0], sessionPath)) {
    throw failure('CLI thread has no unique session file');
  }
  const initial = records(sessionPath);
  const metas = initial.filter((item) => item.type === 'session_meta');
  if (metas.length !== 1 || metas[0].payload?.id !== threadId ||
      !isVisibleCliSessionMeta(metas[0].payload, { workspace }) ||
      !initial.some((item) => inputText(item)?.includes(`FEISHU_BATCH_${requestId}_`))) {
    throw failure('CLI session is not bound to this request and workspace');
  }
  return initial;
}

export function inspectProductionTurn({ before, current, prompt, workspace }) {
  if (current.length < before.length ||
      JSON.stringify(current.slice(0, before.length)) !== JSON.stringify(before)) {
    throw failure('CLI session history changed during continuation', 'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_SESSION_CHANGED');
  }
  const added = current.slice(before.length);
  const userItems = added.filter((item) => inputText(item) !== null);
  const injectedContexts = userItems.filter((item) =>
    isInjectedEnvironmentContext(item, workspace));
  const promptItems = userItems.filter((item) =>
    !injectedContexts.includes(item));
  const userPrompts = promptItems.map(inputText);
  if (injectedContexts.length > 1 ||
      (promptItems.length && injectedContexts.some((item) =>
        added.indexOf(item) > added.indexOf(promptItems[0])))) {
    throw failure('CLI runtime context order changed',
      'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_UNEXPECTED_CONTEXT_ORDER');
  }
  if (userPrompts.length > 1 || (userPrompts.length === 1 && userPrompts[0] !== prompt)) {
    throw failure('CLI continuation prompt does not match the assigned request', 'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_PROMPT_MISMATCH');
  }
  const contexts = added.filter((item) => item.type === 'turn_context');
  if (contexts.length > 1 || contexts.some((item) =>
    item.payload?.approval_policy !== 'on-request' ||
    item.payload?.approvals_reviewer !== 'user' ||
    item.payload?.sandbox_policy?.type !== 'workspace-write' ||
    !samePath(item.payload?.cwd || '', workspace))) {
    throw failure('CLI runtime permissions differ from the reviewed settings', 'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_PERMISSION_MISMATCH');
  }
  if (added.some((item) => item.type === 'event_msg' && item.payload?.type === 'task_failed')) {
    throw failure('CLI background-check turn failed', 'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_TASK_FAILED');
  }
  const completed = added.filter((item) => item.type === 'event_msg' &&
    item.payload?.type === 'task_complete');
  if (completed.length > 1) throw failure('CLI continuation completed more than one turn', 'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_MULTIPLE_COMPLETIONS');
  if (!completed.length) return null;
  if (userPrompts.length !== 1 || contexts.length !== 1 ||
      !String(completed[0].payload?.last_agent_message || '').trim()) {
    throw failure('CLI completion lacks prompt, permission context, or final response', 'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_INCOMPLETE_COMPLETION');
  }
  return String(completed[0].payload.last_agent_message).trim();
}

export async function executeBoundCliThread({
  threadId, requestId, sessionPath, workspace, prompt, model, reasoningEffort,
  expectedBaselineDigest,
  sessionsRoot = defaultSessionsRoot(),
  timeoutMs = 24 * 60 * 60 * 1000, pollMs = 250,
  promptRecordTimeoutMs = 60_000,
  spawn = pty.spawn,
  onPhase, onTerminalSnapshot,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw failure('invalid CLI execution timeout');
  if (!Number.isSafeInteger(promptRecordTimeoutMs) || promptRecordTimeoutMs <= 0) {
    throw failure('invalid prompt record timeout');
  }
  await onPhase?.('preflight_starting');
  const before = inspectBoundCliSession({ sessionPath, threadId, requestId, workspace, sessionsRoot });
  if (expectedBaselineDigest && digestCliSessionRecords(before) !== expectedBaselineDigest) {
    throw failure('CLI session changed after the audited baseline check',
      'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_BASELINE_CHANGED');
  }
  await onPhase?.('preflight_verified');
  const args = buildProductionResumeArgs({ threadId, workspace, prompt, model, reasoningEffort });
  await onPhase?.('pty_spawning');
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: workspace,
      env: { ...createStandaloneCodexEnv(), TERM: 'xterm-256color', NO_COLOR: '1' },
      name: 'xterm-256color', cols: 120, rows: 40,
      useConpty: true, useConptyDll: true,
    });
  } catch (error) {
    await onPhase?.('pty_spawn_failed', { systemCode:
      /^[A-Z0-9_]{2,30}$/u.test(String(error?.code || '')) ? error.code : 'UNKNOWN' });
    throw failure('CLI terminal could not be started',
      'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_PTY_SPAWN_FAILED');
  }
  active.add(child);
  let terminal = '';
  const observer = new ProbeTerminalObserver(requestId, workspace);
  let protectedState = null;
  let exited = false;
  let exitCode = null;
  const data = child.onData((chunk) => {
    terminal = (terminal + chunk).slice(-20_000);
    observer.push(chunk);
    const currentBlocker = classifyProtectedCliScreen(terminal);
    if (currentBlocker) {
      protectedState = currentBlocker;
      try { child.kill(); } catch {}
    }
  });
  const exit = child.onExit((event) => {
    exited = true;
    exitCode = Number.isSafeInteger(event?.exitCode) ? event.exitCode : null;
  });
  try {
    await onPhase?.('pty_spawned');
    const deadline = Date.now() + timeoutMs;
    const promptDeadline = Date.now() + promptRecordTimeoutMs;
    let promptReported = false;
    let contextReported = false;
    let nextSnapshotAt = Date.now() + 5_000;
    const snapshot = async (event) => {
      await onTerminalSnapshot?.({ event,
        classification: classifyCliScreen(observer.raw), screen: observer.snapshot() });
    };
    while (Date.now() < deadline) {
      if (protectedState) {
        await snapshot('protected_screen');
        await onPhase?.('protected_screen', { kind: protectedState });
        throw failure(`CLI requires manual ${protectedState} action`,
          'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_PROTECTED_SCREEN');
      }
      const current = records(sessionPath);
      const response = inspectProductionTurn({ before, current, prompt, workspace });
      const added = current.slice(before.length);
      const promptRecorded = added.some((item) => inputText(item) === prompt);
      if (promptRecorded && !promptReported) {
        promptReported = true;
        await onPhase?.('prompt_recorded');
      }
      if (!contextReported && added.some((item) => item.type === 'turn_context')) {
        contextReported = true;
        await onPhase?.('runtime_permissions_verified');
      }
      if (response !== null) {
        const matches = matchingSessionFiles(sessionsRoot, threadId);
        if (matches.length !== 1 || !samePath(matches[0], sessionPath)) {
          throw failure('CLI thread session changed during execution');
        }
        await onPhase?.('turn_completed');
        return { threadId, finalResponse: response };
      }
      if (exited) {
        await snapshot('child_exited');
        await onPhase?.('pty_exited', { exitCode });
        throw failure('CLI exited before a verified completion',
          'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_CHILD_EXITED');
      }
      if (!promptRecorded && Date.now() >= promptDeadline) {
        await snapshot('prompt_not_recorded');
        await onPhase?.('prompt_not_recorded');
        throw failure('CLI prompt was not recorded within the startup window',
          'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_PROMPT_NOT_RECORDED');
      }
      if (Date.now() >= nextSnapshotAt) {
        await snapshot('periodic');
        nextSnapshotAt = Date.now() + 5_000;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    await onPhase?.('execution_timeout');
    throw failure('CLI execution timed out and needs local review',
      'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_TIMEOUT');
  } catch (error) {
    if (error?.code === 'CLI_EXECUTION_REVIEW_REQUIRED') {
      if (error.reasonCode === 'CLI_PERMISSION_MISMATCH') {
        try { await onPhase?.('runtime_permissions_mismatch'); } catch {}
      }
      throw error;
    }
    try {
      await onTerminalSnapshot?.({ event: 'runtime_error',
        classification: classifyCliScreen(observer.raw), screen: observer.snapshot() });
      await onPhase?.('runtime_error', { systemCode:
        /^[A-Z0-9_]{2,30}$/u.test(String(error?.code || '')) ? error.code : 'UNKNOWN' });
    } catch {}
    throw failure('CLI execution could not be verified',
      'CLI_EXECUTION_REVIEW_REQUIRED', 'CLI_INTERNAL_ERROR');
  } finally {
    try { child.kill(); } catch {}
    data?.dispose?.();
    exit?.dispose?.();
    active.delete(child);
  }
}

export function shutdownCliExecutions() {
  for (const child of active) {
    try { child.kill(); } catch {}
  }
}
