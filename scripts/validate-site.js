#!/usr/bin/env node
/**
 * Validate site/ before publish / Pages upload.
 * Exits nonzero on critical findings. Does not print secret values.
 */
const path = require("path");
const {
  validateSiteDirectory,
  formatFindings,
} = require("../lib/public-audit");

function main() {
  const rootDir = process.cwd();
  const siteRoot = path.join(rootDir, "site");
  const { findings, ok } = validateSiteDirectory(siteRoot, {
    requireManifest: true,
  });

  if (findings.length === 0) {
    process.stdout.write("[validate:site] PASS\n");
    process.exit(0);
  }

  for (const line of formatFindings(findings)) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write(
    `[validate:site] ${ok ? "WARNINGS" : "FAIL"} (${findings.length})\n`
  );
  process.exit(ok ? 0 : 1);
}

main();
