const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    viewport: { width: 1366, height: 768 },
  },
});

