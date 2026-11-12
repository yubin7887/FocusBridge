export const DEFAULT_AI_MODEL = 'gemini-3.8-flash';
export const AI_PROVIDERS = {
  google: {
    providerName: 'Gemini',
    credentialKey: 'geminiApiKey', // Preserve keys already saved by this extension.
  },
  openai: {
    providerName: 'GPT',
    credentialKey: 'openAiApiKey',
  },
};

export const AI_MODELS = {
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', provider: 'google', thinkingLevel: 'LOW' },
  'gpt-6-luna': { name: 'GPT-6 Luna', provider: 'openai', reasoningEffort: 'none' },
  'gpt-6.1-terra': { name: 'GPT-6.1 Terra', provider: 'openai', reasoningEffort: 'none' },
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', provider: 'openai', reasoningEffort: 'low', maxOutputTokens: 2048 },
};
