#!/usr/bin/env node
/**
 * EP-040 — Serve output/digest-reader on localhost.
 * Usage: npm run reader:serve
 */
const {
  DEFAULT_PORT,
  READER_DIR_REL,
  resolvePort,
  readerDir,
  readerUrl,
  isPortInUse,
  ensureReaderHtml,
  startReaderServer,
  attachShutdown,
} = require("../lib/reader-launch");

async function main() {
  const rootDir = process.cwd();
  const port = resolvePort(process.env);
  const url = readerUrl(port);

  try {
    ensureReaderHtml(rootDir);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const inUse = await isPortInUse(port);
  if (inUse) {
    process.stdout.write(`Reader server already running: ${url}\n`);
    process.stdout.write(
      `Port ${port} is in use. Open that URL, or stop the other process and retry.\n`
    );
    process.exit(0);
  }

  const dir = readerDir(rootDir);
  let server;
  try {
    server = await startReaderServer(dir, port);
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      process.stdout.write(`Reader server already running: ${url}\n`);
      process.exit(0);
    }
    process.stderr.write(
      `Failed to start Reader server on port ${port}: ${error.message}\n`
    );
    process.exit(1);
  }

  process.stdout.write(`Serving ${READER_DIR_REL}\n`);
  process.stdout.write(`Reader server: ${url}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
  attachShutdown(server, (msg) => process.stderr.write(`${msg}\n`));
}

main().catch((error) => {
  process.stderr.write(`reader:serve failed: ${error.message}\n`);
  process.exit(1);
});
