import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
import { mkdir, writeFile } from 'node:fs/promises';
import { createOpenApiDocument } from '@foodly-notes/contracts/openapi';

await mkdir('dist', { recursive: true });
await writeFile('dist/openapi.json', JSON.stringify(createOpenApiDocument(), null, 2) + '\n');
console.info('OpenAPI 3.1.1/draft-07 generado en dist/openapi.json para revisión local.');
