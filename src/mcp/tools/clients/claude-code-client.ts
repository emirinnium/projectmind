import { logger } from '../../../cli/utils/logger.js';

interface ClaudeCodeClientOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Client for interacting with the Claude Code API.
 */
export class ClaudeCodeClient {
  private apiKey: string;
  private model: string;

  constructor(opts: ClaudeCodeClientOptions) {
    this.apiKey = opts.apiKey ?? '';
    this.model = opts.model ?? 'claude-3-opus-20240229';
  }

  /**
   * Analyze code using Claude Code API.
   */
  async analyzeCode(content: string, prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Claude Code API key not configured');
    }

    try {
      const response = await fetch('https://api.claude-code.com/v1/analyze', {
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
        throw new Error(`Claude Code API error: ${error}`);
      }

      const data = await response.json() as { result: string };
      return data.result;
    } catch (error) {
      logger.error('Error calling Claude Code API:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Generate code using Claude Code API.
   */
  async generateCode(prompt: string, context?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Claude Code API key not configured');
    }

    try {
      const response = await fetch('https://api.claude-code.com/v1/generate', {
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
        throw new Error(`Claude Code API error: ${error}`);
      }

      const data = await response.json() as { result: string };
      return data.result;
    } catch (error) {
      logger.error('Error calling Claude Code API:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
