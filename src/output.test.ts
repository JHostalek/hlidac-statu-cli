import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
    expect(outcome.file).toBeUndefined();
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

  test('binary body without -o errors with content-type and byte count', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const outcome = formatOutcome(base({ status: 200, contentType: 'application/zip', bytes }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toBe('binary response (application/zip, 4 bytes); use -o <path> to save');
    expect(outcome.file).toBeUndefined();
  });

  test('binary body with -o routes bytes to file channel, exit 0', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const outcome = formatOutcome(base({ status: 200, contentType: 'application/zip', bytes }), {
      output: '/tmp/out.zip',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toBe('wrote 5 bytes to /tmp/out.zip (application/zip)');
    expect(outcome.file?.path).toBe('/tmp/out.zip');
    expect(outcome.file?.bytes).toBe(bytes);
  });

  test('binary body with -o propagates 4xx status to exit code', () => {
    const outcome = formatOutcome(
      base({ status: 500, contentType: 'application/octet-stream', bytes: new Uint8Array([0]) }),
      { output: '/tmp/err.bin' },
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.file).toBeDefined();
  });

  test('binary body with missing content-type falls back to "unknown content-type"', () => {
    const outcome = formatOutcome(base({ status: 200, contentType: '', bytes: new Uint8Array([0]) }));
    expect(outcome.stderr).toContain('unknown content-type');
  });

  test('JSON body with -o writes pretty JSON to file, no stdout', () => {
    const outcome = formatOutcome(base({ status: 200, body: { ok: true }, raw: '{"ok":true}' }), {
      output: '/tmp/out.json',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('');
    expect(outcome.file?.path).toBe('/tmp/out.json');
    const decoded = new TextDecoder().decode(outcome.file?.bytes);
    expect(decoded).toBe('{\n  "ok": true\n}');
    expect(outcome.stderr).toContain('wrote');
    expect(outcome.stderr).toContain('/tmp/out.json');
  });

  test('JSON 4xx with -o keeps HTTP status stderr line AND reports file write', () => {
    const outcome = formatOutcome(base({ status: 404, body: { error: 'nope' }, raw: '{"error":"nope"}' }), {
      output: '/tmp/err.json',
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain('HTTP 404');
    expect(outcome.stderr).toContain('wrote');
    expect(outcome.file).toBeDefined();
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

  test('binary response exposes contentType + bodyBytes, body null, no file', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const outcome = formatEnvelope(base({ status: 200, contentType: 'application/zip', bytes }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.file).toBeUndefined();
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.contentType).toBe('application/zip');
    expect(parsed.bodyBytes).toBe(5);
    expect(parsed.body).toBeNull();
  });

  test('-o routes envelope JSON to file, empty stdout, confirmation on stderr', () => {
    const outcome = formatEnvelope(base({ status: 200, body: { hits: 1 }, raw: '{"hits":1}' }), {
      output: '/tmp/env.json',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toBe(`wrote ${outcome.file?.bytes.byteLength} bytes to /tmp/env.json`);
    expect(outcome.file?.path).toBe('/tmp/env.json');
    const parsed = JSON.parse(new TextDecoder().decode(outcome.file?.bytes));
    expect(parsed.body).toEqual({ hits: 1 });
  });

  test('dryRun + -o writes envelope JSON to file', () => {
    const outcome = formatEnvelope(
      base({ status: 0, url: 'https://api.hlidacstatu.cz/api/v2/smlouvy/hledat?dotaz=x' }),
      { dryRun: true, output: '/tmp/dry.json' },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.file?.path).toBe('/tmp/dry.json');
    const parsed = JSON.parse(new TextDecoder().decode(outcome.file?.bytes));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.ok).toBe(true);
  });
});

describe('emitOutcome', () => {
  test('drains large piped stdout before exiting', () => {
    const outputModule = new URL('./output.ts', import.meta.url).href;
    const size = 256 * 1024;
    const script = `import { emitOutcome } from ${JSON.stringify(outputModule)}; emitOutcome({ stdout: 'x'.repeat(${size}), exitCode: 0 });`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.length).toBe(size + 1);
    expect(result.stdout.endsWith('\n')).toBe(true);
  });
});
