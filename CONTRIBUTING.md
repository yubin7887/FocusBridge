# FocusBridge 기여 가이드

## 이슈 제보

GitHub Issues에 Chrome 버전, FocusBridge 커밋 또는 버전, 재현 단계, 기대 동작과 실제 동작을 적어 주세요. 접근성 이름 문제라면 가능할 때 요소의 역할, 원래 이름과 기대하는 이름도 알려 주세요. URL·콘솔 로그·스크린샷에서 API 키, 로그인 정보, 개인 정보와 비공개 URL은 가려 주세요. [FocusBridge Issues](https://github.com/yubin7887/FocusBridge/issues)

## 변경 제안

1. 저장소를 포크하고 최신 `main`에서 작업 브랜치를 만듭니다.
2. `npm ci`로 의존성을 설치합니다. [빌드와 Chrome 로드 방법](README.md#설치-및-실행)
3. 한 PR에 한 가지 목적을 담아 주세요. 탐지·매칭·라벨 적용 동작을 변경하는 경우 관련 테스트에 재현 사례를 추가하거나 갱신해 주세요. 테스트 입력은 작은 자체 작성 HTML을 우선 사용하고, 외부 자료가 필요하다면 출처와 재배포 가능 범위를 확인해 주세요.
4. `main`을 대상으로 PR을 열고 변경 이유, 재현 방법과 실행한 테스트의 결과를 적어 주세요. 재현에 실제 API 키나 사용자 브라우저 프로필을 포함하지 마세요.

## 테스트

```sh
npm ci
npx playwright install chromium
npm run test:all
```

| 명령 | 범위 |
| --- | --- |
| `npm test` | 접근성 이름 탐지 테스트 |
| `npm run test:match` | 사전 매칭, 브라우저 동작과 배너 대체 라벨 테스트 |
| `npm run test:previous` | 요소 식별 정보, DB 저장·조회와 이전 매칭 흐름 테스트 |
| `npm run test:extension` | Chromium에서 로드한 확장 프로그램의 이전 매칭 통합 테스트 |
| `npm run test:ai` | AI 요청, 이미지 처리 및 Chrome 확장 프로그램 통합 테스트. 모의 AI 응답 사용 |

빌드 산출물(`dist/`)과 로컬 설정, 브라우저 프로필, 테스트 결과물은 커밋에 포함하지 마세요.
