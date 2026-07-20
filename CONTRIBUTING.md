# contributing

## setup

Development uses Bun 1.3.14, recorded in `.bun-version` and `packageManager`:

```bash
git clone https://github.com/JHostalek/hlidac-statu-cli.git
cd hlidac-statu-cli
bun ci
bunx lefthook install
```

## workflow

```bash
bun run openapi:validate # validate all embedded operations
bun run check            # typecheck + lint
bun run test             # includes compiled-CLI contract tests
bun run build            # compile dist/hs
bun run dev              # source watch mode for local experiments
```

For a live smoke test, export `HLIDAC_STATU_API_TOKEN` and run `./dist/hs smlouvy hledat --dotaz 'ico:00000000'`. Prefer `./dist/hs --dry-run ...` when network access is unnecessary.

## CLI contract

Verify changes through the same discovery and output surface consumers use:

```bash
./dist/hs schema | jq '.commands | length'
./dist/hs --dry-run smlouvy hledat --dotaz x | jq '.request'
./dist/hs --json smlouvy hledat --dotaz x | jq '{ok,status,error}'
```

Global options precede the command path. Exit 0 means success or dry-run, exit 1 means an operational or HTTP failure, and exit 2 means invalid input or missing configuration. Keep stdout for results, stderr for plain diagnostics, and successful file output silent.

## architecture and conventions

- Strict TypeScript and ESM; explicit `.js` extensions on local imports.
- `src/generator.ts` plans the complete command tree from `src/openapi.json` without side effects.
- `src/cli-app.ts` maps that plan to Effect CLI. Keep one Effect runtime at `src/cli.ts`.
- `src/api.ts` owns Hlídač API request policy through Effect's HTTP client. Command handlers do not call `fetch` directly.
- `src/output.ts` owns rendering, streaming, and atomic filesystem publication.
- Expected runtime failures use the stable codes in `src/errors.ts`; rendering and exit mapping stay centralized.
- Do not add separate human/agent modes. Deterministic schema discovery, structured output, silence, and safe dry-run serve both.
- OpenAPI maintenance remains plain Bun: use `bun run openapi:sync`, and never edit `src/openapi.json` manually.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org).

## proof before a pull request

```bash
bun ci
bun run openapi:validate
bun run check
bun run test:coverage
bun run build
```

No test requires the production API or a real token.

## reporting issues

Include `hs --version`, Bun version, macOS version and architecture, the exact command, a redacted response, and reproduction steps. Never include API tokens, authorization headers, or private endpoint credentials.
