#!/usr/bin/env node
/**
 * DEV-001 — Platform Launcher
 *
 *   npm run platform
 *
 * Starts Launcher (4173) → Editorial (4174) → Review (4175).
 * Ctrl+C stops all child processes.
 */
try {
  require("dotenv").config({ quiet: true });
} catch (_error) {
  // optional
}

const path = require("path");
const {
  createPlatformLauncher,
  installSignalHandlers,
  ERROR_CODES,
} = require("../lib/platform-launcher");

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const launcher = createPlatformLauncher({
    rootDir,
    logger: {
      info: (msg) => process.stdout.write(`${msg}\n`),
      error: (msg) => process.stderr.write(`${msg}\n`),
    },
  });

  installSignalHandlers(launcher);

  try {
    await launcher.start();
  } catch (error) {
    const code = error && error.code ? error.code : ERROR_CODES.STARTUP_FAILED;
    process.stderr.write(`[platform] ${code}: ${error.message}\n`);
    process.exit(1);
  }

  // Keep the parent alive while children run (stdio inherit).
  // Children crashing triggers stop via exit handlers; signals via installSignalHandlers.
  await new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(
    `[platform] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
});
