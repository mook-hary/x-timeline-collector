#!/usr/bin/env node
/**
 * Intentional publish step: copy reviewed local dashboard from output/ → site/.
 * Does not run the pipeline and does not deploy.
 */
const path = require("path");
const { buildSite } = require("../lib/site-builder");

function main() {
  const rootDir = process.cwd();
  try {
    const result = buildSite({ rootDir });
    process.stdout.write(
      `[build:site] wrote ${path.relative(rootDir, result.siteRoot) || "site"}\n`
    );
    if (result.warnings && result.warnings.length) {
      for (const w of result.warnings) {
        process.stderr.write(`[build:site] warning: ${w.code}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(
      `[build:site] failed: ${error.message}\n` +
        "Generate a local dashboard first (pipeline), review it, then re-run.\n"
    );
    process.exit(1);
  }
}

main();
