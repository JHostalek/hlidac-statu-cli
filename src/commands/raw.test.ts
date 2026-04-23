import { beforeEach, describe, expect, mock, test } from 'bun:test';

const hlidacRequestMock = mock();
mock.module('../api.js', () => ({ hlidacRequest: hlidacRequestMock }));

const { handleRaw } = await import('./raw.js');

beforeEach(() => {
  hlidacRequestMock.mockReset();
});

describe('handleRaw', () => {
  test('parses key=value params and forwards method + path', async () => {
    hlidacRequestMock.mockResolvedValue({ status: 200, body: { ok: 1 }, raw: '{"ok":1}' });
    const outcome = await handleRaw('GET', '/smlouvy/hledat', ['dotaz=elektřiny', 'strana=1'], undefined);
    expect(hlidacRequestMock).toHaveBeenCalledWith(
      'GET',
      '/smlouvy/hledat',
      { dotaz: 'elektřiny', strana: '1' },
      undefined,
    );
    expect(outcome.exitCode).toBe(0);
  });

  test('forwards JSON body to hlidacRequest', async () => {
    hlidacRequestMock.mockResolvedValue({ status: 200, body: {}, raw: '{}' });
    await handleRaw('POST', '/datasety', [], { hello: 'world' });
    expect(hlidacRequestMock).toHaveBeenCalledWith('POST', '/datasety', {}, { hello: 'world' });
  });

  test('supports = inside the value', async () => {
    hlidacRequestMock.mockResolvedValue({ status: 200, body: {}, raw: '{}' });
    await handleRaw('GET', '/x', ['q=a=b'], undefined);
    expect(hlidacRequestMock).toHaveBeenCalledWith('GET', '/x', { q: 'a=b' }, undefined);
  });

  test('rejects param without = with exit 2 and does not call API', async () => {
    const outcome = await handleRaw('GET', '/x', ['malformed'], undefined);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('malformed');
    expect(hlidacRequestMock).not.toHaveBeenCalled();
  });
});
