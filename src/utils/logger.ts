/**
 * Centralized logger for ProjectMind.
 * All modules should import from this file.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private minLevel: LogLevel;
  private isMcpMode: boolean;
  private contextPrefix: string | null = null;

  constructor() {
    this.minLevel = 'info';
    this.isMcpMode = false;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setMcpMode(enabled: boolean): void {
    this.isMcpMode = enabled;
  }

  setContext(prefix: string): void {
    this.contextPrefix = prefix;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.minLevel];
  }

  private format(level: LogLevel, message: string, context?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const ctx = context ? ` ${JSON.stringify(context)}` : '';
    const prefix = this.contextPrefix ? `[${this.contextPrefix}] ` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${prefix}${message}${ctx}`;
  }

  private output(level: LogLevel, formatted: string): void {
    if (this.isMcpMode) {
      process.stderr.write(formatted + '\n');
    } else {
      switch (level) {
        case 'debug':
        case 'info':
          console.log(formatted);
          break;
        case 'warn':
          console.warn(formatted);
          break;
        case 'error':
          console.error(formatted);
          break;
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      this.output('debug', this.format('debug', message, context));
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      this.output('info', this.format('info', message, context));
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      this.output('warn', this.format('warn', message, context));
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      this.output('error', this.format('error', message, context));
    }
  }
}

export const logger = new Logger();
export default logger;
