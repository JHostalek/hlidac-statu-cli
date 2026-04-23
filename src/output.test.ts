import { describe, expect, test } from 'bun:test';
import { formatOutcome } from './output.js';

describe('formatOutcome', () => {
  test('exit 0 with pretty-printed JSON body on 2xx', () => {
    const outcome = formatOutcome({ status: 200, body: { ok: true }, raw: '{"ok":true}' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBeUndefined();
    expect(outcome.stdout).toBe('{\n  "ok": true\n}');
  });

  test('exit 1 with HTTP status on stderr for 4xx', () => {
    const outcome = formatOutcome({ status: 403, body: { message: 'forbidden' }, raw: '{"message":"forbidden"}' });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toBe('HTTP 403');
    expect(outcome.stdout).toContain('forbidden');
  });

  test('falls back to raw text when body is undefined', () => {
    const outcome = formatOutcome({ status: 502, body: undefined, raw: '<html>Bad Gateway</html>' });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe('<html>Bad Gateway</html>');
  });
});
