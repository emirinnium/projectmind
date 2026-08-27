import { logger } from '../../../cli/utils/logger.js';

interface CursorClientOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Client for interacting with the Cursor API.
 */
export class CursorClient {
  private apiKey: string;
  private model: string;

  constructor(opts: CursorClientOptions) {
    this.apiKey = opts.apiKey ?? '';
    this.model = opts.model ?? 'cursor-2';
  }

  /**
   * Analyze code using Cursor API.
   */
  async analyzeCode(content: string, prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Cursor API key not configured');
    }

    try {
      const response = await fetch('https://api.cursor.com/v1/analyze', {
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
        throw new Error(`Cursor API error: ${error}`);
      }

      const data = await response.json() as { result: string };
      return data.result;
    } catch (error) {
      logger.error('Error calling Cursor API:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Generate code using Cursor API.
   */
  async generateCode(prompt: string, context?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Cursor API key not configured');
    }

    try {
      const response = await fetch('https://api.cursor.com/v1/generate', {
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
        throw new Error(`Cursor API error: ${error}`);
      }

      const data = await response.json() as { result: string };
      return data.result;
    } catch (error) {
      logger.error('Error calling Cursor API:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
