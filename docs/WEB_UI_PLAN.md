# Web UI / Dashboard Plan

## Overview
A web-based dashboard for ProjectMind that provides visual reports, charts, and interactive exploration of codebase intelligence.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Web Dashboard                         │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Overview   │  │  Debt       │  │  Security   │     │
│  │  (metrics)  │  │  (chart)    │  │  (issues)   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Hotspots   │  │  Embeddings │  │  Agents     │     │
│  │  (heatmap)  │  │  (similar)  │  │  (activity) │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    REST API Server                       │
├─────────────────────────────────────────────────────────┤
│                    ProjectMind Core                       │
└─────────────────────────────────────────────────────────┘
```

## Tech Stack
- **Frontend**: Next.js 14 + React 18 + Tailwind CSS
- **Charts**: Recharts or Chart.js
- **API**: Next.js API routes + ProjectMind MCP client
- **Auth**: Optional (local-first, no auth needed)

## Pages

### 1. Dashboard (`/`)
- Total files, languages, coverage
- Cognitive load distribution
- Recent scan history

### 2. Debt (`/debt`)
- Debt items by severity
- Pattern drift over time
- Architectural drift heatmap

### 3. Security (`/security`)
- Secrets found
- Eval/Function constructor usage
- Weak crypto detection

### 4. Hotspots (`/hotspots`)
- Files with highest cognitive load
- Most changed files
- Agent coverage map

### 5. Embeddings (`/embeddings`)
- Similar code search
- Code clustering visualization
- Duplicate detection

### 6. Agents (`/agents`)
- Agent activity timeline
- Files touched per agent
- Pattern fingerprints

## API Endpoints
```
GET  /api/scan              # Run scan
GET  /api/report            # Get full report
GET  /api/debt              # Get debt items
GET  /api/security          # Get security findings
GET  /api/hotspots          # Get hotspot files
GET  /api/embeddings/similar # Find similar code
GET  /api/agents            # Get agent profiles
```

## Implementation Plan

### Phase 1: Core Dashboard (1 week)
- [ ] Next.js scaffold
- [ ] API routes for scan/report
- [ ] Overview page with metrics
- [ ] Basic charts

### Phase 2: Detail Pages (1 week)
- [ ] Debt page
- [ ] Security page
- [ ] Hotspots page

### Phase 3: Advanced Features (1 week)
- [ ] Embeddings similarity search
- [ ] Agent activity timeline
- [ ] Export reports (PDF/JSON)

## File Structure
```
web/
├── package.json
├── next.config.js
├── tailwind.config.ts
├── src/
│   ├── app/
│   │   ├── page.tsx          # Dashboard
│   │   ├── debt/page.tsx
│   │   ├── security/page.tsx
│   │   ├── hotspots/page.tsx
│   │   ├── embeddings/page.tsx
│   │   ├── agents/page.tsx
│   │   └── api/
│   │       ├── scan/route.ts
│   │       ├── report/route.ts
│   │       └── ...
│   ├── components/
│   │   ├── MetricCard.tsx
│   │   ├── DebtChart.tsx
│   │   ├── Heatmap.tsx
│   │   └── AgentTimeline.tsx
│   └── lib/
│       ├── mcpClient.ts
│       └── formatters.ts
└── README.md
```

## Success Metrics
- < 2s page load time
- < 5s for full report generation
- Works offline (with Transformers.js)
- Mobile responsive

## Next Steps
1. Create Next.js scaffold
2. Build API routes
3. Create dashboard UI components
4. Add charts and visualizations
