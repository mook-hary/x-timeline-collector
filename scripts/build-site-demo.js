#!/usr/bin/env node
/**
 * Write the safe public demo placeholder into site/.
 */
const path = require("path");
const { writeDemoSite } = require("../lib/site-builder");

function main() {
  const rootDir = process.cwd();
  const result = writeDemoSite({ rootDir });
  process.stdout.write(
    `[build:site:demo] wrote ${path.relative(rootDir, result.siteRoot) || "site"}\n`
  );
}

main();
