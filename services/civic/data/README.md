# services/civic/data — generated, git-ignored (this README is the only tracked file)

```text
data/
  raw/<source_id>/<fetched_at>__<name>            bytes exactly as received (immutable; new sha256 -> new file)
  raw/<source_id>/<fetched_at>__<name>.meta.json  {url, sha256, bytes, fetched_at, source_updated, content_type}
  normalized/<source_id>.ndjson                   one record per line; replaced on every run
  manifest.json                                   per source: fetched_at (always), source_updated (when published), counts, raw refs, status
  *.log                                           stderr of the last CLI run (request log)
```

Source ids: `usaspending`, `bonfire`, `programs`, `mcm-cash-awardees`, `mcrs-awardees`, `mi-stc` (+ `mi-stc-statewide.ndjson`), `elections`.
`DCI_CIVIC_DATA_DIR` overrides this directory.
