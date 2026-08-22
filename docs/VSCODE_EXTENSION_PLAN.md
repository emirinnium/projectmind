# VS Code Extension Plan

## Overview
A VS Code extension that brings ProjectMind's intelligence directly into the editor, providing real-time feedback on code quality, security, and architecture.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                     │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Status Bar  │  │  Sidebar    │  │  Inline     │     │
│  │  (metrics)   │  │  (reports)  │  │  (hints)    │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│              Extension Host (Node.js)                    │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  LSP Client  │  │  MCP Client │  │  File Watch │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│              ProjectMind MCP Server                      │
└─────────────────────────────────────────────────────────┘
```

## Features

### 1. Real-time Code Analysis
- **Inline diagnostics**: Show coherence issues directly in the editor
- **Security warnings**: Highlight potential secrets, eval usage, weak crypto
- **Cognitive load indicator**: Show file complexity in status bar

### 2. Sidebar Panel
- **Project overview**: Total files, languages, coverage
- **Debt tracker**: Top debt items by severity
- **Hotspots**: Files with highest cognitive load
- **Recent scans**: Scan history with trends

### 3. Commands
| Command | Description |
|---------|-------------|
| `ProjectMind: Scan Project` | Run full project scan |
| `ProjectMind: Scan File` | Scan current file only |
| `ProjectMind: Show Report` | Open full report in panel |
| `ProjectMind: Check Coherence` | Check current file coherence |
| `ProjectMind: Find Similar` | Find similar code snippets |
| `ProjectMind: Show Impact` | Show change impact analysis |

### 4. Configuration
```json
{
  "projectmind.autoScan": true,
  "projectmind.scanOnSave": true,
  "projectmind.showInlineHints": true,
  "projectmind.mcpServerPath": "projectmind",
  "projectmind.embeddings.provider": "transformers"
}
```

## Implementation Plan

### Phase 1: Core Extension (2 weeks)
- [ ] Set up extension scaffold with `yo code`
- [ ] Implement MCP client connection
- [ ] Add status bar with basic metrics
- [ ] Implement scan commands

### Phase 2: UI & Diagnostics (2 weeks)
- [ ] Build sidebar webview panel
- [ ] Add inline diagnostics (squiggles)
- [ ] Implement code actions (quick fixes)
- [ ] Add file watchers for auto-scan

### Phase 3: Advanced Features (2 weeks)
- [ ] Integrate embeddings for similar code search
- [ ] Add impact analysis on file changes
- [ ] Implement debt tracking visualization
- [ ] Add export/share reports

## Technical Stack
- **Extension**: TypeScript + VS Code Extension API
- **UI**: React + VS Code WebView API
- **Communication**: MCP (Model Context Protocol)
- **State**: In-memory cache + SQLite (via MCP)

## File Structure
```
vscode-projectmind/
├── src/
│   ├── extension.ts          # Entry point
│   ├── mcpClient.ts          # MCP connection
│   ├── statusBar.ts          # Status bar items
│   ├── sidebar.ts            # Sidebar panel
│   ├── diagnostics.ts        # Inline diagnostics
│   ├── commands.ts           # Command handlers
│   └── config.ts             # Configuration
├── webview/
│   ├── SidebarPanel.tsx      # React sidebar
│   └── components/           # UI components
├── package.json              # Extension manifest
└── README.md
```

## Success Metrics
- < 100ms response time for inline hints
- < 5s for full project scan (incremental)
- < 50MB memory footprint
- Works offline (with Transformers.js)

## Next Steps
1. Create extension scaffold
2. Implement MCP client
3. Build MVP with scan + status bar
4. Publish to VS Code Marketplace
