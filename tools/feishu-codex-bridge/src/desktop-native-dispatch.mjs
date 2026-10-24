import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultUiHelper = path.resolve(moduleDir, '..', 'scripts', 'submit-codex-desktop-prompt.ps1');
const THREAD_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const DESKTOP_ORIGINATORS = new Set(['codex_work_desktop', 'Codex Desktop']);
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 250;
const COMPLETION_POLL_MS = 1_000;
const MAX_SESSION_READ_CHUNK_BYTES = 4 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertNotAborted(signal, operation) {
  if (signal?.aborted) {
    throw new Error(`${operation} aborted: ${String(signal.reason || 'shutdown')}`);
  }
}

function readShared(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (['EBUSY', 'EACCES', 'EPERM', 'ENOENT'].includes(error?.code)) return null;
    throw error;
  }
}

export function listCodexSessionFiles(sessionsRoot) {
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

export function createDesktopNativeMarker(requestId, nonce = crypto.randomUUID()) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!/^RQ-[A-Z0-9-]+$/iu.test(normalizedRequestId)) {
    throw new Error('desktop-native dispatch requires a valid requestId');
  }
  const normalizedNonce = String(nonce || '')
    .replace(/[^a-z0-9-]/giu, '')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  if (!normalizedNonce) throw new Error('desktop-native dispatch requires a nonce');
  // Keep the marker free of underscores and Markdown punctuation. Codex Desktop
  // escapes underscores in stored user messages, which makes exact recovery
  // matching unnecessarily fragile.
  return `FEISHU-NATIVE-${normalizedRequestId}-${normalizedNonce}`;
}

export function buildDesktopNativePrompt({
  requestId,
  threadTitle,
  marker,
  instructionPath,
  instructionSha256,
}) {
  const values = { requestId, threadTitle, marker, instructionPath, instructionSha256 };
  for (const [name, value] of Object.entries(values)) {
    if (!String(value || '').trim()) throw new Error(`desktop-native prompt requires ${name}`);
  }
  if (!String(marker).includes(String(requestId))) {
    throw new Error('desktop-native marker must contain the requestId');
  }
  if (!/^[a-f0-9]{64}$/iu.test(String(instructionSha256))) {
    throw new Error('desktop-native prompt requires a SHA-256 digest');
  }
  return [
    // Deep-link prefill treats the composer as rich text: leading Markdown
    // heading syntax and an adjacent blank line are normalized away. Keep the
    // guarded prompt plain so UI Automation can compare it byte-for-byte.
    String(threadTitle),
    `飞书背调批次：${requestId}`,
    `唯一关联标记：${marker}`,
    `读取并完整执行本机任务文件：${path.resolve(instructionPath)}`,
    `任务文件 SHA-256：${String(instructionSha256).toLowerCase()}`,
    '先核对文件哈希和 requestId；不一致时立即停止。只处理该文件中的同一批次，不得接入其他批次。',
  ].join('\n');
}

export function buildCodexNewDeepLink({ workspace, prompt }) {
  if (!String(workspace || '').trim()) throw new Error('Codex deep link requires workspace');
  if (!String(prompt || '').trim()) throw new Error('Codex deep link requires prompt');
  const query = new URLSearchParams({ path: path.resolve(workspace), prompt: String(prompt) });
  return `codex://new?${query.toString()}`;
}

export function parseDesktopSession(filePath, marker) {
  const text = readShared(filePath);
  if (text == null || !text.includes(marker)) return null;

  let meta = null;
  let metaRecordedAt = null;
  let taskComplete = null;
  let taskFailed = null;
  let lastTurnUsage = null;
  const submittedUserPrompts = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session_meta' && !meta) {
      meta = event.payload;
      metaRecordedAt = event.timestamp || null;
    }
    if (event.type === 'token_usage_record') {
      lastTurnUsage = event.payload?.turn_token_usage || lastTurnUsage;
    }
    if (
      event.type === 'response_item' &&
      event.payload?.type === 'message' &&
      event.payload?.role === 'user'
    ) {
      const content = event.payload.content;
      const contentItemKinds =
        event.payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
      const isPlainUserText =
        Array.isArray(content) &&
        content.length === 1 &&
        content[0]?.type === 'input_text' &&
        typeof content[0]?.text === 'string' &&
        Array.isArray(contentItemKinds) &&
        contentItemKinds.length === 1 &&
        contentItemKinds[0] === 'user.text';
      if (isPlainUserText) submittedUserPrompts.push(content[0].text);
    }
    if (event.type === 'event_msg' && event.payload?.type === 'task_complete') {
      taskComplete = event.payload;
    }
    if (event.type === 'event_msg' && event.payload?.type === 'task_failed') {
      taskFailed = event.payload;
    }
  }
  return {
    filePath,
    text,
    meta,
    metaRecordedAt,
    taskComplete,
    taskFailed,
    lastTurnUsage,
    submittedUserPrompts,
  };
}

export function isDesktopNativeSessionMeta(meta, { workspace } = {}) {
  if (!meta || !workspace) return false;
  const id = String(meta.id || '');
  const sessionId = String(meta.session_id || '');
  if (id && sessionId && id !== sessionId) return false;
  const threadId = id || sessionId;
  return Boolean(
    DESKTOP_ORIGINATORS.has(meta.originator) &&
    meta.source === 'vscode' &&
    meta.thread_source === 'user' &&
    THREAD_ID_PATTERN.test(threadId) &&
    normalizedPath(meta.cwd) === normalizedPath(workspace),
  );
}

function promptMatchesStoredUserText(storedPrompt, expectedPrompt) {
  if (storedPrompt === expectedPrompt) return true;
  return storedPrompt === `${expectedPrompt}\n` || storedPrompt === `${expectedPrompt}\r\n`;
}

export function findDesktopNativeSession({
  baseline = new Set(),
  sessionsRoot,
  marker,
  expectedPrompt,
  workspace,
  notBeforeMs,
}) {
  if (!String(expectedPrompt || '').trim()) {
    throw new Error('desktop-native session discovery requires the expected prompt');
  }
  const candidates = [];
  for (const filePath of listCodexSessionFiles(sessionsRoot)) {
    if (baseline.has(filePath)) continue;
    // Recovery scans can include years of unrelated, very large rollouts.
    // A file last written before this draft was opened cannot contain its
    // subsequently submitted prompt. Filter it before loading JSONL text.
    if (Number.isFinite(notBeforeMs) &&
        fs.statSync(filePath).mtimeMs < notBeforeMs - 5_000) continue;
    const parsed = parseDesktopSession(filePath, marker);
    if (!parsed?.meta) continue;
    const recordedAt = Date.parse(parsed.metaRecordedAt || '');
    const recordedInWindow = !Number.isFinite(notBeforeMs) ||
      (Number.isFinite(recordedAt) && recordedAt >= notBeforeMs - 5_000);
    // Codex Desktop may keep a prewarmed draft for several minutes before the
    // user message is submitted. The payload timestamp reflects that prewarm;
    // the outer session_meta event timestamp reflects when the rollout became
    // real and is the correct launch-window boundary.
    const promptMatches =
      parsed.submittedUserPrompts.length === 1 &&
      promptMatchesStoredUserText(parsed.submittedUserPrompts[0], expectedPrompt);
    if (
      !isDesktopNativeSessionMeta(parsed.meta, { workspace }) ||
      !recordedInWindow ||
      !promptMatches
    ) {
      throw new Error(`desktop-native marker appeared in an invalid Codex session: ${filePath}`);
    }
    candidates.push(parsed);
  }
  if (candidates.length > 1) {
    throw new Error(`desktop-native marker appeared in ${candidates.length} Codex sessions`);
  }
  return candidates[0] || null;
}

function completeSessionRecords(sessionPath) {
  const content = readShared(sessionPath);
  if (content == null) return null;
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) !== '') lines.pop(); // A writer may be appending a JSONL record.
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

function researchToolKind(item) {
  if (item?.type !== 'response_item' || item.payload?.type !== 'custom_tool_call' ||
      item.payload?.name !== 'exec') return null;
  const input = String(item.payload.input || '');
  if (/\btools\.web__run\s*\(/u.test(input) &&
      /\b(?:search_query|image_query|open|find)\s*:/u.test(input)) return 'web';
  // A browser dependency check is setup, not research. Require a page action.
  if (/\btools\.exec_command\s*\(/u.test(input) &&
      /cdp-request\.ps1/iu.test(input) &&
      /\/(?:dom\/query|navigate|new\?|screenshot)(?:\b|\?)/iu.test(input)) return 'edge_page';
  return null;
}

function hasSourceBearingOutput(item, kind) {
  if (item?.payload?.isError === true || !Array.isArray(item?.payload?.output)) return false;
  const visibleText = item.payload.output
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text).join('\n');
  if (/\b(?:script error|tool error|access denied)\b/iu.test(visibleText.slice(0, 400))) {
    return false;
  }
  if (kind === 'web') return /https?:\/\/[^\s<>]+/iu.test(visibleText);
  return visibleText.trim().length >= 100;
}

function scopeTerms(terms) {
  return (terms || []).flatMap((value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (/^https?:\/\//u.test(raw)) {
      try {
        const parts = new URL(raw).pathname.split('/').filter(Boolean);
        return [raw, ...parts.filter((part) => part.length >= 3)];
      } catch { return [raw]; }
    }
    return raw.split(/[\s（）(),，;；:：|]+/u)
      .filter((part) => /[\u3400-\u9fff]/u.test(part) ? part.length >= 2 : part.length >= 3);
  });
}

function toolMentionsScope(item, terms) {
  const candidates = scopeTerms(terms);
  if (!candidates.length) return true;
  const input = String(item.payload?.input || '')
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .toLowerCase();
  return candidates.some((term) => input.includes(term));
}

export function inspectDesktopResearchStart({
  sessionPath, sessionsRoot, marker, expectedPrompt, workspace, expectedThreadId,
  instructionPath, instructionSha256, researchTerms = [],
}) {
  if (!sessionPath || !sessionsRoot || !marker || !expectedPrompt || !workspace ||
      !THREAD_ID_PATTERN.test(String(expectedThreadId || ''))) {
    throw new Error('native research handoff requires a complete bound identity');
  }
  const realSession = fs.realpathSync(sessionPath);
  const relative = path.relative(fs.realpathSync(sessionsRoot), realSession);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      !path.basename(realSession).includes(expectedThreadId) ||
      listCodexSessionFiles(sessionsRoot).filter((file) =>
        path.basename(file).includes(expectedThreadId)).length !== 1) {
    throw new Error('native research handoff has no unique bound session file');
  }
  if (instructionPath || instructionSha256) {
    if (!instructionPath || !/^[a-f0-9]{64}$/iu.test(String(instructionSha256 || '')) ||
        !String(expectedPrompt).includes(path.resolve(instructionPath)) ||
        !String(expectedPrompt).includes(String(instructionSha256).toLowerCase()) ||
        crypto.createHash('sha256').update(fs.readFileSync(instructionPath)).digest('hex') !==
          String(instructionSha256).toLowerCase()) {
      throw new Error('native research instruction identity changed');
    }
  }
  const rows = completeSessionRecords(sessionPath);
  if (rows == null) return null;
  const metas = rows.filter((item) => item.type === 'session_meta');
  if (metas.length !== 1 ||
      !isDesktopNativeSessionMeta(metas[0].payload, { workspace }) ||
      String(metas[0].payload.id || metas[0].payload.session_id) !== expectedThreadId) {
    throw new Error('native research session metadata mismatch');
  }
  const prompts = rows.filter((item) =>
    item.type === 'response_item' && item.payload?.type === 'message' &&
    item.payload?.role === 'user' &&
    item.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds?.join(',') ===
      'user.text').map((item) => item.payload.content?.[0]?.text);
  if (prompts.length !== 1 || !promptMatchesStoredUserText(prompts[0], expectedPrompt) ||
      !String(prompts[0]).includes(marker)) {
    throw new Error('native research prompt does not match the bound request');
  }
  const starts = rows.filter((item) =>
    item.type === 'event_msg' && item.payload?.type === 'task_started');
  const contexts = rows.filter((item) => item.type === 'turn_context');
  if (starts.length > 1 || contexts.length > 1) {
    throw new Error('native research handoff crossed multiple turns');
  }
  if (rows.some((item) => item.type === 'event_msg' &&
      ['task_failed', 'task_complete'].includes(item.payload?.type))) {
    throw new Error('native research turn ended before a durable handoff');
  }
  if (!starts.length || !contexts.length) return null;
  const context = contexts[0].payload;
  if (normalizedPath(context?.cwd) !== normalizedPath(workspace) ||
      typeof context?.approval_policy !== 'string' || !context.approval_policy ||
      typeof context?.sandbox_policy?.type !== 'string' || !context.sandbox_policy.type) {
    throw new Error('native research runtime context mismatch');
  }
  const contextIndex = rows.indexOf(contexts[0]);
  for (let i = contextIndex + 1; i < rows.length; i += 1) {
    const kind = researchToolKind(rows[i]);
    if (!kind) continue;
    if (!toolMentionsScope(rows[i], researchTerms)) continue;
    const callId = String(rows[i].payload.call_id || '');
    if (!callId) throw new Error('research tool call has no correlation id');
    const outputIndex = rows.findIndex((item, index) => index > i &&
      item.type === 'response_item' && item.payload?.type === 'custom_tool_call_output' &&
      item.payload?.call_id === callId && hasSourceBearingOutput(item, kind));
    if (outputIndex < 0) return null;
    return {
      threadId: expectedThreadId,
      sessionPath: realSession,
      researchTool: kind,
      callId,
      callRecordIndex: i,
      outputRecordIndex: outputIndex,
      runtime: {
        cwd: context.cwd,
        approvalPolicy: context.approval_policy,
        sandboxType: context.sandbox_policy.type,
        approvalsReviewer: context.approvals_reviewer || null,
      },
      observedAt: new Date().toISOString(),
    };
  }
  return null;
}

export function defaultCodexSessionsRoot(env = process.env) {
  const codexHomeEntry = Object.entries(env)
    .find(([key]) => key.toUpperCase() === 'CODEX_HOME');
  const codexHome = codexHomeEntry?.[1]
    ? path.resolve(codexHomeEntry[1])
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

export function launchCodexDeepLink(deepLink, {
  pwsh = process.env.PWSH_EXE || 'pwsh',
} = {}) {
  return new Promise((resolve, reject) => {
    // explorer.exe accepts ordinary filesystem targets but silently ignored the
    // codex: protocol on the verified Windows host. Start-Process delegates the
    // URI to the registered protocol handler without passing it through a shell.
    const child = spawn(pwsh, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Start-Process -FilePath $env:CODEX_NATIVE_DEEP_LINK',
    ], {
      env: { ...process.env, CODEX_NATIVE_DEEP_LINK: deepLink },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cannot open Codex deep link: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

export function submitCodexDesktopPrompt({
  prompt,
  marker,
  projectName,
  uiHelperPath = defaultUiHelper,
  pwsh = process.env.PWSH_EXE || 'pwsh',
}) {
  if (process.platform !== 'win32') {
    throw new Error('Codex Desktop UI submission is supported only on Windows');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-dispatch-'));
  const expectedPromptPath = path.join(tempDir, 'expected-prompt.txt');
  try {
    fs.writeFileSync(expectedPromptPath, prompt, 'utf8');
    const result = spawnSync(pwsh, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      uiHelperPath,
      '-ExpectedPromptPath',
      expectedPromptPath,
      '-Marker',
      marker,
      '-ExpectedProjectName',
      projectName,
    ], {
      cwd: path.dirname(uiHelperPath),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 40_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Codex Desktop UI submission failed: ${String(result.stderr || result.stdout || '').trim()}`,
      );
    }
    const output = String(result.stdout || '').trim();
    const parsed = JSON.parse(output);
    if (parsed?.invoked !== true || parsed?.marker !== marker) {
      throw new Error('Codex Desktop UI helper returned an invalid confirmation');
    }
    return parsed;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export class DesktopNativeDispatcher {
  constructor({
    launch = launchCodexDeepLink,
    submit = submitCodexDesktopPrompt,
    listSessions = listCodexSessionFiles,
    findSession = findDesktopNativeSession,
    wait = sleep,
    now = () => Date.now(),
  } = {}) {
    this.launch = launch;
    this.submit = submit;
    this.listSessions = listSessions;
    this.findSession = findSession;
    this.wait = wait;
    this.now = now;
  }

  async dispatch({
    requestId,
    threadTitle,
    workspace,
    instructionPath,
    instructionSha256,
    marker = createDesktopNativeMarker(requestId),
    sessionsRoot = defaultCodexSessionsRoot(),
    projectName = path.basename(path.resolve(workspace)),
    discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    signal,
  }) {
    if (process.platform !== 'win32' && this.launch === launchCodexDeepLink) {
      throw new Error('desktop-native dispatch is supported only on Windows');
    }
    const prompt = buildDesktopNativePrompt({
      requestId,
      threadTitle,
      marker,
      instructionPath,
      instructionSha256,
    });
    const deepLink = buildCodexNewDeepLink({ workspace, prompt });
    const baseline = new Set(this.listSessions(sessionsRoot));
    const notBeforeMs = this.now();
    assertNotAborted(signal, 'desktop-native dispatch');
    await this.launch(deepLink);
    assertNotAborted(signal, 'desktop-native dispatch');
    let ui;
    let submitError;
    try {
      ui = await this.submit({ prompt, marker, projectName });
    } catch (error) {
      // InvokePattern may have succeeded even if the helper failed to return
      // its acknowledgement. Inspect the session once; never click again.
      submitError = error;
    }

    const deadline = performance.now() + discoveryTimeoutMs;
    while (performance.now() < deadline) {
      assertNotAborted(signal, 'desktop-native discovery');
      const session = this.findSession({
        baseline,
        sessionsRoot,
        marker,
        expectedPrompt: prompt,
        workspace,
        notBeforeMs,
      });
      if (session) {
        return {
          threadId: String(session.meta.id || session.meta.session_id),
          source: session.meta.source,
          originator: session.meta.originator,
          threadSource: session.meta.thread_source,
          sessionPath: session.filePath,
          marker,
          prompt,
          ui: ui || { invoked: 'uncertain', recoveredAfterSubmitError: true },
        };
      }
      await this.wait(POLL_MS);
    }
    if (submitError) {
      throw new Error(
        'Codex Desktop UI submission returned an error and no matching session was found; inspect the draft before retrying',
        { cause: submitError },
      );
    }
    throw new Error(
      'timed out waiting for the Codex Desktop native session after UI invocation; submission outcome is uncertain',
    );
  }

  async waitForResearchStart({ timeoutMs = 15 * 60_000, signal, ...identity }) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      assertNotAborted(signal, 'desktop-native research handoff');
      const evidence = inspectDesktopResearchStart(identity);
      if (evidence) return evidence;
      await this.wait(COMPLETION_POLL_MS);
    }
    throw new Error('timed out waiting for verified desktop research activity');
  }

  async waitForCompletion({
    sessionPath,
    marker,
    workspace,
    expectedThreadId,
    timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
    signal,
  }) {
    const deadline = performance.now() + timeoutMs;
    const decoder = new StringDecoder('utf8');
    let offset = 0;
    let carry = '';
    let markerWindow = '';
    let markerSeen = false;
    let metaValidated = false;
    let lastTurnUsage = null;

    const consumeDecoded = (decoded) => {
      const markerProbe = markerWindow + decoded;
      if (markerProbe.includes(marker)) markerSeen = true;
      markerWindow = markerProbe.slice(-Math.max(0, marker.length - 1));
      carry += decoded;
      const lines = carry.split(/\r?\n/u);
      carry = lines.pop() || '';

      for (const line of lines.filter(Boolean)) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'session_meta') {
          const meta = event.payload;
          if (workspace && !isDesktopNativeSessionMeta(meta, { workspace })) {
            throw new Error('desktop-native completion session metadata is invalid');
          }
          const actualThreadId = String(meta?.id || meta?.session_id || '');
          if (expectedThreadId && actualThreadId !== expectedThreadId) {
            throw new Error(
              `desktop-native completion thread mismatch: ${actualThreadId || 'missing'}`,
            );
          }
          metaValidated = true;
        }
        if (event.type === 'token_usage_record') {
          lastTurnUsage = event.payload?.turn_token_usage || lastTurnUsage;
        }
        if (event.type === 'event_msg' && event.payload?.type === 'task_failed') {
          throw new Error(
            event.payload.message || event.payload.error || 'Codex Desktop task failed',
          );
        }
        if (event.type === 'event_msg' && event.payload?.type === 'task_complete') {
          if (!metaValidated || !markerSeen) {
            throw new Error('desktop-native completion lacked validated metadata or marker');
          }
          const finalResponse = String(event.payload.last_agent_message || '').trim();
          if (!finalResponse) throw new Error('Codex Desktop completed without a final response');
          return {
            finalResponse,
            usage: lastTurnUsage,
            completedAt: event.payload.completed_at || null,
            turnId: event.payload.turn_id || null,
          };
        }
      }
      return null;
    };

    while (performance.now() < deadline) {
      assertNotAborted(signal, 'desktop-native completion wait');
      let stat;
      try {
        stat = fs.statSync(sessionPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(`desktop-native session file is missing: ${sessionPath}`);
        }
        throw error;
      }
      if (stat.size < offset) throw new Error('desktop-native session file was truncated');

      if (stat.size > offset) {
        const fd = fs.openSync(sessionPath, 'r');
        try {
          while (offset < stat.size) {
            const byteCount = Math.min(
              MAX_SESSION_READ_CHUNK_BYTES,
              stat.size - offset,
            );
            const buffer = Buffer.allocUnsafe(byteCount);
            const bytesRead = fs.readSync(fd, buffer, 0, byteCount, offset);
            if (bytesRead <= 0) throw new Error('desktop-native session read made no progress');
            offset += bytesRead;
            const completion = consumeDecoded(decoder.write(buffer.subarray(0, bytesRead)));
            if (completion) return completion;
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      await this.wait(COMPLETION_POLL_MS);
    }
    throw new Error('timed out waiting for Codex Desktop task completion');
  }
}

export const desktopNativeDispatcher = new DesktopNativeDispatcher();

export const desktopNativeDispatchDefaults = Object.freeze({
  discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
  completionTimeoutMs: DEFAULT_COMPLETION_TIMEOUT_MS,
  uiHelperPath: defaultUiHelper,
});
