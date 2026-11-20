// Regenerate src/api/schema.d.ts from the OpenAPI spec.
// Uses ../api/openapi.yaml (the repo's spec) when present, else the vendored
// draft copy in api-spec/openapi.yaml.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const src = existsSync('../api/openapi.yaml') ? '../api/openapi.yaml' : 'api-spec/openapi.yaml';
execFileSync('npx', ['openapi-typescript', src, '-o', 'src/api/schema.d.ts'], { stdio: 'inherit' });
