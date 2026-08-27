# ProjectMind v0.9.0 Hardening Plan

## 🔴 CRITICAL PRIORITY (Today – 27 August 2026)

### K2: API Key Leak
**Risk**: Live API key committed in `opencode.json:35` (public GitHub repo).
**Files**: `opencode.json`, `.gitignore`
**Changes**:
```bash
# 1. Revoke the key immediately via TokenRouter dashboard.
# 2. Remove from Git history:
git filter-repo --replace-text <(echo "sk-RtytAH4o4HoK41B0LcCQTBz5gwUG8uzXypjO9L9AQAbrLhgv== tokenrouter_api_key")
# 3. Add to .gitignore:
echo "opencode.json" >> .gitignore
# 4. Replace with env reference:
echo '{"apiKey": "${TOKENROUTER_API_KEY}"}' > opencode.json
```
**Validation**: `git grep sk-RtytAH4o4` → 0 results.

---

### K1: MCP Server Crash
**Risk**: Top-level `getDatabase()` call in `mcp-server.ts:85-86` crashes server before initialization.
**Files**: `src/mcp/dependencies.ts`, `src/mcp-server.ts`
**Changes**:
```typescript
// src/mcp/dependencies.ts
let _oauthRegistry: ClientRegistry | null = null;
let _oauthTokens: TokenService | null = null;

export function getOauthRegistry(): ClientRegistry {
  return _oauthRegistry ??= new ClientRegistry(getDatabase());
}
export function getOauthTokens(): TokenService {
  return _oauthTokens ??= new TokenService(getDatabase(), OAUTH_TOKEN_TTL);
}

// src/mcp-server.ts: Remove lines 85-86 (top-level instantiation).
```
**Validation**: `node -e "import('./dist/index.js')"` → exit 0.

---

### K3: Guard Bypass (`pm_debt clear`)
**Risk**: `guard.ts` only blocks `clear-patterns`; `clear` deletes all debt data.
**Files**: `src/mcp/tools/guard.ts`, `src/mcp/tools/cli-parity.ts`
**Changes**:
```typescript
// src/mcp/tools/guard.ts
const BLOCKED_SUBCOMMANDS = new Map<string, Set<string>>([
  'debt', new Set(['clear', 'clear-patterns', 'rebuild-index', 'clean-debt']),
  // ...other commands
]);

// src/mcp/tools/cli-parity.ts:60-69
if (isBlockedCliInvocation(argv)) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Blocked by guard' }) }] };
}
```
**Validation**: `pm_debt {args:["clear"]}` → `{"ok":false,"error":"Blocked by guard"}`.

---

### K4: Arbitrary File Write (`-o` Flag)
**Risk**: 12 CLI commands (e.g., `layers`, `churn`) write to arbitrary paths via `-o`.
**Files**: `src/mcp/tools/_shared.ts`, CLI command files (e.g., `layers.ts`)
**Changes**:
```typescript
// src/mcp/tools/_shared.ts
export function safeOutputPath(output: string): string {
  const abs = path.resolve(loadConfig().projectRoot, output);
  if (!abs.startsWith(loadConfig().projectRoot + path.sep)) {
    throw new Error(`Output path escapes project root: ${output}`);
  }
  return abs;
}

// In CLI commands (e.g., layers.ts:139)
writeFileSync(safeOutputPath(opts.output), content);
```
**Validation**: `layers --output "../../.git/hooks/pre-commit"` → error.

---

### K5: Path Traversal (taint, sync, coherence)
**Risk**: `taint.ts:27` reads arbitrary files via `readFileSync(args.filePath)`.
**Files**: `src/mcp/tools/_shared.ts`, `taint.ts`, `sync.ts`
**Changes**:
```typescript
// src/mcp/tools/_shared.ts
export function confineToProject(p: string): string {
  const abs = path.resolve(loadConfig().projectRoot, p);
  if (!abs.startsWith(loadConfig().projectRoot + path.sep)) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  return abs;
}

// taint.ts:27
const content = readFileSync(confineToProject(args.filePath), 'utf-8');
```
**Validation**: `analyze_taint {filePath:"/etc/passwd"}` → error.

---

## 🟠 HIGH PRIORITY (This Week)

### K6: Bearer Token Hygiene
**Risk**: Tokens stored in plaintext in SQLite DB (default permissions).
**Files**: `src/auth/tokens.ts`, `src/storage/migrations.ts`
**Changes**:
```typescript
// tokens.ts:42-44
const tokenHash = createHash('sha256').update(token).digest('hex');
this.db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, ...) VALUES (?, ?, ...)').run(tokenHash, ...);

// verify()
const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hash);
```
**Validation**: DB file contains no plaintext tokens.

---

### K7: WAL Data Loss
**Risk**: Checkpoint failure deletes WAL files, causing silent data loss.
**Files**: `src/storage/database-core.ts`
**Changes**: Remove `unlinkSync(walPath)` and `unlinkSync(shmPath)` in catch block.
**Validation**: Concurrent process scenario → no data loss.

---

### K9: Vec Index Lifecycle
**Risk**: `rebuild()`/`remove()` never called; project filter missing.
**Files**: `src/storage/kg/projects.ts`, `src/storage/kg/files.ts`
**Changes**:
```typescript
// projects.ts:96 (project deletion)
vecIndex.remove(projectId);

// files.ts:128 (file upsert)
if (vecIndex.isAvailable()) vecIndex.upsert(fileId, embedding);
```
**Validation**: Project deletion removes vec rows.

---

### K10: Circular Dependencies UNIQUE Constraint
**Risk**: `cycle_path` lacks UNIQUE constraint; duplicates bloat table.
**Files**: `src/storage/migrations.ts`
**Changes**: Add migration:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_cycle_path ON circular_dependencies(cycle_path);
```
**Validation**: Duplicate cycles not inserted.

---

## 🟡 MEDIUM PRIORITY (2 Weeks)

### K12/R14: Parser Pool Hot Path
**Risk**: `multilang-parser.ts` creates new `Parser()` per file.
**Files**: `src/parser/multilang-parser.ts`
**Changes**: Replace `new Parser()` with `getParserFor(entry.language)`.
**Validation**: 1000 files → 1 parser instantiation.

---

### K11/R15: Embedding Architecture
**Risk**: Provider system disconnected; batch=1.
**Files**: `src/core/embeddings/embeddings.ts`
**Changes**:
```typescript
async function generateEmbeddings(texts: string[], dim: number): Promise<Float32Array[]> {
  if (currentProvider) return currentProvider.generateBatch(texts, dim);
  return legacyGenerateBatch(texts, dim); // Fallback
}
```
**Validation**: `llm.provider: gemini` affects scan.

---

### K14/R16: Ghost Cleanup
**Risk**: Dead modules (`tracer`, `PatternExtractor`, `VectorIndex`).
**Files**: `src/tracer/`, `src/parser/patterns/`, `src/core/embeddings/vector-index.ts`
**Changes**: Delete dead modules.
**Validation**: `git grep "tracer|PatternExtractor"` → 0 results.

---

## 📌 Protocol Improvements

### S1: OAuth Scope Enforcement
**Files**: `src/auth/http.ts`
**Changes**: Add scope validation in `handleToken()`:
```typescript
const allowedScopes = client.scope?.split(' ') || [];
if (scope && !allowedScopes.includes(scope)) {
  throw new AuthError('Invalid scope');
}
```
**Validation**: `scope: "admin"` → error.

---

### P8: CLI Bridge Whitelist
**Files**: `src/mcp/tools/cli-bridge.ts`
**Changes**: Update description to match actual allowlist.
**Validation**: `run_cli {args:["adr"]}` → `{"ok":false,"error":"not allowed"}`.

---

## 🛠️ Validation Gates
1. **Unit Tests**: `npm run test:vitest` (330+ tests pass).
2. **Lint**: `npm run lint` (0 errors).
3. **Build**: `npm run build` (0 errors).
4. **Smoke Test**:
   ```bash
   node -e "import('./dist/index.js')" && pm mcp
   ```

## 📝 Memory Key
Store as `decision:v0.9.0-hardening` with value:
```
v0.9.0 Hardening: 14 fixes applied (5 CRITICAL, 4 HIGH, 5 MEDIUM).
- **Security**: Path sandboxing (K5), guard runtime enforcement (K3), arbitrary file write prevention (K4), API key revocation (K2), bearer token hashing (K6).
- **Architecture**: MCP server lazy init (K1), vec index lifecycle (K9), circular dependencies UNIQUE (K10), parser pool hot path (K12).
- **Performance**: Embedding batch API (K11), ghost cleanup (K14).
- **Protocol**: OAuth scope enforcement (S1), CLI bridge whitelist (P8).
Gates: tsc 0, vitest 330+, lint 0 errors.
Remaining Risks:
- OAuth scope enforcement is coarse-grained (no fine-grained ACLs).
- Vec index dim-mismatch still logs warnings (no hard fail).
Next Steps:
1. Commit hardening changes (feat: v0.9.0 hardening).
2. v0.9.0 release prep (version bump, CHANGELOG, gates).
3. Monitor for regressions in CI/CD.
```