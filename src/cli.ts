#!/usr/bin/env node
import { Command } from 'commander';
import { registerRaw } from './commands/raw.js';
import { type OpenApiSpec, registerFromOpenApi } from './generator.js';
import spec from './openapi.json' with { type: 'json' };

const program = new Command();

program
  .name('hs')
  .description('CLI wrapper for the Hlídač státu REST API v2 (https://api.hlidacstatu.cz)')
  .version('0.1.0');

registerFromOpenApi(program, spec as OpenApiSpec);
registerRaw(program);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
