// Playwright config. Specs launch their own persistent Chromium context with the
// unpacked extension loaded, so there is no shared browser fixture here.
// End-to-end tests run locally only: YouTube blocks datacenter IPs (CI).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testIgnore: ['**/unit/**'],
  outputDir: 'test-results',
  timeout: 5 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
});
