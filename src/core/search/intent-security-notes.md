# Intent Broadcast Security Notes — Private Branch Sanitization

## Question 5 (partially addressed)

When broadcasting intent results or sharing search outputs across branches, private branch changes must be sanitized before transmission.

### Sanitization rule
- Before including any file change in an intent broadcast, check the current branch:
  ```bash
  git branch --show-current
  ```
- If the branch is **not** a public branch (e.g., `main`, `master`, `release/*`, `public/*`), exclude the change from the broadcast.
- Only include changes from branches that are explicitly public or tagged for release.
- This prevents accidental leakage of experimental or private work into shared intent channels.

### Implementation note
In `src/core/search/intent-engine.ts`, any future broadcast integration should filter results by verifying `git branch --show-current` and excluding non-public branches from the output set.
