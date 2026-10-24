import crypto from 'node:crypto';

const FEISHU_DOCUMENT_URL = /^https:\/\/[^\s/]+\.feishu\.cn\/(?:docx|wiki|docs)\/[^\s?#/]+(?:[?#][^\s]*)?$/iu;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'recovery_required']);

function normalized(value) {
  return String(value || '').trim();
}

export function jobSha256(job) {
  return crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex');
}

export function validateCompletionManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('completion manifest must be a JSON object');
  }

  const manifest = structuredClone(value);
  manifest.request_id = normalized(manifest.request_id);
  manifest.source_message_id = normalized(manifest.source_message_id);
  manifest.thread_id = normalized(manifest.thread_id);
  manifest.expected_status = normalized(manifest.expected_status);
  manifest.expected_stage = normalized(manifest.expected_stage);
  manifest.expected_job_sha256 = normalized(manifest.expected_job_sha256).toLowerCase();
  manifest.final_response = normalized(manifest.final_response);
  manifest.evidence = normalized(manifest.evidence);

  if (!manifest.request_id) throw new Error('manifest request_id is required');
  if (!manifest.source_message_id) throw new Error('manifest source_message_id is required');
  if (!manifest.thread_id) throw new Error('manifest thread_id is required');
  if (!manifest.expected_status) throw new Error('manifest expected_status is required');
  if (!manifest.expected_stage) throw new Error('manifest expected_stage is required');
  if (!/^[0-9a-f]{64}$/u.test(manifest.expected_job_sha256)) {
    throw new Error('manifest expected_job_sha256 must be a SHA-256 hex digest');
  }
  if (!manifest.final_response) throw new Error('manifest final_response is required');
  if (!manifest.evidence) throw new Error('manifest evidence is required');

  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error('manifest documents must be a non-empty array');
  }
  const seenUrls = new Set();
  manifest.documents = manifest.documents.map((document, index) => {
    const subject = normalized(document?.subject);
    const url = normalized(document?.url);
    const review = normalized(document?.review);
    if (!subject) throw new Error(`manifest documents[${index}].subject is required`);
    if (!FEISHU_DOCUMENT_URL.test(url)) {
      throw new Error(`manifest documents[${index}].url is not a Feishu document URL`);
    }
    if (!review) throw new Error(`manifest documents[${index}].review is required`);
    if (seenUrls.has(url)) throw new Error(`duplicate document URL in completion manifest: ${url}`);
    seenUrls.add(url);
    if (!manifest.final_response.includes(url)) {
      throw new Error(`final_response does not include document URL: ${url}`);
    }
    return { subject, url, review };
  });

  return manifest;
}

export function inspectCompletionRepair(store, manifestValue) {
  const manifest = validateCompletionManifest(manifestValue);
  const jobs = store.listJobs();
  const matches = jobs.filter((job) => job.requestId === manifest.request_id);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one job for ${manifest.request_id}, found ${matches.length}`);
  }
  const job = matches[0];

  if (job.sourceMessageId !== manifest.source_message_id) {
    throw new Error('source message id does not match the completion manifest');
  }
  if (job.codexThreadId !== manifest.thread_id) {
    throw new Error('Codex thread id does not match the completion manifest');
  }
  if (job.codexThreadRequestId !== manifest.request_id) {
    throw new Error('Codex thread ownership is not durably bound to this request');
  }
  if (job.status !== manifest.expected_status || job.stage !== manifest.expected_stage) {
    throw new Error(
      `job state changed: expected ${manifest.expected_status}/${manifest.expected_stage}, `
      + `found ${job.status}/${job.stage}`,
    );
  }

  const actualJobSha256 = jobSha256(job);
  if (actualJobSha256 !== manifest.expected_job_sha256) {
    throw new Error(
      `job fingerprint changed: expected ${manifest.expected_job_sha256}, found ${actualJobSha256}`,
    );
  }

  const otherActiveJobs = jobs.filter((candidate) =>
    candidate.requestId !== manifest.request_id && ACTIVE_JOB_STATUSES.has(candidate.status));
  if (otherActiveJobs.length > 0) {
    throw new Error(`other active jobs exist: ${otherActiveJobs.map((item) => item.requestId).join(', ')}`);
  }

  const outbox = store.getOutboxStats();
  if (outbox.pending !== 0) {
    throw new Error(`reply outbox has ${outbox.pending} pending item(s)`);
  }

  return { manifest, job, actualJobSha256, outbox };
}

export function applyCompletionRepair(store, manifestValue, { now = new Date() } = {}) {
  const inspection = inspectCompletionRepair(store, manifestValue);
  const completedAt = now.toISOString();
  const updated = store.updateJob(inspection.manifest.request_id, {
    status: 'completed',
    stage: 'completed',
    completedAt,
    finalResponse: inspection.manifest.final_response,
    completionDocuments: inspection.manifest.documents,
    completionMigratedAt: completedAt,
    completionMigrationEvidence: inspection.manifest.evidence.slice(0, 1000),
    errorSummary: null,
  });
  return { ...inspection, updated };
}
