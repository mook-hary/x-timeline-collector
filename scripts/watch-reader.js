#!/usr/bin/env node
/**
 * EP-041 — Watch Mode: regenerate Reader on file changes.
 * Usage: npm run reader:watch
 */
const path = require("path");
const {
  resolvePort,
  readerDir,
  readerUrl,
  isPortInUse,
  ensureReaderHtml,
  startReaderServer,
  generateReader,
  attachShutdown,
  ENRICHED_REL,
} = require("../lib/reader-launch");
const {
  resolveWatchTargets,
  createWatchScheduler,
  startWatching,
} = require("../lib/reader-watch");

function write(line = "") {
  process.stdout.write(`${line}\n`);
}

function writeErr(line = "") {
  process.stderr.write(`${line}\n`);
}

async function main() {
  const rootDir = process.cwd();
  const port = resolvePort(process.env);
  const url = readerUrl(port);

  write("Watching Reader...");
  write("");

  const initial = generateReader(rootDir, { stdio: "pipe" });
  if (initial.status !== 0) {
    writeErr("Reader generation failed.");
    writeErr(`Check ${ENRICHED_REL}, then fix and save again.`);
    writeErr("");
    try {
      ensureReaderHtml(rootDir);
    } catch (_error) {
      writeErr(
        "No Reader HTML to serve yet. Fix generation errors and retry: npm run reader:watch"
      );
      process.exit(initial.status || 1);
    }
    writeErr("Serving last successful Reader. Watching continues...");
    writeErr("");
  }

  let ownsServer = false;
  const inUse = await isPortInUse(port);
  if (inUse) {
    write(`Server already running:`);
    write(url);
    write("");
  } else {
    try {
      ensureReaderHtml(rootDir);
      const server = await startReaderServer(readerDir(rootDir), port);
      ownsServer = true;
      write("Server:");
      write(url);
      write("");
      attachShutdown(server, (msg) => writeErr(msg));
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        write("Server already running:");
        write(url);
        write("");
      } else {
        writeErr(`Failed to start Reader server: ${error.message}`);
        process.exit(1);
      }
    }
  }

  const targets = resolveWatchTargets(rootDir);
  if (targets.length === 0) {
    writeErr("No watch targets found (lib/, scripts/, enriched data).");
    process.exit(1);
  }

  const watchControls = { refresh: () => {} };

  const scheduler = createWatchScheduler({
    // Production always uses WATCH_DEBOUNCE_MS (200); floor is enforced inside.
    generate: () => generateReader(rootDir, { stdio: "pipe" }),
    onChange: (paths) => {
      write("");
      write("Change detected:");
      for (const p of paths) write(p);
      write("");
    },
    onAfterGenerate: () => {
      watchControls.refresh();
    },
    log: write,
  });

  const watching = startWatching(rootDir, {
    schedule: (rel) => scheduler.schedule(rel),
    log: writeErr,
  });
  watchControls.refresh = watching.refresh;

  write("Waiting for changes...");
  write("");
  write("Press Ctrl+C to stop.");

  const shutdownWatchers = () => {
    scheduler.stop();
    watching.stop();
  };

  // attachShutdown already handles server exit when we own it.
  const onStop = () => {
    writeErr("\nStopping Reader watch...");
    shutdownWatchers();
    if (!ownsServer) process.exit(0);
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
}

main().catch((error) => {
  writeErr(`reader:watch failed: ${error.message}`);
  process.exit(1);
});
