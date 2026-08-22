# src/cli/utils/shared.ts

**Language:** TypeScript
**Exports:** 10

## function: `createContext`

* Shared CLI utilities to reduce import coupling and boilerplate across command modules

```typescript
export function createContext()
```

## function: `closeContext`

* Closes the database connection

```typescript
export function closeContext(ctx: CLIContext)
```

## function: `formatGenomeScore`

* Generic wrapper for CLI commands that need database access
 * Handles context creation, error handling, and cleanup

```typescript
export function formatGenomeScore(score: number)
```

## function: `formatDebtReport`

* Format debt report for display

```typescript
export function formatDebtReport(report: { totalItems: number; bySeverity: Record<string, number>; coherenceGenomeScore: number; items: any[] })
```

## function: `handleCliError`

* Standard error handler for CLI commands

```typescript
export function handleCliError(error: unknown, context?: string)
```

## function: `getFilesToCheck`

* Async handler wrapper for Commander commands

```typescript
export function getFilesToCheck(path: string)
```

## function: `trackAgentTouched`

* Base class for CLI commands to eliminate boilerplate

```typescript
export function trackAgentTouched(kg: KnowledgeGraph, filePath: string, agentName: string)
```

## interface: `CLIContext`
```typescript
export interface CLIContext
```

## interface: `ServiceMap`
```typescript
export interface ServiceMap
```

## interface: `RetryOptions`
```typescript
export interface RetryOptions
```
