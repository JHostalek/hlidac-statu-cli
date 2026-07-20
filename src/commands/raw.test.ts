import { beforeEach, describe, expect, mock, test } from 'bun:test';

const hlidacRequestMock = mock();
mock.module('../api.js', () => ({ hlidacRequest: hlidacRequestMock }));

const { handleRaw } = await import('./raw.js');

beforeEach(() => {
  hlidacRequestMock.mockReset();
});

describe('handleRaw', () => {
  test('parses key=value params and forwards method + path', async () => {
    hlidacRequestMock.mockResolvedValue({
      method: 'GET',
      url: 'u',
      status: 200,
      body: { ok: 1 },
      raw: '{"ok":1}',
    });
    const outcome = await handleRaw('GET', '/smlouvy/hledat', ['dotaz=elektřiny', 'strana=1'], undefined);
    expect(hlidacRequestMock).toHaveBeenCalledWith(
      'GET',
      '/smlouvy/hledat',
      { dotaz: 'elektřiny', strana: '1' },
      undefined,
      { dryRun: false },
    );
    expect(outcome.exitCode).toBe(0);
  });

  test('forwards JSON body to hlidacRequest', async () => {
    hlidacRequestMock.mockResolvedValue({ method: 'POST', url: 'u', status: 200, body: {}, raw: '{}' });
    await handleRaw('POST', '/datasety', [], { hello: 'world' });
    expect(hlidacRequestMock).toHaveBeenCalledWith('POST', '/datasety', {}, { hello: 'world' }, { dryRun: false });
  });

  test('supports = inside the value', async () => {
    hlidacRequestMock.mockResolvedValue({ method: 'GET', url: 'u', status: 200, body: {}, raw: '{}' });
    await handleRaw('GET', '/x', ['q=a=b'], undefined);
    expect(hlidacRequestMock).toHaveBeenCalledWith('GET', '/x', { q: 'a=b' }, undefined, { dryRun: false });
  });

  test('rejects param without = with exit 2 and does not call API', async () => {
    const outcome = await handleRaw('GET', '/x', ['malformed'], undefined);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('malformed');
    expect(hlidacRequestMock).not.toHaveBeenCalled();
  });

  test('rejects an empty query key with exit 2 and does not call API', async () => {
    const outcome = await handleRaw('GET', '/x', ['=value'], undefined);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('=value');
    expect(hlidacRequestMock).not.toHaveBeenCalled();
  });

  test('json option produces an envelope payload', async () => {
    hlidacRequestMock.mockResolvedValue({
      method: 'GET',
      url: 'https://api.hlidacstatu.cz/api/v2/x',
      status: 200,
      body: { hits: 0 },
      raw: '{"hits":0}',
    });
    const outcome = await handleRaw('GET', '/x', [], undefined, { json: true });
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.request.method).toBe('GET');
  });

  test('dryRun forwards dryRun=true and forces envelope shape', async () => {
    hlidacRequestMock.mockResolvedValue({
      method: 'GET',
      url: 'https://api.hlidacstatu.cz/api/v2/x',
      status: 0,
      body: undefined,
      raw: '',
    });
    const outcome = await handleRaw('GET', '/x', [], undefined, { dryRun: true });
    expect(hlidacRequestMock).toHaveBeenCalledWith('GET', '/x', {}, undefined, { dryRun: true });
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });
});
