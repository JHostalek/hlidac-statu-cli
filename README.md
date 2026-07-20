# hlidac-statu-cli

`hs` is a CLI wrapper for the [Hlídač státu](https://www.hlidacstatu.cz) REST API v2. It exposes all 63 operations from an embedded OpenAPI document and returns the API payload without projection or interpretation.

## install

The supported distribution target is macOS on Apple Silicon:

```bash
brew install JHostalek/tap/hs
```

To build from source, install [Bun](https://bun.sh) 1.3.14:

```bash
git clone https://github.com/JHostalek/hlidac-statu-cli.git
cd hlidac-statu-cli
bun ci
bun run build
./dist/hs --version
```

## discover commands

Start with the machine-readable command contract. Each `path` is the literal argument sequence after `hs`:

```bash
hs schema | jq
hs schema smlouvy | jq '.commands[] | {path, summary}'
hs schema smlouvy hledat | jq '.commands[0]'

hs --help
hs smlouvy --help
hs smlouvy hledat --help
```

Command names mirror the Czech API (`smlouvy` = contracts, `firmy` = companies, `osoby` = people, `dotace` = subsidies, `hledat` = search). The schema is the reliable mapping from an intent to an executable path.

## authenticate

Live API requests require a token from https://www.hlidacstatu.cz/api:

```bash
export HLIDAC_STATU_API_TOKEN=<your-token>
```

An explicit `HLIDAC_STATU_BASE_URL` is intended for controlled endpoints and local tests; those requests may run without a token.

## invoke

Global options belong before the command path. Endpoint parameters follow it:

```bash
hs smlouvy hledat --dotaz 'ico:00000000' --strana 1
hs firmy ico get 00000205 | jq '.jmeno'
hs --timeout 90s dotace hledat --dotaz 'obnovitelné'
```

Default mode writes the bare response body to stdout. JSON bodies are pretty-printed; text bodies remain text. HTTP failures preserve the server body on stdout and write `HTTP <status>` to stderr.

Use `--json` for one stable envelope on parsed command success or failure:

```bash
hs --json smlouvy hledat --dotaz x
# {"request":{...},"status":200,"ok":true,"body":...}
```

The envelope exposes a public error `code` and conservative `retryable` value. Discover the closed code set with:

```bash
hs schema | jq '.errorCodes'
```

Use `--dry-run` to validate and fully encode a request without credentials or network access. It always emits the envelope shape:

```bash
hs --dry-run smlouvy hledat --dotaz 'česká energie' | jq '.request'
hs --dry-run datasety zaznamy post set --data '{"Id":"1"}'
```

Write the selected stdout representation atomically with `-o`. Successful file output is silent:

```bash
hs -o results.json smlouvy hledat --dotaz x
hs --json -o envelope.json smlouvy hledat --dotaz x
```

Binary responses require `-o` in default mode so bytes never reach the terminal accidentally:

```bash
hs -o smlouvy.zip dumpZip get smlouvy 2026-04-21
```

With `--json`, binary bytes are drained but not embedded; `body` is `null` and `contentType` plus `bodyBytes` describe the response.

## raw requests

`raw` is the escape hatch for an endpoint not yet present in the embedded specification:

```bash
hs raw GET /smlouvy/hledat dotaz=elektřiny strana=1
hs raw POST /datasety -d '{"hello":"world"}'
hs --json raw GET /firmy/ico/00000205
```

## exit codes

| code | meaning |
|---:|---|
| 0 | Success (HTTP 2xx/3xx) or dry-run |
| 1 | HTTP, transport, timeout, binary-output, filesystem, or internal failure |
| 2 | Invalid input or missing configuration |

Parser errors use Effect CLI's standard text diagnostics. Successfully parsed `--json` commands return structured failures. Stdout contains results; stderr contains plain diagnostics only. There are no progress indicators, banners, success messages, or TTY-dependent output modes.

See [AGENTS.md](./AGENTS.md) for the compact operational contract.

## OpenAPI coverage

All 63 embedded OpenAPI operations have generated commands. Route collisions are resolved deterministically; for example, the item-specific dataset-record route is `datasety zaznamy post-by-item-id`.

Commercial-licence-only endpoints may return 403 with free-tier tokens. The CLI still exposes them because authorization is server policy.

## data licence

Data retrieved through this tool is published by Hlídač státu under [CC BY 3.0 CZ](https://www.hlidacstatu.cz/texty/licence/). Published derivatives must attribute Hlídač státu and link to https://www.hlidacstatu.cz.

## related

- [`hlidac-statu-mcp`](https://github.com/JHostalek/hlidac-statu-mcp) — MCP server variant

## licence

MIT — see [LICENSE](./LICENSE).
