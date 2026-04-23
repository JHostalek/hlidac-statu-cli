# contributing

## setup

```bash
git clone https://github.com/JHostalek/hlidac-statu-cli.git && cd hlidac-statu-cli
bun install
lefthook install
```

## workflow

```bash
bun run check        # typecheck + lint
bun run test         # run tests
bun run build        # compile standalone binary (dist/hs)
bun run dev          # watch mode for local experiments
```

for manual smoke tests, export `HLIDAC_STATU_API_TOKEN` (get one at https://www.hlidacstatu.cz/api) and run `./dist/hs smlouvy hledat --dotaz "ico:00000000"`.

## conventions

- strict TypeScript, ESM, explicit `.js` extensions on imports
- same-directory imports use `./`; no path aliases
- all HTTP requests go through `hlidacRequest()` in `src/api.ts` — never call `fetch()` directly from command handlers
- commands live under `src/commands/` (hand-written) or are auto-generated from `src/openapi.json` via `src/generator.ts`
- the generator is a pure passthrough — no projection, filtering, or interpretation of response bodies
- output contract: JSON body → stdout; `HTTP <status>` → stderr on ≥400; exit 0 on success, 1 on HTTP error, 2 on CLI misuse
- commits follow [conventional commits](https://www.conventionalcommits.org) (enforced via commitlint)

## submitting changes

1. fork and branch from `main`
2. follow the conventions above
3. `bun run check && bun run test && bun run build` — all green
4. open a PR with a clear description of what and why

## reporting issues

include: `hs --version`, bun version, node version, OS, the exact command you ran, redacted API response (no token), and steps to reproduce.
