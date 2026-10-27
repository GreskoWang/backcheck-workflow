import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDesktopNativePrompt } from './desktop-native-dispatch.mjs';
import { reviewManifestPath, verifyCompletedReports } from './delivery-review.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const REQUEST = /^RQ-[A-Z0-9-]+$/iu;
const ORIGINATORS = new Set(['codex_work_desktop', 'Codex Desktop']);
const DEFAULT_BYTES_PER_POLL = 16 * 1024 * 1024;
const DEFAULT_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_FINAL_BYTES = 128 * 1024;
const READ_CHUNK = 256 * 1024;
const ANCHOR_BYTES = 4096;
const MAX_REVIEW_MANIFEST_BYTES = 1024 * 1024;

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sameText = (actual, expected) => actual === expected || actual === `${expected}\n` || actual === `${expected}\r\n`;
const normalizedPath = value => process.platform === 'win32' ? value.toLowerCase() : value;

export function completionJobFingerprint(job) {
  return digest(JSON.stringify(job ?? null));
}

function outcome(status, reason, extra = {}) { return { status, reason, ...extra }; }

function realFileWithin(root, filename) {
  if (!root || !filename || !path.isAbsolute(filename)) throw new Error('invalid_path');
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(filename);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path_outside_root');
  }
  if (!fs.statSync(realFile).isFile()) throw new Error('not_regular_file');
  return realFile;
}

// This is only an invalidation key for a failed review, never review evidence.
// Snapshot contents remain the reviewer's responsibility. In particular, do not
// follow an untrusted manifest's snapshot path outside the bound workspace.
function reviewFileState(filename, root, readManifest = false) {
  try {
    const actual = root ? realFileWithin(root, filename) : fs.realpathSync(filename);
    const stat = fs.statSync(actual);
    if (!stat.isFile()) throw new Error('not_regular_file');
    const signature = { path: normalizedPath(actual), dev: stat.dev, ino: stat.ino,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    if (!readManifest || stat.size > MAX_REVIEW_MANIFEST_BYTES) return { signature };
    const fd = fs.openSync(actual, 'r');
    try {
      // Bound the read even if the file grows after stat(). A changed manifest
      // will invalidate this signature on the following poll.
      const buffer = Buffer.alloc(MAX_REVIEW_MANIFEST_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!read) break;
        length += read;
      }
      const bytes = buffer.subarray(0, length);
      signature.sha256 = digest(bytes);
      return { signature, text: length <= MAX_REVIEW_MANIFEST_BYTES ? bytes.toString('utf8') : null };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    return { signature: { path: String(filename || ''), unavailable: error?.code || error?.message || 'unavailable' } };
  }
}

function failedReviewKey(job, completion, options) {
  const manifest = reviewFileState(reviewManifestPath(options.stateDir, job.requestId), options.stateDir, true);
  let documents, artifacts;
  try { const data = JSON.parse(manifest.text); documents = data.documents; artifacts = data.artifacts; } catch { documents = null; }
  const snapshots = Array.isArray(documents) && documents.length <= 30
    ? documents.map(item => typeof item?.snapshotPath === 'string'
      ? reviewFileState(item.snapshotPath, options.workspace).signature : { invalidSnapshotPath: true }) : [];
  const python = process.env.FEISHU_REVIEW_PYTHON || path.join(os.homedir(), '.cache',
    'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const auditor = process.env.FEISHU_REVIEW_AUDITOR || path.join(process.env.CODEX_HOME ||
    path.join(os.homedir(), '.codex'), 'skills', 'review-feishu-background-check',
    'scripts', 'audit_feishu_snapshot.py');
  const artifactFiles = Array.isArray(artifacts) && artifacts.length <= 10
    ? artifacts.flatMap(item => [item.localPath, ...(Array.isArray(item.sourceFiles) ? item.sourceFiles : [])].filter(value => typeof value === 'string')
      .map(filename => reviewFileState(filename, options.workspace).signature)) : [];
  return digest(JSON.stringify({ completion, manifest: manifest.signature, snapshots, artifactFiles,
    validator: [reviewFileState(python).signature, reviewFileState(auditor).signature] }));
}

function authorizationGate(job, authorization) {
  if (job?.status !== 'handed_off' || job?.stage !== 'research_started') return 'not_handed_off';
  if (authorization?.enabled !== true || authorization.chatId !== job.chatId ||
      !Number.isSafeInteger(authorization.activatedFromMs) || authorization.activatedFromMs <= 0) {
    return 'completion_route_not_authorized';
  }
  if (!Number.isSafeInteger(job.sourceMessageCreatedAtMs) ||
      job.sourceMessageCreatedAtMs < authorization.activatedFromMs) return 'before_completion_activation';
  return null;
}

function prepareIdentity(job, options) {
  if (!REQUEST.test(job.requestId || '') || !UUID.test(job.codexThreadId || '') ||
      job.codexThreadRequestId !== job.requestId ||
      job.codexThreadCreationMode !== 'desktop_native_handoff_v1' ||
      job.codexThreadSource !== 'vscode' || !ORIGINATORS.has(job.codexThreadOriginator) ||
      job.codexThreadSourceKind !== 'user' ||
      job.handoffEvidence?.threadId !== job.codexThreadId ||
      !Number.isSafeInteger(job.handoffEvidence?.outputRecordIndex) || job.handoffEvidence.outputRecordIndex < 0 ||
      !/^FEISHU-NATIVE-RQ-[A-Z0-9-]+-[a-z0-9-]+$/iu.test(job.codexNativeDispatchMarker || '') ||
      !job.codexNativeDispatchMarker.startsWith(`FEISHU-NATIVE-${job.requestId}-`)) {
    throw new Error('job_binding_invalid');
  }
  const workspace = fs.realpathSync(options.workspace);
  const sessionPath = realFileWithin(options.sessionsRoot, job.codexNativeSessionPath);
  if (!sessionPath.endsWith('.jsonl')) throw new Error('session_extension_invalid');
  const instructionPath = realFileWithin(workspace, job.codexNativeInstructionPath);
  if (fs.statSync(instructionPath).size > 1024 * 1024 ||
      digest(fs.readFileSync(instructionPath)) !== job.codexNativeInstructionSha256) {
    throw new Error('instruction_digest_changed');
  }
  const expectedPrompt = buildDesktopNativePrompt({
    requestId: job.requestId, threadTitle: job.codexThreadTitle,
    marker: job.codexNativeDispatchMarker,
    instructionPath: job.codexNativeInstructionPath,
    instructionSha256: job.codexNativeInstructionSha256,
  });
  return { workspace, sessionPath, expectedPrompt };
}

function plainUserText(event) {
  const item = event.type === 'response_item' ? event.payload : null;
  if (item?.type !== 'message' || item.role !== 'user' ||
      item.content?.length !== 1 || item.content[0]?.type !== 'input_text' ||
      typeof item.content[0]?.text !== 'string' ||
      item.internal_chat_message_metadata_passthrough?.content_item_kinds?.length !== 1 ||
      item.internal_chat_message_metadata_passthrough.content_item_kinds[0] !== 'user.text') return null;
  return item.content[0].text;
}

function consumeEvent(state, event, job, identity) {
  state.recordIndex += 1;
  const payload = event?.payload;
  if (event?.type === 'session_meta') {
    let cwd;
    try { cwd = fs.realpathSync(payload?.cwd || ''); } catch { throw new Error('session_workspace_invalid'); }
    const id = payload?.id || payload?.session_id;
    if ((payload?.id && payload?.session_id && payload.id !== payload.session_id) ||
        id !== job.codexThreadId || payload?.source !== 'vscode' || payload?.thread_source !== 'user' ||
        !ORIGINATORS.has(payload?.originator) ||
        normalizedPath(cwd) !== normalizedPath(identity.workspace)) throw new Error('session_metadata_invalid');
    state.metaValidated = true;
  }
  const userText = plainUserText(event);
  if (userText !== null) {
    if (sameText(userText, identity.expectedPrompt)) state.markerValidated = true;
    // A later genuine user submission of another bridge batch invalidates ownership.
    const explicitRequest = userText.match(/(?:^|\r?\n)飞书背调批次：(RQ-[A-Z0-9-]+)(?:\r?\n|$)/iu)?.[1];
    if (explicitRequest && explicitRequest !== job.requestId) throw new Error('foreign_batch_prompt');
    if (state.terminal) { state.terminal = null; state.pendingReason = 'user_input_after_completion'; }
  }
  if (event?.type === 'turn_context') {
    const turnId = payload?.turn_id;
    if (typeof turnId !== 'string' || !turnId) throw new Error('turn_identity_missing');
    if (turnId !== state.turnId || state.terminal) {
      if (turnId !== state.turnId) state.failedTurn = false;
      state.turnId = turnId;
      state.terminal = null;
      state.pendingReason = 'latest_turn_active';
    }
  }
  if (event?.type === 'event_msg') {
    if (payload?.type === 'task_started') {
      if (typeof payload.turn_id !== 'string' || !payload.turn_id) throw new Error('turn_identity_missing');
      state.turnId = payload.turn_id;
      state.failedTurn = false;
      state.terminal = null;
      state.pendingReason = 'latest_turn_active';
    } else if (['task_failed', 'turn_aborted', 'task_aborted'].includes(payload?.type)) {
      state.turnId = payload.turn_id || state.turnId;
      state.failedTurn = true;
      state.terminal = null;
      state.pendingReason = 'latest_turn_failed_or_aborted';
    } else if (payload?.type === 'user_message' && state.terminal) {
      state.terminal = null;
      state.pendingReason = 'user_input_after_completion';
    } else if (payload?.type === 'task_complete') {
      const turnId = payload.turn_id;
      if (typeof turnId !== 'string' || !turnId || (state.turnId && turnId !== state.turnId)) {
        throw new Error('completion_turn_mismatch');
      }
      if (state.failedTurn) return;
      const finalResponse = String(payload.last_agent_message || '').trim();
      if (Buffer.byteLength(finalResponse) > MAX_FINAL_BYTES) throw new Error('completion_text_too_large');
      state.turnId = turnId;
      state.terminal = {
        finalResponse, turnId, recordIndex: state.recordIndex,
        completedAt: payload.completed_at || event.timestamp || null,
      };
    }
  }
  if (event?.type === 'response_item' && state.terminal &&
      ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(payload?.type)) {
    state.terminal = null;
    state.pendingReason = 'tool_activity_after_completion';
  }
}

function readAnchor(fd, offset) {
  const size = Math.min(offset, ANCHOR_BYTES);
  const buffer = Buffer.alloc(size);
  if (size && fs.readSync(fd, buffer, 0, size, offset - size) !== size) throw new Error('session_anchor_unavailable');
  return digest(buffer);
}

function createScan() {
  return { offset: 0, carry: Buffer.alloc(0), recordIndex: -1, metaValidated: false,
    markerValidated: false, turnId: null, failedTurn: false, terminal: null, pendingReason: 'completion_not_observed',
    hash: crypto.createHash('sha256'), anchor: null, stat: null };
}

function scanBoundSession(state, job, identity, options) {
  const fd = fs.openSync(identity.sessionPath, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (state.stat && (before.ino !== state.stat.ino || before.dev !== state.stat.dev || before.size < state.offset ||
        (before.size === state.offset && before.mtimeMs !== state.stat.mtimeMs))) throw new Error('session_rewritten');
    if (state.anchor && readAnchor(fd, state.offset) !== state.anchor) throw new Error('session_rewritten');
    const until = Math.min(before.size, state.offset + options.maxBytesPerPoll);
    while (state.offset < until) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, until - state.offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      if (!read) throw new Error('session_read_no_progress');
      state.offset += read;
      const bytes = buffer.subarray(0, read);
      state.hash.update(bytes);
      const joined = state.carry.length ? Buffer.concat([state.carry, bytes]) : bytes;
      let start = 0;
      for (let newline = joined.indexOf(10); newline !== -1; newline = joined.indexOf(10, start)) {
        if (newline - start > options.maxRecordBytes) throw new Error('session_record_too_large');
        const line = joined.subarray(start, newline).toString('utf8').trim();
        start = newline + 1;
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('session_record_invalid'); }
        consumeEvent(state, event, job, identity);
      }
      state.carry = Buffer.from(joined.subarray(start));
      if (state.carry.length > options.maxRecordBytes) throw new Error('session_record_too_large');
    }
    const after = fs.fstatSync(fd);
    state.anchor = readAnchor(fd, state.offset);
    state.stat = { ino: after.ino, dev: after.dev, size: after.size, mtimeMs: after.mtimeMs };
    if (state.offset < after.size) return outcome('waiting', 'session_scan_incomplete', { scannedBytes: state.offset, sessionBytes: after.size });
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return outcome('waiting', 'session_changed_during_read');
    if (state.carry.length) return outcome('waiting', 'partial_session_record');
    if (!state.metaValidated || !state.markerValidated) return outcome('blocked', 'bound_prompt_not_verified');
    if (!state.terminal) return outcome('waiting', state.pendingReason);
    if (!state.terminal.finalResponse) return outcome('waiting', 'completion_has_no_final_response');
    if (state.terminal.recordIndex <= job.handoffEvidence.outputRecordIndex) return outcome('waiting', 'completion_precedes_research_handoff');
    return outcome('candidate', 'latest_bound_turn_completed', {
      completion: { ...state.terminal, threadId: job.codexThreadId,
        sessionSha256: state.hash.copy().digest('hex'), sessionBytes: state.offset },
    });
  } finally { fs.closeSync(fd); }
}

/** Read-only incremental observer. Reuse this instance between timer ticks. */
export function createCompletionObserver({
  workspace, sessionsRoot, stateDir, readLatestRevision,
  verifyReports = verifyCompletedReports,
  maxBytesPerPoll = DEFAULT_BYTES_PER_POLL, maxRecordBytes = DEFAULT_RECORD_BYTES,
} = {}) {
  if (!workspace || !sessionsRoot || !stateDir || typeof verifyReports !== 'function' ||
      typeof readLatestRevision !== 'function' || !Number.isSafeInteger(maxBytesPerPoll) || maxBytesPerPoll < 1 ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error('completion observer options are incomplete');
  const options = { workspace, sessionsRoot, stateDir, maxBytesPerPoll, maxRecordBytes };
  const scans = new Map();
  const inFlight = new Map();

  async function inspect(job, authorization, verify) {
    const reason = authorizationGate(job, authorization);
    if (reason) { if (job?.requestId) scans.delete(job.requestId); return outcome('ignored', reason); }
    const expectedJobSha256 = completionJobFingerprint(job);
    let identity;
    try { identity = prepareIdentity(job, options); }
    catch { return outcome('blocked', 'bound_session_identity_unavailable', { expectedJobSha256 }); }
    // Read-only health fields may change between ticks; they must not reset a
    // large rollout scan. Only binding/activation changes invalidate the cursor.
    const key = digest(JSON.stringify([
      job.requestId, job.chatId, job.sourceMessageId, job.sourceMessageCreatedAtMs,
      job.codexThreadId, job.codexThreadRequestId, job.codexThreadCreationMode,
      job.codexThreadSource, job.codexThreadOriginator, job.codexThreadSourceKind,
      job.codexNativeDispatchMarker, job.codexNativeInstructionPath,
      job.codexNativeInstructionSha256, job.codexThreadTitle,
      job.handoffEvidence, authorization, identity.sessionPath,
    ]));
    let entry = scans.get(job.requestId);
    if (!entry || entry.key !== key) { entry = { key, state: createScan() }; scans.set(job.requestId, entry); }
    let result;
    try { result = scanBoundSession(entry.state, job, identity, options); }
    catch (error) {
      scans.delete(job.requestId);
      const known = new Set(['session_rewritten', 'session_record_too_large', 'session_record_invalid',
        'session_workspace_invalid', 'session_metadata_invalid', 'foreign_batch_prompt',
        'turn_identity_missing', 'completion_turn_mismatch', 'completion_text_too_large']);
      return outcome('blocked', known.has(error?.message) ? error.message : 'session_read_unavailable', { expectedJobSha256 });
    }
    if (result.status !== 'candidate' || !verify) return { ...result, expectedJobSha256 };
    const reviewKey = failedReviewKey(job, result.completion, options);
    if (entry.failedReviewKey === reviewKey) {
      return outcome('waiting', 'report_review_not_ready', { expectedJobSha256, reviewCached: true });
    }
    const reviewNotReady = () => {
      entry.failedReviewKey = reviewKey;
      return outcome('waiting', 'report_review_not_ready', { expectedJobSha256 });
    };
    let reviewReceipts;
    try {
      reviewReceipts = await verifyReports({ job, requestId: job.requestId,
        finalResponse: result.completion.finalResponse, stateDir, workspace, readLatestRevision });
      const artifactReview = job.deliveryReviewMode === 'special_artifacts_v1' && job.workflowKind === 'special_research';
      if (!Array.isArray(reviewReceipts) || !reviewReceipts.length ||
          reviewReceipts.some(receipt => receipt?.verdict !== 'PASS' || (artifactReview
            ? receipt.kind !== 'special_artifact_review_v1' || !receipt.artifactId ||
              !/^[a-f0-9]{64}$/u.test(receipt.contentDigest || '') || !/^[a-f0-9]{64}$/u.test(receipt.sourceDigest || '') ||
              !/^[a-f0-9]{64}$/u.test(receipt.manifestDigest || '') || !receipt.receiptId || !receipt.reviewedAt
            : !receipt.token || !Number.isSafeInteger(Number(receipt.revision_id)) || Number(receipt.revision_id) <= 0))) {
        return reviewNotReady();
      }
    } catch { return reviewNotReady(); }
    delete entry.failedReviewKey;
    let after;
    try { after = scanBoundSession(entry.state, job, identity, options); }
    catch { scans.delete(job.requestId); return outcome('blocked', 'session_changed_during_review', { expectedJobSha256 }); }
    if (after.status !== 'candidate' || after.completion.sessionSha256 !== result.completion.sessionSha256 ||
        after.completion.turnId !== result.completion.turnId) {
      return outcome('waiting', 'session_changed_during_review', { expectedJobSha256 });
    }
    return { ...result, status: 'eligible', reason: 'latest_completion_and_review_verified', reviewReceipts, expectedJobSha256 };
  }

  return {
    observe(job, authorization) {
      // Concurrent ticks for one job share the same read/verification operation.
      const key = `${job?.requestId || ''}:${completionJobFingerprint(job)}:${digest(JSON.stringify(authorization ?? null))}`;
      if (inFlight.has(key)) return inFlight.get(key);
      const pending = inspect(job, authorization, true).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
    inspect(job, authorization) { return inspect(job, authorization, false); },
    forget(requestId) { scans.delete(requestId); },
  };
}

export async function observeCompletedHandoff(options) {
  const { job, authorization, ...dependencies } = options;
  return createCompletionObserver(dependencies).observe(job, authorization);
}

export async function inspectBoundSessionCompletion(options) {
  const { job, authorization, ...dependencies } = options;
  return createCompletionObserver({ readLatestRevision: async () => { throw new Error('inspection does not read Feishu'); },
    ...dependencies }).inspect(job, authorization);
}
