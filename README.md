# FocusBridge

FocusBridge는 접근성 이름이 빠진 버튼과 링크 등을 찾아 이름을 보완하는 Chrome 확장 프로그램입니다. 아이콘만 있는 메뉴나 이미지 링크처럼 화면에는 기능이 드러나지만 스크린리더로는 용도를 구분하기 어려운 요소에서, 사용자가 해당 기능을 파악하고 탐색할 수 있도록 돕기 위해 개발했습니다.

## 주요 기능

- 접근성 이름이 누락된 버튼·링크·탭 등의 요소를 찾아 화면에 표시합니다. 열린 Shadow DOM도 검사합니다.
- 같은 페이지의 이전 방문 기록과 기능 사전을 활용해 이름을 복구합니다.
- 로컬 단서로 이름을 확정하기 어려운 요소는 설정한 Gemini, OpenAI 또는 Groq API에 추론을 요청할 수 있습니다.
- 새 이름을 `aria-label`로 적용하고 접근성 이름을 다시 확인합니다. 조건을 만족하는 AI 결과는 다음 방문에 재사용할 수 있도록 저장합니다.

현재 확장 프로그램은 최상위 문서를 검사합니다. iframe 내부와 닫힌 Shadow DOM은 검사 범위에서 제외됩니다. 식별 단서가 부족하거나 AI 호출이 실패하면 일부 요소에는 이름이 붙지 않을 수 있습니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 확장 프로그램 | Chrome Extensions Manifest V3, JavaScript ES modules, HTML, CSS |
| 접근성 이름·역할 계산 | `dom-accessibility-api`, 브라우저 DOM API |
| 확장 내부 통신·저장 | `chrome.runtime`, `chrome.webNavigation`, `chrome.storage.local`, IndexedDB |
| AI 연동 | Fetch API, Gemini API, OpenAI Responses API, Groq Chat Completions API |
| 빌드·테스트 | Node.js, npm, esbuild, Playwright Chromium |

## 시스템 구조와 매칭 방식

```text
웹페이지 → 콘텐츠 스크립트 → 역할·접근성 이름 검사
                                 ↓
                          이전 방문 기록 조회
                                 ↓ 미해결
                              사전 매칭
                                 ↓ 미해결
                서비스 워커 → 설정한 AI 제공자
                                 ↓
                   대상 재확인 → 라벨 적용 → 저장
```

1. **수집과 탐지.** `collector.js`가 계산된 역할과 접근성 노출 여부로 검사 대상을 고르고, `detector.js`가 접근성 이름을 점검합니다. DOM이나 페이지 주소가 바뀌면 다시 검사합니다. [요소 수집 코드](src/collector.js) · [이름 탐지 코드](src/detector.js)
2. **이전 방문 매칭.** 현재 페이지의 주소와 요소의 역할, 속성, 상태, 주변 DOM 등으로 식별 정보를 만듭니다. 서비스 워커가 IndexedDB를 조회하고, 만료되지 않은 기록의 식별 정보가 정확히 일치할 때 저장된 라벨을 적용합니다. 식별 정보를 만들 수 없는 요소도 다음 단계에서 처리합니다. [요소 식별 코드](src/previous-fingerprint.js) · [이전 방문 기록 저장 코드](src/previous-store.js)
3. **사전 매칭.** 링크 목적지, 요소 속성, 아이콘과 주변 문구를 기능 사전과 비교합니다. 직접 단서가 있고 후보 점수와 순위 차이가 기준을 충족하면 이름을 확정합니다. 배너 패턴으로 분류된 요소에는 우선 `배너 이미지 N`을 붙이고 AI 결과를 확인합니다. [사전 매칭 코드](src/matcher.js) · [기능 사전](src/dictionary.json)
4. **AI 추론과 적용.** API 키가 등록돼 있으면 남은 요소의 텍스트 단서와 추출할 수 있는 이미지를 서비스 워커가 선택한 제공자에 보냅니다. 이미지는 원본 `img` 또는 지원하는 SVG·CSS 형태에서 가져오며, 화면 캡처를 허용한 경우에는 보이는 요소 영역을 잘라 사용할 수 있습니다. 응답이 돌아오면 페이지와 요소가 요청 당시와 일치하는지 다시 확인합니다. 적용에 성공하고 재방문 비교 조건을 충족한 AI 라벨을 IndexedDB에 저장합니다.

## 설치 및 실행

Chrome, Node.js 20 이상, npm, Git이 필요합니다.

```sh
git clone https://github.com/yubin7887/FocusBridge.git
cd FocusBridge
npm ci
npm run build
```

1. Chrome 주소창에서 `chrome://extensions`를 엽니다.
2. **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 선택합니다.
3. `manifest.json`이 있는 `FocusBridge` 폴더를 선택합니다.
4. 검사할 웹페이지를 열거나 새로고침합니다. 다시 빌드한 뒤에는 확장 관리 화면에서 FocusBridge를 다시 로드하고 대상 웹페이지도 새로고침합니다.

사전 매칭과 저장된 이전 방문 기록의 조회는 API 키 없이도 동작합니다.

## API 키 설정

1. 사용할 제공자에서 본인 API 키를 발급합니다. [Google AI Studio](https://aistudio.google.com/apikey) · [OpenAI Platform](https://platform.openai.com/api-keys) · [GroqCloud](https://console.groq.com/keys)
2. `chrome://extensions`에서 **FocusBridge → 세부정보 → 확장 프로그램 옵션**을 엽니다.
3. **AI 모델**을 고르고 해당 제공자의 키를 입력한 다음 **키 저장**을 누릅니다.
4. 대상 웹페이지를 새로고침합니다. 신규 요청을 중단하려면 설정에서 해당 제공자의 **등록한 키 삭제**를 누릅니다.

키는 사용자의 브라우저에 있는 확장 프로그램 로컬 저장소에 저장되며, 신뢰된 확장 프로그램 영역만 접근할 수 있습니다. AI 기능을 사용하면 선택한 제공자에게 요소의 텍스트, 페이지 제목·주변 문구 같은 문맥과 준비된 이미지가 전송될 수 있습니다. API 사용량과 비용은 사용자가 등록한 키에 귀속됩니다.

화면 캡처는 기본적으로 꺼져 있습니다. 직접 추출하기 어려운 아이콘의 화면 캡처를 사용하려면 옵션에서 **아이콘 화면 캡처 허용**을 선택하고 Chrome의 모든 사이트 접근 권한을 승인합니다. 허용한 경우 현재 탭에서 해당 요소가 보이는 부분을 잘라 AI에 보낼 수 있습니다. 직접 추출된 이미지도 AI 요청에 포함될 수 있습니다.

## 기여와 라이선스

개발 흐름과 테스트 방법은 [기여 안내](CONTRIBUTING.md)를 참고하세요.

FocusBridge가 작성한 소프트웨어는 [MIT 라이선스](LICENSE)로 배포됩니다. 포함된 외부 라이브러리와 실제 사이트에서 수집한 테스트 자료의 출처 및 적용 범위는 [제3자 고지](THIRD_PARTY_NOTICES.md)를 참고하세요.
