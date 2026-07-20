# Custom datasets and bulk dumps

Use custom datasets for Hlídač-hosted collections outside the fixed REST domains. Use dumps for bulk, offline, or reproducible analysis.

## Read custom datasets

```bash
hs datasety
hs datasety get '<datasetId>'
hs datasety hledat '<datasetId>' --help
hs datasety zaznamy get '<datasetId>' '<itemId>'
hs datasety zaznamy existuje '<datasetId>' '<itemId>'
```

Discover a `datasetId` from the list before searching or retrieving records. Dataset schemas differ; inspect dataset metadata and the first result before writing `jq` projections.

`jsonSchema` is a JSON-encoded string. Decode it before constructing field-specific queries or projections:

```bash
hs datasety get '<datasetId>' | jq '.jsonSchema | fromjson'
```

Use dataset metadata `origUrl` and `sourcecodeUrl` for provenance when present. Search returns 25 records per page in observed datasets. The `desc` search option is a string value such as `0` or `1`, not a generated boolean flag.

Dataset creation, update, deletion, record upsert, and bulk insert are remote writes. Do not perform them merely because the user asked to “check” or “explore” a dataset. Use `--dry-run` to demonstrate request construction. Update cannot change `datasetId` or `jsonSchema`. Item-write modes such as `skip`, `merge`, and `rewrite` have different overwrite behavior; inspect help and obtain explicit authorization.

The generated bulk-insert command is distinct from the item-level `post-by-item-id` command:

```bash
hs datasety zaznamy post '<datasetId>' --data '[...]'
```

## Discover dumps

```bash
hs dumps
hs dumpItems get '<datatype>'
```

Inspect available datatypes, dates, sizes, and `fulldump` flags rather than guessing them. Available types are not guaranteed to cover every REST domain. For example, a custom dataset about subsidy recipients is not equivalent to individual `dotace` records.

To choose the latest incremental contract dump:

```bash
hs dumps | jq -r '[.[] | select(
  .dataType == "smlouvy" and .fulldump == false and .date != null
)] | max_by(.date) | .date[:10]'
```

## Download a dump

```bash
hs -o '<safe-path>.zip' dumpZip get '<datatype>' '<YYYY-MM-DD>'
```

`dumpZip` returns binary data and requires `-o`. Without it, `hs` refuses to put bytes on stdout. Do not use `--json` as a substitute for downloading: the JSON envelope reports metadata while leaving `body` null.

Confirm before overwriting an existing path or downloading unexpectedly large data. Keep the datatype and source date alongside derived artifacts for reproducibility.

Avoid `dumpItems` unless the user explicitly needs its undated JSON export and accepts its size. Large full JSON responses can exceed local string/memory limits, and dated JSON URLs advertised by dump metadata may be unavailable. Prefer `dumps → dated dumpZip`.

## Choose search or bulk

Use search when the request is narrow, interactive, or needs current server-side indexing. Use dumps when the task needs complete iteration, repeated local analysis, or a stable snapshot. API search pagination limits can make it unsuitable for exhaustive export. The CLI streams binary downloads to disk, so confirm disk expectations for large full dumps.
