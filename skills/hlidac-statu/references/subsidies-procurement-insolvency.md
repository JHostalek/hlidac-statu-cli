# Subsidies, public procurement, and insolvency

These domains describe different relationships. Do not treat a procurement notice, signed contract, subsidy award, and insolvency proceeding as interchangeable evidence.

## Subsidies (`dotace`)

```bash
hs dotace hledat --dotaz '<query>' --strana 1
hs dotace get '<subsidy-id>'
```

The search uses the API's full-text syntax. Useful fields include `ico`, `jmeno`, `holding`, `osobaid`, `castka`, `projekt`, `program`, `kodProgramu`, `kodProjektu`, `typ`, and `oblast`.

```bash
hs dotace hledat --dotaz 'ico:00000205 AND castka:>1000000' --razeni 3
hs dotace hledat --dotaz 'typ:Evropska AND oblast:ZivotniProstredi'
```

Sorting is a numeric enum; inspect leaf help before selecting `--razeni`. Search first, then retrieve material records by `results[].id`. Search and detail can have the same top-level fields; detail still confirms the record exists under that ID.

## Public procurement (`verejnezakazky`)

```bash
hs verejnezakazky CpvOblasti
hs verejnezakazky hledat --ico 00000000 --strana 1
hs verejnezakazky hledat --oblast IT --zverejnenoOd 2025-01-01 --zverejnenoDo 2025-12-31
hs verejnezakazky get '<procurement-id>'
```

This is the richest typed search surface. It supports combinations of full text, CPV prefixes or areas, publication/signature/change date ranges, price ranges, IČO, page, and numeric sorting. Discover exact flags and types from leaf help.

Use `CpvOblasti` to discover accepted area identifiers before applying `--oblast`. CPV codes are hierarchical; prefix matching can intentionally broaden a query.

Use `--ico` for either buyer or supplier. Use `icozadavatel:<ico>` or `icododavatel:<ico>` inside `--dotaz` when the role matters. Other useful query fields include `jmenozadavatel`, `jmenododavatel`, `holdingzadavatel`, `holdingdodavatel`, `cpv`, `oblast`, `cena`, `zverejneno`, `podepsano`, `id`, `text`, `predmet`, `mena`, and `zahajeny:1` for begun/API-open records.

Do not describe `zahajeny:1` matches as currently accepting bids without checking a live submission deadline or primary notice. Records can have null deadlines or already name a supplier.

Search records can already contain buyer, suppliers, CPV, prices, dates, state, issue flags, forms, documents, and changelog. If `verejnezakazky get <results[].id>` returns 404 for a live search result, treat detail as unavailable and use the embedded search record; do not guess a replacement ID.

## Insolvency (`insolvence`)

```bash
hs insolvence hledat --dotaz '<query>' --strana 1
hs insolvence get '<proceeding-id>'
```

The embedded OpenAPI summaries incorrectly describe these as contract endpoints. Treat that text as a specification defect. The endpoints concern insolvency proceedings, and the detail identifier is the `spisovaZnacka` (case/file reference).

Use general fields to match any procedural role, or role-specific fields when the distinction matters:

```bash
hs insolvence hledat --dotaz 'ico:00000205'
hs insolvence hledat --dotaz 'icodluznik:00000205'
hs insolvence hledat --dotaz 'icoveritel:00000205'
hs insolvence hledat --dotaz 'icospravce:00000205'
hs insolvence hledat --dotaz 'id:"INS 11818/2026"'
hs insolvence get 'INS 11818/2026'
```

Equivalent role-specific forms exist for person IDs, holdings, and names. Useful date/document fields include `zahajeno`, `zmeneno`, `typdokumentu`, `texttypdokumentu`, and `text`.

Access may require a commercial licence. HTTP 403 means unavailable access, not zero matching proceedings.

Full records can contain birth dates and Czech personal-identifier fields. Extract only what the question requires; do not echo entire records.

## Comparative investigation

For an organization:

1. Resolve the IČO.
2. Search procurement to find tenders and awards.
3. Search contracts to find registered agreements.
4. Search subsidies for public funding.
5. Search insolvency for proceedings involving the entity.
6. Correlate only on stable identifiers, record IDs, and dates.

Avoid causal claims from temporal proximity alone. A tender can produce multiple contracts; a contract can be amended; a subsidy record can cover a different project; an insolvency hit can involve different procedural roles.
