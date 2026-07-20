import { hlidacRequest, type QueryValue } from '../api.js';
import { type CliOutcome, formatEnvelope, formatOutcome } from '../output.js';

export const RAW_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export interface RawOptions {
  json?: boolean;
  dryRun?: boolean;
  output?: string;
}

export async function handleRaw(
  method: string,
  path: string,
  kvArgs: string[],
  body: unknown,
  options: RawOptions = {},
): Promise<CliOutcome> {
  const query: Record<string, QueryValue> = {};
  for (const arg of kvArgs) {
    const eq = arg.indexOf('=');
    if (eq <= 0) {
      return { stdout: '', stderr: `invalid key=value argument: ${arg}`, exitCode: 2 };
    }
    query[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  const dryRun = options.dryRun === true;
  const json = options.json === true || dryRun;
  const { output } = options;
  const result = await hlidacRequest(method, path, query, body, { dryRun });
  return json ? formatEnvelope(result, { dryRun, output }) : formatOutcome(result, { output });
}
