#!/usr/bin/env node
import { Command } from 'commander';
import { HlidacStatuError } from './api.js';
import { registerRaw } from './commands/raw.js';
import { registerSchema } from './commands/schema.js';
import { type OpenApiSpec, registerFromOpenApi } from './generator.js';
import spec from './openapi.json' with { type: 'json' };

const program = new Command();

program
  .name('hs')
  .description('CLI wrapper for the Hlídač státu REST API v2 (https://api.hlidacstatu.cz)')
  .version('0.1.0')
  .option('--json', 'emit a JSON envelope { request, status, ok, body, error? } to stdout')
  .option('--dry-run', 'resolve the request URL but do not call the API; implies --json shape');

registerFromOpenApi(program, spec as OpenApiSpec);
registerRaw(program);
registerSchema(program);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof HlidacStatuError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
