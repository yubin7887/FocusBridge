# Previous Matching — 1단계

현재 단계는 **식별 정보 생성과 정확 비교**다. IndexedDB, Service Worker,
7일 만료 정책, content.js 연결, AI 호출, aria-label 적용은 아직 구현하지 않았다.
기존 탐지·사전 매칭 흐름은 그대로다.

## 사용 방법

```js
import { createFingerprint, exactFingerprintMatch } from '../src/previous-fingerprint.js';

const before = createFingerprint(element);
// 재방문하거나 비동기 작업이 끝난 뒤, 현재 요소에서 다시 수집한다.
const after = createFingerprint(currentElement);
const matches = exactFingerprintMatch(before, after);
```

- `eligible: true`: 비교 가능한 스냅샷. `canonical`은 고정 순서로 직렬화한 정보다.
- `eligible: false`: `reason`에 제외 사유가 있다. 향후 연결 시 사전 매칭으로 넘긴다.
- 이 함수는 확정 이름을 생성하지 않으며, true도 기능의 의미를 보장하지 않는다.
- DB 레코드의 만료·AI 검증·충돌 여부는 다음 단계에서 별도로 검사한다.

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

다음 단계는 확장 프로그램 컨텍스트의 IndexedDB 저장·조회와 검증된 결과를
받는 인터페이스다. 실제 AI 확정 기준은 팀원과 합의 후 연결한다.
