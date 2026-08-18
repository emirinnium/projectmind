# Contributing to ProjectMind

Thank you for your interest in contributing! This document outlines the process and guidelines.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/<your-username>/projectmind.git`
3. **Install** dependencies: `npm install`
4. **Build** to verify: `npm run build`
5. **Run tests**: `npm test`

## Development Workflow

### Branch Naming
- `feature/<short-description>` — New features
- `fix/<short-description>` — Bug fixes
- `refactor/<short-description>` — Code improvements
- `docs/<short-description>` — Documentation updates

### Commit Messages
Follow [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add new coherence analysis tool
fix: resolve circular dependency detection edge case
refactor: simplify debt tracker initialization
docs: update CLI command reference
test: add integration test for MCP server
chore: update dependencies
```

### Pull Request Process
1. Create a branch from `main`
2. Make your changes with tests
3. Ensure all checks pass: `npm run build && npm test`
4. Update CHANGELOG.md (Unreleased section)
5. Open PR against `main` with clear description

## Code Standards

- **TypeScript strict mode** — No `any`, explicit types
- **ESM modules** — Use `import`/`export`, `.js` extensions in imports
- **Async/await** — Prefer over callbacks
- **Error handling** — Use `Result` types or try/catch with context
- **Logging** — Use the shared `logger` utility, not `console.log`

## Testing

- Write integration tests in `tests/integration.test.ts`
- Test new MCP tools end-to-end
- Verify CLI commands manually: `node dist/cli.js <command>`
- Target: maintain 48+ passing tests

## Adding MCP Tools

1. Create tool in `src/mcp/tools/<name>.ts`
2. Export registration function
3. Register in `src/mcp/tools/index.ts`
4. Add types to `src/mcp/tools/types.ts` if needed
5. Test with MCP client

## Reporting Issues

Use GitHub Issues with:
- **Bug**: Steps to reproduce, expected vs actual, environment
- **Feature**: Use case, proposed API, alternatives considered
- **Question**: Search existing issues first

## Code of Conduct

Be respectful, inclusive, and constructive. This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.