import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stableHash } from '../../../src/utils/hash.js';
import { answerCodebaseQuestion } from '../../../src/core/intelligence/qa-engine.js';

describe('evidence-first codebase Q&A', () => {
  it('answers from fresh bounded excerpts and refuses unsupported questions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projectmind-qa-'));
    try {
      const filePath = join(root, 'src', 'auth.ts');
      const content = 'export function authenticate(token: string) { return token.length > 0; }\n';
      await mkdir(join(root, 'src'));
      await writeFile(filePath, content, 'utf8');
      const info = {
        id: 1,
        path: filePath,
        relativePath: 'src/auth.ts',
        language: 'typescript',
        sizeBytes: Buffer.byteLength(content),
        hash: stableHash(content),
        agentTouched: false,
        agentTouchedBy: null,
        agentTouchedAt: null,
        cognitiveLoad: 0,
        lastScanned: new Date().toISOString(),
        lastSynced: new Date().toISOString(),
        patterns: [],
      };
      const kg = {
        getAllFiles: () => [info],
        getFileByPath: (path: string) =>
          path === 'src/auth.ts' || path === filePath ? info : null,
      };
      const answer = await answerCodebaseQuestion(kg, root, 'Where is authenticate defined?');
      expect(answer).toMatchObject({
        success: true,
        questionType: 'where',
        synthesis: 'deterministic-evidence',
      });
      expect(answer.evidence[0]).toMatchObject({ filePath: 'src/auth.ts', freshness: 'fresh' });
      expect(answer.answer).toMatch(/src\/auth\.ts:1-\d+/);

      const refused = await answerCodebaseQuestion(
        kg,
        root,
        'What is the runtime database latency?',
      );
      expect(refused.success).toBe(false);
      expect(refused.refusal).toMatch(/insufficient source evidence/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
