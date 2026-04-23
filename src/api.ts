const BASE_URL = 'https://api.hlidacstatu.cz/api/v2';

export class HlidacStatuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlidacStatuError';
  }
}

export interface HlidacResult {
  status: number;
  body: unknown;
  raw: string;
}

export type QueryValue = string | number | boolean | undefined;

export async function hlidacRequest(
  method: string,
  path: string,
  query?: Record<string, QueryValue>,
  body?: unknown,
): Promise<HlidacResult> {
  const token = process.env.HLIDAC_STATU_API_TOKEN;
  if (!token) throw new HlidacStatuError('HLIDAC_STATU_API_TOKEN env var not set');

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(BASE_URL + normalizedPath);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { Authorization: `Token ${token}` };
  const init: RequestInit = { method: method.toUpperCase(), headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw };
}
