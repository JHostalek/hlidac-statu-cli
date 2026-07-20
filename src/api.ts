const DEFAULT_BASE_URL = 'https://api.hlidacstatu.cz/api/v2';

// HLIDAC_STATU_BASE_URL points hs at an authenticating proxy (e.g. an agent control plane that
// injects the API token server-side). With the override set, the local token becomes optional.
function baseUrl(): string {
  return (process.env.HLIDAC_STATU_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

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
  contentType: string;
  body: unknown;
  raw: string;
  bytes?: Uint8Array;
  dryRunRequest?: {
    contentType: string | null;
    body: unknown;
    authentication: { required: boolean; scheme: 'Token <redacted>' };
  };
}

export type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(baseUrl() + normalizedPath);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export interface RequestOptions {
  dryRun?: boolean;
}

// Servers may annotate JSON with `; charset=utf-8`; strip parameters before the check.
// `text/*` is treated as text too — matches what the spec declares (text/json, text/plain)
// and what JSON.parse can plausibly handle. Anything else → binary.
export function isJsonish(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  if (normalized === '') return false;
  return normalized === 'application/json' || normalized.startsWith('text/');
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
    return {
      method: upperMethod,
      url,
      status: 0,
      contentType: '',
      body: undefined,
      raw: '',
      dryRunRequest: {
        contentType: body === undefined ? null : 'application/json',
        body: body ?? null,
        authentication: {
          required: process.env.HLIDAC_STATU_BASE_URL === undefined,
          scheme: 'Token <redacted>',
        },
      },
    };
  }

  const token = process.env.HLIDAC_STATU_API_TOKEN;
  if (!token && !process.env.HLIDAC_STATU_BASE_URL) {
    throw new HlidacStatuError(
      'HLIDAC_STATU_API_TOKEN is not set. Get a token at https://www.hlidacstatu.cz/api and export it:\n  export HLIDAC_STATU_API_TOKEN=<your-token>',
      2,
    );
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Token ${token}`;
  const init: RequestInit = { method: upperMethod, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') ?? '';

  if (!isJsonish(contentType)) {
    // Binary response: buffer the whole body. Adequate for current dump sizes (tens of KB);
    // switch to streaming if endpoints start returning hundreds of MB.
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { method: upperMethod, url, status: response.status, contentType, body: undefined, raw: '', bytes };
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  return { method: upperMethod, url, status: response.status, contentType, body: parsed, raw };
}
