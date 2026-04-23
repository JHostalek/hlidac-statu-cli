import type { Command } from 'commander';
import { hlidacRequest, type QueryValue } from '../api.js';
import { type CliOutcome, emitOutcome, formatOutcome } from '../output.js';

export async function handleRaw(method: string, path: string, kvArgs: string[], body: unknown): Promise<CliOutcome> {
  const query: Record<string, QueryValue> = {};
  for (const arg of kvArgs) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      return { stdout: '', stderr: `invalid key=value argument: ${arg}`, exitCode: 2 };
    }
    query[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return formatOutcome(await hlidacRequest(method, path, query, body));
}

export function registerRaw(program: Command): void {
  program
    .command('raw')
    .description('Hit any Hlídač státu endpoint directly. Example: hs raw GET /smlouvy/hledat dotaz=elektřiny strana=1')
    .argument('<method>', 'HTTP method (GET, POST, PUT, DELETE, ...)')
    .argument('<path>', 'API path under /api/v2, e.g. /smlouvy/hledat')
    .argument('[params...]', 'Query params as key=value pairs')
    .option('-d, --data <json>', 'JSON request body (parsed before send)')
    .action(async (method: string, path: string, params: string[], opts: { data?: string }) => {
      const body = opts.data !== undefined ? JSON.parse(opts.data) : undefined;
      emitOutcome(await handleRaw(method, path, params, body));
    });
}
