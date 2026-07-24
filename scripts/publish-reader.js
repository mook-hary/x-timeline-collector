#!/usr/bin/env node
/**
 * EP-045 — npm run publish
 * Generate Reader → test → audit → commit digest-reader files → push main
 */
const { runPublishCli } = require("../lib/publish-reader");

try {
  const result = runPublishCli();
  if (result.skippedPush) {
    process.exit(0);
  }
  process.exit(0);
} catch (error) {
  process.exit(error.exitCode != null ? error.exitCode : 1);
}
