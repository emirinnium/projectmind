# ProjectMind private cross-project isolation baseline

- Evaluator: `projectmind-cli-cross-project-isolation` v1
- Repositories: `zod`, `execa`
- Immutable checkout verification: `2/2`
- Shared SQLite project namespaces: `2`
- Indexed rows checked: `1,079`
- Scan errors: `0`
- Overlapping relative paths observed: `0`
- Input hash: `7e35e13905e63dde091d6468fb205888ca8bfc78fee4d77030f607f08c9d5434`
- Result: `PASS`

The evaluator created two projects through the real CLI, scanned each
immutable checkout with `scan --project <id> --full`, and then inspected the
shared SQLite store. Every stored absolute path was confined to the checkout
belonging to its project, and both project IDs had independent indexed rows.
The run is an isolation/namespace check, not a semantic retrieval-quality
claim. The third-party repositories remain temporary checkouts and no source
content is committed to ProjectMind.
