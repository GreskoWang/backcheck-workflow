import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSpecialPricingRegistry } from './special-pricing.mjs';
import { accountingMonth, bindAccountingState, ensureMonthlySheet, insertBeforeTotal,
  parseAccountingFormula, readSheet, specialAccountingTotalFormula, withAccountingLock,
  writeAccountingCellOnce } from './accounting-ledger.mjs';

const SPECIAL_CHAT = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
const OWNER = '\u738b\u4e66\u9cb2';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value);
const fail = message => { throw new Error(message); };

export function assertSpecialAccountingOrder({ order, job, policy, requireScope = false }) {
  if (policy?.enabled !== true || !policy.authorization ||
      !Number.isSafeInteger(policy.activationFromMs) || policy.activationFromMs <= 0) fail('special accounting is disabled or its activation is unapproved');
  if (order?.owner !== OWNER || order.chatId !== SPECIAL_CHAT ||
      job?.requestId !== order.requestId || job.sourceMessageId !== order.sourceMessageId ||
      job.chatId !== order.chatId || job.workflowKind !== 'special_research' || job.deliveryKind !== 'special' ||
      job.intakeHold || job.duplicateOfRequestId || job.scopeOnly ||
      !Number.isSafeInteger(job.sourceMessageCreatedAtMs) || job.sourceMessageCreatedAtMs < policy.activationFromMs ||
      job.specialOwnership?.verified !== true || job.specialOwnership.sourceChatId !== job.chatId ||
      job.specialOwnership.sourceMessageId !== job.sourceMessageId ||
      policy.defaultOwner?.name !== OWNER || !policy.defaultOwner?.id || !policy.defaultOwner?.authorizationRef ||
      job.specialOwnership.ownerId !== policy.defaultOwner.id ||
      job.specialOwnership.authorization !== policy.defaultOwner.authorizationRef) {
    fail('special price confirmation does not match an authorized new order and default owner');
  }
  if (requireScope && (job.dispatchScope?.requestMode !== 'special_dispatch' ||
      job.dispatchScope.decision !== 'execute' || !job.dispatchScope.assignments?.length ||
      ['intake_held', 'failed', 'recovery_required', 'paused'].includes(job.status))) {
    fail('special accounting requires a verified executable special order');
  }
  if (requireScope && order.status === 'price_confirmed') {
    const provenance = order.pricing?.provenance;
    if (provenance?.kind !== 'operator_instruction' || !/^[a-f0-9]{64}$/u.test(provenance.evidenceSha256 || '') ||
        !path.isAbsolute(provenance.evidencePath || '') ||
        fs.statSync(provenance.evidencePath).size > 256 * 1024 ||
        hash(fs.readFileSync(provenance.evidencePath)) !== provenance.evidenceSha256) {
      fail('special accounting requires its intact operator-bound human confirmation artifact');
    }
  }
}

/** A command operator supplies the digest of an authenticated human message
 * artifact. Incoming Feishu messages are never confirmation inputs. */
export function readSpecialPriceInstruction({ evidenceFile, evidenceSha256, order, amount, currency = 'CNY' }) {
  if (!path.isAbsolute(evidenceFile || '') || !/^[a-f0-9]{64}$/u.test(evidenceSha256 || '')) fail('exact evidence file and operator-bound SHA256 are required');
  const fd = fs.openSync(evidenceFile, 'r');
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) fail('human confirmation evidence must be a bounded regular file');
    bytes = Buffer.alloc(stat.size + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    bytes = bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
  if (hash(bytes) !== evidenceSha256) fail('human confirmation evidence changed');
  const evidence = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  const target = evidence.target;
  if (evidence.version !== 1 || evidence.source !== 'authenticated_human_instruction' || evidence.role !== 'user' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(evidence.instructionId || '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(evidence.sourceThreadId || '') ||
      typeof evidence.text !== 'string' || !evidence.text.trim() || evidence.text.length > 64000 ||
      target?.orderId !== order.orderId || target.requestId !== order.requestId ||
      target.sourceMessageId !== order.sourceMessageId || target.chatId !== order.chatId ||
      String(evidence.price?.amount) !== String(amount) || evidence.price?.currency !== currency || currency !== 'CNY') {
    fail('human confirmation evidence is not bound to this exact order and amount');
  }
  return { confirmationId: `human-${evidenceSha256}`, decision: 'confirm_special_price', kind: 'operator_instruction',
    target, price: { amount: String(amount), currency }, provenance: {
      source: 'authenticated_human_instruction', instructionId: evidence.instructionId,
      sourceThreadId: evidence.sourceThreadId, evidenceSha256 } };
}

export async function confirmSpecialPriceInstruction({ stateDir, orderId, job, policy,
  evidenceFile, evidenceSha256, amount, currency = 'CNY', checkOnly = false }) {
  const order = createSpecialPricingRegistry({ stateDir }).getOrder(orderId);
  assertSpecialAccountingOrder({ order, job, policy });
  const instruction = readSpecialPriceInstruction({ evidenceFile, evidenceSha256, order, amount, currency });
  if (checkOnly) {
    // Exercise the same exact currency validation without mutating a registry.
    if (!/^[1-9]\d{0,7}(?:\.\d{1,2})?$/u.test(String(amount))) fail('confirmed special price must be positive exact CNY');
    return { status: 'confirmation_checked', orderId, requestId: job.requestId, currency, amount: String(amount), evidenceSha256 };
  }
  const evidenceDirectory = path.join(stateDir, 'special-price-evidence');
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const savedEvidence = path.join(evidenceDirectory, `${evidenceSha256}.json`);
  try { fs.copyFileSync(evidenceFile, savedEvidence, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fs.statSync(savedEvidence).size > 256 * 1024 || hash(fs.readFileSync(savedEvidence)) !== evidenceSha256) fail('saved human evidence artifact is incomplete or changed');
  instruction.provenance.evidencePath = savedEvidence;
  const registry = createSpecialPricingRegistry({ stateDir,
    confirmationAuthority: { operatorInstructionIds: [instruction.provenance.instructionId] },
    resolveTrustedConfirmation: async id => id === instruction.confirmationId ? instruction : null });
  return registry.confirmPrice({ orderId, confirmationId: instruction.confirmationId });
}

function readLedger(stateDir) {
  try {
    const filename = path.join(stateDir, 'accounting-ledger.json');
    if (fs.statSync(filename).size > 16 * 1024 * 1024) fail('accounting ledger exceeds its bounded size');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) fail('accounting ledger entries are invalid');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw error; }
}

function updateEntry(stateDir, key, patch) {
  const ledger = readLedger(stateDir);
  ledger.entries[key] = { ...ledger.entries[key], ...patch };
  const filename = path.join(stateDir, 'accounting-ledger.json');
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  return ledger.entries[key];
}

function labelFor(order, job) {
  const subjects = job.dispatchScope.assignments.map(item => String(item.subject || '').trim());
  if (subjects.some(value => !value)) fail('special accounting subject is missing');
  const summary = [...new Set(subjects)].join(' / ').replace(/["\r\n\t]/gu, ' ').replace(/\s+/gu, ' ').slice(0, 120);
  return `${order.orderId} | CNY ${order.pricing.amount} | ${summary}`;
}

/** Records exactly one confirmed price per canonical special order. Replays
 * reconcile attempted mutations through reads and never resend an uncertain
 * formula, insertion or charge. No historical order discovery is performed. */
export async function recordConfirmedSpecialAccounting({ client, stateDir, orderId, job, policy,
  readCurrentJob = () => job, now = () => new Date() }) {
  return withAccountingLock(stateDir, async () => {
    const order = createSpecialPricingRegistry({ stateDir }).getOrder(orderId);
    assertSpecialAccountingOrder({ order, job, policy, requireScope: true });
    if (order.status !== 'price_confirmed') return { status: order.status, recorded: 0, pricingBlocksResearch: false };
    bindAccountingState(client, stateDir);
    const title = accountingMonth(job.sourceMessageCreatedAtMs);
    const sheetId = await ensureMonthlySheet(client, title, stateDir);
    const key = `special:${order.orderId}`;
    const cellText = labelFor(order, job);
    let entry = readLedger(stateDir).entries[key];
    if (entry && (entry.category !== 'special_confirmed' || entry.specialOrderId !== order.orderId ||
        entry.amountMinor !== order.pricing.amountMinor || entry.confirmationId !== order.pricing.confirmationId ||
        entry.cellText !== cellText || entry.sheetId !== sheetId || entry.requestId !== job.requestId ||
        entry.sourceMessageId !== job.sourceMessageId || entry.chatId !== job.chatId)) fail('special accounting order or confirmed amount conflicts with its existing intent');
    if (entry?.status === 'conflict') return { status: 'held', reason: 'sheet_changed_during_accounting', orderId, recorded: 0 };
    if (!entry) entry = updateEntry(stateDir, key, { status: 'planned', category: 'special_confirmed',
      specialOrderId: order.orderId, requestId: job.requestId, sourceMessageId: job.sourceMessageId,
      chatId: job.chatId, sourceMessageCreatedAtMs: job.sourceMessageCreatedAtMs,
      sourceDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(job.sourceMessageCreatedAtMs)),
      sheetId, sheetTitle: title, column: 'B', subject: cellText, cellText,
      amountMinor: order.pricing.amountMinor, currency: 'CNY', confirmationId: order.pricing.confirmationId,
      confirmedProvenance: order.pricing.provenance, pricingConfirmedAt: order.pricing.confirmedAt,
      authorization: policy.authorization, activationFromMs: policy.activationFromMs });
    let snapshot = await readSheet(client, sheetId);
    const uncertain = phase => {
      updateEntry(stateDir, key, { status: 'outcome_uncertain', uncertainPhase: phase });
      return { status: 'outcome_uncertain', recorded: 0, orderId, phase, pricingStatus: 'price_confirmed' };
    };
    const mutationFailure = (error, phase) => {
      if (error?.code !== 'SPECIAL_ACCOUNTING_CONFLICT') return uncertain(phase);
      updateEntry(stateDir, key, { status: 'conflict', conflictPhase: phase, conflictObservedAt: now().toISOString() });
      return { status: 'held', reason: 'sheet_changed_during_accounting', orderId, recorded: 0 };
    };
    let parts = parseAccountingFormula(snapshot.rows[snapshot.totalIndex][1], 'B', snapshot.totalIndex, snapshot.formulaOptions);
    if (!parts || parts.rate !== 600) fail('special column requires its reviewed base-600 formula');
    const matching = snapshot.rows.slice(1, snapshot.totalIndex).flatMap((values, index) => values?.[1] === cellText ? [index + 2] : []);
    if (matching.length > 1) fail('special order has duplicate existing accounting rows');
    let term = (parts.specialAdjustments || []).find(item => item.orderId === orderId);
    if (matching.length) {
      if (!entry.itemAttempt || term?.row !== matching[0]) fail('existing special row is not attributable to this recorded write intent');
      updateEntry(stateDir, key, { status: 'recorded', cell: `B${matching[0]}`, verifiedAt: now().toISOString(), uncertainPhase: null });
      return { status: 'recorded', recorded: 1, orderId, sheetId, cell: `B${matching[0]}`, amountMinor: order.pricing.amountMinor, replay: true };
    }
    if (entry.itemAttempt) return uncertain('item');
    if (entry.formulaAttempt && !term) return uncertain('formula');
    if (entry.insertAttempt && !entry.cell && !entry.formulaAttempt) {
      const attempt = entry.insertAttempt;
      if (snapshot.totalIndex !== attempt.beforeTotalIndex + 1 ||
          hash(stable(snapshot.rows.slice(0, attempt.beforeTotalIndex))) !== attempt.beforeDataSha256 ||
          snapshot.rows[attempt.beforeTotalIndex]?.some(value => value != null && value !== '')) return uncertain('insert');
      entry = updateEntry(stateDir, key, { cell: `B${snapshot.totalIndex}` });
    }
    const reserved = new Set(Object.values(readLedger(stateDir).entries).filter(item => item.sheetId === sheetId &&
      item.category === 'special_confirmed' && item.specialOrderId !== orderId && item.status !== 'recorded').map(item => item.cell));
    let row = term?.row || (entry.cell ? Number(entry.cell.slice(1)) :
      snapshot.rows.slice(1, snapshot.totalIndex).findIndex((values, index) =>
        (values?.[1] == null || values[1] === '') && !reserved.has(`B${index + 2}`)) + 2);
    if (row === 1) {
      if (entry.insertAttempt) {
        if (snapshot.totalIndex !== entry.insertAttempt.beforeTotalIndex + 1) return uncertain('insert');
        row = snapshot.totalIndex;
      } else {
        const attempt = { beforeTotalIndex: snapshot.totalIndex,
          beforeDataSha256: hash(stable(snapshot.rows.slice(0, snapshot.totalIndex))), attemptedAt: now().toISOString() };
        entry = updateEntry(stateDir, key, { insertAttempt: attempt });
        const beforeInsert = await readSheet(client, sheetId);
        if (stable(beforeInsert.rows) !== stable(snapshot.rows) || beforeInsert.revision !== snapshot.revision) {
          return mutationFailure({ code: 'SPECIAL_ACCOUNTING_CONFLICT' }, 'insert');
        }
        try { snapshot = await insertBeforeTotal(client, sheetId, snapshot); }
        catch { return uncertain('insert'); }
        row = snapshot.totalIndex;
      }
    }
    if (row < 2 || row > snapshot.totalIndex || (snapshot.rows[row - 1]?.[1] != null && snapshot.rows[row - 1][1] !== '')) fail('special accounting reserved cell is occupied or moved');
    entry = updateEntry(stateDir, key, { cell: `B${row}` });
    if (!term) {
      assertSpecialAccountingOrder({ order, job: readCurrentJob(order.requestId), policy, requireScope: true });
      const formula = specialAccountingTotalFormula(client, sheetId, snapshot, { row, cellText, orderId });
      entry = updateEntry(stateDir, key, { formulaAttempt: { cell: `B${snapshot.totalIndex + 1}`, value: formula,
        beforeSha256: hash(stable(snapshot.rows)), attemptedAt: now().toISOString() } });
      try { snapshot = await writeAccountingCellOnce(client, sheetId, entry.formulaAttempt.cell, formula, snapshot); }
      catch (error) { return mutationFailure(error, 'formula'); }
    }
    // Read again immediately before the one charge mutation. A row occupied by
    // another writer is never cleared or overwritten.
    snapshot = await readSheet(client, sheetId);
    parts = parseAccountingFormula(snapshot.rows[snapshot.totalIndex][1], 'B', snapshot.totalIndex, snapshot.formulaOptions);
    term = parts?.specialAdjustments?.find(item => item.orderId === orderId);
    if (term?.row !== row || (snapshot.rows[row - 1]?.[1] != null && snapshot.rows[row - 1][1] !== '')) fail('special accounting target changed after formula verification');
    assertSpecialAccountingOrder({ order, job: readCurrentJob(order.requestId), policy, requireScope: true });
    entry = updateEntry(stateDir, key, { status: 'formula_verified', itemAttempt: { cell: `B${row}`,
      value: cellText, beforeSha256: hash(stable(snapshot.rows)), attemptedAt: now().toISOString() } });
    try { await writeAccountingCellOnce(client, sheetId, `B${row}`, cellText, snapshot); }
    catch (error) { return mutationFailure(error, 'item'); }
    updateEntry(stateDir, key, { status: 'recorded', verifiedAt: now().toISOString(), uncertainPhase: null });
    return { status: 'recorded', recorded: 1, orderId, sheetId, cell: `B${row}`, amountMinor: order.pricing.amountMinor, replay: false };
  });
}
