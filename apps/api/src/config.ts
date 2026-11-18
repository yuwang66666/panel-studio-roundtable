import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readGatewayOptions } from './gateway-options';
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
  ...readGatewayOptions(process.env),
  origins: (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(
    ',',
  ),
};
