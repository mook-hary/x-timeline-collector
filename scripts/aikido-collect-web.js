#!/usr/bin/env node
/**
 * KC-001 — Aikido Web Collector CLI
 * Usage: npm run aikido:collect:web -- <URL> [URL...]
 */
const {
  createAikidoWebCollector,
  createDefaultHttpFetcher,
} = require("../lib/aikido-web-collector");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");

async function main() {
  const urls = process.argv.slice(2).filter((a) => a && !a.startsWith("-"));
  if (urls.length === 0) {
    process.stderr.write(
      "Usage: npm run aikido:collect:web -- <URL> [URL...]\n"
    );
    process.exit(2);
  }

  const intake = createAikidoSourceIntake();
  const collector = createAikidoWebCollector({
    fetcher: createDefaultHttpFetcher(),
    sourceIntake: intake,
  });

  process.stdout.write("Aikido Web Collector\n\n");
  const batch = await collector.collectUrls(urls, { continueOnError: true });

  process.stdout.write(`Requested: ${batch.summary.requestedCount}\n`);
  process.stdout.write(`Created: ${batch.summary.createdCount}\n`);
  process.stdout.write(`Skipped: ${batch.summary.skippedCount}\n`);
  process.stdout.write(`Errors: ${batch.summary.errorCount}\n`);
  process.stdout.write("\n");

  for (const row of batch.results) {
    if (row.ok) {
      process.stdout.write(`OK  ${row.url} -> ${row.source.id}\n`);
    } else {
      process.stdout.write(
        `ERR ${row.url}: ${row.error && row.error.message}\n`
      );
    }
  }

  process.exit(batch.summary.errorCount > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`[aikido-web] ${error.message}\n`);
  process.exit(1);
});
