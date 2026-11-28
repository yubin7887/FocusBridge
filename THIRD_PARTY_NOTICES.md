# 제3자 라이선스 및 자료 출처

FocusBridge에서 작성한 소프트웨어에는 저장소의 [MIT 라이선스](LICENSE)가 적용됩니다. 제3자 구성 요소에는 각각의 원래 라이선스가 적용됩니다.

## npm 의존성

[잠금 파일](package-lock.json)에 기록된 런타임·개발 의존성의 라이선스입니다.

| 구성 요소 | 사용 범위 | 라이선스 |
| --- | --- | --- |
| `dom-accessibility-api` | 확장 프로그램의 접근성 이름·역할 계산. `dist`에 번들됩니다. | [MIT](https://github.com/eps1lon/dom-accessibility-api/blob/v0.7.1/LICENSE.md) |
| `esbuild`, `@esbuild/*` | 빌드 도구와 플랫폼별 바이너리 | [MIT](https://github.com/evanw/esbuild/blob/v0.24.2/LICENSE.md) |
| `playwright`, `playwright-core` | Chromium 테스트 자동화 | [Apache-2.0](https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE) · [NOTICE](https://github.com/microsoft/playwright/blob/v1.64.1/NOTICE) |

확장 프로그램의 빌드 결과를 다른 사람에게 배포할 때는 FocusBridge의 `LICENSE`와 이 파일의 `dom-accessibility-api` 고지를 함께 포함해 주세요. esbuild와 Playwright는 현재 확장 프로그램 번들에서 사용되는 런타임 코드에 포함되지 않습니다. 해당 개발 도구 자체를 재배포한다면 각 패키지의 라이선스와 해당하는 `NOTICE`를 함께 유지하세요.

## 실제 사이트에서 수집한 테스트 자료

`test/data/real/`, `test/data/final/`, `test/data/final2/`는 실제 사이트의 HTML 일부, 링크·이미지 주소 및 주변 문구를 포함한 테스트 자료입니다. 해당 사이트에서 가져온 부분은 FocusBridge의 MIT 라이선스 적용 범위에서 제외합니다. 각 자료의 수집 출처는 해당 폴더의 README에서 확인할 수 있습니다. 별도 배포에 사용하려면 자료별 이용 조건과 재배포 범위를 확인해 주세요. [실제 사이트 자료](test/data/real/README.md) · [1차 시험 자료](test/data/final/README.md) · [2차 시험 자료](test/data/final2/README.md)

## `dom-accessibility-api` 라이선스 원문

```text
MIT License

Copyright (c) 2020 Sebastian Silbermann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
