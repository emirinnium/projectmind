# ProjectMind VS Code Extension

AI-powered codebase intelligence directly in your editor.

## Features

- **Real-time Code Analysis**: Inline diagnostics for coherence issues
- **Security Warnings**: Highlight potential secrets, eval usage, weak crypto
- **Cognitive Load Indicator**: File complexity in status bar
- **Sidebar Panel**: Project overview, debt tracker, hotspots
- **Commands**: Scan, check coherence, find similar code, impact analysis

## Installation

1. Install from VS Code Marketplace (search for "ProjectMind")
2. Or build locally:
   ```bash
   cd vscode-projectmind
   npm install
   npm run package
   code --install-extension projectmind-0.1.0.vsix
   ```

## Requirements

- VS Code 1.85.0 or higher
- ProjectMind CLI (`npm install -g @emirhanturker/projectmind`)
- Node.js 22 or higher

## Commands

| Command | Description |
|---------|-------------|
| `ProjectMind: Scan Project` | Run full project scan |
| `ProjectMind: Scan Current File` | Scan current file only |
| `ProjectMind: Show Report` | Open full report in panel |
| `ProjectMind: Check Coherence` | Check current file coherence |
| `ProjectMind: Find Similar Code` | Find similar code snippets |
| `ProjectMind: Show Impact Analysis` | Show change impact analysis |

## Configuration

```json
{
  "projectmind.autoScan": true,
  "projectmind.scanOnSave": true,
  "projectmind.showInlineHints": true,
  "projectmind.mcpServerPath": "projectmind",
  "projectmind.embeddings.provider": "transformers",
  "projectmind.offline": false
}
```

## License

MIT
