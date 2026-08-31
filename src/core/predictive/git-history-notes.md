# Git History Notes — Predictive Impact Analysis

## Question 6: Reliability of `git log --follow`

`git log --follow` is reliable for simple renames (single file moved within the same repo) because Git tracks content similarity and can follow a file across renames when the similarity threshold is met.

### Edge Cases

- **Submodules**: Submodule paths don't follow parent repo history. If a file lives inside a submodule, `git log --follow` in the parent repo will not trace changes inside the submodule because the parent only records submodule commit pointers, not internal file history.
- **Monorepos**: Multiple packages with the same relative paths (e.g., `packages/core/src/index.ts` in multiple packages) can confuse `--follow` because the path alone is ambiguous without package context.

### More Robust Alternative

For monorepos and complex rename scenarios, prefer:

```bash
git rev-list --objects --all -- <path>
```

This lists all objects (commits, trees, blobs) reachable from any ref for the given path, making it more robust when relative paths collide across packages or when submodule boundaries matter.
