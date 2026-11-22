import { assertListenerReady } from '../../../config/backcheck-config.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createLocalCodex } from './codex-client.mjs';

import { bridgeRoot, config } from './config.mjs';
import { parseCommand, helpText, newRequestId } from './commands.mjs';
import { readFeishuCredential } from './credentials.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createLogger } from './log.mjs';
import {
  isThreadRecoveryError,
  runBackgroundCheck,
} from './codex-runner.mjs';
import { BridgeStore } from './store.mjs';
import { commitResearchHandoff } from './research-handoff.mjs';
import { FeishuMessagePoller } from './feishu-poller.mjs';
import { isNewDispatchMessage } from './activation-boundary.mjs';
import { applyResolvedIntake } from './dispatch-intake-effects.mjs';
import { readAcceptanceReceiptOutcome } from './receipt-readback.mjs';
import {
  canResumeDeliveryReview,
  readLatestFeishuRevision,
  verifyCompletedReports,
} from './delivery-review.mjs';
import { normalizeReplyText, sendTextReplyIdempotent } from './reply-policy.mjs';
import { ShutdownControlServer, shutdownControlPath } from './shutdown-control.mjs';
import { shutdownVisibleThreadBootstraps } from './visible-thread-bootstrap.mjs';
import { shutdownCliExecutions } from './cli-thread-execution.mjs';
import { validatePreflightCompatibility } from './preflight-model.mjs';
import { recordScopePreflightFailure } from './preflight-failure.mjs';
import { createJobQueue } from './job-queue.mjs';
import { sendFeishuPrivateText, sendUserAlertOnce } from './user-alert.mjs';
import { capturePrivateChallengeEvent } from './user-alert-inbox.mjs';
import { recordDispatchAccounting, withAccountingLock } from './accounting-ledger.mjs';
import { accountingClient } from './accounting-client.mjs';
import { createQuietFeishuClient, silentFeishuLogger } from './quiet-feishu-client.mjs';
import { redactSecrets } from './redact.mjs';
import { processAccountingReconciliation } from './accounting-reconciliation.mjs';
import { activeGroupPolicies, getGroupPolicy, acceptsGroupMessage } from './group-policy.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { createCompletionObserver } from './completion-observer.mjs';
import { defaultCodexSessionsRoot } from './desktop-native-dispatch.mjs';
import { createSpecialPricingRegistry } from './special-pricing.mjs';
import { prepareSpecialIncoming } from './special-preflight.mjs';
import { createWorkflowRuntime } from './workflow-runtime.mjs';
import { createFeishuDeliveryAdapters } from './feishu-delivery-adapters.mjs';
import { createSpecialDeliveryAdapters } from './special-delivery-adapter.mjs';

const groupPolicies = assertListenerReady();
const store = new BridgeStore(config.stateDir);
const deliveryStore = new DeliveryStore(config.stateDir);
const pricingRegistry = createSpecialPricingRegistry({ stateDir: config.stateDir });
let deliveryAdapters;
let resolveMessageRoutingReady;
const messageRoutingReady = new Promise(resolve => { resolveMessageRoutingReady = resolve; });
const completionObserver = createCompletionObserver({
  workspace: config.workspace, stateDir: config.stateDir,
  sessionsRoot: config.codexSessionsRoot || defaultCodexSessionsRoot(),
  readLatestRevision: (token) => readLatestFeishuRevision(reviewClient, token),
  verifyReports: verifyJobReports,
});
const workflow = createWorkflowRuntime({ config, groupPolicies, store, deliveryStore, pricingRegistry,
  getAdapters: () => deliveryAdapters, completionObserver });
const activationFromMs = Number(store.getRuntime().acceptNewMessagesFromMs);
const acceptanceFromMs = Number(store.getRuntime().acceptanceRepliesFromMs);
if (!Number.isSafeInteger(activationFromMs) || activationFromMs <= 0) {
  throw new Error('fresh dispatch activation baseline is required before listening');
}
const logger = createLogger(config.logDir);
const pidPath = path.join(config.stateDir, 'bridge.pid');
const instanceLockPath = path.join(config.stateDir, 'bridge.instance.lock');
let channel;
let poller;
let reviewClient;
let alertClient;
let alertAppId;
let alertQueue = Promise.resolve();
let instanceLock;
let shutdownControl;
let shuttingDown = false;
let outboxTimer;
let completionTimer;
let outboxFlushing = false;
let preflightReady = false;
let activePreflightModel = null;
async function verifyJobReports(options) {
  const job = { ...options.job, finalResponse: options.finalResponse };
  if (job.deliveryReviewMode === 'special_artifacts_v1' && job.workflowKind === 'special_research') {
    const reviewed = await deliveryAdapters.verifySpecialArtifacts({ job });
    return reviewed.receipts;
  }
  return verifyCompletedReports(options);
}
const repliesInFlight = new Set();
const runQueue = createJobQueue({
  canRun: () => !shuttingDown && preflightReady,
  nextJob: () => store.listJobs().find((job) => job.status === 'queued'),
  runJob,
});

function writePid() {
  fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf8');
}

function clearPid() {
  try {
    if (Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10) === process.pid) {
      fs.rmSync(pidPath);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('cannot clear pid file', error.message);
  }
}

function releaseInstanceOwnership() {
  if (!instanceLock) return;
  const ownedLock = instanceLock;
  instanceLock = undefined;
  clearPid();
  try {
    if (!ownedLock.release()) {
      logger.warn('instance lock was no longer owned during release');
    }
  } catch (error) {
    logger.error('cannot release instance lock', safeError(error));
  }
}

function safeError(error) {
  const messages = [];
  for (let current = error, depth = 0; current && depth < 3; depth += 1) {
    messages.push(String(current?.message || current));
    current = current?.cause;
  }
  return redactSecrets(messages.join(' | caused by: ') || 'unknown error').slice(0, 800);
}

function queueUserAlert(event, requestId = null) {
  // Alerts are best effort and serialized outside the research queue. A local
  // failure is visible in runtime state; it never replays or blocks dispatch.
  alertQueue = alertQueue.catch(() => {}).then(async () => {
    try {
      if (!alertClient || !alertAppId) throw new Error('private alert client not ready');
      const result = await sendUserAlertOnce({
        stateDir: config.stateDir,
        appId: alertAppId,
        event,
        requestId,
        send: (item) => sendFeishuPrivateText(alertClient, item),
      });
      store.setRuntime({
        lastUserAlertEvent: event,
        lastUserAlertRequestId: requestId,
        lastUserAlertStatus: result.status,
        lastUserAlertAt: new Date().toISOString(),
        lastUserAlertErrorCode: result.errorCode || null,
      });
      logger.info('private user alert attempt recorded', {
        event, requestId, status: result.status, errorCode: result.errorCode || null,
      });
    } catch (error) {
      const summary = safeError(error);
      try {
        store.setRuntime({
          lastUserAlertEvent: event,
          lastUserAlertRequestId: requestId,
          lastUserAlertStatus: 'local_failure',
          lastUserAlertAt: new Date().toISOString(),
          lastUserAlertErrorCode: 'local_failure',
        });
      } catch {}
      logger.error('private user alert failed locally', { event, requestId, error: summary });
    }
  });
}

function makeReplyId(chatId, messageId, text) {
  return crypto
    .createHash('sha256')
    .update(`${chatId}\0${messageId}\0${text}`)
    .digest('hex');
}

async function deliverReply(item) {
  if (!config.feishuGroupRepliesEnabled) return false;
  if (item.status === 'delivered') return true;
  if (repliesInFlight.has(item.id)) return false;
  repliesInFlight.add(item.id);
  try {
    await sendTextReplyIdempotent(channel, item);
    store.recordReplyAttempt(item.id, { delivered: true });
    return true;
  } catch (error) {
    const summary = safeError(error);
    store.recordReplyAttempt(item.id, { delivered: false, error: summary });
    logger.error('failed to send Feishu reply', {
      messageId: item.replyTo,
      error: summary,
    });
    return false;
  } finally {
    repliesInFlight.delete(item.id);
  }
}

async function flushOutbox() {
  if (!config.feishuGroupRepliesEnabled || !channel || outboxFlushing || shuttingDown) return;
  outboxFlushing = true;
  try {
    for (const item of store.listPendingReplies()) await deliverReply(item);
    store.setRuntime({ pendingReplies: store.getOutboxStats().pending });
  } finally {
    outboxFlushing = false;
  }
}

async function reply(chatId, messageId, text) {
  if (!config.feishuGroupRepliesEnabled) return false;
  const completeText = normalizeReplyText(text, config.maxReplyChars);
  const item = store.enqueueReply({
    id: makeReplyId(chatId, messageId, completeText),
    chatId,
    replyTo: messageId,
    text: completeText,
  });
  return deliverReply(item);
}

async function bindGroup(msg, code) {
  const pairing = store.getOrCreatePairing();
  if (code !== pairing.code) {
    await reply(msg.chatId, msg.messageId, '绑定码不正确。请向机器人维护者获取本机生成的绑定码。');
    return;
  }
  const chat = await channel.getChatInfo(msg.chatId);
  const binding = {
    chatId: msg.chatId,
    chatName: chat.name || '未命名群',
    boundBy: msg.senderId,
    boundAt: new Date().toISOString(),
    inviteUrl: config.targetGroupInviteUrl,
  };
  store.setBinding(binding);
  store.clearPairing();
  channel.updatePolicy({ groupAllowlist: [msg.chatId] });
  store.setRuntime({
    boundChatName: binding.chatName,
    boundChatId: binding.chatId,
    pairingRequired: false,
  });
  logger.info('target group bound', { chatName: binding.chatName, chatIdSuffix: msg.chatId.slice(-6) });
  await reply(
    msg.chatId,
    msg.messageId,
    `已绑定为背调派单群：${binding.chatName}\n\n${helpText()}`,
  );
}

async function routeMessage(msg) {
  const policy = getGroupPolicy(groupPolicies, msg.chatId);
  if (!acceptsGroupMessage(policy, msg)) return;
  // WebSocket callbacks may arrive while connect() is resolving. Do not let a
  // delivery event reach its identity check until the real adapters exist.
  await messageRoutingReady;
  const extension = await workflow.routeExtension(msg);
  if (extension.handled) {
    if (extension.status === 'queued') void runQueue();
    if (extension.status === 'held') logger.warn('configured workflow held', { messageId: msg.messageId, reason: extension.reason });
    return;
  }
  const binding = store.getBinding();
  if (!binding && !msg.mentionedBot) return;
  if (store.getJobBySourceMessageId(msg.messageId)) return;
  const alreadySeen = store.isMessageSeen(msg.messageId);

  try {
    const command = parseCommand(msg.content, config.maxRequestChars);
    if (alreadySeen && command.kind !== 'request') return;

    if (!binding) {
      store.markMessageSeen(msg.messageId);
      if (command.kind === 'pair') {
        await bindGroup(msg, command.code);
      } else {
        await reply(msg.chatId, msg.messageId, '机器人尚未绑定目标群，请先由维护者完成绑定。');
      }
      return;
    }

    if (command.kind === 'unknown' || command.kind === 'ignore') {
      store.markMessageSeen(msg.messageId);
      return;
    }
    if (command.kind === 'help') {
      store.markMessageSeen(msg.messageId);
      logger.info('help command ignored in bound dispatch group', { messageId: msg.messageId });
      return;
    }
    if (command.kind === 'invalid') {
      store.markMessageSeen(msg.messageId);
      logger.warn('invalid command ignored in bound dispatch group', {
        messageId: msg.messageId,
        reason: command.reason,
      });
      return;
    }
    if (command.kind === 'pair') {
      store.markMessageSeen(msg.messageId);
      logger.info('pair command ignored in bound dispatch group', { messageId: msg.messageId });
      return;
    }
    if (command.kind === 'status') {
      store.markMessageSeen(msg.messageId);
      logger.info('status command ignored in bound dispatch group', {
        messageId: msg.messageId,
        requestId: command.requestId,
      });
      return;
    }
    if (command.kind !== 'request') {
      store.markMessageSeen(msg.messageId);
      return;
    }

    const requestId = newRequestId();
    const job = {
      requestId,
      status: 'queued',
      requestText: command.body,
      senderId: msg.senderId,
      chatId: msg.chatId,
      sourceMessageId: msg.messageId,
      sourceMessageCreatedAtMs: Number(msg.createTime),
      scopeOnly: Boolean(command.scopeOnly),
      deliveryKind: 'regular',
      createdAt: new Date().toISOString(),
      codexThreadId: null,
      codexThreadRequestId: requestId,
    };
    const acceptance = store.addJobForMessage(msg.messageId, job);
    if (!acceptance.job) return;
    const acceptedJob = acceptance.job;
    if (acceptance.held) {
      logger.warn('cross-group intake held for source review', { requestId: acceptedJob.requestId });
      return;
    }
    if (acceptance.added) {
      logger.info('background-check request queued', { requestId: acceptedJob.requestId });
    }
    void runQueue();
  } catch (error) {
    const durableJob = store.getJobBySourceMessageId(msg.messageId);
    if (!durableJob) store.forgetMessage(msg.messageId);
    throw error;
  }
}

async function runJob(job) {
  const startedAt = new Date().toISOString();

  try {
    const initialCheckpoint = store.getJob(job.requestId);
    if (['paused', 'handed_off', 'completed', 'transferred', 'cancelled'].includes(initialCheckpoint?.status) ||
        initialCheckpoint?.handoffEvidence) return;
    const policy = getGroupPolicy(groupPolicies, job.chatId);
    if (!policy?.researchEnabled || !acceptsGroupMessage(policy, {
      chatId: job.chatId, createTime: job.sourceMessageCreatedAtMs,
    })) {
      store.updateJob(job.requestId, { status: 'intake_held', stage: 'group_policy_hold' });
      return;
    }
    if (job.workflowKind === 'special_research' && !job.specialIntake) {
      if (initialCheckpoint?.stage === 'verifying_delivery') {
        const missing = new Error('special review checkpoint has no original intake evidence');
        missing.code = 'review_evidence_invalid'; missing.reviewStatus = 'BLOCKED';
        throw missing;
      }
      store.updateJob(job.requestId, { stage: 'special_preflight' });
      const prepared = await prepareSpecialIncoming({ message: job.sourceMessage,
        groupPolicy: policy, stateDir: config.stateDir, client: reviewClient,
        createCodex: createLocalCodex, preflightModel: activePreflightModel });
      if (prepared.status !== 'ready') {
        store.updateJob(job.requestId, { status: 'intake_held', stage: 'special_intake_hold',
          specialIntakeReasons: prepared.reasons });
        return;
      }
      // Derived text and hashed attachment keys remain in specialIntake;
      // the original request identity and intake fingerprint stay immutable.
      store.updateJob(job.requestId, { specialIntake: prepared.specialIntake || prepared,
        specialOwnership: prepared.specialOwnership,
        pricingStatus: prepared.pricing?.status || 'pending_pricing',
        preflightModelUsed: prepared.preflightModelUsed });
      job = store.getJob(job.requestId);
    }
    const checkpoint = store.getJob(job.requestId);
    const reviewOnly = checkpoint?.stage === 'verifying_delivery';
    const executionJob = reviewOnly
      ? store.prepareDeliveryReview(job.requestId, { workspace: config.workspace })
      : store.prepareExecutionJob(job.requestId);
    const resumingReview = reviewOnly && canResumeDeliveryReview(executionJob);
    if (executionJob.stage === 'verifying_delivery' && !resumingReview) {
      throw new Error('delivery review checkpoint has incomplete thread ownership or report evidence');
    }
    if (resumingReview) {
      store.updateJob(job.requestId, {
        status: 'running', stage: 'verifying_delivery',
        reviewStatus: 'RUNNING', reviewInputFingerprint: executionJob.reviewInputFingerprint,
      });
      logger.info('background-check delivery review resumed', { requestId: job.requestId });
    } else {
      store.updateJob(job.requestId, { status: 'running', stage: 'scope_preflight', startedAt });
      logger.info('background-check request preflight started', { requestId: job.requestId });
    }
    const result = resumingReview ? {
      finalResponse: executionJob.finalResponse,
      dispatchScope: executionJob.dispatchScope,
      threadId: executionJob.codexThreadId,
      usage: executionJob.usage,
      skipped: false,
      testOnly: false,
    } : await runBackgroundCheck(executionJob, {
      ...config,
      groupPolicies,
      codexPreflightModel: activePreflightModel,
    }, {
      async onScopeResolved(scope, metadata) {
        return applyResolvedIntake({ job, scope, metadata, policy, store, pricingRegistry,
          logger, safeError, acceptanceFromMs, maxChars: config.maxReplyChars,
          recordAccounting: ({ job: resolvedJob, scope: resolvedScope }) => recordDispatchAccounting({
            client: accountingClient(reviewClient, alertAppId), stateDir: config.stateDir,
            job: resolvedJob, scope: resolvedScope,
          }),
          send: item => sendTextReplyIdempotent(channel, item),
          readback: (item, options) => readAcceptanceReceiptOutcome(channel, item, { ...options, botAppId: alertAppId }),
          onReceiptUncertain: requestId => queueUserAlert('receipt_uncertain', requestId),
        });
      },
      onExecutionStarting(_scope, metadata) {
        store.updateJob(job.requestId, {
          stage: metadata.creationMode === 'desktop_native_handoff_v1'
            ? 'handoff_verifying' : 'executing',
          codexThreadTitle: metadata.threadTitle,
          ...(metadata.creationMode === 'cli_visible_v1' ? {
            codexCliAttemptStartedAt: new Date().toISOString(),
            codexCliAttemptThreadId: metadata.threadId,
          } : {}),
        });
      },
      onThreadBootstrapStarting(_scope, metadata) {
        store.updateJob(job.requestId, {
          stage: 'thread_bootstrapping',
          codexThreadTitle: metadata.threadTitle,
          codexThreadBootstrapStartedAt: new Date().toISOString(),
          codexThreadCreationMode: metadata.creationMode,
          codexNativeDispatchMarker: metadata.marker,
          codexNativeInstructionPath: metadata.instructionPath,
          codexNativeInstructionSha256: metadata.instructionSha256,
        });
      },
      onThreadBootstrapped(threadId, metadata) {
        store.bindExecutionThread(job.requestId, threadId, {
          title: metadata.threadTitle,
        });
        store.updateJob(job.requestId, {
          codexThreadSource: metadata.source,
          codexThreadOriginator: metadata.originator,
          codexThreadSourceKind: metadata.threadSource,
          codexThreadCreationMode: metadata.creationMode,
          codexNativeDispatchMarker: metadata.marker,
          codexNativeSessionPath: metadata.sessionPath,
          codexCliSessionPath: metadata.creationMode === 'cli_visible_v1' ? metadata.sessionPath : undefined,
          codexThreadBootstrappedAt: new Date().toISOString(),
        });
      },
      onResearchStarted(_scope, evidence) {
        commitResearchHandoff(store, job.requestId, evidence);
      },
    });
    if (result.threadId) {
      store.bindExecutionThread(job.requestId, result.threadId, {
        title: result.threadTitle,
      });
    }
    if (result.handedOff) {
      if (result.deliveryReviewMode) store.updateJob(job.requestId, {
        deliveryReviewMode: result.deliveryReviewMode, deliveryReviewStatus: result.deliveryReviewStatus,
      });
      if (result.deliveryEligible === false) store.updateJob(job.requestId, {
        deliveryEligible: false, deliveryReviewStatus: result.deliveryReviewStatus,
        remainingDeliveryGate: result.remainingDeliveryGate,
      });
      const persisted = store.getJob(job.requestId);
      if (persisted?.status !== 'handed_off' ||
          persisted?.codexThreadId !== result.threadId ||
          persisted?.handoffEvidence?.callId !== result.handoffEvidence?.callId) {
        throw new Error('research handoff was not durably recorded');
      }
      logger.info('Codex Desktop research started and ownership handed off', {
        requestId: job.requestId,
        threadId: result.threadId,
        researchTool: result.handoffEvidence.researchTool,
      });
      return;
    }
    let reviewReceipts = [];
    if (result.deliveryEligible === false) {
      store.updateJob(job.requestId, { status: 'review_pending', stage: 'special_artifact_review_pending',
        finalResponse: result.finalResponse, dispatchScope: result.dispatchScope,
        deliveryReviewStatus: result.deliveryReviewStatus });
      return;
    }
    if (!result.testOnly && !result.skipped) {
      store.updateJob(job.requestId, {
        stage: 'verifying_delivery',
        finalResponse: result.finalResponse,
        dispatchScope: result.dispatchScope,
      });
      if (result.deliveryReviewMode) store.updateJob(job.requestId, { deliveryReviewMode: result.deliveryReviewMode });
      const persistedReview = store.getJob(job.requestId);
      // Each delivery mode retains its original validator and input format.
      const reviewCheckpoint = store.prepareDeliveryReview(job.requestId, { workspace: config.workspace });
      const reviewBinding = value => JSON.stringify({ requestId: value.requestId,
        codexThreadId: value.codexThreadId, codexThreadRequestId: value.codexThreadRequestId,
        finalResponse: value.finalResponse, dispatchScope: value.dispatchScope,
        deliveryReviewMode: value.deliveryReviewMode, specialOwnership: value.specialOwnership,
        workflowKind: value.workflowKind, scopeVersion: value.scopeVersion });
      store.updateJob(job.requestId, {
        reviewStatus: 'RUNNING',
        reviewInputFingerprint: reviewCheckpoint.reviewInputFingerprint,
      });
      reviewReceipts = await verifyJobReports({
        job: persistedReview,
        requestId: job.requestId,
        finalResponse: result.finalResponse,
        stateDir: config.stateDir,
        workspace: config.workspace,
        readLatestRevision: (token) => readLatestFeishuRevision(reviewClient, token),
      });
      // A pause, ownership update, or evidence edit during asynchronous review
      // must not be overwritten by a stale PASS.
      const currentReview = store.prepareDeliveryReview(job.requestId, { workspace: config.workspace });
      if (currentReview.status !== 'running' || currentReview.stage !== 'verifying_delivery' ||
          currentReview.intakeHold || currentReview.duplicateOfRequestId ||
          reviewBinding(currentReview) !== reviewBinding(reviewCheckpoint) ||
          currentReview.reviewInputFingerprint !== reviewCheckpoint.reviewInputFingerprint) {
        const changed = new Error('delivery review checkpoint changed during verification');
        changed.code = 'review_checkpoint_changed';
        changed.reviewStatus = 'BLOCKED';
        throw changed;
      }
    }
    const completedAt = new Date().toISOString();
    store.updateJob(job.requestId, {
      status: 'completed',
      stage: result.testOnly ? 'scope_test_complete' : result.skipped ? 'scope_complete' : 'completed',
      completedAt,
      dispatchScope: result.dispatchScope,
      finalResponse: result.finalResponse,
      usage: result.usage,
      reviewReceipts,
      reviewStatus: reviewReceipts.length ? 'PASS' : null,
      reviewErrorCode: null, errorSummary: null,
    });
    logger.info('background-check request completed', {
      requestId: job.requestId,
      skipped: result.skipped,
    });
    try { await workflow.onCompleted(store.getJob(job.requestId)); }
    catch (error) { logger.error('completed research delivery held', { requestId: job.requestId, error: safeError(error) }); }
  } catch (error) {
    const errorSummary = safeError(error);
    const persistedJob = store.getJob(job.requestId);
    if (['paused', 'handed_off', 'completed', 'transferred', 'cancelled'].includes(persistedJob?.status) ||
        persistedJob?.handoffEvidence) {
      logger.warn('bridge review cannot change a paused, handed-off, or terminal job', {
        requestId: job.requestId,
      });
      return;
    }
    if (persistedJob?.stage === 'verifying_delivery' &&
        !persistedJob.handoffEvidence &&
        persistedJob.codexThreadCreationMode !== 'desktop_native_handoff_v1') {
      const reviewFailure = {
        status: error.reviewStatus || error.verdict || 'ERROR', code: error.code || 'delivery_review_failed',
        inputFingerprint: persistedJob.reviewInputFingerprint || null,
        failedAt: new Date().toISOString(), errorSummary,
      };
      store.updateJob(job.requestId, {
        status: 'review_pending', stage: 'verifying_delivery', completedAt: null,
        reviewStatus: reviewFailure.status, reviewErrorCode: reviewFailure.code,
        reviewLastFailure: reviewFailure, errorSummary,
      });
      logger.error('delivery review requires evidence or an explicit retry; research was not restarted', {
        requestId: job.requestId, code: reviewFailure.code,
      });
      return;
    }
    if (['thread_bootstrapping', 'handoff_verifying'].includes(persistedJob?.stage) ||
        isThreadRecoveryError(error)) {
      store.markThreadRecoveryRequired(job.requestId, {
        reason: errorSummary,
        fromStage: persistedJob?.stage,
      });
      logger.error('background-check thread requires local recovery review', {
        requestId: job.requestId,
        error: errorSummary,
      });
      if (['scope_preflight', 'scope_resolved', 'thread_bootstrapping', 'handoff_verifying', 'executing']
        .includes(persistedJob?.stage)) queueUserAlert('handoff_review', job.requestId);
    } else {
      const preflightFailure = persistedJob?.stage === 'scope_preflight';
      if (preflightFailure) {
        const failure = recordScopePreflightFailure({
          store, requestId: job.requestId, error, errorSummary,
        });
        if (failure.blocksQueue) preflightReady = false;
      } else {
        store.updateJob(job.requestId, {
          status: 'failed', stage: 'failed',
          completedAt: new Date().toISOString(), errorSummary,
        });
      }
      logger.error('background-check request failed', { requestId: job.requestId, error: errorSummary });
      if (['scope_preflight', 'scope_resolved', 'thread_bootstrapping', 'handoff_verifying', 'executing']
        .includes(persistedJob?.stage)) {
        queueUserAlert(preflightFailure ? 'preflight_failed' : 'startup_failed', job.requestId);
      }
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('bridge shutting down', { signal });
  try {
    store.setRuntime({ state: 'stopping', signal });
    poller?.stop();
    if (outboxTimer) clearInterval(outboxTimer);
    if (completionTimer) clearInterval(completionTimer);
    await shutdownVisibleThreadBootstraps(signal);
    shutdownCliExecutions();
    await shutdownControl?.close();
    await channel?.disconnect();
  } catch (error) {
    logger.error('bridge shutdown failed', safeError(error));
  } finally {
    releaseInstanceOwnership();
    process.exit(0);
  }
}

async function main() {
  if (config.codexDispatchMode !== 'desktop_native_handoff_v1') {
    throw new Error('dispatch bridge requires desktop_native_handoff_v1 for new requests');
  }
  instanceLock = acquireInstanceLock(instanceLockPath, {
    legacyPidPath: pidPath,
    entryPath: path.join(bridgeRoot, 'src', 'bridge.mjs'),
  });
  writePid();
  shutdownControl = new ShutdownControlServer({
    pipePath: shutdownControlPath(bridgeRoot),
    pid: process.pid,
    token: instanceLock.token,
    onShutdown: shutdown,
    logger,
  });
  await shutdownControl.start();
  const recoveredJobs = store.recoverInterruptedJobs();
  const recoveryRequired = recoveredJobs.filter((job) => job.status === 'recovery_required');
  if (recoveryRequired.length > 0) {
    logger.error('jobs require local recovery review before execution', {
      requestIds: recoveryRequired.map((job) => job.requestId),
    });
  }
  const pairing = store.getBinding() ? null : store.getOrCreatePairing();
  const credential = await readFeishuCredential(config.credentialReader);
  const binding = store.getBinding();

  channel = Lark.createLarkChannel({
    appId: credential.appId,
    appSecret: credential.appSecret,
    transport: 'websocket',
    loggerLevel: Lark.LoggerLevel.warn,
    logger: silentFeishuLogger,
    source: 'codex-background-check-bridge',
    policy: {
      groupAllowlist: activeGroupPolicies(groupPolicies).map(policy => policy.chatId),
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    safety: {
      dedup: { ttl: 24 * 60 * 60 * 1000, maxEntries: 5000 },
      chatQueue: { enabled: true },
      staleMessageWindowMs: 10 * 60 * 1000,
    },
    outbound: {
      textChunkLimit: config.maxReplyChars,
      retry: { maxAttempts: 3, baseDelayMs: 700 },
      allowedFileDirs: [config.workspace],
    },
  });

  channel.on({
    message(msg) {
      if (msg.chatType === 'p2p') {
        // Receive only a fresh, exact owner-binding challenge. All other DMs
        // remain silent and never enter the dispatch or reply pipeline.
        try {
          const result = capturePrivateChallengeEvent({
            stateDir: config.stateDir,
            appId: credential.appId,
            message: msg,
          });
          if (['captured', 'conflict'].includes(result.status)) {
            logger.info('private alert challenge event recorded', { status: result.status });
          }
        } catch (error) {
          logger.error('private alert challenge event failed', safeError(error));
        }
        return;
      }
      void routeMessage(msg).catch((error) => {
        logger.error('message handler failed', {
          messageId: msg.messageId,
          error: safeError(error),
        });
      });
    },
    error(error) {
      logger.error('Feishu channel error', safeError(error));
    },
    reconnecting() {
      logger.warn('Feishu WebSocket reconnecting');
      store.setRuntime({ state: 'reconnecting' });
    },
    reconnected() {
      logger.info('Feishu WebSocket reconnected');
      store.setRuntime({ state: 'connected' });
    },
  });

  await channel.connect();
  const pollingClient = createQuietFeishuClient(credential);
  reviewClient = pollingClient;
  alertClient = pollingClient;
  alertAppId = credential.appId;
  const baseDeliveryAdapters = createFeishuDeliveryAdapters({ appClient: pollingClient, appId: credential.appId,
    config: config.delivery, deliveryStore, stateDir: config.stateDir, workspace: config.workspace,
    botOpenId: channel.botIdentity?.openId, reviewModel: () => activePreflightModel });
  deliveryAdapters = createSpecialDeliveryAdapters({ baseAdapters: baseDeliveryAdapters, appClient: pollingClient,
    appId: credential.appId, config, deliveryStore, stateDir: config.stateDir, workspace: config.workspace,
    botOpenId: channel.botIdentity?.openId, dependencies: { getReviewModel: () => activePreflightModel } });
  resolveMessageRoutingReady();
  credential.appSecret = undefined;
  try {
    const accounting = await withAccountingLock(config.stateDir, () => processAccountingReconciliation({
      client: accountingClient(reviewClient, alertAppId), stateDir: config.stateDir,
    }));
    if (accounting) {
      store.setRuntime({ lastAccountingReconciliationAt: new Date().toISOString(),
        lastAccountingReconciliationStatus: accounting.status,
        accountingReconciliationPid: process.pid });
      logger.info('authorized billing reconciliation completed', {
        added: accounting.added, moved: accounting.moved,
        removedDuplicates: accounting.removedDuplicates,
      });
    }
  } catch (error) {
    store.setRuntime({ lastAccountingReconciliationStatus: 'blocked',
      operatorAttentionRequired: true });
    logger.error('authorized billing reconciliation blocked', safeError(error));
  }
  const botName = channel.botIdentity?.name || 'unknown';
  poller = new FeishuMessagePoller({
    client: pollingClient,
    botIdentity: channel.botIdentity,
    getBinding: () => store.getBinding(),
    getPolicies: () => groupPolicies,
    onMessage: routeMessage,
    logger,
    intervalMs: config.pollIntervalSeconds * 1000,
    lookbackMs: config.pollLookbackMinutes * 60 * 1000,
    formatError: safeError,
    onHealth: (patch) => store.setRuntime(patch),
    getWatermark: (chatId) => store.getPollWatermark(chatId),
    setWatermark: (chatId, value) => store.setPollWatermark(chatId, value),
  });
  store.setRuntime({
    state: 'connected',
    pid: process.pid,
    botName,
    boundChatName: binding?.chatName || null,
    activeGroups: activeGroupPolicies(groupPolicies).map(({ chatId, role }) => ({ chatId, role })),
    pairingRequired: !binding,
    pollingState: 'active',
    groupRepliesEnabled: config.feishuGroupRepliesEnabled,
    acceptanceRepliesEnabled: config.feishuAcceptanceRepliesEnabled,
    acceptanceRepliesFromMs: acceptanceFromMs,
    acceptNewMessagesFromMs: activationFromMs,
    pollIntervalSeconds: config.pollIntervalSeconds,
    pollLookbackMinutes: config.pollLookbackMinutes,
    pendingReplies: store.getOutboxStats().pending,
    recoveryRequiredJobs: recoveryRequired.length,
  });
  logger.info('bridge connected', {
    botName,
    boundChatName: binding?.chatName || null,
    pairingRequired: !binding,
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
  if (pairing) logger.info('pairing code ready', { pairingCode: pairing.code });
  outboxTimer = setInterval(() => void flushOutbox(), 5000);
  outboxTimer.unref?.();
  void flushOutbox();
  poller.start();
  completionTimer = setInterval(() => {
    if (!shuttingDown && preflightReady) void workflow.observeCompletions().catch(error =>
      logger.error('completion observation failed', safeError(error)));
  }, 30000);
  completionTimer.unref?.();
  store.setRuntime({ preflightStatus: 'checking', preflightCheckedAt: new Date().toISOString() });
  try {
    const check = await validatePreflightCompatibility({
      config,
      createCodex: () => createLocalCodex(),
    });
    activePreflightModel = check.model;
    preflightReady = true;
    store.setRuntime({
      preflightStatus: 'ready',
      preflightModel: check.model,
      preflightCheckedAt: check.validatedAt,
      preflightError: null,
    });
    logger.info('structured dispatch preflight ready', { model: check.model });
    void workflow.retryPendingDeliveries().catch(error => logger.error('pending delivery held', safeError(error)));
    void runQueue();
  } catch (error) {
    const summary = safeError(error);
    store.setRuntime({
      preflightStatus: 'blocked',
      preflightCheckedAt: new Date().toISOString(),
      preflightError: summary,
      operatorAttentionRequired: true,
    });
    logger.error('structured dispatch preflight blocked; queued requests retained', summary);
    queueUserAlert('startup_blocked');
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', safeError(error));
  try {
    if (instanceLock) store.setRuntime({ state: 'failed', error: safeError(error) });
  } catch (stateError) {
    logger.error('cannot persist failed runtime state', safeError(stateError));
  } finally {
    void shutdownControl?.close();
    releaseInstanceOwnership();
    process.exit(1);
  }
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled rejection', safeError(error));
});

main().catch(async (error) => {
  logger.error('bridge startup failed', safeError(error));
  shuttingDown = true;
  try {
    if (instanceLock) store.setRuntime({ state: 'failed', error: safeError(error) });
  } catch (stateError) {
    logger.error('cannot persist failed runtime state', safeError(stateError));
  }
  try {
    poller?.stop();
    if (outboxTimer) clearInterval(outboxTimer);
    if (completionTimer) clearInterval(completionTimer);
    await shutdownControl?.close();
    await channel?.disconnect();
  } catch (shutdownError) {
    logger.error('startup cleanup failed', safeError(shutdownError));
  } finally {
    releaseInstanceOwnership();
    process.exitCode = 1;
  }
});

process.on('exit', () => releaseInstanceOwnership());
