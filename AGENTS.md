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
