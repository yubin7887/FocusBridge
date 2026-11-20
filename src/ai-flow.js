import { buildAiEvidence } from './ai-payload.js';
import { CAPTURE_ICONS, INFER_NAMES, SAVE_NAMES, LOAD_IMAGES } from './ai-messages.js';
import { collectAiIcons } from './ai-icon.js';
import { AI_BATCH_SIZE } from './ai-client.js';
import { collectTargets } from './collector.js';
import { checkName } from './detector.js';
import { createFingerprint, createPageKey, exactFingerprintMatch } from './previous-fingerprint.js';

const memo = new WeakMap();
const loggedResponses = new WeakSet();
const duplicateLinks = new Map();
const MAX_DUPLICATE_LINKS = 128;
const MAX_LINK_MARKUP_LENGTH = 16000;
const FAILED_REQUEST_COOLDOWN_MS = 60000;
let duplicateLinksPage;
let network = Promise.resolve();

function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function duplicateLinkKey(element, fingerprint, evidence) {
  if (fingerprint?.reason !== 'ambiguous-element' || !element.matches('a[href]')) return null;
  const href = element.href;
  if (!element.getAttribute('href').trim() || typeof href !== 'string' || !/^https?:\/\//i.test(href) || href.includes('#')) return null;
  const markup = element.outerHTML;
  if (markup.length > MAX_LINK_MARKUP_LENGTH) return null;
  // Keep the original destination (including the query) and markup local.
  return JSON.stringify([href, markup, evidence]);
}

function freshWork(work) {
  const seen = new Set();
  return work.filter(({ request }) => {
    if (request.promise || seen.has(request)) return false;
    seen.add(request);
    return true;
  });
}

export async function resolveAiResults(result, fingerprints, isCurrent, runtime = globalThis.chrome?.runtime) {
  const pageKey = createPageKey(result.pageUrl);
  if (duplicateLinksPage !== result.pageUrl) {
    duplicateLinks.clear();
    duplicateLinksPage = result.pageUrl;
  }
  if (!pageKey || !runtime?.sendMessage || !runtime.id || window !== window.top
    || !result.report.some((entry) => entry.match.decision === 'ai')) return;

  const pendingLinks = new Map();
  const readOriginal = (fn) => result.withOriginalLabels ? result.withOriginalLabels(fn) : fn();
  const work = readOriginal(() => result.report.flatMap((entry, index) => {
    if (entry.match.decision !== 'ai') return [];
    const element = result.missing[index].element;
    const evidence = buildAiEvidence(element, entry);
    const fingerprint = fingerprints[index]?.eligible ? fingerprints[index] : null;
    const signature = JSON.stringify([pageKey, evidence, fingerprint?.canonical]);
    const linkKey = duplicateLinkKey(element, fingerprints[index], evidence);
    const existing = linkKey ? duplicateLinks.get(linkKey) : memo.get(element);
    const shared = pendingLinks.get(linkKey);
    const cached = existing?.signature === signature && existing.expires > Date.now() ? existing : null;
    const request = shared ?? cached ?? { signature, payload: { requestId: newRequestId(), ...evidence }, fingerprint, linkKey };
    if (linkKey) pendingLinks.set(linkKey, request);
    request.isCurrent = isCurrent;
    if (!shared) request.imageElement = element;
    return [{ element, entry, request, reused: Boolean(shared || cached) }];
  }));

  for (let offset = 0; offset < work.length; offset += AI_BATCH_SIZE) {
    if (!isCurrent()) return;
    const batch = work.slice(offset, offset + AI_BATCH_SIZE);
    const fresh = freshWork(batch);
    if (fresh.length) {
      const send = network.then(async () => {
        // A newer scan can take ownership of a pending request during image preparation.
        const active = fresh.filter(({ request }) => request.isCurrent())
          .map(({ request }) => ({ request, element: request.imageElement }));
        if (!active.length) return { status: 'stale' };
        const sameImageTarget = ({ request, element }) => request.isCurrent() && request.imageElement === element;
        const captured = await collectAiIcons(active, async (viewport, rects) => {
          if (!active.every(sameImageTarget)) return { images: [], status: 'scan-changed' };
          return runtime.sendMessage({ type: CAPTURE_ICONS, pageKey, viewport, rects });
        }, async (sources) => {
          const currentIds = new Set(active.filter(sameImageTarget).map(({ request }) => request.payload.requestId));
          const items = sources.filter(({ requestId }) => currentIds.has(requestId));
          return items.length ? runtime.sendMessage({ type: LOAD_IMAGES, pageKey, items }) : { images: [] };
        }).catch(() => null);
        const current = active.filter(({ request }) => request.isCurrent());
        if (!current.length) return { status: 'stale' };
        try {
          const items = current.map((item) => {
            const { request } = item;
            const image = sameImageTarget(item) ? captured?.images.get(request.payload.requestId)?.() : undefined;
            request.imageSource = image?.source;
            return { payload: request.payload, fingerprint: request.fingerprint, image: image?.data };
          });
          const imageStatus = items.every(({ image }) => image) ? 'attached'
            : captured?.status === 'captured' ? 'geometry-changed' : captured?.status || 'scan-changed';
          return await runtime.sendMessage({ type: INFER_NAMES, pageKey, items, imageStatus });
        } catch { return { status: 'unavailable' }; }
      });
      network = send.then(() => {}, () => {});
      for (const { element, request } of fresh) {
        request.expires = Infinity;
        if (request.linkKey) {
          duplicateLinks.delete(request.linkKey);
          if (duplicateLinks.size >= MAX_DUPLICATE_LINKS) duplicateLinks.delete(duplicateLinks.keys().next().value);
          duplicateLinks.set(request.linkKey, request);
        } else memo.set(element, request);
        request.promise = send.then((response) => {
          const reply = response?.results?.find((row) => row.requestId === request.payload.requestId);
          const status = reply ? 'ok' : response?.status === 'ok' ? 'stale' : response?.status || 'unavailable';
          request.expires = status === 'ok' ? Infinity : status === 'stale' ? 0
            : response?.retryAt ?? Date.now() + FAILED_REQUEST_COOLDOWN_MS;
          return { status, label: reply?.label, model: response?.model,
            httpStatus: reply?.httpStatus ?? response?.httpStatus, requestCount: reply?.requestCount ?? response?.requestCount,
            retryAt: response?.retryAt };
        });
      }
    }

    const replies = await Promise.all(batch.map(({ request }) => request.promise));
    if (!isCurrent()) {
      if (batch.some(({ reused }) => !reused)) {
        console.info('[FocusBridge AI] 새 검사가 시작되어 이전 검사에는 AI 응답을 반영하지 않았습니다.');
      }
      return;
    }
    const failure = replies.find(({ status }) => status !== 'ok');
    result.aiStatus = failure?.status ?? 'ok';
    const ready = batch.flatMap((item, i) => {
      const { entry } = item;
      const { status, label, model, httpStatus, requestCount } = replies[i];
      entry.aiStatus = status === 'ok' ? (label ? 'stale-element' : 'no-label') : status;
      entry.aiModel = model;
      entry.aiHttpStatus = httpStatus;
      entry.aiRequestCount = requestCount;
      entry.aiReused = item.reused;
      entry.aiImageSource = item.request.imageSource ?? 'none';
      return status === 'ok' && label ? [{ ...item, label }] : [];
    });
    let changed = false;
    if (ready.length) {
      const currentTargets = new Set(collectTargets(document));
      readOriginal(() => {
        for (const { element, entry, request, label } of ready) {
          if (!currentTargets.has(element)) continue;
          const now = checkName(element);
          if (now.status !== entry.status || now.name !== entry.currentName || now.role !== entry.role) continue;
          const current = request.fingerprint || request.linkKey ? createFingerprint(element) : null;
          if (request.fingerprint && !exactFingerprintMatch(request.fingerprint, current)) continue;
          const evidence = buildAiEvidence(element, entry);
          if (request.linkKey && duplicateLinkKey(element, current, evidence) !== request.linkKey) continue;
          const signature = JSON.stringify([pageKey, evidence, current?.canonical]);
          if (signature !== request.signature) continue;
          entry.match = { decision: 'confirm', pattern: 'AI', label, score: 0, candidates: [], source: 'ai' };
          entry.aiStatus = 'label-ready';
          changed = true;
        }
      });
    }
    if (changed) window.dispatchEvent(new Event('focusbridge:ai-labels-ready'));

    const ids = [];
    for (const { element, entry, request } of batch) {
      if (entry.aiStatus !== 'label-ready') continue;
      if (entry.labelApplied !== true || !element.isConnected || element.getAttribute('aria-label') !== entry.match.label) {
        entry.labelApplied = false;
        entry.aiStorage = 'not-applied';
        continue;
      }
      entry.aiStorage = !request.fingerprint ? 'ineligible' : request.saved ? 'already-saved' : 'pending';
      if (entry.aiStorage === 'pending') ids.push(request.payload.requestId);
    }
    if (ids.length && isCurrent()) {
      try {
        const saved = await runtime.sendMessage({ type: SAVE_NAMES, pageKey, ids });
        for (const { entry, request } of batch) {
          if (entry.aiStorage !== 'pending') continue;
          const outcome = saved?.results?.find((row) => row.requestId === request.payload.requestId);
          entry.aiStorage = outcome?.status || 'storage-error';
          if (outcome && outcome.status !== 'storage-error') request.saved = true;
          // A worker restart or expiry can discard an unused save ticket.
          if (!outcome && saved?.status === 'ok') request.expires = 0;
        }
      } catch {
        for (const { entry } of batch) {
          if (entry.aiStorage === 'pending') entry.aiStorage = 'storage-error';
        }
      }
    }
    // A reused response may never have been logged if its original scan became stale.
    const firstResults = [];
    const seen = new Set();
    for (const item of batch) {
      if (loggedResponses.has(item.request) || seen.has(item.request)) continue;
      seen.add(item.request);
      firstResults.push(item);
    }
    if (firstResults.length) {
      console.groupCollapsed('[FocusBridge AI] 응답 결과');
      console.table(firstResults.map(({ entry }) => ({
        model: entry.aiModel,
        status: entry.labelApplied && entry.aiStatus === 'label-ready' ? 'applied' : entry.aiStatus,
        requests: entry.aiRequestCount,
        reused: entry.aiReused,
        http: entry.aiHttpStatus,
        imageSource: entry.aiImageSource,
        label: entry.match.source === 'ai' ? entry.match.label : null,
        storage: entry.aiStorage,
        selector: entry.selector,
      })));
      console.groupEnd();
      for (const { request } of firstResults) loggedResponses.add(request);
    }
    if (failure) return failure.status === 'service-unavailable' ? failure.retryAt : undefined;
  }
}
