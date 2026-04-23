import type { HlidacResult } from './api.js';

export interface CliOutcome {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export function formatOutcome(result: HlidacResult): CliOutcome {
  const stdout = result.body !== undefined ? JSON.stringify(result.body, null, 2) : result.raw;
  const exitCode = result.status >= 400 ? 1 : 0;
  const stderr = result.status >= 400 ? `HTTP ${result.status}` : undefined;
  return { stdout, stderr, exitCode };
}

export function emitOutcome(outcome: CliOutcome): never {
  if (outcome.stdout.length > 0) process.stdout.write(`${outcome.stdout}\n`);
  if (outcome.stderr) process.stderr.write(`${outcome.stderr}\n`);
  process.exit(outcome.exitCode);
}
