import { AI_MODELS, AI_PROVIDERS, DEFAULT_AI_MODEL } from './ai-config.js';

export const AI_MODEL_KEY = 'aiModel';
const LEGACY_PROVIDER_KEY = 'aiProvider';

export async function restrictKeyAccess(storage = globalThis.chrome?.storage?.local) {
  if (typeof storage?.setAccessLevel !== 'function') throw new Error('Extension storage unavailable');
  await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return storage;
}

export async function readAiSettings(storage) {
  const keys = Object.values(AI_PROVIDERS).map(({ credentialKey }) => credentialKey);
  const stored = await storage.get([AI_MODEL_KEY, LEGACY_PROVIDER_KEY, ...keys]);
  const preferred = stored[AI_MODEL_KEY];
  const legacyModel = stored[LEGACY_PROVIDER_KEY] === 'openai' ? 'gpt-6-luna' : DEFAULT_AI_MODEL;
  const model = typeof preferred === 'string' && Object.hasOwn(AI_MODELS, preferred) ? preferred : legacyModel;
  const value = stored[AI_PROVIDERS[AI_MODELS[model].provider].credentialKey];
  return { model, apiKey: typeof value === 'string' ? value.trim() : '' };
}
