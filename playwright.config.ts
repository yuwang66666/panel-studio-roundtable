import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'prototype.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:5175',
    headless: true,
    channel: 'msedge',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
