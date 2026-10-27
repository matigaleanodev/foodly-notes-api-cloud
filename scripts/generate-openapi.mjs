import { mkdir, writeFile } from 'node:fs/promises';
import { createOpenApiDocument } from '../src/contracts/openapi.ts';

await mkdir('dist', { recursive: true });
await writeFile('dist/openapi.json', JSON.stringify(createOpenApiDocument(), null, 2) + '\n');
console.info('OpenAPI 3.1.1/draft-07 generado en dist/openapi.json para revisión local.');
