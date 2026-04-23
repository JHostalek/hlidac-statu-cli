# hlidac-statu-cli

`hs` — a CLI wrapper for the [Hlídač státu](https://www.hlidacstatu.cz) REST API v2. Query Czech public-contracts data, company registries, subsidies, insolvencies, and people registries from the shell and pipe into `jq`.

Pure passthrough: no filtering, no projection, no interpretation. What the API returns is what you get. Subcommands are generated from the official OpenAPI spec, so `hs --help` stays in sync with the server.

## install

```bash
# via npm (published bundle — runs on node ≥18)
npm install -g @jhostalek/hlidac-statu-cli

# or from source (bun ≥1.1)
git clone https://github.com/JHostalek/hlidac-statu-cli.git
cd hlidac-statu-cli
bun install
bun run build    # dist/hs standalone binary
```

## auth

Get a token at https://www.hlidacstatu.cz/api and export it:

```bash
export HLIDAC_STATU_API_TOKEN=<your-token>
```

## usage

```bash
hs --help                                  # list top-level resources
hs smlouvy --help                          # subcommands under /smlouvy
hs smlouvy hledat --help                   # params for GET /smlouvy/hledat

hs smlouvy hledat --dotaz 'ico:00000000' --strana 1
hs smlouvy get 12345
hs firmy ico get 00000205                  # GET /firmy/ico/{ico}
hs firmy get 'ČEZ, a.s.'                   # GET /firmy/{jmenoFirmy}
hs dotace hledat --dotaz 'obnovitelné' --razeni 3
hs osoby get andrej-babis
hs datasety                                # GET /datasety (list)
hs datasety get sponzori-politickych-stran
```

All responses are pretty-printed JSON to stdout. Pipe into `jq`, `grep`, or redirect to a file:

```bash
hs smlouvy hledat --dotaz 'predmet:uklid' --strana 1 | jq '.results | length'
hs smlouvy get 12345 > contract.json
hs firmy ico get 00000205 | jq -r '.jmeno, .adresa'
```

### escape hatch

If a command you need isn't exposed as a subcommand (e.g. a spec collision, or a new endpoint we haven't pulled in), use `hs raw`:

```bash
hs raw GET /smlouvy/hledat dotaz=elektřiny strana=1
hs raw POST '/datasety/my-dataset/zaznamy' -d '[{"Id":"1","jmeno":"Ferda"}]'
```

Query params as `key=value` positional args; body via `-d <json>`.

## for agents

Programmatic discovery and structured output:

```bash
hs schema | jq                                 # full command tree as JSON
hs --json smlouvy hledat --dotaz x             # envelope: {request,status,ok,body,error?}
hs --dry-run smlouvy hledat --dotaz x          # resolve URL, no API call (no token needed)
```

See [AGENTS.md](./AGENTS.md) for the full agent contract.

## exit codes

| code | meaning                                                            |
|------|--------------------------------------------------------------------|
| 0    | HTTP 2xx/3xx success or `--dry-run`                                |
| 1    | HTTP ≥400 (body still on stdout) or generic local error            |
| 2    | Config error (missing env var) or invalid `--data` JSON            |

## coverage

61 of 62 OpenAPI endpoints are auto-generated at build time. The one exception (`POST /datasety/{datasetId}/zaznamy` bulk insert) collides with the item-level POST and is reachable via `hs raw`.

Commercial-licence-only endpoints (e.g. `/insolvence/*`, `/smlouvy/vsechnaID`) return 403 on free-tier tokens — the CLI surfaces them anyway; authorization is a server-side concern.

## data licence

Data retrieved via this tool is published by Hlídač státu under [CC BY 3.0 CZ](https://www.hlidacstatu.cz/texty/licence/). Any derived output you publish must attribute Hlídač státu and link back to https://www.hlidacstatu.cz.

## related

- [`hlidac-statu-mcp`](https://github.com/JHostalek/hlidac-statu-mcp) — MCP server variant for use with Claude Desktop and other MCP clients.

## licence

MIT — see [LICENSE](./LICENSE).
