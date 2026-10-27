import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { BridgeStore } from '../src/store.mjs';
import { inspectDeliveryReviewRetry, queueDeliveryReviewRetry } from '../src/delivery-review-retry.mjs';

const { values } = parseArgs({ options: {
  'request-id': { type: 'string' }, 'state-dir': { type: 'string' },
  workspace: { type: 'string' }, 'expected-job-sha256': { type: 'string' },
  'expected-input-sha256': { type: 'string' },
  reason: { type: 'string' }, apply: { type: 'boolean', default: false },
  'restore-review-checkpoint': { type: 'boolean', default: false },
} });
let stateDir = values['state-dir'];
let workspace = values.workspace;
if (!stateDir || !workspace) {
  const { config } = await import('../src/config.mjs');
  stateDir ||= config.stateDir;
  workspace ||= config.workspace;
}
if (!path.isAbsolute(stateDir) || !path.isAbsolute(workspace) || !values['request-id']) {
  throw new Error('absolute state-dir/workspace and request-id are required');
}
if (!fs.existsSync(path.join(stateDir, 'jobs.json'))) throw new Error('existing job store is required');
const store = new BridgeStore(stateDir);
const options = { requestId: values['request-id'], workspace };
if (!values.apply) {
  process.stdout.write(`${JSON.stringify({
    mode: 'inspect', ...inspectDeliveryReviewRetry(store, options),
    researchExecuted: false, externalMessages: 0,
  }, null, 2)}\n`);
} else {
  const lock = acquireInstanceLock(path.join(stateDir, 'bridge.instance.lock'), {
    legacyPidPath: path.join(stateDir, 'bridge.pid'),
  });
  try {
    const backupRoot = path.join(stateDir, 'review-retry-backups');
    const before = fs.readFileSync(store.jobsPath);
    const inspection = inspectDeliveryReviewRetry(store, options);
    if (inspection.expectedJobSha256 !== values['expected-job-sha256'] ||
        inspection.inputFingerprint !== values['expected-input-sha256'] || !inspection.queueAllowed) {
      throw new Error('review retry inspection changed or rejected unchanged evidence');
    }
    fs.mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `jobs-${crypto.randomUUID()}.json`);
    fs.writeFileSync(backupPath, before, { flag: 'wx', mode: 0o600 });
    if (!fs.readFileSync(backupPath).equals(before) || !fs.readFileSync(store.jobsPath).equals(before)) {
      throw new Error('job store or backup changed before review retry');
    }
    const job = queueDeliveryReviewRetry(store, {
      ...options, expectedJobSha256: values['expected-job-sha256'], reason: values.reason,
      expectedInputSha256: values['expected-input-sha256'],
      restoreLegacyReview: values['restore-review-checkpoint'],
    });
    process.stdout.write(`${JSON.stringify({
      mode: 'review-only-queued', requestId: job.requestId, status: job.status,
      stage: job.stage, backupPath, researchExecuted: false, externalMessages: 0,
    }, null, 2)}\n`);
  } finally { lock.release(); }
}
