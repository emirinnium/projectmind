# src/cli/context.ts

**Language:** TypeScript
**Exports:** 5

## function: `createCliContext`

* CLI Context - provides shared services for all CLI commands
 * Eliminates boilerplate duplication across command modules

```typescript
export function createCliContext()
```

## function: `getProjectRoot`
```typescript
export function getProjectRoot(options: CommandOptions)
```

## function: `getFilesToCheck`
```typescript
export function getFilesToCheck(path: string)
```

## class: `CliContext`
```typescript
export class CliContext
```

## interface: `CommandOptions`
```typescript
export interface CommandOptions
```
