import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCX_LINK = /https:\/\/[^\s)\]]*?feishu\.cn\/docx\/([A-Za-z0-9]+)/giu;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export function canResumeDeliveryReview(job) {
  const tokens = reportTokens(job?.finalResponse);
  const special = job?.workflowKind === 'special_research' && job.deliveryReviewMode === 'special_artifacts_v1';
  return job?.stage === 'verifying_delivery' &&
    !job.intakeHold && !job.duplicateOfRequestId && job.deliveryEligible !== false &&
    (!job.status || ['queued', 'running', 'review_pending', 'failed'].includes(job.status)) &&
    !job.handoffEvidence && job.codexThreadCreationMode !== 'desktop_native_handoff_v1' &&
    (special ? Boolean(job.specialIntake?.structuredRequest && job.specialIntake?.scope && Array.isArray(job.specialIntake.attachments))
      : tokens.length > 0 && tokens.length <= 30 && new Set(tokens).size === tokens.length) &&
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

export function readDeliveryReviewManifest({ requestId, finalResponse, stateDir, workspace }) {
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

  return { manifest, documents: manifest.documents.map((item, index) => ({
    token: evidenceTokens[index], snapshotPath: containedFile(workspace, item.snapshotPath),
  })) };
}

function boundedReviewDependency(name, filePath) {
  const resolved = path.resolve(filePath);
  let stat;
  try { stat = fs.statSync(resolved); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return { name, path: resolved, state: 'missing' };
    throw error;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
    throw new Error('review dependency is not a bounded regular file');
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('review dependency grew beyond its size limit');
  return { name, path: resolved, state: 'present',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function deliveryReviewInputFingerprint(options) {
  if (options.workflowKind === 'special_research' && options.deliveryReviewMode === 'special_artifacts_v1') {
    return specialReviewInputFingerprint(options);
  }
  const { manifest, documents } = readDeliveryReviewManifest(options);
  const { auditor, python } = scriptPaths();
  const reviewWorkspace = process.env.BACKGROUND_CHECK_WORKSPACE || options.workspace;
  const localConfigPath = process.env.BACKCHECK_CONFIG_PATH ||
    path.join(reviewWorkspace, 'config', 'backcheck-local.json');
  // Hash only the explicit executable/policy dependency set, never a recursive
  // workspace tree. Missing synthetic dependencies remain distinguishable.
  const dependencies = [boundedReviewDependency('auditor', auditor),
    ...['team_merge_audit.py', 'business_risk_gate.py', 'disclaimer_gate.py']
      .map((name) => boundedReviewDependency(name, path.join(path.dirname(auditor), name))),
    boundedReviewDependency('business_policy', path.join(reviewWorkspace, '背调风险提示.md')),
    boundedReviewDependency('approved_local_config', localConfigPath),
  ];
  return crypto.createHash('sha256').update(JSON.stringify({
    policy: 'delivery-review-v3', python, dependencies, reviewPolicyVersion: options.reviewPolicyVersion || null,
    requestId: options.requestId, finalResponse: options.finalResponse,
    dispatchScope: options.dispatchScope || null, scopeVersion: options.scopeVersion || null,
    manifest, documents: documents.map((item) => ({
      token: item.token, sha256: crypto.createHash('sha256')
        .update(fs.readFileSync(item.snapshotPath)).digest('hex'),
    })),
  })).digest('hex');
}

// A special review still uses its existing semantic/visual validator. This
// checkpoint binds its own manifest and local inputs instead of imposing a
// docx manifest on workbooks, CSVs, or sheets. No remote calls happen here.
function specialReviewInputFingerprint(options) {
  const readBounded = (filename, limit, researchOnly = false) => {
    const file = containedFile(options.workspace, filename);
    const relative = path.relative(fs.realpathSync(options.workspace), file);
    const parts = relative.split(path.sep).map(part => part.toLowerCase());
    if (researchOnly && (['tools','config','external','.git','.codex','.aws'].includes(parts[0]) ||
        parts.some(part => /^(?:credentials?|secrets?|\.env)$/u.test(part)))) {
      throw new Error('special review input is outside research scope');
    }
    if (fs.statSync(file).size > limit) throw new Error('special review input exceeds its byte budget');
    const bytes = fs.readFileSync(file);
    if (bytes.length > limit) throw new Error('special review input grew beyond its byte budget');
    return {file,bytes,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  };
  const source = readBounded(reviewManifestPath(options.stateDir, options.requestId), 1024 * 1024);
  const manifest = JSON.parse(source.bytes.toString('utf8').replace(/^\uFEFF/u,''));
  if (manifest.schemaVersion !== 1 || manifest.requestId !== options.requestId ||
      manifest.sourceChatId !== options.chatId || manifest.sourceMessageId !== options.sourceMessageId ||
      !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 10) {
    throw new Error('special review manifest does not match its request and source');
  }
  const inputs = [], ids = new Set();
  for (const artifact of manifest.artifacts) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(artifact.id || '') || ids.has(artifact.id) ||
        !['xlsx','csv','feishu_sheet','feishu_docx'].includes(artifact.artifactType)) {
      throw new Error('special review artifact identity is invalid');
    }
    ids.add(artifact.id);
    if (['xlsx','csv'].includes(artifact.artifactType)) {
      if (artifact.url) throw new Error('special local artifact cannot also name a remote URL');
      const input = readBounded(artifact.localPath, MAX_SNAPSHOT_BYTES, true);
      inputs.push({id:artifact.id,file:input.file,sha256:input.sha256});
    } else if (typeof artifact.url !== 'string' || artifact.localPath) {
      throw new Error('special remote artifact must retain its URL identity');
    }
    if (artifact.sourceFiles != null && (!Array.isArray(artifact.sourceFiles) || artifact.sourceFiles.length > 20)) {
      throw new Error('special review source-note list is invalid');
    }
    for (const filename of artifact.sourceFiles || []) {
      const input = readBounded(filename, 1024 * 1024, true);
      inputs.push({id:artifact.id,file:input.file,sha256:input.sha256});
    }
  }
  const attachments = options.specialIntake?.attachments;
  if (!Array.isArray(attachments) || attachments.length > 64) throw new Error('special requirement attachments are invalid');
  for (const attachment of attachments) {
    const input = readBounded(attachment.localPath, MAX_SNAPSHOT_BYTES);
    const relative = path.relative(fs.realpathSync(options.stateDir), input.file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !/^[a-f0-9]{64}$/u.test(attachment.sha256 || '') || input.sha256 !== attachment.sha256) {
      throw new Error('special requirement attachment is outside its original state or changed');
    }
    inputs.push({kind:'requirement_image',file:input.file,sha256:input.sha256});
  }
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const dependencies = ['special-artifacts.mjs','special-preflight.mjs','special-delivery-adapter.mjs']
    .map(name => boundedReviewDependency(name, path.join(directory,name)));
  for (const name of ['read-special-workbook.py','render-special-workbook.py','render-special-workbook.mjs']) {
    dependencies.push(boundedReviewDependency(name,path.join(directory,'..','scripts',name)));
  }
  dependencies.push(boundedReviewDependency('approved_local_config',process.env.BACKCHECK_CONFIG_PATH ||
    path.join(options.workspace,'config','backcheck-local.json')));
  return crypto.createHash('sha256').update(JSON.stringify({policy:'special-review-checkpoint-v1',
    requestId:options.requestId,chatId:options.chatId,sourceMessageId:options.sourceMessageId,
    finalResponse:options.finalResponse,dispatchScope:options.dispatchScope,scopeVersion:options.scopeVersion,
    workflowKind:options.workflowKind,deliveryReviewMode:options.deliveryReviewMode,
    deliveryEligible:options.deliveryEligible,specialIntake:options.specialIntake,
    specialOwnership:options.specialOwnership,manifestSha256:source.sha256,inputs,dependencies,
    reviewPolicyVersion:options.reviewPolicyVersion})).digest('hex');
}

function reviewFailure(code, message, reviewStatus, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.reviewStatus = reviewStatus;
  return error;
}

export async function verifyCompletedReports({
  requestId, finalResponse, stateDir, workspace, readLatestRevision,
  runAudit = runReadOnlyAudit,
}) {
  if (typeof readLatestRevision !== 'function') {
    throw new Error('live Feishu revision reader is required for completion');
  }
  const { documents } = readDeliveryReviewManifest({ requestId, finalResponse, stateDir, workspace });
  const receipts = [];
  for (const { token, snapshotPath } of documents) {
    let audit;
    try { audit = await runAudit(snapshotPath); }
    catch (cause) {
      throw reviewFailure('review_audit_error', `report ${token} audit could not complete`, 'ERROR', cause);
    }
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
      throw reviewFailure('format_review_rejected',
        `report ${token} has no matching deterministic FORMAT_REVIEW: PASS`,
        audit?.verdict === 'FAIL' ? 'FAIL' : 'BLOCKED');
    }
    let latestRevision;
    try { latestRevision = await readLatestRevision(token); }
    catch (cause) {
      throw reviewFailure('review_revision_read_failed',
        `report ${token} latest revision could not be read`, 'ERROR', cause);
    }
    if (String(latestRevision) !== String(revision)) {
      throw reviewFailure('review_revision_changed',
        `report ${token} changed after FORMAT_REVIEW: PASS`, 'BLOCKED');
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
