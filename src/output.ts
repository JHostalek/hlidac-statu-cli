import { writeFileSync } from 'node:fs';
import type { HlidacResult } from './api.js';

export interface CliOutcome {
  stdout: string;
  stderr?: string;
  exitCode: number;
  file?: { path: string; bytes: Uint8Array };
}

export interface OutcomeOptions {
  output?: string;
}

const encoder = new TextEncoder();

export function formatOutcome(result: HlidacResult, options: OutcomeOptions = {}): CliOutcome {
  const { output } = options;

  if (result.bytes !== undefined) {
    if (output === undefined) {
      return {
        stdout: '',
        stderr: `binary response (${result.contentType || 'unknown content-type'}, ${result.bytes.byteLength} bytes); use -o <path> to save`,
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `wrote ${result.bytes.byteLength} bytes to ${output} (${result.contentType || 'unknown content-type'})`,
      exitCode: result.status >= 400 ? 1 : 0,
      file: { path: output, bytes: result.bytes },
    };
  }

  const stdout = result.body !== undefined ? JSON.stringify(result.body, null, 2) : result.raw;
  const exitCode = result.status >= 400 ? 1 : 0;
  const stderr = result.status >= 400 ? `HTTP ${result.status}` : undefined;

  if (output !== undefined) {
    const bytes = encoder.encode(stdout);
    return {
      stdout: '',
      stderr: stderr
        ? `${stderr}\nwrote ${bytes.byteLength} bytes to ${output}`
        : `wrote ${bytes.byteLength} bytes to ${output}`,
      exitCode,
      file: { path: output, bytes },
    };
  }

  return { stdout, stderr, exitCode };
}

export interface EnvelopeOptions extends OutcomeOptions {
  dryRun?: boolean;
}

export function formatEnvelope(result: HlidacResult, options: EnvelopeOptions = {}): CliOutcome {
  const { dryRun = false, output } = options;
  const ok = dryRun || (result.status >= 200 && result.status < 400);
  const envelope: Record<string, unknown> = {
    request: { method: result.method, url: result.url },
    status: result.status,
    ok,
  };
  if (result.bytes !== undefined) {
    envelope.contentType = result.contentType;
    envelope.bodyBytes = result.bytes.byteLength;
    envelope.body = null;
  } else {
    envelope.body = result.body !== undefined ? result.body : result.raw.length > 0 ? result.raw : null;
  }
  if (dryRun) envelope.dryRun = true;
  if (!dryRun && result.status >= 400) envelope.error = result.body ?? result.raw;

  const stdout = JSON.stringify(envelope, null, 2);
  const exitCode = ok ? 0 : 1;

  if (output !== undefined) {
    const bytes = encoder.encode(stdout);
    return {
      stdout: '',
      stderr: `wrote ${bytes.byteLength} bytes to ${output}`,
      exitCode,
      file: { path: output, bytes },
    };
  }

  // Binary body with --json and no -o: envelope JSON carries contentType + bodyBytes only.
  // The bytes themselves are never embedded in the envelope (would require base64 + size blow-up).
  return { stdout, exitCode };
}

export function emitOutcome(outcome: CliOutcome): void {
  if (outcome.file) {
    writeFileSync(outcome.file.path, outcome.file.bytes);
  }
  if (outcome.stdout.length > 0) process.stdout.write(`${outcome.stdout}\n`);
  if (outcome.stderr) process.stderr.write(`${outcome.stderr}\n`);
  // Let Node/Bun drain piped stdout and stderr before the process exits. Calling
  // process.exit() here truncates sufficiently large JSON responses.
  process.exitCode = outcome.exitCode;
}
