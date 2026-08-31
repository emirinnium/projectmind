import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from '@/cli/utils/shared.js';

export function createTestgenCommand(): Command {
  const testgenCmd = new Command('testgen')
    .description('Generate test scaffolding for source files')
    .argument('[file]', 'File to generate tests for')
    .option('-f, --framework <fw>', 'Test framework: vitest|jest', 'vitest')
    .option('-t, --target <dir>', 'Target test directory', 'tests/unit')
    .option('--dry-run', 'Show generated tests without writing')
    .action(asyncHandler(async (file: string, opts: { framework: string; target: string; dryRun: boolean }) => {
      await withService(['scale'], async (_ctx, services) => {
        const scale = services.scale!;
        const config = loadConfig();
        
        output.section('Test Generation');
        
        const report = scale.getScaleReport();
        const allFiles = report.modules.flatMap(m => m.files || []);
        
        const filesToProcess = file 
          ? allFiles.filter(f => f.path.includes(file) || file.includes(f.path))
          : allFiles.filter(f => f.language === 'typescript' || f.language === 'javascript');
        
        if (filesToProcess.length === 0) {
          output.warn('No matching files found');
          return;
        }
        
        for (const targetFile of filesToProcess.slice(0, 10)) {
          output.section(`Scaffolding: ${targetFile.relativePath}`);
          
          let content: string;
          try {
            content = readFileSync(targetFile.path, 'utf-8');
          } catch {
            output.warn(`Could not read ${targetFile.path}`);
            continue;
          }
          
          const exports = extractExports(content);
          
          if (exports.length === 0) {
            output.info('No exports found to test');
            continue;
          }
          
          const testCode = generateTestFile(targetFile.relativePath, exports, opts.framework);
          
          if (opts.dryRun) {
            output.info(testCode);
          } else {
            const testDir = join(config.projectRoot, opts.target);
            if (!existsSync(testDir)) {
              mkdirSync(testDir, { recursive: true });
            }
            
            const testFileName = targetFile.relativePath.replace(/\.(ts|js)$/, `.test.$1`);
            const testPath = join(testDir, testFileName);
            const testDirPath = dirname(testPath);
            if (!existsSync(testDirPath)) {
              mkdirSync(testDirPath, { recursive: true });
            }
            
            writeFileSync(testPath, testCode);
            output.success(`Generated: ${testPath}`);
            output.kv('Exports tested', exports.length);
          }
        }
      });
    }));

  testgenCmd
    .command('scaffold <file>')
    .description('Quick scaffold for a single file')
    .option('-f, --framework <fw>', 'Test framework: vitest|jest', 'vitest')
    .action(asyncHandler(async (file: string, opts: { framework: string }) => {
      const content = readFileSync(file, 'utf-8');
      const exports = extractExports(content);
      
      if (exports.length === 0) {
        output.warn('No exports found');
        return;
      }
      
      output.info(generateTestFile(file, exports, opts.framework));
    }));

  return testgenCmd;
}

function extractExports(content: string): Array<{ name: string; type: 'function' | 'class' | 'const' | 'interface'; params: string }> {
  const exports: Array<{ name: string; type: 'function' | 'class' | 'const' | 'interface'; params: string }> = [];
  
  const funcRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    exports.push({ name: match[1], type: 'function', params: match[2] });
  }
  
  const classRegex = /export\s+class\s+(\w+)/g;
  while ((match = classRegex.exec(content)) !== null) {
    exports.push({ name: match[1], type: 'class', params: '' });
  }
  
  const constFuncRegex = /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  while ((match = constFuncRegex.exec(content)) !== null) {
    exports.push({ name: match[1], type: 'function', params: match[2] });
  }
  
  return exports;
}

function generateTestFile(sourceFile: string, exports: Array<{ name: string; type: string; params: string }>, framework: string): string {
  const importPath = sourceFile.replace(/\.(ts|js)$/, '').replace(/\\/g, '/');
  const isVitest = framework === 'vitest';
  
  const testCases = exports.map(exp => {
    if (exp.type === 'function') {
      return `
describe('${exp.name}', () => {
  it('should work correctly', () => {
    expect(sut.${exp.name}).toBeDefined();
  });
});`;
    } else if (exp.type === 'class') {
      return `
describe('${exp.name}', () => {
  it('should instantiate', () => {
    expect(new sut.${exp.name}()).toBeInstanceOf(sut.${exp.name});
  });
});`;
    }
    return '';
  }).join('\n');
  
  return `${isVitest ? `import { describe, it, expect } from 'vitest';` : `import { describe, it, expect } from '@jest/globals';`}
import * as sut from './${importPath}';

${testCases}
`;
}