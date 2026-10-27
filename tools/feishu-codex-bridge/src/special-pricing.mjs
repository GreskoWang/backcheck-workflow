import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OWNER = '王书鲲';
const REQUEST_ID = /^RQ-[A-Z0-9-]+$/iu;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/u;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/u;
const ORDER_ID = /^SP-[A-F0-9]{32}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const STATUSES = new Set(['pending_pricing', 'price_confirmed', 'pricing_conflict']);
const LEDGER_HOLD = Object.freeze({ status: 'blocked', reason: 'controlled_special_accounting_required' });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function invalid(message, code = 'SPECIAL_PRICING_INVALID') {
  const error = new Error(message); error.code = code; return error;
}

function validateIdentity(value) {
  if (!REQUEST_ID.test(value?.requestId || '') || !MESSAGE_ID.test(value?.sourceMessageId || '') ||
      !CHAT_ID.test(value?.chatId || '')) throw invalid('special order requires exact request, source message and group identities');
  return { requestId: value.requestId, sourceMessageId: value.sourceMessageId, chatId: value.chatId };
}

function identityMatches(left, right) {
  return left.requestId === right.requestId && left.sourceMessageId === right.sourceMessageId && left.chatId === right.chatId;
}

function orderIdentities(order) { return [order, ...order.aliases]; }

function parsePrice(value) {
  if (value?.currency !== 'CNY') throw invalid('special pricing only accepts explicitly confirmed CNY');
  const text = String(value?.amount ?? '');
  if (!/^[1-9]\d{0,7}(?:\.\d{1,2})?$/u.test(text)) throw invalid('confirmed special price must be a positive exact currency amount');
  const [whole, fraction = ''] = text.split('.');
  const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw invalid('confirmed special price is invalid');
  return { currency: 'CNY', amountMinor, amount: `${whole}.${fraction.padEnd(2, '0')}` };
}

function trustedProvenance(record, authority) {
  if (record?.kind === 'operator_instruction') {
    const instructionId = record.provenance?.instructionId;
    if (record.provenance?.source !== 'authenticated_human_instruction' ||
        !ID.test(instructionId || '') || !authority.operatorInstructionIds?.includes(instructionId)) {
      throw invalid('operator price confirmation is not bound to an authorized human instruction', 'SPECIAL_PRICING_UNTRUSTED');
    }
    const evidence = record.provenance;
    if (evidence.evidenceSha256 != null && (!/^[a-f0-9]{64}$/u.test(evidence.evidenceSha256) ||
        !ID.test(evidence.sourceThreadId || '') || !path.isAbsolute(evidence.evidencePath || ''))) {
      throw invalid('operator evidence artifact binding is invalid', 'SPECIAL_PRICING_UNTRUSTED');
    }
    return { kind: record.kind, instructionId, ...(evidence.evidenceSha256 ? {
      evidenceSha256: evidence.evidenceSha256, sourceThreadId: evidence.sourceThreadId, evidencePath: evidence.evidencePath,
    } : {}) };
  }
  if (record?.kind === 'verified_user_event') {
    const event = record.provenance;
    const user = authority.confirmingUser;
    if (!user || !/^ou_[A-Za-z0-9_-]+$/u.test(user.openId || '') || !user.tenantKey ||
        event?.source !== 'verified_feishu_message_metadata' || event.senderType !== 'user' ||
        event.senderOpenId !== user.openId || event.tenantKey !== user.tenantKey ||
        !MESSAGE_ID.test(event.messageId || '') || !CHAT_ID.test(event.chatId || '') ||
        !authority.confirmationChatIds?.includes(event.chatId) || event.priceMatchesMessage !== true) {
      throw invalid('event price confirmation lacks the exact authorized user and verified metadata', 'SPECIAL_PRICING_UNTRUSTED');
    }
    return { kind: record.kind, messageId: event.messageId, chatId: event.chatId,
      senderOpenId: event.senderOpenId, tenantKey: event.tenantKey };
  }
  throw invalid('group text and display names cannot authorize a special price', 'SPECIAL_PRICING_UNTRUSTED');
}

function validateState(state) {
  if (state?.version !== 1 || !Array.isArray(state.orders) || !Array.isArray(state.confirmations)) {
    throw invalid('special pricing registry is invalid');
  }
  const orders = new Set(), sourceOwners = new Map(), requestOwners = new Map(), confirmationIds = new Set();
  for (const order of state.orders) {
    validateIdentity(order);
    if (!ORDER_ID.test(order.orderId || '') || orders.has(order.orderId) || order.owner !== OWNER ||
        !STATUSES.has(order.status) || !Array.isArray(order.aliases) || !Array.isArray(order.conflicts)) {
      throw invalid('special pricing order identity or status is invalid');
    }
    orders.add(order.orderId);
    if (order.status === 'pending_pricing' && order.pricing !== null) throw invalid('pending special orders cannot contain a price');
    if (order.status === 'price_confirmed' && (!order.pricing ||
        !Number.isSafeInteger(order.pricing.amountMinor) || order.pricing.amountMinor <= 0 || order.pricing.currency !== 'CNY')) {
      throw invalid('confirmed price registry value is invalid');
    }
    for (const identity of orderIdentities(order)) {
      validateIdentity(identity);
      for (const [index, key] of [[sourceOwners, identity.sourceMessageId], [requestOwners, identity.requestId]]) {
        if (index.has(key) && index.get(key) !== order.orderId) throw invalid('special pricing identity is bound to multiple orders');
        index.set(key, order.orderId);
      }
    }
  }
  for (const confirmation of state.confirmations) {
    if (!ID.test(confirmation.confirmationId || '') || confirmationIds.has(confirmation.confirmationId) ||
        !orders.has(confirmation.orderId) || !/^[a-f0-9]{64}$/u.test(confirmation.digest || '') ||
        !/^[a-f0-9]{64}$/u.test(confirmation.priceDigest || '')) {
      throw invalid('special price confirmation is duplicated or invalid');
    }
    confirmationIds.add(confirmation.confirmationId);
  }
  for (const order of state.orders) {
    if (!order.pricing) continue;
    const price = parsePrice(order.pricing);
    const confirmation = state.confirmations.find(item => item.confirmationId === order.pricing.confirmationId);
    if (price.amountMinor !== order.pricing.amountMinor || !confirmation || confirmation.orderId !== order.orderId ||
        confirmation.priceDigest !== hash(price)) throw invalid('stored special price is not bound to its confirmed evidence');
  }
  return state;
}

function publicOrder(order, operation) {
  return { operation, ...structuredClone(order), pricingBlocksResearch: false, ledgerCapability: { ...LEDGER_HOLD } };
}

/**
 * A local pricing record, never a billing or dispatch permission.
 * Resolver callbacks must read operator-controlled evidence; incoming group
 * text, caller-supplied amounts and display names are deliberately not inputs.
 */
export function createSpecialPricingRegistry({
  stateDir, confirmationAuthority = {}, resolveTrustedConfirmation, resolveTrustedAlias,
  now = () => new Date(),
} = {}) {
  if (!stateDir || !path.isAbsolute(stateDir)) throw invalid('special pricing state directory must be absolute');
  const directory = path.resolve(stateDir);
  const file = path.join(directory, 'special-pricing.json');
  const lock = path.join(directory, 'special-pricing.lock');
  const authority = structuredClone(confirmationAuthority);

  function read() {
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw invalid('special pricing registry exceeds its bounded size');
      return validateState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, orders: [], confirmations: [] };
      throw error;
    }
  }

  function mutate(operation) {
    fs.mkdirSync(directory, { recursive: true });
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw invalid('special pricing registry is busy; do not create a second record', 'SPECIAL_PRICING_BUSY'); throw error; }
    let temporary;
    try {
      const state = read();
      const result = operation(state);
      validateState(state);
      temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, file); temporary = null;
      return result;
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  function findOrder(state, orderId) {
    if (!ORDER_ID.test(orderId || '')) throw invalid('exact special orderId is required');
    const order = state.orders.find(item => item.orderId === orderId);
    if (!order) throw invalid('special pricing order is unknown');
    return order;
  }

  function hold(order, reason, evidenceDigest) {
    const conflict = { reason, evidenceDigest };
    if (!order.conflicts.some(item => item.reason === reason && item.evidenceDigest === evidenceDigest)) {
      order.conflicts.push({ ...conflict, recordedAt: now().toISOString() });
    }
    order.status = 'pricing_conflict';
    order.updatedAt = now().toISOString();
    return publicOrder(order, 'held');
  }

  return {
    registerOrder(value) {
      const identity = validateIdentity(value);
      return mutate(state => {
        const source = state.orders.find(order => orderIdentities(order).some(id => id.sourceMessageId === identity.sourceMessageId));
        const request = state.orders.find(order => orderIdentities(order).some(id => id.requestId === identity.requestId));
        if (source || request) {
          if (source && request && source.orderId !== request.orderId) throw invalid('source and request point to different special orders');
          const order = source || request;
          if (orderIdentities(order).some(id => identityMatches(id, identity))) return publicOrder(order, 'existing');
          // Same source message can be replayed with another accidental requestId;
          // it remains the same price, but alias registration needs trusted proof.
          return publicOrder(order, 'alias_verification_required');
        }
        const timestamp = now().toISOString();
        const order = { orderId: `SP-${hash([identity.requestId, identity.sourceMessageId]).slice(0, 32).toUpperCase()}`,
          ...identity, owner: OWNER, status: 'pending_pricing', pricing: null,
          aliases: [], conflicts: [], createdAt: timestamp, updatedAt: timestamp };
        state.orders.push(order);
        return publicOrder(order, 'registered');
      });
    },

    getOrder(orderId) { return publicOrder(findOrder(read(), orderId), 'read'); },

    findOrder({ requestId: request, sourceMessageId: source } = {}) {
      if (!request && !source) throw invalid('a request or source message identity is required');
      const matches = read().orders.filter(order => orderIdentities(order).some(id =>
        (!request || id.requestId === request) && (!source || id.sourceMessageId === source)));
      if (matches.length > 1) throw invalid('special pricing lookup is ambiguous');
      return matches.length ? publicOrder(matches[0], 'read') : null;
    },

    async linkAlias({ orderId, aliasId }) {
      if (!ID.test(aliasId || '') || typeof resolveTrustedAlias !== 'function') throw invalid('trusted alias resolution is required');
      const evidence = await resolveTrustedAlias(aliasId);
      if (evidence?.aliasId !== aliasId || evidence.orderId !== orderId) throw invalid('alias proof identity mismatch');
      const alias = validateIdentity(evidence.alias);
      const evidenceDigest = hash(evidence);
      return mutate(state => {
        const order = findOrder(state, orderId);
        if (evidence.kind === 'platform_original_message') {
          if (evidence.provenance?.source !== 'verified_feishu_message_metadata' ||
              !orderIdentities(order).some(id => id.sourceMessageId === evidence.originalSourceMessageId && id.chatId === evidence.originalChatId)) {
            throw invalid('forward alias does not identify the verified original message');
          }
        } else {
          trustedProvenance(evidence, authority);
          if (evidence.kind !== 'operator_instruction') throw invalid('only operator instructions or platform provenance can associate order aliases');
        }
        const other = state.orders.find(item => item.orderId !== orderId && orderIdentities(item).some(id =>
          id.requestId === alias.requestId || id.sourceMessageId === alias.sourceMessageId));
        if (other) return hold(order, 'alias_already_owned_by_another_order', evidenceDigest);
        const prior = order.aliases.find(item => item.aliasId === aliasId);
        if (prior && (prior.evidenceDigest !== evidenceDigest || !identityMatches(prior, alias))) {
          return hold(order, 'alias_proof_changed', evidenceDigest);
        }
        if (orderIdentities(order).some(id => identityMatches(id, alias))) return publicOrder(order, 'existing_alias');
        order.aliases.push({ ...alias, aliasId, evidenceDigest, linkedAt: now().toISOString() });
        order.updatedAt = now().toISOString();
        return publicOrder(order, 'alias_linked');
      });
    },

    async confirmPrice({ orderId, confirmationId }) {
      if (!ID.test(confirmationId || '') || typeof resolveTrustedConfirmation !== 'function') {
        throw invalid('trusted operator confirmation resolution is required', 'SPECIAL_PRICING_UNTRUSTED');
      }
      const confirmation = await resolveTrustedConfirmation(confirmationId);
      if (confirmation?.confirmationId !== confirmationId || confirmation.target?.orderId !== orderId ||
          confirmation.decision !== 'confirm_special_price') throw invalid('price confirmation is not bound to this exact order');
      const target = validateIdentity(confirmation.target);
      const provenance = trustedProvenance(confirmation, authority);
      const price = parsePrice(confirmation.price);
      const evidenceDigest = hash(confirmation);
      return mutate(state => {
        const order = findOrder(state, orderId);
        if (!orderIdentities(order).some(identity => identityMatches(identity, target))) {
          return hold(order, 'confirmation_target_identity_conflict', evidenceDigest);
        }
        const previous = state.confirmations.find(item => item.confirmationId === confirmationId);
        if (previous && (previous.orderId !== orderId || previous.digest !== evidenceDigest)) {
          return hold(order, 'confirmation_identity_reused_or_changed', evidenceDigest);
        }
        if (previous) return publicOrder(order, order.status === 'pricing_conflict' ? 'held' : 'already_confirmed');
        state.confirmations.push({ confirmationId, orderId, digest: evidenceDigest, priceDigest: hash(price), provenance,
          recordedAt: now().toISOString() });
        if (order.status === 'pricing_conflict') return publicOrder(order, 'held');
        if (order.pricing && order.pricing.amountMinor !== price.amountMinor) {
          return hold(order, 'conflicting_confirmed_price', evidenceDigest);
        }
        if (order.pricing) return publicOrder(order, 'already_confirmed');
        order.pricing = { ...price, confirmationId, provenance, confirmedAt: now().toISOString() };
        order.status = 'price_confirmed'; order.updatedAt = now().toISOString();
        return publicOrder(order, 'price_confirmed');
      });
    },

    ledgerCapability(orderId) {
      findOrder(read(), orderId);
      // There is deliberately no adapter, callback, receipt or ledger mutation.
      // The separate special-accounting entrypoint validates the exact job,
      // activation, confirmed amount, formula plan and durable write intent.
      return { ...LEDGER_HOLD, canWrite: false };
    },
  };
}
