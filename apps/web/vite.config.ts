import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { createClientFileSecurity } from './server-security';
const clientFiles = createClientFileSecurity(fileURLToPath(new URL('.', import.meta.url)));
export default defineConfig({
  plugins: [clientFiles.plugin, react(), tailwindcss()],
  server: {
    fs: clientFiles.fs,
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:' + (process.env.API_PORT || 3001) },
  },
});
