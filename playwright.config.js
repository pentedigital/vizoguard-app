const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // Electron apps need single instance
  workers: 1,
  reporter: "list",
  timeout: 60000,
  projects: [
    {
      name: "electron",
      use: {},
    },
  ],
});
