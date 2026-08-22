import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createProjectCommand(): Command {
  const projectCmd = new Command('project')
    .description('Multi-project management: create, list, switch projects');

  projectCmd
    .command('list')
    .description('List all projects')
    .action(asyncHandler(async () => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const projects = kg.listProjects();

        output.section(`Projects (${projects.length})`);
        for (const p of projects) {
          output.kv(`${p.name} (ID: ${p.id})`, `${p.fileCount} files, last scanned: ${p.lastScanned}`);
          output.kv('  Root', p.rootPath);
        }
      });
    }));

  projectCmd
    .command('create <name> <rootPath>')
    .description('Create a new project')
    .option('-d, --description <text>', 'Project description')
    .action(asyncHandler(async (name: string, rootPath: string, opts: { description?: string }) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const project = kg.createProject(name, rootPath, opts.description);
        output.success(`Project '${project.name}' created with ID ${project.id}`);
      });
    }));

  projectCmd
    .command('switch <id>')
    .description('Switch to a different project')
    .option('--no-scan', 'Skip automatic scan after switching')
    .action(asyncHandler(async (id: string, opts: { scan?: boolean }) => {
      await withService(['scale'], async (ctx, services) => {
        const kg = ctx.kg;
        const scale = services.scale!;
        const projectId = parseInt(id, 10);
        const result = kg.switchProject(projectId);

        if (!result.success) {
          output.error(result.error || 'Failed to switch project');
          return;
        }

        output.success(`Switched to project '${result.project!.name}' (ID: ${result.project!.id})`);

        // Auto-scan if enabled and project has no files
        if (opts.scan !== false) {
          const files = kg.getAllFiles();
          if (files.length === 0) {
            output.info(`Project has no files, scanning ${result.project!.rootPath}...`);
            try {
              const scanResult = await scale.scanProject(result.project!.rootPath);
              output.success(`Scan complete: ${scanResult.scanned} files, ${scanResult.errors} errors`);
            } catch (e) {
              output.warn(`Scan failed: ${e instanceof Error ? e.message : e}`);
            }
          } else {
            output.info(`Project has ${files.length} files. Use 'scan' command to update.`);
          }
        }
      });
    }));

  projectCmd
    .command('current')
    .description('Show the current project')
    .action(asyncHandler(async () => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const project = kg.getCurrentProject();

        if (project) {
          output.section('Current Project');
          output.kv('ID', String(project.id));
          output.kv('Name', project.name);
          output.kv('Root', project.rootPath);
        } else {
          output.warn('No project selected. Using default project.');
        }
      });
    }));

  projectCmd
    .command('delete <id>')
    .description('Delete a project and all its files')
    .action(asyncHandler(async (id: string) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const projectId = parseInt(id, 10);

        if (projectId === 1) {
          output.error('Cannot delete the default project');
          return;
        }

        const result = kg.deleteProject(projectId);

        if (result.success) {
          output.success(`Deleted project ${projectId} and ${result.deletedFiles} files`);
        } else {
          output.error(result.error || 'Failed to delete project');
        }
      });
    }));

  return projectCmd;
}
