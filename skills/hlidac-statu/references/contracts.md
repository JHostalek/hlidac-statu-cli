# Contracts

Use this domain for the Czech Register of Contracts (`Registr smluv`): searching agreements, retrieving authoritative record detail, and extracting registered text or subject.

## Command map

```bash
hs smlouvy hledat --dotaz '<query>' --strana 1
hs smlouvy get '<contract-id>'
hs smlouvy text get '<contract-id>'
hs smlouvy predmet get '<contract-id>'
```

Inspect current sorting values with `hs smlouvy hledat --help`. They are numeric API enums, not stable English names.

`hs smlouvy vsechnaID` returns all current contract IDs and may require a commercial licence. Use dumps for bulk work when possible.

## Search recipes

The API accepts its own full-text syntax through `--dotaz`. Boolean operators must be uppercase. Useful established patterns include:

```bash
hs smlouvy hledat --dotaz 'ico:00000000'
hs smlouvy hledat --dotaz 'predmet:uklid'
hs smlouvy hledat --dotaz 'icoPrijemce:00000000 AND podepsano:[2025-01-01 TO 2025-12-31]'
hs smlouvy hledat --dotaz 'cena:>1000000 AND NOT(mena:EUR)'
```

Use `ico` for either side, `icoPlatce` for the public payer/customer, and `icoPrijemce` for the supplier/recipient. Other useful fields include `jmenoPlatce`, `jmenoPrijemce`, `dsPlatce`, `dsPrijemce`, `holding`, `holdingPlatce`, `holdingPrijemce`, `osobaid`, `cena`, `cenasDPH`, `cenabezDPH`, `zverejneno`, `podepsano`, `predmet`, `textSmlouvy`, `schvalil`, `oblast`, `mena`, `id`, and `idSmlouvy`.

Use quoted phrases for exact text and `[start TO end]` for ranges. Preserve the exact IČO string. Test unfamiliar fields independently before combining them.

## Investigation flow

1. Resolve an organization name to IČO with `firmy` when identity matters.
2. Search contracts using that IČO or a narrowly tested full-text query.
3. Inspect result keys and pagination metadata.
4. Retrieve each material contract by ID before making detailed claims.
5. Use `text` or `predmet` only when the detail response does not answer the question. `text` returns one string per attachment; `--addPredmet 1` appends the subject as an additional final element.

Search results are discovery records; detail is the better evidentiary source. Distinguish publication date, signature date, value, payer/customer, and supplier/contractor rather than calling every organization a “party” without its role.

## Caveats

- Hidden or missing price is not zero.
- `id` identifies a registry version; `idSmlouvy` can match several versions. Report which one the API returned.
- One page is not a complete search.
- Flags and record fields remain Czech because the CLI mirrors the API.
- Search syntax mistakes can produce zero results without proving absence.
