import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  EvidenceLedger,
  evidenceLedgerExportSchema,
  ledgerEventSchema,
  verifyLedgerExport,
} from '@/core/ledger/evidence-ledger.js';
import { asyncHandler, output, withContext } from '@/cli/utils/shared.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { writeFileAtomically } from '@/utils/atomic-write.js';
import { closeDatabase } from '@/storage/database.js';
import {
  createDatabaseBackup,
  restoreDatabaseFile,
  validateDatabaseBackup,
} from '@/storage/database-backup.js';

interface LedgerOptions {
  format: string;
  afterId?: string;
  limit: string;
}

interface LedgerRecordOptions {
  eventType: string;
  toolName: string;
  inputJson: string;
  resultJson: string;
  graphHash?: string;
  policyVersion?: string;
  scope?: string;
  sourceFreshness?: string;
  summaryJson?: string;
  format: string;
}

interface LedgerExportOptions {
  format: string;
  limit: string;
  output?: string;
}

interface LedgerVerifyOptions {
  format: string;
  exportPath?: string;
  /** Commander stores the `--export` option under this reserved-word key. */
  export?: string;
}

interface LedgerBackupOptions {
  output: string;
  format: string;
}

interface LedgerRestoreOptions {
  input: string;
  format: string;
  force?: boolean;
}

function parseLimit(value: string): number {
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`--limit must be an integer between 1 and 1000: ${value}`);
  }
  return limit;
}

function parseExportLimit(value: string): number {
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new Error(`--limit must be an integer between 1 and 100000: ${value}`);
  }
  return limit;
}

function parseAfterId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const afterId = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new Error(`--after-id must be a non-negative integer: ${value}`);
  }
  return afterId;
}

function validateFormat(format: string): asserts format is 'text' | 'json' {
  if (format !== 'text' && format !== 'json') {
    throw new Error(`--format must be text or json: ${format}`);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createLedger(ctx: {
  db: import('node:sqlite').DatabaseSync;
  kg: { getCurrentProjectId(): number };
}) {
  return new EvidenceLedger(ctx.db, ctx.kg.getCurrentProjectId());
}

export function createLedgerCommand(): Command {
  const command = new Command('ledger')
    .description('Inspect ProjectMind evidence decision records')
    .action(() => command.outputHelp());

  command
    .command('list')
    .description('List payload-free evidence ledger records')
    .option('--format <format>', 'Output: text|json', 'text')
    .option('--after-id <id>', 'Only records after this ID')
    .option('--limit <n>', 'Maximum records to return', '100')
    .action(
      asyncHandler(async (options: LedgerOptions) => {
        await withContext(async (ctx) => {
          validateFormat(options.format);
          const ledger = createLedger(ctx);
          const records = ledger.list({
            afterId: parseAfterId(options.afterId),
            limit: parseLimit(options.limit),
          });
          if (options.format === 'json') {
            output.json({
              success: true,
              projectId: ctx.kg.getCurrentProjectId(),
              records,
            });
            return;
          }
          output.section('ProjectMind Evidence Ledger');
          output.kv('Project', ctx.kg.getCurrentProjectId());
          output.kv('Records', records.length);
          for (const record of records) {
            output.kv(
              `#${record.id} ${record.eventType}/${record.toolName}`,
              `${record.createdAt} — ${record.recordHash}`,
            );
          }
          if (records.length === 0) {
            output.info('No ledger records exist for the active project yet.');
          }
        });
      }),
    );

  command
    .command('record')
    .description('Explicitly append a payload-free evidence decision record')
    .requiredOption('--event-type <type>', 'mcp-invocation|scan|context|review|edit|custom')
    .requiredOption('--tool <name>', 'Tool or command that produced the decision')
    .requiredOption('--input-json <json>', 'JSON input payload; only its hash is stored')
    .requiredOption('--result-json <json>', 'JSON result payload; only its hash is stored')
    .option('--graph-hash <sha256>', 'Optional graph hash')
    .option('--policy-version <version>', 'Optional policy version')
    .option('--scope <scope>', 'Optional scope label')
    .option('--source-freshness <status>', 'fresh|stale|unindexed|missing|unknown|not-checked')
    .option('--summary-json <json>', 'Optional bounded scalar summary JSON')
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (options: LedgerRecordOptions) => {
        validateFormat(options.format);
        const event = ledgerEventSchema.parse({
          eventType: options.eventType,
          toolName: options.toolName,
          input: parseJson(options.inputJson, '--input-json'),
          result: parseJson(options.resultJson, '--result-json'),
          ...(options.graphHash ? { graphHash: options.graphHash } : {}),
          ...(options.policyVersion ? { policyVersion: options.policyVersion } : {}),
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.sourceFreshness ? { sourceFreshness: options.sourceFreshness } : {}),
          ...(options.summaryJson
            ? { summary: parseJson(options.summaryJson, '--summary-json') }
            : {}),
        });
        await withContext(async (ctx) => {
          const record = createLedger(ctx).append(event);
          if (options.format === 'json') {
            output.json({ success: true, record });
            return;
          }
          output.section('Evidence Ledger Record');
          output.kv('Record', `#${record.id}`);
          output.kv('Event', `${record.eventType}/${record.toolName}`);
          output.kv('Record hash', record.recordHash);
          output.success('Payload-free evidence record appended.');
        });
      }),
    );

  command
    .command('export')
    .description('Export payload-free ledger records for independent verification')
    .option('--format <format>', 'Output: text|json', 'json')
    .option('--limit <n>', 'Maximum records to export', '100000')
    .option('--output <path>', 'Write the JSON export inside the project root')
    .action(
      asyncHandler(async (options: LedgerExportOptions) => {
        validateFormat(options.format);
        await withContext(async (ctx) => {
          const bundle = createLedger(ctx).exportRecords(parseExportLimit(options.limit));
          if (options.output) {
            const exportPath = assertProjectPath(options.output, ctx.config.projectRoot, {
              rejectIgnored: false,
            });
            writeFileAtomically(exportPath, `${JSON.stringify(bundle, null, 2)}\n`);
            output.success(`Evidence ledger export written to ${options.output}`);
            return;
          }
          if (options.format === 'json') {
            output.json(bundle);
            return;
          }
          output.section('Evidence Ledger Export');
          output.kv('Project', bundle.projectId);
          output.kv('Records', bundle.records.length);
          output.info(
            'JSON export is required for independent verification: pm ledger verify --export <file>.',
          );
        });
      }),
    );

  command
    .command('verify')
    .description('Verify the active project evidence ledger hash chain')
    .option('--format <format>', 'Output: text|json', 'text')
    .option('--export <path>', 'Verify a previously exported ledger JSON file')
    .action(
      asyncHandler(async (options: LedgerVerifyOptions) => {
        await withContext(async (ctx) => {
          validateFormat(options.format);
          let verification;
          const requestedExportPath = options.exportPath ?? options.export;
          if (requestedExportPath) {
            const exportPath = assertProjectPath(requestedExportPath, ctx.config.projectRoot, {
              mustExist: true,
              rejectIgnored: false,
            });
            let parsed: unknown;
            try {
              parsed = JSON.parse(readFileSync(exportPath, 'utf8')) as unknown;
            } catch (error) {
              throw new Error(
                `Unable to read ledger export: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            const bundle = evidenceLedgerExportSchema.parse(parsed);
            verification = verifyLedgerExport({
              ...bundle,
              totalRecords: bundle.totalRecords ?? bundle.records.length,
              complete: bundle.complete ?? true,
            });
          } else {
            verification = createLedger(ctx).verify();
          }
          if (options.format === 'json') {
            output.json({
              success: verification.valid,
              source: requestedExportPath ? 'export' : 'database',
              verification,
            });
            return;
          }
          output.section('ProjectMind Evidence Ledger Verification');
          output.kv('Source', requestedExportPath ? 'export' : 'database');
          output.kv('Project', verification.projectId);
          output.kv('Checked records', verification.checkedRecords);
          output.kv('Status', verification.valid ? 'valid' : 'invalid');
          output.kv('Chain head', verification.chainHead ?? 'empty');
          for (const issue of verification.issues) {
            output.error(`#${issue.id} ${issue.code}: ${issue.message}`);
          }
          if (verification.valid) {
            output.success('The evidence ledger chain is internally consistent.');
          }
        });
      }),
    );

  command
    .command('backup')
    .description('Create a validated SQLite database snapshot for recovery')
    .option(
      '--output <path>',
      'Backup destination inside the project root',
      '.projectmind/pm-knowledge.db.backup',
    )
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (options: LedgerBackupOptions) => {
        validateFormat(options.format);
        await withContext(async (ctx) => {
          const backupPath = assertProjectPath(options.output, ctx.config.projectRoot, {
            rejectIgnored: false,
          });
          createDatabaseBackup(ctx.db, backupPath);
          const validation = validateDatabaseBackup(backupPath);
          const result = {
            success: validation.valid,
            backupPath: options.output,
            bytes: validation.valid ? statSync(backupPath).size : null,
            validation,
          };
          if (options.format === 'json') {
            output.json(result);
            return;
          }
          output.section('ProjectMind Database Backup');
          output.kv('Path', options.output);
          output.kv('Integrity', validation.integrity);
          output.kv('Schema version', validation.schemaVersion ?? 'unknown');
          output.success('Validated SQLite backup created.');
        });
      }),
    );

  command
    .command('restore')
    .description('Restore the active SQLite database from a validated snapshot')
    .requiredOption('--input <path>', 'Backup file inside the project root')
    .option('--force', 'Required confirmation because the active database is replaced')
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (options: LedgerRestoreOptions) => {
        validateFormat(options.format);
        if (options.force !== true) {
          throw new Error(
            'Database restore replaces the active index; rerun with --force to confirm.',
          );
        }
        await withContext(async (ctx) => {
          const backupPath = assertProjectPath(options.input, ctx.config.projectRoot, {
            mustExist: true,
            rejectIgnored: false,
          });
          const validation = validateDatabaseBackup(backupPath);
          if (!validation.valid) {
            throw new Error(`Database backup is not restorable: ${validation.details.join('; ')}`);
          }
          const databasePath = resolve(ctx.config.projectRoot, ctx.config.databasePath);
          closeDatabase();
          restoreDatabaseFile(databasePath, backupPath);
          const result = {
            success: true,
            backupPath: options.input,
            databasePath: ctx.config.databasePath,
            restoredSchemaVersion: validation.schemaVersion,
          };
          if (options.format === 'json') {
            output.json(result);
            return;
          }
          output.section('ProjectMind Database Restore');
          output.kv('Source', options.input);
          output.kv('Database', ctx.config.databasePath);
          output.kv('Schema version', validation.schemaVersion ?? 'unknown');
          output.success('Database restored. Run pm scan --full before trusting derived indexes.');
        });
      }),
    );

  return command;
}
