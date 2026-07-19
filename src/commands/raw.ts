import type { Command } from 'commander';
import { hlidacRequest, type QueryValue } from '../api.js';
import { type CliOutcome, emitOutcome, formatEnvelope, formatOutcome } from '../output.js';

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
    if (eq === -1) {
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

export function registerRaw(program: Command): void {
  const cmd = program
    .command('raw')
    .description('Hit any Hlídač státu endpoint directly. Example: hs raw GET /smlouvy/hledat dotaz=elektřiny strana=1')
    .argument('<method>', 'HTTP method (GET, POST, PUT, DELETE, ...)')
    .argument('<path>', 'API path under /api/v2, e.g. /smlouvy/hledat')
    .argument('[params...]', 'Query params as key=value pairs')
    .option('-d, --data <json>', 'JSON request body (parsed before send)')
    .action(async (method: string, path: string, params: string[], opts: { data?: string }) => {
      let body: unknown;
      if (opts.data !== undefined) {
        try {
          body = JSON.parse(opts.data);
        } catch (err) {
          emitOutcome({
            stdout: '',
            stderr: `invalid --data JSON: ${err instanceof Error ? err.message : String(err)}`,
            exitCode: 2,
          });
        }
      }
      const globals = cmd.optsWithGlobals();
      emitOutcome(
        await handleRaw(method, path, params, body, {
          json: globals.json === true,
          dryRun: globals.dryRun === true,
          output: typeof globals.output === 'string' ? globals.output : undefined,
        }),
      );
    });
}
