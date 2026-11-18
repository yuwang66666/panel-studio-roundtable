import { Repository } from './repository';
import { config } from './config';
import { makeSample } from '../../../packages/domain/src/samples';
const repo = new Repository(config.dataDir);
try {
  for (let i = 0; i < 5; i++) repo.importSample(makeSample(i));
  console.log('已初始化 5 场明确标识的历史样例；现有讨论与模型连接未改动。');
} finally {
  repo.close();
}
