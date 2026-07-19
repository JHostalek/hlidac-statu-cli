import { readFile, writeFile } from 'node:fs/promises';

const SPEC_URL = 'https://api.hlidacstatu.cz/swagger/v2/swagger.json';
const SPEC_PATH = new URL('../src/openapi.json', import.meta.url);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

type OpenApiDocument = {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, unknown>>;
};

function parseDocument(source: string, label: string): OpenApiDocument {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${label}: expected a JSON object`);

  const candidate = parsed as Partial<OpenApiDocument>;
  if (typeof candidate.openapi !== 'string' || !candidate.openapi.startsWith('3.')) {
    throw new Error(`${label}: expected an OpenAPI 3.x document`);
  }
  if (typeof candidate.info?.title !== 'string') throw new Error(`${label}: missing info.title`);
  if (typeof candidate.paths !== 'object' || candidate.paths === null) throw new Error(`${label}: missing paths`);
  const document = candidate as OpenApiDocument;
  if (operationCount(document) === 0) throw new Error(`${label}: no HTTP operations found`);
  return document;
}

function operationCount(document: OpenApiDocument): number {
  return Object.values(document.paths).reduce(
    (count, pathItem) => count + Object.keys(pathItem).filter((key) => HTTP_METHODS.has(key.toLowerCase())).length,
    0,
  );
}

function serialize(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonical(document: OpenApiDocument): string {
  return JSON.stringify(canonicalize(document));
}

async function localDocument(): Promise<{ document: OpenApiDocument; serialized: string }> {
  const source = await readFile(SPEC_PATH, 'utf8');
  const document = parseDocument(source, 'embedded specification');
  return { document, serialized: serialize(document) };
}

async function remoteDocument(): Promise<{ document: OpenApiDocument; serialized: string }> {
  const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OpenAPI download failed: HTTP ${response.status}`);
  const document = parseDocument(await response.text(), 'remote specification');
  return { document, serialized: serialize(document) };
}

function summary(document: OpenApiDocument): string {
  return `${document.info.title}; OpenAPI ${document.openapi}; ${operationCount(document)} operations`;
}

const mode = process.argv[2];
if (mode === 'validate') {
  const local = await localDocument();
  process.stdout.write(`valid: ${summary(local.document)}\n`);
} else if (mode === 'sync') {
  const remote = await remoteDocument();
  await writeFile(SPEC_PATH, remote.serialized);
  process.stdout.write(`updated: ${summary(remote.document)}\n`);
} else if (mode === 'check') {
  const [local, remote] = await Promise.all([localDocument(), remoteDocument()]);
  if (canonical(local.document) !== canonical(remote.document)) {
    process.stderr.write(
      `OpenAPI drift detected\nembedded: ${summary(local.document)}\nremote:   ${summary(remote.document)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`current: ${summary(local.document)}\n`);
  }
} else {
  process.stderr.write('usage: bun scripts/openapi.ts <sync|check|validate>\n');
  process.exitCode = 2;
}
