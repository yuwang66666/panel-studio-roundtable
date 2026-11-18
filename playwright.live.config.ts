import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',testMatch:'live.spec.ts',fullyParallel:false,workers:1,timeout:60000,use:{baseURL:'http://127.0.0.1:5174',headless:true,actionTimeout:10000,channel:'msedge',screenshot:'only-on-failure'},reporter:[['list']]});
