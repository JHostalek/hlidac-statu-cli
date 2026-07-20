# Specialized and internal surfaces

Several generated commands expose service infrastructure because `hs` mirrors the complete OpenAPI specification. Coverage does not mean every endpoint is an appropriate research tool.

## Website monitoring (`Weby`)

Use `Weby`, `Weby domeny`, `Weby nedostupnost`, and `Weby get <id>` only for questions about monitored Czech public websites, domains, or availability.

```text
Weby list → numeric website ID → Weby get <id> --days <small-number>
          ↘ organization IČO → firmy ico get <ico>
```

Prefer `Weby nedostupnost --days <n>` for outage questions. Use detail only for a selected service and keep `days` bounded because the timeseries can contain thousands of samples per day. `Weby domeny` returns newline-delimited plain text, not JSON; do not pipe it to `jq`.

Inspect the first response to learn the live record shape. Do not conflate website availability with the legal or operational status of the institution.

## Diagnostics

- `ping get <text>`: connectivity test.
- `getmyip`: inspect the caller IP as seen by the API; do not reveal it unless relevant.
- `Check`: health/diagnostic surface; inspect only when diagnosing access.
- `getexception`: deliberate exception behavior; avoid.

These endpoints do not answer public-data research questions.

## Infrastructure to quarantine

Do not call these domains during ordinary research:

- `aitask`: backend task creation, queue consumption, status changes, restarts, and completion.
- `voice2text`: speech-processing worker queues and state transitions.
- `ocr`: OCR task submission/storage/statistics.
- `tbls`: table-extraction task submission/statistics.

Some state-changing operations use GET. Treat names such as `AddTask`, `GetNextTask`, `SetTaskStatus`, and `RestartTask` as evidence of effects regardless of HTTP method. Queue/statistics responses can also contain operational or personal fields such as worker emails; do not fetch them casually.

Only operate these endpoints when the user explicitly asks to administer that subsystem, the exact effect is understood, and the target environment is authorized. Prefer `--dry-run` during investigation.

## Classification source

Use [endpoint-classification.json](endpoint-classification.json) when a command's default exposure or effect is uncertain. `default` means ordinary research use, `conditional` means a specialized or potentially costly workflow, and `avoid` means infrastructure or deliberate failure behavior.
