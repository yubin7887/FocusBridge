# FocusBridge
스크린리더가 읽지 못하는 웹페이지 요소를 탐지하고, 해당 요소를 읽을 수 있도록 개선하는 크롬 확장 프로그램입니다.

## AI 연결

1. `npm install`과 `npm run build`를 실행합니다.
2. Chrome의 `chrome://extensions`에서 개발자 모드를 켜고 프로젝트 폴더를 압축해제된 확장으로 로드합니다.
3. FocusBridge의 세부정보 → 확장 프로그램 옵션에서 AI 모델을 선택하고 해당 제공업체의 본인 API 키를 저장합니다. 모델을 바꾸거나 키를 저장한 뒤 사용할 탭을 새로고침합니다.

기본 모델은 Gemini 3.8 Flash입니다. 설정에서 GPT-6 Luna, GPT-6.1 Terra, GPT-6.1 Sol도 선택할 수 있습니다. GPT 모델은 OpenAI 키 하나를 공유하고, Gemini 키는 별도로 저장합니다. 이전 방문 매칭과 사전 매칭으로 해결되지 않은 요소만 선택한 모델로 보냅니다. AI가 생성한 이름은 해당 요소를 다시 확인한 후 저장 조건을 충족할 때만 브라우저의 IndexedDB에 보관합니다.

`npm run test:all`로 회귀 테스트를, Playwright Chromium 설치 후 `npm run test:ai`로 키 설정과 모의 Gemini/GPT 연동을 확인할 수 있습니다.

기본 AI 제공업체와 모델은 `src/ai-config.js`에서 관리합니다. 다른 제공업체를 연결하려면
`src/ai-client.js`에 해당 API의 요청 생성과 응답 추출을 추가하고, 제공업체별 키 저장 항목과
`manifest.json`의 호출 도메인 권한을 지정합니다. 이후 매칭과 IndexedDB는 공통 `requestId`와 `label`을 사용합니다.
