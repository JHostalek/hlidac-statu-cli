# AGENTS.md — `hs` for LLM agents

`hs` wraps the Hlídač státu REST API v2. Subcommands are auto-generated from the OpenAPI spec, so the surface always matches the server.

## Required env

```bash
export HLIDAC_STATU_API_TOKEN=<token>   # get one at https://www.hlidacstatu.cz/api
```

`--dry-run` is the one mode that does not require a token.

## Discovery, in this order

```bash
hs schema | jq                       # full machine-readable command tree
hs --help                            # top-level groups
hs <group> --help                    # leaf commands under a group
hs <group> <leaf> --help             # typed flags with (type, required, default, enum) hints
```

`hs schema` returns one entry per leaf endpoint:

```json
{
  "path": ["smlouvy", "hledat"],
  "method": "GET",
  "httpPath": "/smlouvy/hledat",
  "summary": "Vyhledá smlouvy v databázi smluv",
  "pathParams": [],
  "queryParams": [
    { "name": "dotaz", "type": "string", "required": false, "description": "fulltext dotaz" },
    { "name": "strana", "type": "integer", "required": false, "description": "stránka, max. 250" }
  ],
  "hasRequestBody": false
}
```

`path` is the literal argv tail you'd pass after `hs`. To invoke the entry above: `hs smlouvy hledat --dotaz x --strana 1`.

## Output modes

Default (no flag) — bare body to stdout, `HTTP <code>` to stderr on ≥400. Pipe to `jq`.

```bash
hs smlouvy hledat --dotaz 'ico:00000000'      # pretty JSON body, exit 0/1
```

Envelope (`--json`) — wrap everything for programmatic consumption:

```bash
hs --json smlouvy hledat --dotaz x
# { "request": {"method":"GET","url":"..."}, "status":200, "ok":true, "body": ... }
# on 4xx/5xx: ok=false, error=<body>, exit 1
```

Dry-run (`--dry-run`) — resolve URL + query, do not call the API. Forces envelope shape, always exit 0:

```bash
hs --dry-run smlouvy hledat --dotaz x
# { "request": {...}, "status":0, "ok":true, "body":null, "dryRun":true }
```

File output (`-o, --output <path>`) — write the response body to a file instead of stdout. Combines with any other mode; stderr gets a one-line `wrote N bytes to <path>` confirmation:

```bash
hs smlouvy hledat --dotaz x -o results.json         # pretty JSON → file
hs --json smlouvy hledat --dotaz x -o envelope.json # envelope → file
```

## Binary responses

Non-JSON endpoints (e.g. `GET /dumpZip/{datatype}/{date}` returns `application/zip`) **require `-o`** — the CLI will not write bytes to stdout. Without `-o`:

```
$ hs dumpZip get smlouvy 2026-04-21
binary response (application/zip, 25782 bytes); use -o <path> to save
# exit 1
```

With `-o`, bytes land on disk unchanged:

```bash
hs dumpZip get smlouvy 2026-04-21 -o smlouvy.zip
# wrote 25782 bytes to smlouvy.zip (application/zip)
```

Under `--json`, the envelope for a binary response reports metadata only — `body` is `null`, and new fields `contentType` + `bodyBytes` describe what was returned:

```bash
hs --json dumpZip get smlouvy 2026-04-21
# { "request": {...}, "status":200, "ok":true, "contentType":"application/zip", "bodyBytes":25782, "body":null }
```

To fetch the latest available dump for a datatype, resolve the date via `/dumps` first:

```bash
DATE=$(hs dumps | jq -r 'map(select(.dataType == "smlouvy")) | max_by(.date) | .date[:10]')
hs dumpZip get smlouvy "$DATE" -o "smlouvy-$DATE.zip"
```

## Exit codes

| Code | Meaning                                                           |
|------|-------------------------------------------------------------------|
| 0    | Success (HTTP 2xx/3xx) or dry-run                                 |
| 1    | HTTP 4xx/5xx (default mode); generic local error                  |
| 2    | Config error (missing env var) or invalid `--data` JSON           |

## Escape hatch — `hs raw`

When the generated command is wrong or you need an endpoint not yet in the spec:

```bash
hs raw GET /smlouvy/hledat dotaz=elektřiny strana=1
hs raw POST /datasety -d '{"hello":"world"}'
hs --json raw GET /firmy/ico/00000205
```

## Pagination

Most search endpoints use `--strana <n>` (1-indexed). There is no built-in paging — loop in your script and stop when the result set thins out.

## Language note

Command names mirror the API: Czech (`smlouvy`=contracts, `firmy`=companies, `osoby`=people, `dotace`=subsidies, `verejnezakazky`=public procurement, `hledat`=search, `get`=detail). Use `hs schema` to map English intents to Czech paths.

## Conventions

- Default mode is byte-stable for `| jq` pipelines. `--json` is opt-in.
- Param types in `--help` are wrapped in parens: `(integer, required, default 1, enum: 0|1|2)`.
- Path-param leaves are named after the HTTP method (`smlouvy get <id>`, `datasety delete <id>`), so a path-only group like `smlouvy` always lists its sub-actions under `--help`.
- If `hs schema` collides with a future `/schema` endpoint, fall back to `hs raw GET /schema`.
