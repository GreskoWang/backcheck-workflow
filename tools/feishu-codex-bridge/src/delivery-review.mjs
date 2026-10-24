import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DOCX_LINK = /https:\/\/[^\s)\]]*?feishu\.cn\/docx\/([A-Za-z0-9]+)/giu;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export function canResumeDeliveryReview(job) {
  return job?.stage === 'verifying_delivery' &&
    typeof job.finalResponse === 'string' && job.finalResponse.trim().length > 0 &&
    job.dispatchScope?.decision === 'execute' &&
    typeof job.codexThreadId === 'string' && job.codexThreadId.length > 0 &&
    job.codexThreadRequestId === job.requestId;
}

export function reviewManifestPath(stateDir, requestId) {
  if (!/^RQ-[A-Z0-9-]+$/iu.test(String(requestId || ''))) {
    throw new Error('review manifest requires a valid requestId');
  }
  return path.join(stateDir, 'review-evidence', `${requestId}.json`);
}

function reportTokens(text) {
  return [...String(text || '').matchAll(DOCX_LINK)].map((match) => match[1]);
}

function containedFile(workspace, filePath) {
  if (!path.isAbsolute(filePath)) throw new Error('review snapshot path must be absolute');
  const root = fs.realpathSync(workspace);
  const candidate = fs.realpathSync(filePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('review snapshot must be a file inside the background-check workspace');
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error('review snapshot is not a bounded regular file');
  }
  return candidate;
}

function scriptPaths() {
  const home = os.homedir();
  return {
    python: process.env.FEISHU_REVIEW_PYTHON || path.join(
      home, '.cache', 'codex-runtimes', 'codex-primary-runtime',
      'dependencies', 'python', 'python.exe',
    ),
    auditor: process.env.FEISHU_REVIEW_AUDITOR || path.join(
      process.env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'review-feishu-background-check',
      'scripts', 'audit_feishu_snapshot.py',
    ),
  };
}

export async function runReadOnlyAudit(snapshotPath) {
  const { python, auditor } = scriptPaths();
  if (!fs.existsSync(python) || !fs.existsSync(auditor)) {
    throw new Error('review validator or bundled Python is unavailable');
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(python, [auditor, snapshotPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch {
    throw new Error('review validator did not return JSON');
  }
  if (result.code !== 0 && audit.verdict === 'PASS') {
    throw new Error('review validator exit code contradicts PASS');
  }
  return audit;
}

export async function verifyCompletedReports({
  requestId,
  finalResponse,
  stateDir,
  workspace,
  readLatestRevision,
  runAudit = runReadOnlyAudit,
}) {
  if (typeof readLatestRevision !== 'function') {
    throw new Error('live Feishu revision reader is required for completion');
  }
  const linked = reportTokens(finalResponse);
  if (linked.length === 0 || new Set(linked).size !== linked.length) {
    throw new Error('final response must contain distinct Feishu docx report links');
  }
  const manifest = JSON.parse(fs.readFileSync(reviewManifestPath(stateDir, requestId), 'utf8'));
  if (manifest?.requestId !== requestId || !Array.isArray(manifest.documents)) {
    throw new Error('review manifest requestId or documents is invalid');
  }
  if (manifest.documents.length !== linked.length || manifest.documents.length > 30) {
    throw new Error('review manifest does not cover exactly the linked reports');
  }
  const evidenceTokens = manifest.documents.map((item) => {
    const tokens = reportTokens(item?.url);
    if (tokens.length !== 1 || typeof item?.snapshotPath !== 'string') {
      throw new Error('review manifest contains an invalid report entry');
    }
    return tokens[0];
  });
  if (new Set(evidenceTokens).size !== evidenceTokens.length ||
      evidenceTokens.some((token) => !linked.includes(token))) {
    throw new Error('review manifest tokens do not match final report links');
  }

  const receipts = [];
  for (let index = 0; index < manifest.documents.length; index += 1) {
    const item = manifest.documents[index];
    const token = evidenceTokens[index];
    const snapshotPath = containedFile(workspace, item.snapshotPath);
    const audit = await runAudit(snapshotPath);
    const receipt = audit?.receipt;
    const revision = receipt?.revision_id;
    if (audit?.verdict !== 'PASS' || audit?.visual?.verdict !== 'PASS' ||
        audit?.stats?.errors !== 0 || audit?.stats?.blocked !== 0 ||
        !receipt || receipt.verdict !== 'PASS' ||
        receipt.token !== token || audit.document?.token !== token ||
        String(revision) !== String(audit.document?.revision_id) ||
        !Number.isSafeInteger(Number(revision)) || Number(revision) <= 0 ||
        !receipt.script_version || !receipt.reviewer_id ||
        !receipt.layout_fingerprint || !receipt.generated_at) {
      throw new Error(`report ${token} has no matching deterministic FORMAT_REVIEW: PASS`);
    }
    const latestRevision = await readLatestRevision(token);
    if (String(latestRevision) !== String(revision)) {
      throw new Error(`report ${token} changed after FORMAT_REVIEW: PASS`);
    }
    receipts.push({ token, revision_id: Number(revision), ...receipt });
  }
  return receipts;
}

export async function readLatestFeishuRevision(client, token) {
  const response = await client.request({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(token)}`,
    method: 'GET',
  });
  if (response?.code !== 0) {
    throw new Error(`Feishu read-only document revision failed with code ${response?.code ?? 'unknown'}`);
  }
  const revision = response?.data?.document?.revision_id;
  if (!Number.isSafeInteger(Number(revision)) || Number(revision) <= 0) {
    throw new Error('Feishu did not return a valid document revision');
  }
  return Number(revision);
}
