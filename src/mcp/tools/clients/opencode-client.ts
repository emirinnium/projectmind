import { logger } from '../../../cli/utils/logger.js';

interface OpenCodeClientOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Client for interacting with the OpenCode API.
 */
export class OpenCodeClient {
  private apiKey: string;
  private model: string;

  constructor(opts: OpenCodeClientOptions) {
    this.apiKey = opts.apiKey ?? '';
    this.model = opts.model ?? 'opencode-3';
  }

  /**
   * Analyze code using OpenCode API.
   */
  async analyzeCode(content: string, prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenCode API key not configured');
    }

    try {
      const response = await fetch('https://api.opencode.com/v1/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          content,
          prompt,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenCode API error: ${error}`);
      }

      const data = await response.json() as { result: string };
      return data.result;
    } catch (error) {
      logger.error('Error calling OpenCode API:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Generate code using OpenCode API.
   */
  async generateCode(prompt: string, context?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenCode API key not configured');
    }

    try {
      const response = await fetch('https://api.opencode.com/v1/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          context: context ?? '',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenCode API error: ${error}`);
      }

      const data = await response.json() as { result: string };
      return data.result;
    } catch (error) {
      logger.error('Error calling OpenCode API:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
