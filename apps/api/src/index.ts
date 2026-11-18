import { createApp } from './app';
import { config } from './config';
const { app } = await createApp({ logger: true, modelEnv: process.env });
await app.listen({ port: config.port, host: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
