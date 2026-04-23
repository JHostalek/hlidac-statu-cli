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

export interface EnvelopeOptions {
  dryRun?: boolean;
}

export function formatEnvelope(result: HlidacResult, options: EnvelopeOptions = {}): CliOutcome {
  const dryRun = options.dryRun === true;
  const ok = dryRun || (result.status >= 200 && result.status < 400);
  const body = result.body !== undefined ? result.body : result.raw.length > 0 ? result.raw : null;
  const envelope: Record<string, unknown> = {
    request: { method: result.method, url: result.url },
    status: result.status,
    ok,
    body,
  };
  if (dryRun) envelope.dryRun = true;
  if (!dryRun && result.status >= 400) envelope.error = result.body ?? result.raw;
  return { stdout: JSON.stringify(envelope, null, 2), exitCode: ok ? 0 : 1 };
}

export function emitOutcome(outcome: CliOutcome): never {
  if (outcome.stdout.length > 0) process.stdout.write(`${outcome.stdout}\n`);
  if (outcome.stderr) process.stderr.write(`${outcome.stderr}\n`);
  process.exit(outcome.exitCode);
}
