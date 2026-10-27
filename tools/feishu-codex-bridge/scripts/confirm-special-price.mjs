import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { confirmSpecialPriceInstruction, recordConfirmedSpecialAccounting } from '../src/special-accounting.mjs';

export function parseSpecialPriceArguments(argv) {
  const values = {};
  const flags = new Set(['--confirm', '--apply', '--help']);
  const options = new Set(['--order-id', '--amount', '--evidence-file', '--evidence-sha256']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (values[name] !== undefined || (!flags.has(name) && !options.has(name))) throw new Error('unknown or duplicate special price argument');
    if (flags.has(name)) values[name] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing ${name}`);
      values[name] = argv[++i];
    }
  }
  if (values['--confirm'] && values['--apply']) throw new Error('choose --confirm or --apply');
  if (!values['--help'] && [...options].some(name => !values[name])) throw new Error('order ID, CNY amount, human evidence file and exact evidence SHA256 are required');
  return values;
}

export async function runSpecialPriceCommand(argv, dependencies = {}) {
  const args = parseSpecialPriceArguments(argv);
  if (args['--help']) return { usage: 'node scripts/confirm-special-price.mjs --order-id SP-... --amount 700.00 --evidence-file ABSOLUTE_JSON --evidence-sha256 SHA256 [--confirm | --apply]',
    modes: { default: 'validate only; no mutation', confirm: 'record exact human-confirmed price locally', apply: 'confirm price, then write and verify one authorized new-order fee' },
    evidence: { version: 1, source: 'authenticated_human_instruction', role: 'user', instructionId: 'actual-human-message-id',
      sourceThreadId: 'actual-source-thread-id', text: 'verbatim human confirmation',
      target: { orderId: 'exact-order', requestId: 'exact-request', sourceMessageId: 'exact-source', chatId: 'exact-special-group' },
      price: { amount: '700.00', currency: 'CNY' } } };
  const configuration = dependencies.configuration || await import('../../../config/backcheck-config.mjs');
  const runtime = dependencies.runtime || (await import('../src/config.mjs')).config;
  const { createSpecialPricingRegistry } = await import('../src/special-pricing.mjs');
  const { BridgeStore } = await import('../src/store.mjs');
  const order = createSpecialPricingRegistry({ stateDir: runtime.stateDir }).getOrder(args['--order-id']);
  const store = dependencies.store || new BridgeStore(runtime.stateDir);
  const job = store.getJob(order.requestId);
  const group = configuration.localConfig.groups?.find(item => item.chatId === order.chatId && item.role === 'special_dispatch');
  const policy = { ...configuration.localConfig.special_accounting, defaultOwner: group?.defaultOwner };
  if (!group?.enabled || !Number.isSafeInteger(group.activationFromMs) ||
      !Number.isSafeInteger(policy.activationFromMs) || policy.activationFromMs < group.activationFromMs) {
    throw new Error('special source group and accounting cutover must both be explicitly enabled');
  }
  const confirmed = await confirmSpecialPriceInstruction({ stateDir: runtime.stateDir, orderId: order.orderId,
    job, policy, evidenceFile: args['--evidence-file'], evidenceSha256: args['--evidence-sha256'],
    amount: args['--amount'], checkOnly: !args['--confirm'] && !args['--apply'] });
  if (!args['--apply']) return { mode: args['--confirm'] ? 'confirmed' : 'checked', orderId: order.orderId,
    pricingStatus: confirmed.status, recorded: 0 };
  if (confirmed.status !== 'price_confirmed') return { mode: 'held', orderId: order.orderId, pricingStatus: confirmed.status, recorded: 0 };
  let client = dependencies.client;
  if (!client) {
    const [{ readFeishuCredential }, { createQuietFeishuClient }, { accountingClient }] = await Promise.all([
      import('../src/credentials.mjs'), import('../src/quiet-feishu-client.mjs'), import('../src/accounting-client.mjs')]);
    const credential = await readFeishuCredential(runtime.credentialReader);
    client = accountingClient(createQuietFeishuClient(credential), credential.appId);
    credential.appSecret = undefined;
  }
  const accounting = await recordConfirmedSpecialAccounting({ client, stateDir: runtime.stateDir,
    orderId: order.orderId, job: store.getJob(order.requestId), policy, readCurrentJob: id => store.getJob(id) });
  return { mode: 'applied', orderId: order.orderId, pricingStatus: confirmed.status, accounting };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSpecialPriceCommand(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.mode === 'held' || result.accounting?.status === 'outcome_uncertain') process.exitCode = 2;
  }).catch(error => { console.error(String(error?.message || 'special price command failed')); process.exitCode = 1; });
}
