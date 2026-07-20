---
name: hlidac-statu
description: Investigate Czech public-sector data through the hs CLI, including contracts, companies, people, subsidies, insolvency, public procurement, political sponsorship, custom datasets, website monitoring, and bulk dumps. Use when a user asks to find, compare, trace, explain, or export data from Hlídač státu; translate English intent into the Czech REST command surface; connect records through IČO, person IDs, contract IDs, or dataset IDs; and report evidence with appropriate limitations.
---

# Investigate with Hlídač státu

Use `hs` as the deterministic execution layer. Supply the domain model, command selection, query construction, cross-domain chaining, and interpretation that the raw REST surface does not provide.

## Work from intent, not endpoint names

Route the request before discovering syntax:

| User intent | Start with | Read |
|---|---|---|
| Find contracts, contract parties, values, text, or anomalies | `smlouvy` | [contracts.md](references/contracts.md) |
| Resolve a company, institution, municipality, or person | `firmy` or `osoby` | [entities-people-sponsorship.md](references/entities-people-sponsorship.md) |
| Trace political donations | `sponzoring`, after resolving the recipient party's IČO | [entities-people-sponsorship.md](references/entities-people-sponsorship.md) |
| Find subsidies, tenders, or insolvency proceedings | `dotace`, `verejnezakazky`, or `insolvence` | [subsidies-procurement-insolvency.md](references/subsidies-procurement-insolvency.md) |
| Search user-created data or obtain bulk exports | `datasety`, `dumps`, `dumpItems`, or `dumpZip` | [datasets-dumps.md](references/datasets-dumps.md) |
| Inspect monitored public websites | `Weby` | [specialized-and-internal.md](references/specialized-and-internal.md) |
| Diagnose or operate API infrastructure | Usually decline or explain the boundary | [specialized-and-internal.md](references/specialized-and-internal.md) |

Read only the references required for the current request.

## Discover the live command surface

Do not recall flags from memory. Discover them in this order:

```bash
hs schema | jq '.[] | select(.path[0] == "smlouvy")'
hs smlouvy --help
hs smlouvy hledat --help
```

Treat `path` in `hs schema` as the literal argument tail after `hs`. Use `hs raw` only when the generated command cannot represent an operation.

Before a complicated request, verify URL construction without calling the API:

```bash
hs --dry-run smlouvy hledat --dotaz 'ico:00000000' --strana 1
```

Use `--json` when request metadata and status must remain attached to the result. Otherwise use the bare JSON body for `jq` pipelines.

## Follow identifiers across domains

Prefer stable identifiers to names:

```text
company or institution name → firmy lookup → IČO
person name → osoby search → osobaId
search result → domain detail endpoint → record ID
political party name → firmy lookup → recipient IČO → sponzoring
dump datatype + date → dumpZip
dataset name → datasetId → search or item detail
```

Resolve ambiguous names first. Preserve leading zeroes in IČO values by treating them as strings. Do not assume that similarly named organizations or people are identical.

For an organization investigation, reuse its IČO across contracts, subsidies, procurement, insolvency, and sponsorship where the target endpoint supports it. State when a domain has no direct IČO filter and a full-text query is being used instead.

## Build and verify searches

Start narrowly enough to test the query, then broaden deliberately. Inspect the first response before writing a projection:

```bash
hs smlouvy hledat --dotaz 'ico:00000000' --strana 1 | jq 'keys'
```

Use the API's search syntax exactly; do not translate field names inside `--dotaz`. Combine filters only after validating each important filter independently. If the result is empty, distinguish among no matching data, wrong identifier, unsupported query syntax, unavailable licence, and pagination beyond the result set.

Most searches use the 1-indexed `--strana` flag and do not page automatically. Loop explicitly and stop based on response metadata or an empty/thin result page. Search endpoints commonly return 25 records per page. Help may advertise page 250 while a live endpoint enforces 200; treat a 400 near the end as a server limit, not completion. Do not claim completeness from one page or beyond the server's accessible window.

Keep request rate at or below four calls per second. On HTTP 429, back off rather than retrying immediately.

## Apply safety boundaries

Default to operations classified as `default` and `read` in [endpoint-classification.json](references/endpoint-classification.json).

- Treat `POST`, `PUT`, `DELETE`, and `hs raw` mutations as writes. Explain the exact target and obtain authorization before calling them.
- Treat endpoints under `aitask`, `ocr`, `tbls`, and `voice2text` as service infrastructure. Do not call them for ordinary research, including GET endpoints whose names imply state changes or queue consumption.
- Treat `getexception` as a deliberate error endpoint and do not call it for diagnostics.
- Use `-o` for binary responses. Confirm the destination before large downloads or overwrites.
- Never infer that an endpoint is safe from its HTTP method alone.

Use `hs --dry-run` to demonstrate mutation request construction without changing remote state.

## Report evidence, not API-shaped noise

Answer the user's question rather than dumping the response. Include:

1. The material finding.
2. Identifiers used to disambiguate subjects.
3. Relevant dates, values, parties, and record IDs.
4. Search scope and pagination performed.
5. Access, licence, coverage, or data-quality limitations.

Label absence carefully: “the query returned no records” is not proof that an event never occurred. Preserve Czech proper names and identifiers exactly. Translate field meaning when useful, but do not silently reinterpret the underlying data.

## Handle failures

- Missing token: explain `HLIDAC_STATU_API_TOKEN`; continue with `--dry-run` when request construction alone is useful.
- HTTP 403: report the endpoint and likely access-tier boundary; do not treat it as an empty dataset.
- HTTP 4xx: inspect the returned body, leaf help, and dry-run URL before changing the query.
- Binary response without `-o`: rerun only after choosing a safe output path.
- Missing or colliding generated command: inspect `hs schema`, then use `hs raw` with the same output and safety rules.
