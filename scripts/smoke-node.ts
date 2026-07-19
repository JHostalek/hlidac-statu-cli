import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function run(args: string[]): string {
  const result = Bun.spawnSync(['node', 'dist/hs.js', ...args], { stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`node dist/hs.js ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

const version = run(['--version']);
if (version !== packageJson.version)
  throw new Error(`version mismatch: package=${packageJson.version}, cli=${version}`);

const dryRun = JSON.parse(run(['--dry-run', 'smlouvy', 'hledat', '--dotaz', 'smoke'])) as {
  dryRun?: boolean;
  ok?: boolean;
  request?: { method?: string; url?: string };
};
if (dryRun.dryRun !== true || dryRun.ok !== true || dryRun.request?.method !== 'GET') {
  throw new Error(`invalid dry-run envelope: ${JSON.stringify(dryRun)}`);
}

process.stdout.write(`node bundle smoke passed (${version})\n`);
