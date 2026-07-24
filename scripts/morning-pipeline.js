#!/usr/bin/env node
/**
 * EP-046 — Morning Pipeline CLI (collect → enrich → publish).
 * Usage: npm run morning -- [--dry-run] [morning flags]
 */
const {
  parseMorningPipelineArgs,
  runMorningPipeline,
} = require("../lib/morning-pipeline");

function main() {
  let options;
  try {
    options = parseMorningPipelineArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[morning-pipeline] ${error.message}\n`);
    process.exit(1);
  }

  try {
    runMorningPipeline(options);
  } catch (error) {
    const code = Number.isInteger(error.exitCode) ? error.exitCode : 1;
    process.exit(code);
  }
}

main();
