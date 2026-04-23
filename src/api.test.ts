import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { HlidacStatuError, hlidacRequest } from './api.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.HLIDAC_STATU_API_TOKEN;
const fetchMock = mock();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.HLIDAC_STATU_API_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.HLIDAC_STATU_API_TOKEN;
  else process.env.HLIDAC_STATU_API_TOKEN = originalToken;
});

function mockResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('hlidacRequest', () => {
  test('sends Authorization: Token <token> header and uppercases method', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('get', '/smlouvy/hledat');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Token test-token' });
    expect(String(url)).toBe('https://api.hlidacstatu.cz/api/v2/smlouvy/hledat');
  });

  test('normalizes path without leading slash', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('GET', 'smlouvy/hledat');
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://api.hlidacstatu.cz/api/v2/smlouvy/hledat');
  });

  test('assembles query string from params, skipping undefined', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('GET', '/smlouvy/hledat', { dotaz: 'ČEZ', strana: 2, missing: undefined });
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('dotaz')).toBe('ČEZ');
    expect(url.searchParams.get('strana')).toBe('2');
    expect(url.searchParams.has('missing')).toBe(false);
  });

  test('sends JSON body with Content-Type when body provided', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('POST', '/datasety', undefined, { hello: 'world' });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Token test-token', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"hello":"world"}');
  });

  test('passes through a string body unchanged', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'));
    await hlidacRequest('POST', '/raw', undefined, '{"already":"serialized"}');
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.body).toBe('{"already":"serialized"}');
  });

  test('throws HlidacStatuError when token env var absent', async () => {
    delete process.env.HLIDAC_STATU_API_TOKEN;
    await expect(hlidacRequest('GET', '/smlouvy/hledat')).rejects.toThrow(HlidacStatuError);
  });

  test('propagates non-2xx status without throwing', async () => {
    fetchMock.mockResolvedValue(mockResponse(403, '{"message":"forbidden"}'));
    const result = await hlidacRequest('GET', '/smlouvy/vsechnaID');
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ message: 'forbidden' });
  });

  test('returns raw text and undefined body on non-JSON response', async () => {
    fetchMock.mockResolvedValue(mockResponse(502, '<html>Bad Gateway</html>'));
    const result = await hlidacRequest('GET', '/smlouvy/hledat');
    expect(result.status).toBe(502);
    expect(result.body).toBeUndefined();
    expect(result.raw).toBe('<html>Bad Gateway</html>');
  });
});
