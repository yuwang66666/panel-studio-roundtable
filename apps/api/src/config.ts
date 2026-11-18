import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
function positive(name: string, fallback: number) {
  const v = Number(process.env[name] || fallback);
  if (!Number.isInteger(v) || v < 1) throw new Error(`Invalid ${name}`);
  return v;
}
export const config = {
  dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(repoRoot, '.data'),
  port: positive('API_PORT', 3001),
  maxDiscussions: positive('MAX_CONCURRENT_DISCUSSIONS', 3),
  globalConcurrency: positive('MODEL_CONCURRENCY', 4),
  connectionConcurrency: positive('CONNECTION_CONCURRENCY', 2),
  timeout: positive('MODEL_TIMEOUT_MS', 60000),
  summaryTimeout: positive('SUMMARY_TIMEOUT_MS', 90000),
  origins: (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(
    ',',
  ),
};
