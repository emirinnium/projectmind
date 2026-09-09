# `trace`

ProjectMind runtime tracing accepts normalized JSON and CSV edge-list input,
Code-Graph-RAG JSONL traces, and Node/V8 `.cpuprofile` files.

## Supported formats

- `json`: an array of calls or an object containing `calls`/`events`
- `csv`: `fromFunctionName,toFunctionName` with optional workload, count, and static-missed columns
- `cgr`: newline-delimited Code-Graph-RAG records. Both canonical snake-case
  fields (`from_function`, `to_function`, `workload_id`, `dynamic_call_count`)
  and ProjectMind field names are accepted; stack records become adjacent edges.
- `cpuprofile`: V8 CPU profiles produced by `node --cpu-prof`. Sampled parent-
  child edges are emitted with their sample frequency as `callCount`.

Examples:

```bash
pm trace convert cgr-trace.jsonl --format cgr --workload-id smoke -o trace.json
pm trace convert run.cpuprofile --format cpuprofile --workload-id smoke -o trace.json
pm trace ingest trace.json --workload-id smoke
```

Native Go `pprof` is a gzip-compressed protobuf profile rather than a stable
JSON edge-list contract. ProjectMind does not pretend to parse it as JSON; use
the upstream pprof tooling to export a trace/edge list first, then convert that
normalized JSON or CSV. This keeps sampled-profile limitations explicit.
