import { buildAiEvidence } from './ai-payload.js';
import { INFER_NAMES, SAVE_NAMES } from './ai-messages.js';
import { AI_BATCH_SIZE } from './ai-client.js';
import { collectTargets } from './collector.js';
import { checkName } from './detector.js';
import { createFingerprint, createPageKey, exactFingerprintMatch } from './previous-fingerprint.js';

const memo = new WeakMap();
let network = Promise.resolve();

function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function resolveAiResults(result, fingerprints, isCurrent, runtime = globalThis.chrome?.runtime) {
  const pageKey = createPageKey(result.pageUrl);
  if (!pageKey || !runtime?.sendMessage || !runtime.id || window !== window.top
    || !result.report.some((entry) => entry.match.decision === 'ai')) return;

  const readOriginal = (fn) => result.withOriginalLabels ? result.withOriginalLabels(fn) : fn();
  const work = readOriginal(() => result.report.flatMap((entry, index) => {
    if (entry.match.decision !== 'ai') return [];
    const element = result.missing[index].element;
    const evidence = buildAiEvidence(element, entry);
    const fingerprint = fingerprints[index]?.eligible ? fingerprints[index] : null;
    const signature = JSON.stringify([pageKey, evidence, fingerprint?.canonical]);
    const existing = memo.get(element);
    const request = existing?.signature === signature && existing.expires > Date.now()
      ? existing : { signature, payload: { requestId: newRequestId(), ...evidence }, fingerprint };
    request.isCurrent = isCurrent;
    return [{ element, entry, request }];
  }));

  for (let offset = 0; offset < work.length; offset += AI_BATCH_SIZE) {
    if (!isCurrent()) return;
    const batch = work.slice(offset, offset + AI_BATCH_SIZE);
    const fresh = batch.filter(({ request }) => !request.promise);
    if (fresh.length) {
      const send = network.then(async () => {
        const current = fresh.filter(({ request }) => request.isCurrent());
        if (!current.length) return { status: 'stale' };
        try {
          return await runtime.sendMessage({
            type: INFER_NAMES, pageKey,
            items: current.map(({ request }) => ({ payload: request.payload, fingerprint: request.fingerprint })),
          });
        } catch { return { status: 'unavailable' }; }
      });
      network = send.then(() => {});
      for (const { element, request } of fresh) {
        request.expires = Infinity;
        memo.set(element, request);
        request.promise = send.then((response) => {
          const reply = response?.results?.find((row) => row.requestId === request.payload.requestId);
          const status = response?.status === 'ok' && !reply ? 'stale' : response?.status || 'unavailable';
          request.expires = Date.now() + (status === 'ok' ? 60000 : status === 'stale' ? 0 : 20000);
          return { status, label: reply?.label, model: response?.model, httpStatus: response?.httpStatus };
        });
      }
    }

    const replies = await Promise.all(batch.map(({ request }) => request.promise));
    if (!isCurrent()) {
      console.info('[FocusBridge AI] 새 검사가 시작되어 이전 검사에는 AI 응답을 반영하지 않았습니다.');
      return;
    }
    const currentTargets = new Set(collectTargets(document));
    const ids = [];
    let changed = false;
    readOriginal(() => {
      batch.forEach(({ element, entry, request }, i) => {
        const { status, label, model, httpStatus } = replies[i];
        result.aiStatus = status;
        entry.aiStatus = status === 'ok' ? (label ? 'stale-element' : 'no-label') : status;
        entry.aiModel = model;
        entry.aiHttpStatus = httpStatus;
        if (status !== 'ok' || !label || !currentTargets.has(element)) return;
        const now = checkName(element);
        if (now.status !== entry.status || now.name !== entry.currentName || now.role !== entry.role) return;
        const current = request.fingerprint ? createFingerprint(element) : null;
        if (request.fingerprint && !exactFingerprintMatch(request.fingerprint, current)) return;
        const signature = JSON.stringify([pageKey, buildAiEvidence(element, entry), current?.canonical]);
        if (signature !== request.signature) return;
        entry.match = { decision: 'confirm', pattern: 'AI', label, score: 0, candidates: [], source: 'ai' };
        entry.aiStatus = 'label-ready';
        entry.aiStorage = !current ? 'ineligible' : request.saved ? 'already-saved' : 'pending';
        changed = true;
        if (current && !request.saved) ids.push(request.payload.requestId);
      });
    });
    if (changed) window.dispatchEvent(new Event('focusbridge:ai-labels-ready'));
    if (ids.length && isCurrent()) {
      try {
        const saved = await runtime.sendMessage({ type: SAVE_NAMES, pageKey, ids });
        for (const { entry, request } of batch) {
          if (entry.aiStorage !== 'pending') continue;
          const outcome = saved?.results?.find((row) => row.requestId === request.payload.requestId);
          entry.aiStorage = outcome?.status || 'storage-error';
          if (outcome && outcome.status !== 'storage-error') request.saved = true;
        }
      } catch {
        for (const { entry } of batch) {
          if (entry.aiStorage === 'pending') entry.aiStorage = 'storage-error';
        }
      }
    }
    console.groupCollapsed('[FocusBridge AI] 응답 결과');
    console.table(batch.map(({ entry }) => ({
      model: entry.aiModel,
      status: entry.labelApplied && entry.aiStatus === 'label-ready' ? 'applied' : entry.aiStatus,
      http: entry.aiHttpStatus,
      label: entry.match.source === 'ai' ? entry.match.label : null,
      storage: entry.aiStorage,
      selector: entry.selector,
    })));
    console.groupEnd();
    if (replies.some(({ status }) => status !== 'ok')) break;
  }
}
