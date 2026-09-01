import { Command } from 'commander';
import {
  CLIContext,
  ContextFn,
  withContext,
  withService,
  withScale,
  withDebt,
  withCoherence,
  withServices,
} from './index.js';
import { ServiceMap } from './services.js';
import { output } from './output.js';
import { formatGenomeScore } from './formatters.js';
import { handleCliError } from './formatters.js';
import { getFilesToCheck } from './files.js';
import { ScaleManager } from '@/core/scale/manager.js';
import { DebtTracker } from '@/core/debt/tracker.js';
import { CoherenceEngine } from '@/core/coherence/engine.js';

export { CLIContext, ContextFn } from './context.js';

export abstract class BaseCommand {
  protected cmd: Command;

  constructor(name: string, description: string) {
    this.cmd = new Command(name).description(description);
  }

  protected withContext<T>(fn: (ctx: CLIContext) => Promise<T>): Promise<T> {
    return withContext(fn);
  }

  protected withService<T>(
    services: ('scale' | 'debt' | 'coherence')[],
    fn: (ctx: CLIContext, services: ServiceMap) => Promise<T>,
  ): Promise<T> {
    return withService(services, fn);
  }

  protected withScale(fn: ContextFn<ScaleManager>): Promise<void> {
    return withScale(fn);
  }

  protected withDebt(fn: ContextFn<DebtTracker>): Promise<void> {
    return withDebt(fn);
  }

  protected withCoherence(fn: ContextFn<CoherenceEngine>): Promise<void> {
    return withCoherence(fn);
  }

  protected withServices(
    services: ('scale' | 'debt' | 'coherence')[],
    fn: (ctx: CLIContext, services: ServiceMap) => Promise<void>,
  ): Promise<void> {
    return withServices(services, fn);
  }

  protected output = output;
  protected formatGenomeScore = formatGenomeScore;
  protected handleError = handleCliError;
  protected getFilesToCheck = getFilesToCheck;

  getCommand(): Command {
    return this.cmd;
  }
}
