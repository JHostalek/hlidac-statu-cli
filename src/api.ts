const BASE_URL = 'https://api.hlidacstatu.cz/api/v2';

export class HlidacStatuError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'HlidacStatuError';
    this.exitCode = exitCode;
  }
}

export interface HlidacResult {
  method: string;
  url: string;
  status: number;
  body: unknown;
  raw: string;
}

export type QueryValue = string | number | boolean | undefined;

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(BASE_URL + normalizedPath);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export interface RequestOptions {
  dryRun?: boolean;
}

export async function hlidacRequest(
  method: string,
  path: string,
  query?: Record<string, QueryValue>,
  body?: unknown,
  options: RequestOptions = {},
): Promise<HlidacResult> {
  const upperMethod = method.toUpperCase();
  const url = buildUrl(path, query);

  if (options.dryRun) {
    return { method: upperMethod, url, status: 0, body: undefined, raw: '' };
  }

  const token = process.env.HLIDAC_STATU_API_TOKEN;
  if (!token) {
    throw new HlidacStatuError(
      'HLIDAC_STATU_API_TOKEN is not set. Get a token at https://www.hlidacstatu.cz/api and export it:\n  export HLIDAC_STATU_API_TOKEN=<your-token>',
      2,
    );
  }

  const headers: Record<string, string> = { Authorization: `Token ${token}` };
  const init: RequestInit = { method: upperMethod, headers };
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
  return { method: upperMethod, url, status: response.status, body: parsed, raw };
}
