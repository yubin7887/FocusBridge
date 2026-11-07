import { createPageKey, FINGERPRINT_VERSION } from './previous-fingerprint.js';

export const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 기존 DB 호환성을 위해 저장소 이름은 유지한다. 검증 완료를 뜻하지 않는다.
const STORE = 'confirmedLabels';

function validateFingerprint(fp) {
  if (fp?.eligible !== true || fp.version !== FINGERPRINT_VERSION
    || !fp.pageKey || createPageKey(fp.pageKey) !== fp.pageKey
    || typeof fp.canonical !== 'string' || fp.canonical.length > 16000) {
    throw new Error('invalid-fingerprint');
  }
  let payload;
  try { payload = JSON.parse(fp.canonical); } catch { throw new Error('invalid-fingerprint'); }
  if (!payload || payload.pageKey !== fp.pageKey || payload.version !== fp.version
    || !payload.element || !payload.path || !payload.name) throw new Error('invalid-fingerprint');
}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// AI 생성 결과의 기본 형식만 확인한다. 이름의 의미적 정확성은 별도 평가에서 측정한다.
export function createPreviousStore({ dbName = 'focusbridge', now = Date.now } = {}) {
  let connection;
  function open() {
    if (!connection) {
      connection = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, {
            keyPath: ['pageKey', 'fingerprintVersion', 'fingerprintHash'],
          });
          store.createIndex('pageKey', 'pageKey');
          store.createIndex('expiresAt', 'expiresAt');
        };
        request.onerror = () => { connection = undefined; reject(request.error); };
        let blocked = false;
        request.onblocked = () => { blocked = true; connection = undefined; reject(new Error('database-blocked')); };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) { db.close(); return; }
          db.onversionchange = () => { db.close(); connection = undefined; };
          resolve(db);
        };
      });
    }
    return connection;
  }

  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('transaction-aborted'));
      tx.onerror = () => {}; // abort 이벤트에서 실패를 전달한다.
      try {
        operation(tx.objectStore(STORE), (value) => { result = value; });
      } catch (error) { tx.abort(); reject(error); }
    });
  }

  async function saveAiResult({ fingerprint, label, source }) {
    // 호출자가 비동기 저장 도중 원본 객체를 바꿔도 호출 당시 값만 저장한다.
    fingerprint = { ...fingerprint };
    validateFingerprint(fingerprint);
    if (source !== 'ai' || typeof label !== 'string' || !label.trim() || label.length > 200) {
      throw new Error('invalid-ai-result');
    }
    // 해시 계산은 트랜잭션을 열기 전에 끝낸다.
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint.canonical));
    const fingerprintHash = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
    const key = [fingerprint.pageKey, fingerprint.version, fingerprintHash];
    await removeExpired();
    return transaction('readwrite', (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const existing = request.result;
        // DB 열기/트랜잭션 대기 시간이 아니라 실제 기록 판정 시각을 사용한다.
        const time = now();
        const active = existing && existing.expiresAt > time;
        // 해시가 같아도 원본이 다르면 만료 여부와 무관하게 같은 요소로 취급하지 않는다.
        if (existing && (existing.fingerprintCanonical !== fingerprint.canonical
          || (active && (existing.status === 'conflict' || existing.label !== label.trim())))) {
          store.put({ ...existing, status: 'conflict', updatedAt: time });
          done({ status: 'conflict' });
        } else if (active) {
          done({ status: 'unchanged', expiresAt: existing.expiresAt });
        } else {
          const record = {
            pageKey: fingerprint.pageKey, fingerprintVersion: fingerprint.version,
            fingerprintHash, fingerprintCanonical: fingerprint.canonical,
            label: label.trim(), source: 'ai',
            status: 'active', createdAt: existing?.createdAt ?? time, updatedAt: time,
            expiresAt: time + RECORD_TTL_MS,
          };
          store.put(record);
          done({ status: 'saved', expiresAt: record.expiresAt });
        }
      };
    });
  }

  async function lookupPage(pageKey) {
    if (!pageKey || createPageKey(pageKey) !== pageKey) throw new Error('invalid-page');
    await removeExpired();
    const db = await open();
    const records = await requestResult(db.transaction(STORE).objectStore(STORE).index('pageKey').getAll(pageKey));
    const time = now();
    return records.filter((r) => r.status === 'active' && r.expiresAt > time
      && r.fingerprintVersion === FINGERPRINT_VERSION && r.source === 'ai');
  }

  // 별도 타이머 없이 저장·조회 시 만료 인덱스로 정리한다.
  // 확장 프로그램이 꺼져 있는 동안에는 실행하지 않고 다음 사용 시 처리한다.
  async function removeExpired() {
    return transaction('readwrite', (store, done) => {
      let deleted = 0;
      const request = store.index('expiresAt').openCursor(IDBKeyRange.upperBound(now()));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done(deleted); return; }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
    });
  }

  async function close() {
    const pending = connection;
    connection = undefined;
    if (pending) (await pending).close();
  }
  return { saveAiResult, lookupPage, close };
}
