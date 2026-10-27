import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canResumeDeliveryReview, deliveryReviewInputFingerprint } from './delivery-review.mjs';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${filePath}: ${error.message}`);
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function makePairingCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

function normalized(value) {
  return String(value || '').trim();
}

function sourceMessageIds(job) {
  return [...new Set([job?.sourceMessageId, ...(job?.sourceAliases || []).map((item) => item.messageId)].filter(Boolean))];
}

function intakeFingerprint(job) {
  const text = String(job?.requestText || '').normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  const media = Array.isArray(job?.sourceMediaKeys) ? job.sourceMediaKeys.map(String) : [];
  if (!text && !media.length) return null;
  return crypto.createHash('sha256').update(JSON.stringify({ text, media })).digest('hex');
}

function assertPersistedUniqueness(jobs) {
  const requestIds = new Set();
  const sourceIds = new Set();
  const canonicalIds = new Set();
  const threadOwners = new Map();

  for (const job of jobs) {
    const requestId = normalized(job?.requestId);
    if (!requestId) throw new Error('persisted job requires requestId');
    if (requestIds.has(requestId)) {
      throw new Error(`duplicate request id in job store: ${requestId}`);
    }
    requestIds.add(requestId);

    for (const sourceMessageId of sourceMessageIds(job)) {
      if (sourceIds.has(sourceMessageId)) {
        throw new Error(`duplicate source message id in job store: ${sourceMessageId}`);
      }
      sourceIds.add(sourceMessageId);
    }
    const canonicalId = normalized(job?.canonicalSourceMessageId || job?.sourceMessageId);
    if (canonicalId) {
      if (canonicalIds.has(canonicalId)) throw new Error(`duplicate canonical source message id: ${canonicalId}`);
      canonicalIds.add(canonicalId);
    }

    const threadId = normalized(job?.codexThreadId);
    if (threadId) {
      const existingOwner = threadOwners.get(threadId);
      if (existingOwner) {
        throw new Error(
          `Codex thread ${threadId} is bound to multiple requests: ${existingOwner}, ${requestId}`,
        );
      }
      threadOwners.set(threadId, requestId);
    }
  }
}

function findUniqueJob(jobs, requestId) {
  const matches = jobs.filter((job) => job.requestId === requestId);
  if (matches.length === 0) throw new Error(`job not found: ${requestId}`);
  if (matches.length > 1) throw new Error(`duplicate request id in job store: ${requestId}`);
  return matches[0];
}

export class BridgeStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.bindingPath = path.join(stateDir, 'binding.json');
    this.pairingPath = path.join(stateDir, 'pairing.json');
    this.jobsPath = path.join(stateDir, 'jobs.json');
    this.seenPath = path.join(stateDir, 'seen-message-ids.json');
    this.runtimePath = path.join(stateDir, 'runtime.json');
    this.watermarksPath = path.join(stateDir, 'poll-watermarks.json');
    this.outboxPath = path.join(stateDir, 'reply-outbox.json');
    fs.mkdirSync(stateDir, { recursive: true });
  }

  getBinding() {
    return readJson(this.bindingPath, null);
  }

  setBinding(binding) {
    atomicWriteJson(this.bindingPath, binding);
  }

  getOrCreatePairing() {
    const existing = readJson(this.pairingPath, null);
    if (existing?.code) return existing;
    const pairing = { code: makePairingCode(), createdAt: new Date().toISOString() };
    atomicWriteJson(this.pairingPath, pairing);
    return pairing;
  }

  clearPairing() {
    try {
      fs.rmSync(this.pairingPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  listJobs() {
    return readJson(this.jobsPath, []);
  }

  saveJobs(jobs) {
    assertPersistedUniqueness(jobs);
    atomicWriteJson(this.jobsPath, jobs);
  }

  recoverInterruptedJobs() {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    let changed = false;
    for (const job of jobs) {
      // A pause is an explicit operator decision. Restart recovery must not
      // reinterpret it as an interrupted run or put it back on the queue.
      if (job.status === 'paused') continue;
      if (job.status === 'running' || job.status === 'queued') {
        // A saved result is resumed only through the read-only review path.
        // The CLI execution guard remains intact for every research attempt.
        if (canResumeDeliveryReview(job)) {
          job.status = 'queued';
          job.reviewRecoveryOnly = true;
          job.recoveredAt = new Date().toISOString();
          changed = true;
          continue;
        }
        const threadId = normalized(job.codexThreadId);
        const ownerRequestId = normalized(job.codexThreadRequestId);
        const cliTurnMayHaveRun = Boolean(job.codexCliAttemptStartedAt) ||
          (job.codexThreadCreationMode === 'cli_visible_v1' &&
           ['thread_bootstrapping', 'executing'].includes(job.stage));
        const desktopHandoffMayHaveRun = job.codexThreadCreationMode ===
          'desktop_native_handoff_v1' &&
          ['thread_bootstrapping', 'handoff_verifying', 'research_started'].includes(job.stage);
        const bindingWasAmbiguous =
          ['thread_bootstrapping', 'executing', 'handoff_verifying'].includes(job.stage) && !threadId;
        const ownershipIsUnverified = Boolean(threadId) && ownerRequestId !== job.requestId;

        if (cliTurnMayHaveRun || desktopHandoffMayHaveRun ||
            bindingWasAmbiguous || ownershipIsUnverified) {
          job.status = 'recovery_required';
          job.recoveryFromStage = job.stage;
          job.stage = 'thread_recovery_required';
          job.recoveryReason = cliTurnMayHaveRun
            ? 'CLI turn may have started; inspect the bound session before any same-request continuation'
            : desktopHandoffMayHaveRun
              ? 'Codex Desktop may be researching; inspect the bound session before any continuation'
            : bindingWasAmbiguous
            ? 'execution began before a Codex thread binding was durably recorded'
            : ownerRequestId
              ? `Codex thread ownership points to ${ownerRequestId}`
              : 'Codex thread ownership is unverified';
          job.recoveredAt = new Date().toISOString();
          changed = true;
        } else if (job.status === 'running') {
          job.status = 'queued';
          job.recoveredAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    if (changed) this.saveJobs(jobs);
    return jobs;
  }

  getJob(requestId) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const matches = jobs.filter((job) => job.requestId === requestId);
    return matches.length === 1 ? matches[0] : null;
  }

  getJobBySourceMessageId(messageId) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const matches = jobs.filter((job) => sourceMessageIds(job).includes(messageId));
    if (matches.length > 1) {
      throw new Error(`duplicate source message id in job store: ${messageId}`);
    }
    return matches[0] || null;
  }

  addJob(job) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const isolatedJob = this.#isolateNewJob(job, jobs);
    jobs.push(isolatedJob);
    this.saveJobs(jobs);
    return jobs;
  }

  addJobForMessage(messageId, job, { canonicalSourceMessageId, canonicalSourceVerified = false } = {}) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const existing = jobs.find((item) => sourceMessageIds(item).includes(messageId));
    if (existing) {
      this.markMessageSeen(messageId);
      return { added: false, job: existing };
    }
    if (canonicalSourceMessageId && (canonicalSourceVerified !== true || !/^om_[A-Za-z0-9]+$/u.test(canonicalSourceMessageId))) {
      throw new Error('canonical origin requires verified message metadata');
    }
    const canonicalId = canonicalSourceMessageId || messageId;
    const canonicalOwner = jobs.find((item) =>
      (item.canonicalSourceMessageId || item.sourceMessageId) === canonicalId ||
      sourceMessageIds(item).includes(canonicalId));
    if (canonicalOwner) {
      // One durable jobs.json commit claims the forwarding alias. A crash
      // before updating seen IDs is repaired by the source lookup on replay.
      canonicalOwner.sourceAliases = [...(canonicalOwner.sourceAliases || []), {
        messageId, chatId: job.chatId, createdAtMs: job.sourceMessageCreatedAtMs,
        reason: 'verified_forward_origin',
      }];
      this.saveJobs(jobs);
      this.markMessageSeen(messageId);
      return { added: false, duplicate: true, job: canonicalOwner };
    }
    const fingerprint = intakeFingerprint(job);
    const candidates = fingerprint && job.chatId ? jobs.filter((item) =>
      item.chatId && item.chatId !== job.chatId &&
      (item.intakeFingerprint || intakeFingerprint(item)) === fingerprint) : [];
    const intakeHold = candidates.length ? {
      reason: 'cross_group_same_content_requires_origin_review',
      candidateRequestIds: candidates.map((item) => item.requestId),
      heldAt: new Date().toISOString(),
    } : null;
    // Write the durable job before claiming the source message. If the process
    // stops between these writes, the sourceMessageId lookup above makes replay
    // idempotent and repairs the missing claim without creating a second job.
    const isolatedJob = this.#isolateNewJob({
      ...job, sourceMessageId: messageId, canonicalSourceMessageId: canonicalId,
      sourceOriginVerified: canonicalSourceVerified === true,
      sourceAliases: [], intakeFingerprint: fingerprint,
      ...(intakeHold ? { status: 'intake_held', stage: 'cross_group_duplicate_review', intakeHold } : {}),
    }, jobs);
    jobs.push(isolatedJob);
    this.saveJobs(jobs);
    this.markMessageSeen(messageId);
    return { added: true, held: Boolean(intakeHold), job: isolatedJob };
  }

  #isolateNewJob(job, jobs) {
    const requestId = normalized(job?.requestId);
    if (!requestId) throw new Error('new job requires requestId');
    if (jobs.some((item) => item.requestId === requestId)) {
      throw new Error(`duplicate request id in job store: ${requestId}`);
    }
    const sourceMessageId = normalized(job?.sourceMessageId);
    if (sourceMessageId && jobs.some((item) => sourceMessageIds(item).includes(sourceMessageId))) {
      throw new Error(`duplicate source message id in job store: ${sourceMessageId}`);
    }
    // A new Feishu request must never inherit a thread id from the caller or a
    // previously executed job. The request marker is persisted immediately so
    // only this request may later resume the thread bound to it.
    return {
      ...job,
      requestId,
      accountingPolicy: 'per_code_v2',
      codexThreadId: null,
      codexThreadRequestId: requestId,
      codexThreadTitle: null,
    };
  }

  prepareDeliveryReview(requestId, { workspace } = {}) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);
    if (job.intakeHold || job.duplicateOfRequestId || !canResumeDeliveryReview(job) ||
        !['queued', 'running', 'review_pending', 'failed'].includes(job.status)) {
      throw new Error('delivery review requires a resumable owned result; paused, handed-off, or terminal jobs cannot resume');
    }
    try {
      const inputFingerprint = deliveryReviewInputFingerprint({
        ...job, stateDir: this.stateDir, workspace,
      });
      return { ...job, reviewInputFingerprint: inputFingerprint };
    } catch (error) {
      error.code = 'review_evidence_invalid';
      error.reviewStatus = 'BLOCKED';
      throw error;
    }
  }

  prepareExecutionJob(requestId) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);

    if (job.intakeHold || job.status === 'intake_held' || job.duplicateOfRequestId) {
      throw new Error(`request ${requestId} requires cross-group origin review before execution`);
    }

    if (job.stage === 'verifying_delivery') {
      throw new Error(`request ${requestId} requires delivery-review-only preparation`);
    }
    if (job.status === 'paused') {
      throw new Error(
        `request ${requestId} is paused and cannot execute until explicitly resumed`,
      );
    }
    if (job.status === 'handed_off' || job.handoffEvidence) {
      throw new Error(`request ${requestId} was handed to Codex Desktop and cannot be dispatched again`);
    }

    let changed = false;
    const ownerRequestId = normalized(job.codexThreadRequestId);
    if (ownerRequestId && ownerRequestId !== requestId) {
      throw new Error(
        `Codex thread ownership mismatch: ${requestId} cannot resume thread owned by ${ownerRequestId}`,
      );
    }
    const threadId = normalized(job.codexThreadId);
    if (job.codexCliAttemptStartedAt) {
      throw new Error(
        `request ${requestId} has a prior CLI execution attempt and requires local rollout review`,
      );
    }
    if (
      job.status === 'recovery_required' ||
      (['thread_bootstrapping', 'executing', 'handoff_verifying'].includes(job.stage) && !threadId)
    ) {
      throw new Error(
        `request ${requestId} requires local recovery review before Codex execution`,
      );
    }
    if (threadId && !ownerRequestId) {
      throw new Error(
        `Codex thread ${threadId} has no verified ownership for request ${requestId}`,
      );
    }
    if (!threadId && !ownerRequestId) {
      // There is no existing thread to claim. Recording the request marker before
      // launch is safe and lets a legacy queued/preflight job start a new thread.
      job.codexThreadRequestId = requestId;
      changed = true;
    }

    if (changed) this.saveJobs(jobs);
    return job;
  }

  pauseJob(requestId, { reason, requestedBy = 'operator', now = new Date() } = {}) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('pause timestamp must be a valid Date');
    }

    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);
    if (job.status === 'paused') return job;

    const pausableStatuses = new Set(['queued', 'running', 'recovery_required', 'review_pending']);
    if (!pausableStatuses.has(job.status)) {
      throw new Error(
        `request ${requestId} cannot be paused from status ${job.status || 'missing'}`,
      );
    }

    job.pausedFromStatus = job.status;
    job.pausedFromStage = normalized(job.stage) || null;
    job.status = 'paused';
    job.stage = 'paused';
    job.pausedAt = now.toISOString();
    job.pauseReason = normalized(reason) || 'paused by explicit user request';
    job.pauseRequestedBy = normalized(requestedBy) || 'operator';
    this.saveJobs(jobs);
    return job;
  }

  bindExecutionThread(requestId, threadId, { title } = {}) {
    const normalizedThreadId = normalized(threadId);
    if (!normalizedThreadId) throw new Error('cannot bind an empty Codex thread id');

    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);

    const ownerRequestId = normalized(job.codexThreadRequestId);
    if (ownerRequestId !== requestId) {
      throw new Error(
        ownerRequestId
          ? `Codex thread ownership mismatch: ${requestId} cannot bind a thread owned by ${ownerRequestId}`
          : `request ${requestId} has no verified thread ownership marker`,
      );
    }
    const currentThreadId = normalized(job.codexThreadId);
    if (currentThreadId && currentThreadId !== normalizedThreadId) {
      throw new Error(
        `request ${requestId} is already bound to Codex thread ${currentThreadId}`,
      );
    }
    const otherOwner = jobs.find((item) =>
      item.requestId !== requestId &&
      normalized(item.codexThreadId) === normalizedThreadId);
    if (otherOwner) {
      throw new Error(
        `Codex thread ${normalizedThreadId} is already bound to request ${otherOwner.requestId}`,
      );
    }

    job.codexThreadId = normalizedThreadId;
    job.codexThreadRequestId = requestId;
    if (!job.codexThreadBoundAt) job.codexThreadBoundAt = new Date().toISOString();
    if (title) job.codexThreadTitle = String(title);
    this.saveJobs(jobs);
    return job;
  }

  markThreadRecoveryRequired(requestId, { reason, fromStage } = {}) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);
    const previousStage = normalized(fromStage) || normalized(job.stage) || 'thread_bootstrapping';
    job.status = 'recovery_required';
    job.recoveryFromStage = previousStage;
    job.stage = 'thread_recovery_required';
    job.recoveryReason = normalized(reason) || 'Codex thread identity requires local review';
    job.recoveredAt = new Date().toISOString();
    this.saveJobs(jobs);
    return job;
  }

  claimUnusedCliRecovery(requestId, {
    expectedThreadId, expectedSessionPath, expectedSourceMessageId,
    expectedFirstAttemptAt, sessionRecordCount,
  } = {}) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);
    const recoverable = (job.status === 'running' && job.stage === 'executing') ||
      (job.status === 'recovery_required' && job.stage === 'thread_recovery_required' &&
       job.recoveryFromStage === 'executing');
    if (!recoverable || job.finalResponse || job.reviewReceipts ||
        job.codexCliRecoveryClaimedAt || job.codexCliRecoveryExecutionStartedAt) {
      throw new Error(`request ${requestId} is not an unused CLI recovery candidate`);
    }
    if (!expectedThreadId || job.codexThreadId !== expectedThreadId ||
        job.codexThreadRequestId !== requestId ||
        job.codexThreadSource !== 'cli' || job.codexThreadOriginator !== 'codex-tui' ||
        job.codexThreadCreationMode !== 'cli_visible_v1' ||
        !expectedSessionPath || job.codexCliSessionPath !== expectedSessionPath ||
        !expectedSourceMessageId || job.sourceMessageId !== expectedSourceMessageId ||
        !expectedFirstAttemptAt || job.codexCliAttemptStartedAt !== expectedFirstAttemptAt ||
        !Number.isSafeInteger(sessionRecordCount) || sessionRecordCount < 1) {
      throw new Error(`request ${requestId} recovery identity or session evidence changed`);
    }
    job.status = 'running';
    job.stage = 'executing';
    job.codexCliRecoveryClaimedAt = new Date().toISOString();
    job.codexCliRecoveryAttemptThreadId = expectedThreadId;
    job.codexCliRecoverySessionRecordCount = sessionRecordCount;
    this.saveJobs(jobs);
    return job;
  }

  migrateLegacyExecutionThread(requestId, expectedThreadId, { evidence } = {}) {
    const normalizedThreadId = normalized(expectedThreadId);
    const normalizedEvidence = normalized(evidence);
    if (!normalizedThreadId) throw new Error('legacy migration requires the expected thread id');
    if (!normalizedEvidence) throw new Error('legacy migration requires verification evidence');

    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    const job = findUniqueJob(jobs, requestId);
    const actualThreadId = normalized(job.codexThreadId);
    if (actualThreadId !== normalizedThreadId) {
      throw new Error(
        `legacy migration thread mismatch: expected ${normalizedThreadId}, found ${actualThreadId || 'none'}`,
      );
    }
    const currentOwner = normalized(job.codexThreadRequestId);
    if (currentOwner) {
      throw new Error(`legacy thread already has owner ${currentOwner}`);
    }

    job.codexThreadRequestId = requestId;
    job.codexThreadOwnerMigratedAt = new Date().toISOString();
    job.codexThreadOwnerEvidence = normalizedEvidence.slice(0, 500);
    if (job.status === 'recovery_required' && job.stage === 'thread_recovery_required') {
      job.status = 'queued';
      job.stage = job.recoveryFromStage || 'executing';
      job.recoveryReviewedAt = new Date().toISOString();
      job.recoveryResolution = 'verified legacy thread ownership; queued for same-request resume';
    }
    this.saveJobs(jobs);
    return job;
  }

  updateJob(requestId, patch) {
    const jobs = this.listJobs();
    assertPersistedUniqueness(jobs);
    for (const field of ['requestId', 'sourceMessageId', 'codexThreadId', 'codexThreadRequestId',
      'chatId', 'requestText', 'sourceMediaKeys',
      'canonicalSourceMessageId', 'sourceOriginVerified', 'sourceAliases', 'intakeFingerprint', 'intakeHold']) {
      if (Object.hasOwn(patch, field)) {
        throw new Error(`updateJob cannot change protected field ${field}`);
      }
    }
    const job = findUniqueJob(jobs, requestId);
    Object.assign(job, patch);
    this.saveJobs(jobs);
    return job;
  }

  markMessageSeen(messageId) {
    const state = readJson(this.seenPath, { ids: [] });
    if (state.ids.includes(messageId)) return false;
    state.ids.push(messageId);
    if (state.ids.length > 5000) state.ids = state.ids.slice(-5000);
    atomicWriteJson(this.seenPath, state);
    return true;
  }

  isMessageSeen(messageId) {
    return readJson(this.seenPath, { ids: [] }).ids.includes(messageId);
  }

  forgetMessage(messageId) {
    const state = readJson(this.seenPath, { ids: [] });
    const ids = state.ids.filter((id) => id !== messageId);
    if (ids.length === state.ids.length) return false;
    atomicWriteJson(this.seenPath, { ...state, ids });
    return true;
  }

  setRuntime(patch) {
    const current = readJson(this.runtimePath, {});
    atomicWriteJson(this.runtimePath, { ...current, ...patch, updatedAt: new Date().toISOString() });
  }

  getRuntime() {
    return readJson(this.runtimePath, {});
  }

  getPollWatermark(chatId) {
    const value = readJson(this.watermarksPath, {})[chatId];
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  setPollWatermark(chatId, value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('poll watermark must be a positive integer');
    }
    const watermarks = readJson(this.watermarksPath, {});
    watermarks[chatId] = value;
    atomicWriteJson(this.watermarksPath, watermarks);
  }

  enqueueReply(reply) {
    const items = readJson(this.outboxPath, []);
    const existing = items.find((item) => item.id === reply.id);
    if (existing) return existing;
    const item = {
      ...reply,
      status: 'pending',
      attempts: 0,
      createdAt: reply.createdAt || new Date().toISOString(),
      nextAttemptAt: null,
    };
    items.push(item);
    atomicWriteJson(this.outboxPath, compactOutbox(items));
    return item;
  }

  listPendingReplies(now = Date.now()) {
    return readJson(this.outboxPath, []).filter((item) =>
      item.status === 'pending' &&
      (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now));
  }

  recordReplyAttempt(id, { delivered, error } = {}) {
    const items = readJson(this.outboxPath, []);
    const item = items.find((entry) => entry.id === id);
    if (!item) return null;
    const now = new Date();
    item.attempts = (item.attempts || 0) + 1;
    item.lastAttemptAt = now.toISOString();
    if (delivered) {
      item.status = 'delivered';
      item.deliveredAt = now.toISOString();
      delete item.lastError;
      item.nextAttemptAt = null;
    } else {
      item.status = 'pending';
      item.lastError = String(error || 'unknown error').slice(0, 800);
      const delaySeconds = Math.min(60, 2 ** Math.min(item.attempts, 6));
      item.nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    }
    atomicWriteJson(this.outboxPath, compactOutbox(items));
    return item;
  }

  getOutboxStats() {
    const items = readJson(this.outboxPath, []);
    return {
      pending: items.filter((item) => item.status === 'pending').length,
      delivered: items.filter((item) => item.status === 'delivered').length,
    };
  }
}

function compactOutbox(items) {
  const pending = items.filter((item) => item.status === 'pending');
  const delivered = items.filter((item) => item.status === 'delivered').slice(-500);
  return [...delivered, ...pending];
}
