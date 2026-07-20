import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { HlidacStatuError, hlidacRequest } from './api.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.HLIDAC_STATU_API_TOKEN;
const originalBaseUrl = process.env.HLIDAC_STATU_BASE_URL;
const fetchMock = mock();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.HLIDAC_STATU_API_TOKEN = 'test-token';
  delete process.env.HLIDAC_STATU_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.HLIDAC_STATU_API_TOKEN;
  else process.env.HLIDAC_STATU_API_TOKEN = originalToken;
  if (originalBaseUrl === undefined) delete process.env.HLIDAC_STATU_BASE_URL;
  else process.env.HLIDAC_STATU_BASE_URL = originalBaseUrl;
});

function mockResponse(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

function mockBinaryResponse(status: number, bytes: Uint8Array, contentType = 'application/zip'): Response {
  return new Response(bytes.buffer as ArrayBuffer, { status, headers: { 'Content-Type': contentType } });
}

describe('hlidacRequest', () => {
  test('sends Authorization: Token <token> header and uppercases method', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    const result = await hlidacRequest('get', '/smlouvy/hledat');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Token test-token' });
    expect(url).toBe('https://api.hlidacstatu.cz/api/v2/smlouvy/hledat');
    expect(result.method).toBe('GET');
    expect(result.url).toBe('https://api.hlidacstatu.cz/api/v2/smlouvy/hledat');
  });

  test('normalizes path without leading slash', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('GET', 'smlouvy/hledat');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.hlidacstatu.cz/api/v2/smlouvy/hledat');
  });

  test('assembles query string from params, skipping undefined', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('GET', '/smlouvy/hledat', { dotaz: 'ČEZ', strana: 2, missing: undefined });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('dotaz')).toBe('ČEZ');
    expect(parsed.searchParams.get('strana')).toBe('2');
    expect(parsed.searchParams.has('missing')).toBe(false);
  });

  test('sends JSON body with Content-Type when body provided', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('POST', '/datasety', undefined, { hello: 'world' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Token test-token', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"hello":"world"}');
  });

  test('passes through a string body unchanged', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('POST', '/raw', undefined, '{"already":"serialized"}');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"already":"serialized"}');
  });

  test('throws HlidacStatuError with exit code 2 and remediation when token env var absent', async () => {
    delete process.env.HLIDAC_STATU_API_TOKEN;
    const promise = hlidacRequest('GET', '/smlouvy/hledat');
    await expect(promise).rejects.toThrow(HlidacStatuError);
    await promise.catch((err: HlidacStatuError) => {
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain('https://www.hlidacstatu.cz/api');
      expect(err.message).toContain('export HLIDAC_STATU_API_TOKEN');
    });
  });

  test('HLIDAC_STATU_BASE_URL overrides the API base and makes the token optional', async () => {
    delete process.env.HLIDAC_STATU_API_TOKEN;
    process.env.HLIDAC_STATU_BASE_URL = 'https://proxy.example/hlidac/';
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    const result = await hlidacRequest('GET', '/smlouvy/hledat');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example/hlidac/smlouvy/hledat');
    expect(init.headers).toEqual({});
    expect(result.status).toBe(200);
  });

  test('with HLIDAC_STATU_BASE_URL a present token is still forwarded', async () => {
    process.env.HLIDAC_STATU_BASE_URL = 'https://proxy.example/hlidac';
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('GET', '/smlouvy/hledat');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ Authorization: 'Token test-token' });
  });

  test('dryRun returns synthetic result without calling fetch or requiring token', async () => {
    delete process.env.HLIDAC_STATU_API_TOKEN;
    const result = await hlidacRequest('GET', '/smlouvy/hledat', { dotaz: 'x' }, undefined, { dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe(0);
    expect(result.method).toBe('GET');
    expect(result.url).toContain('?dotaz=x');
    expect(result.body).toBeUndefined();
  });

  test('propagates non-2xx status without throwing', async () => {
    fetchMock.mockResolvedValue(mockResponse(403, '{"message":"forbidden"}'));
    const result = await hlidacRequest('GET', '/smlouvy/vsechnaID');
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ message: 'forbidden' });
  });

  test('returns raw text and undefined body on unparseable JSON-ish response', async () => {
    fetchMock.mockResolvedValue(mockResponse(502, '<html>Bad Gateway</html>', 'text/html'));
    const result = await hlidacRequest('GET', '/smlouvy/hledat');
    expect(result.status).toBe(502);
    expect(result.contentType).toBe('text/html');
    expect(result.body).toBeUndefined();
    expect(result.raw).toBe('<html>Bad Gateway</html>');
    expect(result.bytes).toBeUndefined();
  });

  test('binary Content-Type returns bytes, empty raw, undefined body', async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);
    fetchMock.mockResolvedValue(mockBinaryResponse(200, zipBytes, 'application/zip'));
    const result = await hlidacRequest('GET', '/dumpZip/smlouvy/2026-04-21');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/zip');
    expect(result.body).toBeUndefined();
    expect(result.raw).toBe('');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.bytes?.byteLength).toBe(zipBytes.byteLength);
    expect(Array.from(result.bytes ?? [])).toEqual(Array.from(zipBytes));
  });

  test('strips Content-Type parameters before classification', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"ok":true}', 'application/json; charset=utf-8'));
    const result = await hlidacRequest('GET', '/smlouvy/hledat');
    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(result.body).toEqual({ ok: true });
    expect(result.bytes).toBeUndefined();
  });

  test('missing Content-Type falls into binary branch', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, { status: 200 }));
    const result = await hlidacRequest('GET', '/dumpZip/smlouvy/2026-04-21');
    expect(result.contentType).toBe('');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.bytes?.byteLength).toBe(3);
  });

  test('missing Content-Type on HTTP error preserves the textual error', async () => {
    fetchMock.mockResolvedValue(new Response('Překročen maximální počet API requestů.', { status: 429 }));
    const result = await hlidacRequest('GET', '/firmy/ico/24738123');
    expect(result.status).toBe(429);
    expect(result.bytes).toBeUndefined();
    expect(result.body).toBeUndefined();
    expect(result.raw).toBe('Překročen maximální počet API requestů.');
  });
});
