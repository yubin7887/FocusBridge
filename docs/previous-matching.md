# Previous Matching — 1·2·3단계

식별 정보 생성·정확 비교, Service Worker의 IndexedDB 저장·조회,
content.js의 이전 매칭 우선 실행까지 구현했다.
개인 API 키를 등록하면 AI가 생성한 이름을 IndexedDB에 저장해 다음 방문에 재사용한다.

## 사용 방법

```js
import { createFingerprint, exactFingerprintMatch } from '../src/previous-fingerprint.js';

const before = createFingerprint(element);
// 재방문하거나 비동기 작업이 끝난 뒤, 현재 요소에서 다시 수집한다.
const after = createFingerprint(currentElement);
const matches = exactFingerprintMatch(before, after);
```

- `eligible: true`: 비교 가능한 스냅샷. `canonical`은 고정 순서로 직렬화한 정보다.
- `eligible: false`: `reason`에 제외 사유가 있다. 사전 매칭으로 넘긴다.
- 이 함수는 확정 이름을 생성하지 않으며, true도 기능의 의미를 보장하지 않는다.
- DB 조회는 만료·출처·충돌 여부를 확인한다. 별도의 AI 의미 검증 단계는 없다.
  이름 정확도와 이전 매칭 정확도는 평가 데이터로 따로 측정한다.

## 합의한 정책과 현재 구현

- 최상위 HTTP(S) 페이지만 대상으로 한다. iframe은 제외한다.
- 경로, 쿼리, 해시를 유지하며 다른 페이지와 기록을 공유하지 않는다.
- 정상적인 접근성 이름이 있는 요소는 제외한다.
- 명시적 `data-action`/`data-command` 또는 실제 HTTP(S) 링크 목적지가 있으면 후보로 받는다.
  이것들이 없어도 자기 ID/class + 아이콘 정보 + 부모 ID/class/role이 함께 있으면 후보로 받는다.
  모든 후보는 유일성 검사와 전체 Fingerprint 일치를 별도로 통과해야 한다.
  ID나 위치만 있는 빈 버튼은 제외한다. 이 조합은 의미적 안전성을 증명하는 규칙은 아니다.
- 태그·선별된 속성·aria 속성·상태·하위 구조·관련 문맥·조상 경로를 비교한다.
  관련 문맥은 부모 속성·부모 직접 텍스트·바로 앞뒤 형제 요소로 한정한다.
  더 먼 형제의 텍스트 변경은 비교하지 않는다. 관련 문맥 범위 안의 변경은 실패 처리한다.
  요소 자체의 aria 참조 및 form 참조는 대상 문맥도 비교한다.
- class 순서·중복은 정규화한다. 일반 텍스트는 잘라내거나 공백을 합치지 않는다.
- 위치·레이아웃용 style은 수집하지 않는다. 입력값과 임의의 data 속성도 수집하지 않는다.
- 중복 ID, 동일한 요소 서명, 누락된 참조, 너무 큰 문맥은 실패 처리한다.
- 주변 입력 필드는 식별 속성만 비교하며 입력값·내부 텍스트는 수집하지 않는다.
  대상 자체가 입력 필드인 경우는 아직 제외한다. 관련 문맥 안의 iframe/canvas 등은 실패한다.
- 열린 Shadow DOM 안의 요소는 host를 포함한 경로로 구분한다. 수집할 문맥 자체에
  별도의 shadow subtree가 있으면 완전히 비교하지 못하므로 실패 처리한다.

보수적인 초기 구현이므로 실제 사이트에서 재사용 가능한 비율은 낮을 수 있다.
허용 범위는 실제 사례와 회귀 테스트를 추가하며 넓힌다. DOM으로 드러나지 않는
이벤트 핸들러 변경, 서버 동작 변경, 외부 CSS/이미지/SVG 리소스 내용 변경은 감지하지 못한다.
따라서 Exact Match는 **정해진 관찰 정보의 동일성**이며 의미적 동일성의 증명은 아니다.
비교 범위 변경을 구분하기 위해 Fingerprint 버전을 2로 올렸다. 이전 버전과는 매칭하지 않는다.

## 검증

```powershell
npm run test:previous
npm run build
npm run test:all
```

Playwright 브라우저가 없다면 설치된 Chrome을 사용할 수 있다.

```powershell
$env:CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:all
```

## 2단계: 저장·조회

- `previous-store.js`: DB `focusbridge`의 `confirmedLabels` 저장소를 관리한다.
- 기본 키: `[pageKey, fingerprintVersion, fingerprintHash]`.
- 인덱스: `pageKey`, `expiresAt`. SHA-256 키와 원본 canonical을 함께 보관한다.
- `saveAiResult({fingerprint, label, source: 'ai'})`로 AI 생성 결과를 저장한다.
  빈 이름·문자열 길이·출처·Fingerprint 형식만 확인하며 `verification`은 요구하거나 저장하지 않는다.
  기존 `confirmedLabels` 저장소 이름은 데이터 호환성을 위해 유지한다. 검증 완료를 뜻하지 않는다.
  기존 레코드에 남아 있는 `verification`은 조회·재사용 판정에 사용하지 않는다.
- 유효기간 중 같은 이름의 중복 저장은 기존 만료를 연장하지 않는다.
- 유효기간 중 다른 이름은 충돌로 표시하고 재사용하지 않는다.
- 만료된 기록은 기존 이름·충돌 상태와 무관하게 새 AI 결과로 교체하고 7일을 다시 계산한다.
  시간 경과만으로 충돌 기록이 다시 활성화되는 것은 아니다.
- 남아 있는 기록과 같은 해시인데 원본 식별 정보가 다르면 충돌 처리한다.
- 비동기 저장 전에 입력 정보를 복사하며, 만료 판정은 실제 DB 기록을 읽은 시각을 기준으로 한다.
- `lookupPage(pageKey)`는 해당 페이지의 유효한 기록만 반환한다.
- 저장·조회할 때 `expiresAt` 인덱스로 모든 페이지의 만료 기록(충돌 기록 포함)을 실제 삭제한다.
  별도 타이머는 없으며 확장 프로그램을 사용하지 않는 동안에는 다음 저장·조회까지 남아 있다.
  삭제 시점 이후에 만료된 기록도 조회 결과에서는 제외한다.
- `background.js`는 조회 메시지만 처리한다. 최상위 탭 문서의 실제 발신 URL과 요청 URL을
  비교한다. iframe·다른 페이지 조회·다른 확장 발신자는 거부한다.
- 메시지: `{type: 'focusbridge:previous:lookup', pageKey}`.
  응답: `{ok: true, records}` 또는 `{ok: false, error}`.
- AI 응답과 일치하는 요청 ID를 같은 문서가 확인한 경우에만 저장한다.

실제 확장 테스트는 [Playwright 공식 확장 테스트 방식](https://playwright.dev/docs/chrome-extensions)에
따라 별도 Chromium과 임시 프로필을 사용한다. 개인 Chrome 프로필은 사용하지 않는다.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache\playwright'
npx playwright install chromium --no-shell
npm run test:extension
```

## 3단계: 탐지 흐름 연결

`수집 → 이름 누락 탐지 → 이전 기록 조회·정확 비교 → 실패 항목만 사전 매칭`

- 최초 방문처럼 기록이 없으면 바로 사전 매칭 결과를 사용한다.
- 이전 매칭 성공은 기존 match 형식을 유지하며 `pattern: 'P1'`, `source: 'previous'`로 구분한다.
  `score: 0`은 사전 점수를 계산하지 않았다는 뜻이며 정확도 수치가 아니다.
- 사전 매칭은 전체 report의 `pageCommon()`을 공유하여 기존 판정 기준을 유지한다.
- iframe은 이전 조회를 건너뛰고 기존 탐지·사전 매칭을 실행한다.
- DB 오류·확장 API 부재·2초 시간 초과는 사전 매칭으로 넘긴다.
- 진행 중인 동일 페이지 조회만 공유하며 완료된 결과는 캐시하지 않는다.
- 변경 감지 즉시 검사 세대를 무효화하고 500ms 디바운스로 다시 검사한다.
  응답 후 URL·DOM 요소·현재 이름·문맥·Fingerprint를 재확인한다.
- 속성·텍스트·열린 Shadow DOM을 감시하고, 500ms 간격으로 URL 및 새 Shadow DOM을 확인한다.
  페이지의 history 함수를 덮어쓰지 않는다. 대규모 DOM에서는 이 순회 비용을 추후 측정할 필요가 있다.
- `scan()`은 이제 Promise를 반환하고 폐기된 검사는 null을 반환한다.
  `window.__focusBridge`에는 마지막 유효한 결과만 게시하며 변경 감지 시 null로 무효화한다.
  `window.__focusBridgeReady`는 자동으로 시작한 최근 검사의 Promise이다.
  최신 검사가 예약된 동안에는 이전 Promise가 남을 수 있으므로 테스트는 유효한 report도 기다린다.
- 결과에 `pageUrl`, `scanId`, `previousStatus`가 추가된다. 콘솔·오버레이도 유효한 결과에만 갱신한다.
- 확장 테스트는 Gemini와 GPT 응답을 모의 처리하고, 재방문에서 저장된 이름이 사용되는지 확인한다.
  테스트 전용 보고서 전달 코드는 임시 확장에만 추가하며 제품 코드에는 넣지 않는다.

### AI 연결

사전 매칭 결과가 `ai`인 요소의 필요한 단서만 설정에서 선택한 AI로 보낸다. Fingerprint는 확장 안에서 보관한다.
응답 후 같은 페이지·요소인지 다시 확인하고, 유효한 이름과 저장 가능한 Fingerprint가 있는 경우
Service Worker에서 `saveAiResult()`를 호출한다.
