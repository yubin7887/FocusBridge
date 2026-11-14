import { AI_MODELS, AI_PROVIDERS } from './ai-config.js';
import { AI_MODEL_KEY, ICON_CAPTURE_KEY, readAiSettings, restrictKeyAccess } from './ai-settings.js';

const form = document.querySelector('#key-form');
const select = document.querySelector('#ai-provider-select');
const input = document.querySelector('#api-key');
const save = form.querySelector('button[type="submit"]');
const remove = document.querySelector('#remove-key');
const status = document.querySelector('#status');
const providerText = document.querySelector('#ai-provider');
const keyLabel = document.querySelector('label[for="api-key"]');
const access = restrictKeyAccess().catch(() => null);

for (const [id, { name }] of Object.entries(AI_MODELS)) {
  select.add(new Option(name, id));
}

async function update(action, message) {
  select.disabled = input.disabled = save.disabled = remove.disabled = true;
  let available = false;
  let hasKey = false;
  try {
    const storage = await access;
    if (!storage) {
      status.textContent = '확장 프로그램 저장소를 사용할 수 없습니다. chrome://extensions에서 FocusBridge를 새로고침해 주세요.';
      return;
    }
    available = true;
    await action(storage);
    input.value = '';
    const { model, apiKey } = await readAiSettings(storage);
    const { name, provider } = AI_MODELS[model];
    const { providerName } = AI_PROVIDERS[provider];
    select.value = model;
    providerText.textContent = name;
    keyLabel.textContent = `${providerName} API 키`;
    hasKey = Boolean(apiKey);
    status.textContent = message || (hasKey ? 'API 키가 등록되어 있습니다.' : '등록된 API 키가 없습니다.');
  } catch {
    status.textContent = 'API 키 설정을 변경하지 못했습니다. 확장 프로그램을 다시 로드해 주세요.';
  } finally {
    select.disabled = input.disabled = save.disabled = !available;
    remove.disabled = !hasKey;
  }
}

select.addEventListener('change', () => {
  const model = select.value;
  input.value = '';
  void update((storage) => storage.set({ [AI_MODEL_KEY]: model }));
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = input.value.trim();
  if (!key || /\s/.test(key)) {
    status.textContent = '공백 없이 API 키를 입력해 주세요.';
    return;
  }
  const { credentialKey } = AI_PROVIDERS[AI_MODELS[select.value].provider];
  void update((storage) => storage.set({ [credentialKey]: key }), '키를 저장했습니다. 사용 중인 웹페이지를 새로고침해 주세요.');
});
remove.addEventListener('click', () => {
  const { credentialKey } = AI_PROVIDERS[AI_MODELS[select.value].provider];
  void update((storage) => storage.remove(credentialKey), '키를 삭제했습니다. 새 AI 요청을 중단합니다.');
});
void update(() => {}, '');

const captureButton = document.querySelector('#toggle-icon-capture');
const captureStatus = document.querySelector('#capture-status');
const capturePermission = { origins: ['<all_urls>'] };
let captureAllowed = false;

async function refreshCapturePermission() {
  const storage = await access;
  if (!storage) throw new Error('Extension storage unavailable');
  const stored = await storage.get(ICON_CAPTURE_KEY);
  captureAllowed = stored[ICON_CAPTURE_KEY] === true && await chrome.permissions.contains(capturePermission);
  captureButton.textContent = captureAllowed ? '아이콘 화면 캡처 끄기' : '아이콘 화면 캡처 허용';
  captureButton.disabled = false;
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  try {
    const enable = !captureAllowed;
    const granted = !enable || await chrome.permissions.request(capturePermission);
    const storage = await access;
    await storage.set({ [ICON_CAPTURE_KEY]: enable && granted });
    if (!enable) await chrome.permissions.remove(capturePermission);
    await refreshCapturePermission();
    captureStatus.textContent = granted ? (captureAllowed ? '아이콘 화면 캡처를 켰습니다.' : '아이콘 화면 캡처를 껐습니다.')
      : '아이콘 화면 캡처 권한을 변경하지 않았습니다.';
  } catch {
    captureStatus.textContent = '아이콘 화면 캡처 권한을 변경하지 못했습니다.';
    captureButton.disabled = false;
  }
});
void refreshCapturePermission().catch(() => { captureStatus.textContent = '아이콘 화면 캡처 권한을 확인하지 못했습니다.'; });
