# Companies, institutions, people, and sponsorship

Use company and person endpoints primarily to resolve stable identifiers before searching relationships elsewhere.

## Companies and public institutions

```bash
hs firmy get 'ČEZ, a.s.'
hs firmy ico get 00000205
hs firmy GetDetailInfo --help
```

Use name lookup for discovery and IČO lookup for identity. Partial or even exact names can resolve to the wrong same-name legal entity, so verify the returned legal name, IČO, data box, organization type when available, and fit with the target dataset rather than trusting the first match. State why a candidate was selected when more than one is plausible. Treat IČO as an eight-character string. A name match can represent a company, political party, ministry, municipality, public organization, nonprofit, association, or another legal entity.

`firmy social` and `firmy GetDetailInfo` are specialized surfaces. Inspect leaf help before using them; do not assume they are ordinary single-company detail endpoints.

## People

```bash
hs osoby hledat --help
hs osoby get '<osobaId>'
hs osoby hledatFtx --ftxDotaz '<name>' --status 1 --strana 1
hs osoby PolitikFromText --help
hs osoby PoliticiFromText --help
```

Use `osoby hledatFtx` for ordinary name discovery. It returns a bare array; extract `nameId`, then call `osoby get <nameId>`. Stop paging when it returns an empty array. Status `1` covers politicians, officials, and political donors; status `0` covers non-political people and requires a commercial licence.

Use `osoby hledat --jmeno ... --prijmeni ... --datumNarozeni YYYY-MM-DD` for exact identity search. Although help marks the inputs optional, the live server requires all three. Keep the returned `nameId`; names alone are unsafe when people share a name.

Use `hledatFtx` for names found in free text. Use `PolitikFromText` or `PoliticiFromText` only when the task is explicitly entity extraction from text, not as a substitute for ordinary person search. Inspect whether the endpoint expects query text, a URL, or another parameter before calling it.

## Political sponsorship

```bash
hs sponzoring get '<recipient-party-ico>'
```

The path parameter is `icoPrijemce`: the recipient political party's IČO. This endpoint answers “who donated to this party?” It does not directly answer “which parties did this donor support?” Resolve the party through `firmy` when only its name is known, then filter the returned donation records for the donor when needed.

The response is an unpaged donation array. Filter and aggregate locally by donor, date/year, value, or donation type. Enrich a person donor through `nameIdDarce → osoby get`; enrich an organization donor through `icoDarce → firmy ico get`.

An `icoDarce` value proves only that the donor is an IČO-bearing legal entity; it does not prove the donor is a commercial company. Resolve and classify each candidate before answering “company donors.” Donation rows are individual gifts unless the user asks for totals per donor. State whether cash and valued in-kind gifts are combined, whether donors are aggregated, and how ties at the cutoff are handled.

## Cross-domain flow

```text
organization name → IČO
  ├─ contracts: smlouvy hledat
  ├─ subsidies: dotace hledat
  ├─ procurement: verejnezakazky hledat
  ├─ insolvency: insolvence hledat
  └─ political recipient: sponzoring get

person name → osobaId → osoby get
```

Contract records also hand off to company resolution through `platce.ico` and `prijemce[].ico`. Person-linked contract searches accept `osobaid:<nameId>`.

Not every search domain provides a dedicated IČO flag. When using an IČO inside a full-text query, say so and validate that query separately.

## Identity caveats

- Do not remove leading zeroes from IČO.
- Do not merge entities from names alone.
- A non-empty result from the intended downstream domain can help disambiguate candidates, but absence is not identity proof.
- Historical names and organizational changes can split or merge records.
- A person appearing in Hlídač státu is not itself evidence of wrongdoing.
- Social-profile and sponsorship data may be incomplete or time-bounded.
- Person event `organizace` values are polymorphic; validate that a numeric-looking value is an IČO before using it as one.
- Upstream sponsorship data contains misspelled fields such as `daumNarozeniDarce`; inspect actual keys.
