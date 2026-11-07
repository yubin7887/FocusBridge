import { createPageKey, exactFingerprintMatch } from './previous-fingerprint.js';
import { LOOKUP_PREVIOUS } from './previous-messages.js';

// 진행 중인 같은 페이지 조회만 공유한다. 완료 결과는 캐시하지 않는다.
export function createPreviousLookup({ runtime = globalThis.chrome?.runtime, timeoutMs = 2000 } = {}) {
  const pending = new Map();
  return function lookup(pageUrl) {
    const pageKey = createPageKey(pageUrl);
    if (!pageKey || !runtime?.sendMessage) return Promise.resolve({ status: 'unavailable', records: [] });
    if (pending.has(pageKey)) return pending.get(pageKey);
    const request = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 'timeout', records: [] }), timeoutMs);
      Promise.resolve().then(() => runtime.sendMessage({ type: LOOKUP_PREVIOUS, pageKey })).then(
        (response) => finish(response?.ok === true && Array.isArray(response.records)
          ? { status: 'ok', records: response.records } : { status: 'error', records: [] }),
        () => finish({ status: 'error', records: [] }),
      );
    }).finally(() => pending.delete(pageKey));
    pending.set(pageKey, request);
    return request;
  };
}

export function matchPrevious(fingerprint, records, time = Date.now()) {
  if (!fingerprint?.eligible) return null;
  const candidates = records.filter((record) => record && exactFingerprintMatch({
    eligible: true, pageKey: record.pageKey, version: record.fingerprintVersion,
    canonical: record.fingerprintCanonical,
  }, fingerprint));
  // 중복 응답도 모호한 기록으로 취급한다. 응답 수신 후 만료 여부를 다시 검사한다.
  if (candidates.length !== 1) return null;
  const record = candidates[0];
  if (record.status !== 'active' || record.source !== 'ai' || record.verification?.status !== 'confirmed'
    || !Number.isFinite(record.expiresAt) || record.expiresAt <= time
    || typeof record.label !== 'string' || !record.label.trim() || record.label.length > 200) return null;
  return { decision: 'confirm', pattern: 'P1', label: record.label, score: 0, candidates: [], source: 'previous' };
}
