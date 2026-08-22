# ProjectMind Web Dashboard

A web-based dashboard for ProjectMind that provides visual reports, charts, and interactive exploration of codebase intelligence.

## Tech Stack

- **Frontend**: Next.js 14 + React 18 + Tailwind CSS
- **Charts**: Recharts
- **API**: Next.js API routes + ProjectMind CLI

## Getting Started

```bash
cd web
npm install
npm run dev
```

The dashboard will be available at `http://localhost:3000`.

## Pages

1. **Dashboard** (`/`) — Overview metrics and charts
2. **Debt** (`/debt`) — Cognitive debt analysis
3. **Security** (`/security`) — Security audit findings
4. **Hotspots** (`/hotspots`) — Code hotspot files
5. **Embeddings** (`/embeddings`) — Similar code search
6. **Agents** (`/agents`) — Agent activity timeline

## API Endpoints

- `POST /api/scan` — Run a full project scan
- `GET /api/report` — Get the full scale report

## Configuration

The dashboard connects to the ProjectMind CLI via npx. Make sure the CLI is built:

```bash
cd ..
npm run build
```
