# ProjectMind v0.9.0 Hardening Execution Prompt

## 🎯 Objective
Implement the **prioritized hardening plan** documented in `HARDENING_PLAN.md`. Follow the exact order (CRITICAL → HIGH → MEDIUM) and validate each step before proceeding.

## 📌 Rules of Engagement
1. **Strict Adherence to Plan**: Do not skip or reorder fixes. If a fix requires clarification, ask for it **before** modifying code.
2. **Validation Gates**: After each fix:
   - Run `check_coherence` (fastOnly: true) on modified files.
   - If coherence fails, address suggestions **immediately**.
3. **Memory**: Store a single memory at the end with key `decision:v0.9.0-hardening` (format provided in the plan).
4. **Testing**: After all fixes, run:
   ```bash
   npm run test:vitest  # Must pass 330+ tests
   npm run lint         # Must have 0 errors
   npm run build        # Must succeed
   ```
5. **Git**: Do not commit. Changes will be reviewed before commit.

---

## 🧭 Workflow
### Step 1: Load the Plan
- Read `HARDENING_PLAN.md` (use `read` tool).
- Parse the file into a structured task list (CRITICAL first).

### Step 2: Execute Fixes
For **each fix** in the plan:
1. **Context**: Use `get_context` on the target file(s).
2. **Edit**: Apply the exact changes described in the plan.
3. **Validate**: Run `check_coherence` on the modified file(s).
4. **Proceed**: Only move to the next fix after validation passes.

### Step 3: Final Validation
1. Run full test suite (`npm run test:vitest`).
2. Run lint (`npm run lint`).
3. Run build (`npm run build`).
4. Store memory (key: `decision:v0.9.0-hardening`).

### Step 4: Deliver Summary
Provide a bullet-point summary of:
- What was fixed (by ID, e.g., K1, K2).
- Any remaining risks (e.g., "OAuth scope enforcement is coarse-grained").
- Next steps (e.g., "v0.9.0 release prep").

---

## 🛠️ Tools & Commands
- **File Context**: `get_context { filePath }` (before editing).
- **Coherence Check**: `check_coherence { code, filePath, fastOnly: true }` (after editing).
- **Testing**: `bash { command: "npm run test:vitest", timeout: 300000 }`.
- **Memory**: `projectmind_store_memory { scope: "decisions", key: "decision:v0.9.0-hardening", value: "..." }`.

---

## 🚨 Critical Notes
1. **K2 (API Key Leak)**: This is a **manual step** (requires `git filter-repo`). Skip the code changes for K2, but include it in the summary.
2. **K1 (MCP Server Crash)**: Lazy initialization may require updating all `new ClientRegistry()`/`new TokenService()` calls to use the new getters.
3. **K5 (Path Traversal)**: The `confineToProject` helper must be used in **all** file-reading tools (taint, sync, coherence, etc.).
4. **K6 (Bearer Token Hygiene)**: Add a migration for the `token_hash` column.

---

## 📋 Task List (Extracted from HARDENING_PLAN.md)
```
CRITICAL:
- K2: API Key Leak (manual)
- K1: MCP Server Crash
- K3: Guard Bypass
- K4: Arbitrary File Write
- K5: Path Traversal

HIGH:
- K6: Bearer Token Hygiene
- K7: WAL Data Loss
- K9: Vec Index Lifecycle
- K10: Circular Dependencies UNIQUE

MEDIUM:
- K12/R14: Parser Pool Hot Path
- K11/R15: Embedding Architecture
- K14/R16: Ghost Cleanup

PROTOCOL:
- S1: OAuth Scope Enforcement
- P8: CLI Bridge Whitelist
```

---

## 🏁 Start Execution
1. Read `HARDENING_PLAN.md` to confirm the task list.
2. Begin with **K1 (MCP Server Crash)**.
3. Proceed in order, validating each step.
4. Report progress after each fix (e.g., "K1 completed, coherence PASS").
5. After all fixes, run final validation and deliver the summary.