import type { LLMProvider, LLMConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { GeminiProvider } from './gemini.js';
import { GroqProvider } from './groq.js';
import { logger } from '../../cli/utils/logger.js';

export function createLLMProvider(config: LLMConfig): LLMProvider | null {
  try {
    if (config.provider === 'anthropic') {
      const provider = new AnthropicProvider(config);
      return provider.isAvailable() ? provider : null;
    }
    if (config.provider === 'openai') {
      const provider = new OpenAIProvider(config);
      return provider.isAvailable() ? provider : null;
    }
    if (config.provider === 'gemini') {
      const provider = new GeminiProvider(config);
      return provider.isAvailable() ? provider : null;
    }
    if (config.provider === 'groq') {
      const provider = new GroqProvider(config);
      return provider.isAvailable() ? provider : null;
    }
    if (config.provider === 'ollama') {
      return new OllamaProvider(config);
    }
  } catch (e) {
    logger.warn(`Failed to create LLM provider: ${e}`);
  }
  return null;
}