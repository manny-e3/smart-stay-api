/**
 * Writes the OpenAPI spec to docs/openapi.json, for frontend code generators
 * (e.g. openapi-typescript) and for importing into Postman or Insomnia.
 *
 *   npm run docs:openapi [-- https://api.example.com]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApi } from '../src/docs/openapi.js';

const out = path.resolve('docs/openapi.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
const spec = buildOpenApi({ serverUrl: process.argv[2] });
fs.writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
const operations = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`Wrote ${out} (${operations} operations)`);
