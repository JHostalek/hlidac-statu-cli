import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryPath = new URL('..', import.meta.url).pathname;
const distPath = join(repositoryPath, 'dist');
const packagePath = join(repositoryPath, 'package.json');

interface PackageJson {
  version: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function run(command: string, args: string[], cwd = repositoryPath): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${[command, ...args].join(' ')} failed (${exitCode})\n${stdout}${stderr}`);
  return { stdout, stderr };
}

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as PackageJson;
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error('package.json version must be semver');
  return packageJson.version;
}

function artifactName(version: string): string {
  return `hs-macos-arm64-v${version}.tar.gz`;
}

async function checksum(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

async function packageRelease(): Promise<void> {
  const version = await packageVersion();
  const archiveName = artifactName(version);
  const binaryPath = join(distPath, 'hs');
  const archivePath = join(distPath, archiveName);
  const checksumPath = `${archivePath}.sha256`;

  await mkdir(distPath, { recursive: true });
  await Promise.all([
    rm(binaryPath, { force: true }),
    rm(archivePath, { force: true }),
    rm(checksumPath, { force: true }),
  ]);
  await run(process.execPath, [
    'build',
    'src/cli.ts',
    '--compile',
    '--target=bun-darwin-arm64',
    '--outfile',
    binaryPath,
  ]);
  await chmod(binaryPath, 0o755);
  await run('tar', ['-czf', archivePath, '-C', distPath, 'hs']);
  await Bun.write(checksumPath, `${await checksum(archivePath)}  ${archiveName}\n`);

  console.log(archivePath);
  console.log(checksumPath);
}

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'HLIDAC_STATU_API_TOKEN' && entry[0] !== 'HLIDAC_STATU_BASE_URL',
    ),
  );
}

async function runExecutable(path: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([path, ...args], {
    cwd: repositoryPath,
    env: cleanEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`hs ${args.join(' ')} failed (${exitCode})\n${stdout}${stderr}`);
  return { stdout, stderr };
}

async function verifyRelease(): Promise<void> {
  const version = await packageVersion();
  const archiveName = artifactName(version);
  const archivePath = join(distPath, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  const extractionPath = await mkdtemp(join(tmpdir(), 'hs-release-'));

  try {
    const listed = await run('tar', ['-tzf', archivePath]);
    if (listed.stdout.trim() !== 'hs') throw new Error(`archive must contain only hs; got ${listed.stdout.trim()}`);

    const expectedChecksum = (await readFile(checksumPath, 'utf8')).trim();
    const actualChecksum = `${await checksum(archivePath)}  ${archiveName}`;
    if (expectedChecksum !== actualChecksum) throw new Error('release archive checksum does not match');

    await run('tar', ['-xzf', archivePath, '-C', extractionPath]);
    const executablePath = join(extractionPath, 'hs');
    const executable = await stat(executablePath);
    if ((executable.mode & 0o111) === 0) throw new Error('extracted hs is not executable');

    const architecture = await run('file', [executablePath]);
    if (!architecture.stdout.includes('arm64'))
      throw new Error(`release executable is not arm64: ${architecture.stdout}`);

    const [reportedVersion, help, schema, dryRun] = await Promise.all([
      runExecutable(executablePath, ['--version']),
      runExecutable(executablePath, ['--help']),
      runExecutable(executablePath, ['schema']),
      runExecutable(executablePath, ['--dry-run', 'smlouvy', 'hledat', '--dotaz', 'release-smoke']),
    ]);
    if (reportedVersion.stdout.trim() !== version)
      throw new Error('release executable version does not match package.json');
    if (!help.stdout.includes('hs') || !help.stdout.includes('schema'))
      throw new Error('release executable help is incomplete');

    const schemaDocument = JSON.parse(schema.stdout) as { cliVersion?: string; commands?: unknown[] };
    if (schemaDocument.cliVersion !== version || schemaDocument.commands?.length !== 63) {
      throw new Error('release executable schema contract is incomplete');
    }

    const dryRunEnvelope = JSON.parse(dryRun.stdout) as {
      dryRun?: boolean;
      ok?: boolean;
      request?: { method?: string; authentication?: { scheme?: string } };
    };
    if (
      dryRunEnvelope.dryRun !== true ||
      dryRunEnvelope.ok !== true ||
      dryRunEnvelope.request?.method !== 'GET' ||
      dryRunEnvelope.request.authentication?.scheme !== 'Token <redacted>'
    ) {
      throw new Error('release executable dry-run contract is invalid');
    }

    console.log(`verified ${archiveName}`);
  } finally {
    await rm(extractionPath, { recursive: true, force: true });
  }
}

const action = process.argv[2];
switch (action) {
  case 'version':
    console.log(await packageVersion());
    break;
  case 'artifact':
    console.log(artifactName(await packageVersion()));
    break;
  case 'package':
    await packageRelease();
    break;
  case 'verify':
    await verifyRelease();
    break;
  default:
    throw new Error('usage: bun scripts/release.ts <version|artifact|package|verify>');
}
