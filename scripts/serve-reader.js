#!/usr/bin/env node
/**
 * EP-040/043 — Serve output/digest-reader on the LAN (0.0.0.0).
 * Usage: npm run reader:serve
 */
const {
  READER_DIR_REL,
  resolvePort,
  readerDir,
  isPortInUse,
  ensureReaderHtml,
  startReaderServer,
  attachShutdown,
  formatServeUrlLines,
} = require("../lib/reader-launch");

async function main() {
  const rootDir = process.cwd();
  const port = resolvePort(process.env);

  try {
    ensureReaderHtml(rootDir);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const inUse = await isPortInUse(port);
  if (inUse) {
    process.stdout.write(`Reader server already running:\n`);
    for (const line of formatServeUrlLines(port)) {
      process.stdout.write(`${line}\n`);
    }
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
      process.stdout.write(`Reader server already running:\n`);
      for (const line of formatServeUrlLines(port)) {
        process.stdout.write(`${line}\n`);
      }
      process.exit(0);
    }
    process.stderr.write(
      `Failed to start Reader server on port ${port}: ${error.message}\n`
    );
    process.exit(1);
  }

  process.stdout.write(`Serving ${READER_DIR_REL}\n`);
  for (const line of formatServeUrlLines(port)) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("Press Ctrl+C to stop.\n");
  attachShutdown(server, (msg) => process.stderr.write(`${msg}\n`));
}

main().catch((error) => {
  process.stderr.write(`reader:serve failed: ${error.message}\n`);
  process.exit(1);
});
