import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
console.log({
  node: process.version,
  sqlite: db.prepare('select sqlite_version() as version').get().version,
});
db.close();
