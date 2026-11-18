import { Repository } from './repository';
import { config } from './config';

const repo = new Repository(config.dataDir);
try {
  const versions = repo.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  console.log(`数据库初始化完成，已应用 ${versions.length} 个迁移；现有数据保留。`);
} finally {
  repo.close();
}
