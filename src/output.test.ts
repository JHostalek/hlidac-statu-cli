import { describe, expect, test } from 'bun:test';
import type { HlidacResult } from './api.js';
import { formatEnvelope, formatOutcome } from './output.js';

const base = (over: Partial<HlidacResult>): HlidacResult => ({
  method: 'GET',
  url: 'https://api.hlidacstatu.cz/api/v2/x',
  status: 200,
  contentType: 'application/json',
  body: undefined,
  raw: '',
  ...over,
});

describe('formatOutcome', () => {
  test('exit 0 with pretty-printed JSON body on 2xx', () => {
    const outcome = formatOutcome(base({ status: 200, body: { ok: true }, raw: '{"ok":true}' }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBeUndefined();
    expect(outcome.stdout).toBe('{\n  "ok": true\n}');
  });

  test('exit 1 with HTTP status on stderr for 4xx', () => {
    const outcome = formatOutcome(
      base({ status: 403, body: { message: 'forbidden' }, raw: '{"message":"forbidden"}' }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toBe('HTTP 403');
    expect(outcome.stdout).toContain('forbidden');
  });

  test('falls back to raw text when body is undefined', () => {
    const outcome = formatOutcome(base({ status: 502, body: undefined, raw: '<html>Bad Gateway</html>' }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe('<html>Bad Gateway</html>');
  });
});

describe('formatEnvelope', () => {
  test('200 wraps body in envelope with ok=true and exit 0', () => {
    const outcome = formatEnvelope(base({ status: 200, body: { hits: 1 }, raw: '{"hits":1}' }));
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed).toEqual({
      request: { method: 'GET', url: 'https://api.hlidacstatu.cz/api/v2/x' },
      status: 200,
      ok: true,
      body: { hits: 1 },
    });
  });

  test('404 sets ok=false, error field, exit 1', () => {
    const outcome = formatEnvelope(base({ status: 404, body: { error: 'not found' }, raw: '{"error":"not found"}' }));
    expect(outcome.exitCode).toBe(1);
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(404);
    expect(parsed.error).toEqual({ error: 'not found' });
  });

  test('dryRun forces ok=true, exit 0, dryRun:true marker', () => {
    const outcome = formatEnvelope(
      base({ method: 'GET', url: 'https://api.hlidacstatu.cz/api/v2/smlouvy/hledat?dotaz=x', status: 0 }),
      { dryRun: true },
    );
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.request.url).toContain('?dotaz=x');
    expect(parsed.error).toBeUndefined();
  });

  test('missing body falls back to raw, then null', () => {
    const withRaw = JSON.parse(formatEnvelope(base({ status: 200, raw: 'plaintext' })).stdout);
    expect(withRaw.body).toBe('plaintext');
    const empty = JSON.parse(formatEnvelope(base({ status: 200 })).stdout);
    expect(empty.body).toBeNull();
  });
});
