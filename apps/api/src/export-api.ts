import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './config';
import { openapi } from './openapi';
writeFileSync(resolve(repoRoot, 'docs/openapi.json'), JSON.stringify(openapi(), null, 2) + '\n');
console.log('OpenAPI 已从共享 Zod 契约生成。');
