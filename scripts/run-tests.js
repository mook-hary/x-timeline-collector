#!/usr/bin/env node
/**
 * Run every test/*.js file sequentially.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testDir = path.join(__dirname, "..", "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".js"))
  .sort();

let failed = 0;
for (const name of files) {
  const filePath = path.join(testDir, name);
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, [filePath], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`[test] FAIL ${name} (exit ${result.status})\n`);
  }
}

if (failed) {
  process.stderr.write(`\n[test] ${failed}/${files.length} file(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\n[test] PASS (${files.length} files)\n`);
