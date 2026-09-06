# `trace`

ProjectMind runtime tracing accepts normalized JSON and CSV edge-list input.

## Supported formats

- `json`: an array of calls or an object containing `calls`/`events`
- `csv`: `fromFunctionName,toFunctionName` with optional workload, count, and static-missed columns

`cgr` and `pprof` converters are not implemented. The CLI rejects these formats
explicitly instead of silently treating them as JSON. Convert those formats to
the normalized JSON/CSV contract before invoking `trace convert`.
