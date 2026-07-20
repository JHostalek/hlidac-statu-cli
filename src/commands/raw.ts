import type { QueryValue } from '../api.js';

export const RAW_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export class InvalidRawPair extends Error {}

export function parseRawQuery(kvArgs: readonly string[]): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const argument of kvArgs) {
    const separator = argument.indexOf('=');
    if (separator <= 0) throw new InvalidRawPair(`invalid key=value argument: ${argument}`);
    query[argument.slice(0, separator)] = argument.slice(separator + 1);
  }
  return query;
}
