export const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite';
export const AI_PROVIDERS = {
  google: {
    providerName: 'Gemini',
    credentialKey: 'geminiApiKey', // Preserve keys already saved by this extension.
  },
  openai: {
    providerName: 'GPT',
    credentialKey: 'openAiApiKey',
  },
  groq: {
    providerName: 'Groq',
    credentialKey: 'groqApiKey',
  },
};

export const AI_MODELS = {
  'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash-Lite', provider: 'google', thinkingLevel: 'MINIMAL' },
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', provider: 'google', thinkingLevel: 'LOW' },
  'gpt-6-luna': { name: 'GPT-6 Luna', provider: 'openai', reasoningEffort: 'none' },
  'gpt-6.1-terra': { name: 'GPT-6.1 Terra', provider: 'openai', reasoningEffort: 'none' },
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', provider: 'openai', reasoningEffort: 'low', maxOutputTokens: 2048 },
  'qwen/qwen3.8-27b': { name: 'Qwen 3.8 27B (Groq)', provider: 'groq', maxImages: 3 },
};
