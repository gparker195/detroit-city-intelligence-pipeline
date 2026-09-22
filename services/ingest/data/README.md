# data/ layout

Everything in this folder except this file is generated locally and ignored by git
(`services/ingest/.gitignore`). Snapshots are immutable: a folder is written once, under a
temporary name, then renamed into place; nothing ever rewrites it.

```text
data/
  raw/<source_id>/
    <snapshot_id>/                 fetch time as ISO 8601 with ':' -> '-' (e.g. 2026-09-22T01-52-01.344Z)
      records.ndjson               one canonical-JSON record per line: {key, attributes, geometry}
                                   sorted by the stable key (record_id | parcel_id | ticket_id | OBJECTID ...)
                                   so the sha256 is reproducible across runs
      meta.json                    snapshot_id, source_id, item_id, service_url, layer_url,
                                   fetched_at (we fetched), layer_last_edit (City updated, from editingInfo.lastEditDate),
                                   row_count, received_count, rejected_count, complete, sha256 (of records.ndjson),
                                   where, envelope, key_field, field_allowlist, fields_dropped, pages, paging_method
    latest.json                    pointer {snapshot_id, sha256, fetched_at, layer_last_edit}
    last_error.json                only present after a failed fetch; removed by the next success
  changes/<source_id>/
    <snapshot_id>.ndjson           Change records produced by `pnpm run diff` for that snapshot vs the one before it
                                   {change_id, source_id, entity_key, field, old, new, observed_at,
                                    previous_snapshot_id, snapshot_id, kind: added|removed|modified}
  health.json                      per-source {status, freshness, completeness, ...} from `pnpm run health`
  manifest.json                    latest snapshot per registered source with both dates from `pnpm run manifest`
```

Rules:

- A re-fetch whose records hash to the sha256 in `latest.json` writes nothing (use `--force` to write anyway).
- Field allowlists are applied before anything is written, so person-level fields from the City
  feeds (property_owner_*, inspector_*, owner_name, taxpayer address parts) never land on disk.
- Records carry only City open-data content. OpenStreetMap data is never written here.
