#!/usr/bin/env node
/**
 * EP-045 — npm run publish
 * Generate Reader → test → audit → commit digest-reader files → push main → verify Pages
 */
const { runPublishCli } = require("../lib/publish-reader");

async function main() {
  try {
    await runPublishCli();
    process.exit(0);
  } catch (error) {
    process.exit(error.exitCode != null ? error.exitCode : 1);
  }
}

main();
