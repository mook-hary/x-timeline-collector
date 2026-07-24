#!/usr/bin/env node
/**
 * EP-040 — Generate Reader, serve locally, open browser.
 * Usage: npm run reader:open
 */
const {
  resolvePort,
  readerDir,
  readerUrl,
  isPortInUse,
  ensureReaderHtml,
  startReaderServer,
  generateReader,
  openBrowser,
  attachShutdown,
  ENRICHED_REL,
} = require("../lib/reader-launch");

async function main() {
  const rootDir = process.cwd();
  const port = resolvePort(process.env);
  const url = readerUrl(port);

  const gen = generateReader(rootDir);
  if (gen.status !== 0) {
    process.stderr.write(
      "Reader generation failed.\n" +
        `Check that ${ENRICHED_REL} exists, then retry: npm run reader\n`
    );
    process.exit(gen.status || 1);
  }
  process.stdout.write("Reader generated.\n");

  try {
    ensureReaderHtml(rootDir);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  let ownsServer = false;
  const inUse = await isPortInUse(port);
  if (inUse) {
    process.stdout.write(`Reader server already running: ${url}\n`);
  } else {
    try {
      const server = await startReaderServer(readerDir(rootDir), port);
      ownsServer = true;
      process.stdout.write(`Reader server: ${url}\n`);
      attachShutdown(server, (msg) => process.stderr.write(`${msg}\n`));
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        process.stdout.write(`Reader server already running: ${url}\n`);
      } else {
        process.stderr.write(
          `Failed to start Reader server on port ${port}: ${error.message}\n` +
            `Open manually after: npm run reader:serve\n`
        );
        process.exit(1);
      }
    }
  }

  process.stdout.write("Opening browser...\n");
  const openResult = openBrowser(url);
  if (openResult && openResult.error) {
    process.stderr.write(
      `Could not open browser (${openResult.error.message}).\n` +
        `Open manually: ${url}\n`
    );
  } else if (
    openResult &&
    openResult.status != null &&
    openResult.status !== 0
  ) {
    process.stderr.write(
      `Could not open browser (exit ${openResult.status}).\n` +
        `Open manually: ${url}\n`
    );
  }

  if (ownsServer) {
    process.stdout.write("Press Ctrl+C to stop.\n");
  }
}

main().catch((error) => {
  process.stderr.write(`reader:open failed: ${error.message}\n`);
  process.exit(1);
});
