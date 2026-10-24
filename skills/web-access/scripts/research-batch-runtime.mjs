import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
const TERMINAL = new Set(['collected', 'needs_review', 'paused', 'failed']);

export function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temporary, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      // Windows readers/virus scanners can briefly hold the destination open.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

export function replayItems(file) {
  const items = new Map();
  if (!fs.existsSync(file)) return items;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const item = JSON.parse(lines[index]);
      if (typeof item.source_id !== 'string') throw new Error('source_id missing');
      items.set(item.source_id, item);
    } catch (error) {
      // Only a final partial append may be discarded after an interrupted write.
      if (lines.slice(index + 1).some(line => line.trim())) throw new Error(`Invalid cache record ${index + 1}`);
      throw new Error(`Interrupted final cache record ${index + 1}; preserve file and repair before resuming`);
    }
  }
  return items;
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

export function normalizeSnapshot(raw, { compatibility = false, sequence = 0 } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid research snapshot');
  if (compatibility) {
    const text = raw.text?.text || '';
    return {
      items: text ? [{ source_id: `viewport-${sequence}`, post_url: raw.url, text,
        quoted_text: '', text_truncated: raw.text.truncated !== false,
        needs_expansion: false, media: [], warnings: ['compatibility_snapshot_not_individual_post'] }] : [],
      page: { url: raw.url, loading: false, compatibility: true,
        extraction_truncated: raw.text?.truncated !== false,
        warnings: ['compatibility_mode_requires_source_and_endpoint_review'],
        visible_links: raw.links?.items || [], visible_media: raw.media?.items || [] },
    };
  }
  if (!Array.isArray(raw.items) || !raw.page_state) throw new Error('Snapshot fields missing');
  return {
    items: raw.items.map((item, index) => {
      const media = Array.isArray(item.media) ? item.media : item.media?.items || [];
      const stable = Boolean(item.source_id) && item.stable_deduplication !== false;
      const text = item.own_visible_text ?? item.full_visible_text ?? '';
      const quotedText = (item.repost || []).map(part => [part.author, part.text].filter(Boolean).join(': ')).join('\n');
      // This deduplicates identical observations; it is NOT a post ID. Include
      // media and attribution to avoid merging different posts or blank media.
      const attributableContent = Boolean((text.trim() || quotedText.trim()) && item.author && item.date);
      const domObservation = !stable && attributableContent && raw.recipe === 'bilibili-dynamic'
        && typeof item.dom_observation_id === 'string'
        && /^dom-[a-z0-9]+-[a-z0-9]{1,8}:\d+$/u.test(item.dom_observation_id)
        ? createHash('sha256').update(JSON.stringify([scopedUrl(raw.page_state.url),item.dom_observation_id])).digest('hex') : null;
      const fingerprint = !stable && attributableContent ? createHash('sha256').update(JSON.stringify([
        raw.recipe || null, scopedUrl(raw.page_state.url), item.author, item.date,
        text, quotedText, media.map(entry => [entry.kind, entry.url || entry.media_id || null]).sort(),
      ])).digest('hex') : null;
      return {
        source_id: stable ? String(item.source_id) : domObservation ? `unresolved-dom-${domObservation}` : fingerprint ? `unresolved-content-${fingerprint}` : `unresolved-${sequence}-${index}`,
        observation_identity: stable ? 'public_source_id' : domObservation ? 'dom_observation_not_post_id' : fingerprint ? 'content_fingerprint_not_post_id' : 'unresolved_occurrence',
        post_url: item.post_url || null, account: item.author || null, date: item.date || null,
        text, quoted_text: quotedText,
        text_truncated: Boolean(item.truncation?.text_collection_truncated || item.truncation?.visual_ellipsis_detected),
        needs_expansion: Boolean(item.expansion?.needed || item.truncation?.list_summary || item.truncation?.needs_detail),
        media: media.map((entry, mediaIndex) => ({ ...entry, media_id: entry.media_id || entry.url || `${item.source_id || index}:media:${mediaIndex}` })),
        media_count: item.media?.declared_count ?? media.length,
        warnings: unique([...(item.warnings || []), !stable && 'unstable_source_identity',
          item.media?.gap && 'unexpanded_gallery', item.media?.placeholder_count && 'media_placeholder']),
      };
    }),
    page: raw.page_state,
  };
}

export function mergeItem(previous, current) {
  if (!previous) return current;
  if (previous.post_url && current.post_url && scopedUrl(previous.post_url) !== scopedUrl(current.post_url)) {
    return { ...previous, needs_expansion: true, warnings: unique([...previous.warnings, 'source_identity_conflict']) };
  }
  const textSource = current.text.length >= previous.text.length ? current : previous;
  const quoteSource = current.quoted_text.length >= previous.quoted_text.length ? current : previous;
  const result = { ...previous, ...current, text: textSource.text, quoted_text: quoteSource.quoted_text,
    post_url: current.post_url || previous.post_url || null,
    account: current.account || previous.account || null, date: current.date || previous.date || null,
    text_truncated: textSource.text_truncated || quoteSource.text_truncated,
    needs_expansion: textSource.needs_expansion || quoteSource.needs_expansion };
  const media = new Map();
  for (const entry of [...previous.media, ...current.media]) media.set(entry.url || entry.media_id, entry);
  result.media = [...media.values()];
  result.media_count = Math.max(previous.media_count || 0, current.media_count || 0, result.media.length);
  result.warnings = unique([...textSource.warnings, ...quoteSource.warnings]);
  return result;
}

function scopedUrl(raw) {
  const url = new URL(raw);
  url.hash = '';
  url.searchParams.sort();
  return url.toString();
}

export function buildResult(state, items) {
  const list = [...items.values()];
  const unresolved = list.flatMap(item => [
    item.text_truncated && { source_id: item.source_id, reason: 'text_truncated' },
    item.needs_expansion && { source_id: item.source_id, reason: 'needs_expansion' },
    ...item.warnings.filter(warning => ['unstable_source_identity', 'source_identity_conflict', 'unexpanded_gallery', 'media_placeholder'].includes(warning))
      .map(reason => ({ source_id: item.source_id, reason })),
  ].filter(Boolean));
  if (state.compatibility) unresolved.push({ reason: 'compatibility_requires_source_and_endpoint_review' });
  if (state.page_extraction_truncated) unresolved.push({ reason: 'snapshot_extraction_truncated' });
  const verifiedEndpoint = state.stop_reason === 'visible_endpoint';
  return {
    schema_version: SCHEMA_VERSION,
    job: { id: state.id, state: state.state, reason: state.stop_reason, recipe: state.recipe,
      target_url: state.target_url, iterations: state.iterations, started_at: state.started_at, updated_at: state.updated_at },
    scope: { kind: 'requested_visible_page', starting_position: state.starting_position,
      whole_account_completion_inferred: false },
    items: list,
    coverage: { collection_complete: verifiedEndpoint && !state.compatibility && !unresolved.length,
      stop_reason: state.stop_reason, visible_endpoint_verified: verifiedEndpoint && !state.compatibility,
      observed_count: list.length, unresolved, media_review_complete: false, text_review_complete: false },
    conclusion: 'incomplete',
  };
}

export async function collectBatch({ state, directory, snapshot, advance, recover, cancelled,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const journal = path.join(directory, 'items.ndjson');
  const statusFile = path.join(directory, 'job.json');
  const items = replayItems(journal);
  const seenSnapshots = new Set([...items.values()].filter(item => item.source_id.startsWith('viewport-')).map(item => item.text));
  let idle = 0;
  let recoveryAttempted = false;
  const deadline = now() + state.max_seconds * 1000;
  state.state = 'running';
  state.worker_pid = process.pid;
  state.iterations ||= 0;
  state.resumed_at = state.started_at ? new Date(now()).toISOString() : null;
  state.started_at ||= new Date(now()).toISOString();
  const checkpoint = () => {
    state.updated_at = new Date(now()).toISOString();
    state.item_count = items.size;
    saveJson(statusFile, state);
  };
  const stop = (status, reason) => { state.state = status; state.stop_reason = reason; };
  const runBounded = async operation => {
    const controller = new AbortController();
    const cancelError = reason => Object.assign(new Error(reason), { code: reason });
    const abort = reason => controller.abort(cancelError(reason));
    if (cancelled()) throw cancelError('cancelled');
    const remaining = deadline - now();
    if (remaining <= 0) throw cancelError('job_deadline');
    const timeout = setTimeout(() => abort('job_deadline'), remaining);
    const cancelTimer = setInterval(() => { if (cancelled()) abort('cancelled'); }, 200);
    const interrupted = new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    try {
      const result = await Promise.race([operation(controller.signal), interrupted]);
      if (cancelled()) throw cancelError('cancelled');
      if (now() >= deadline) throw cancelError('job_deadline');
      return result;
    } finally { clearTimeout(timeout); clearInterval(cancelTimer); }
  };
  checkpoint();
  try {
    while (!TERMINAL.has(state.state)) {
      if (cancelled()) { stop('paused', 'cancelled'); break; }
      if (now() >= deadline || state.iterations >= state.max_steps) { stop('needs_review', 'limit'); break; }
      const raw = await runBounded(signal => snapshot(signal));
      state.iterations += 1;
      const { items: observed, page } = normalizeSnapshot(raw, { compatibility: state.compatibility, sequence: state.iterations });
      if (!page.url || scopedUrl(page.url) !== scopedUrl(state.target_url) || page.route_matches_recipe === false) {
        stop('needs_review', 'target_changed'); break;
      }
      if (page.verification_hints?.length) { stop('needs_review', 'verification_required'); break; }
      if (page.login_hints?.length) { stop('needs_review', 'login_required'); break; }
      state.page_extraction_truncated ||= Boolean(page.extraction_truncated);
      let progress = 0;
      for (const item of observed) {
        if (state.compatibility && seenSnapshots.has(item.text)) continue;
        if (state.compatibility) seenSnapshots.add(item.text);
        const previous = items.get(item.source_id);
        const combined = mergeItem(previous, item);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(combined)) {
          items.set(item.source_id, combined);
          fs.appendFileSync(journal, JSON.stringify(combined) + '\n', 'utf8');
          progress += 1;
        }
      }
      // Persist what was actually obtained, but never advance through a broken
      // snapshot or manufacture progress out of anonymous, textless media.
      if (page.extraction_truncated) { stop('needs_review', 'extraction_truncated'); break; }
      const unboundEmpty = observed.some(item => item.observation_identity === 'unresolved_occurrence'
        && !item.text.trim() && !item.quoted_text.trim());
      if (unboundEmpty) { stop('needs_review', 'unattributed_empty_card'); break; }
      if (items.size > 100_000 || (fs.existsSync(journal) && fs.statSync(journal).size > 200 * 1024 * 1024)) {
        stop('needs_review', 'cache_limit'); break;
      }
      idle = progress ? 0 : idle + 1;
      if (progress) recoveryAttempted = false;
      const pagination = page.pagination;
      const endpoint = !page.loading && !page.extraction_truncated && !state.compatibility
        && ((page.explicit_end_hints?.length || 0) > 0 || (pagination?.verified && pagination.at_last_page === true));
      if (endpoint) { stop('collected', 'visible_endpoint'); break; }
      if (idle >= state.plateau_steps) {
        if (!recoveryAttempted) {
          await runBounded(signal => recover(signal));
          recoveryAttempted = true;
          idle = 0;
          checkpoint();
          await runBounded(signal => wait(Math.min(state.interval_ms, Math.max(1, deadline - now())), signal));
          continue;
        }
        stop('needs_review', observed.length ? 'stall' : 'empty_response');
        break;
      }
      checkpoint();
      if (cancelled()) { stop('paused', 'cancelled'); break; }
      // Some infinite feeds keep a rendered loading marker below already loaded
      // cards. An explicit per-job opt-in may advance those cards after a short
      // wait; an empty loading shell still never advances.
      const loadedCardsCanAdvance = state.scroll_with_loaded_items === true
        && observed.length > 0 && (progress > 0 || idle >= 2);
      if (!page.loading || loadedCardsCanAdvance) await runBounded(signal => advance(page, signal));
      await runBounded(signal => wait(Math.min(state.interval_ms, Math.max(1, deadline - now())), signal));
    }
  } catch (error) {
    stop(error.code === 'cancelled' ? 'paused' : 'needs_review', error.code === 'cancelled' ? 'cancelled' : error.code === 'job_deadline' ? 'limit' : 'error');
    state.error = { code: error.code || error.name || 'collection_error', message: String(error.message || error).slice(0, 500) };
  } finally {
    checkpoint();
    saveJson(path.join(directory, 'result.json'), buildResult(state, items));
  }
  return buildResult(state, items);
}
