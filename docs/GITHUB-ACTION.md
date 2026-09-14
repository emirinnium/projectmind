# ProjectMind GitHub Action

ProjectMind includes `.github/actions/projectmind/action.yml`, a composite
action for bounded CI checks on Linux, macOS, and Windows runners. It invokes
an exact npm version with `npx` and never requires `--legacy-peer-deps` or a
global install.

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - uses: emirinnium/projectmind/.github/actions/projectmind@master
    with:
      command: pr-preview
      version: 1.0.4
      format: sarif
      report-path: projectmind-review.sarif
  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: projectmind-review.sarif
```

Supported operations are deliberately limited to `health`, `audit`, and
`pr-preview`; arbitrary command strings are rejected. `health` and `audit`
produce JSON. `pr-preview` supports JSON, Markdown, SARIF, and GitHub markdown.
The report path must be workspace-relative and cannot contain traversal.

The action is a reporting/checking surface. It does not modify source files,
Git state, or repository configuration.
