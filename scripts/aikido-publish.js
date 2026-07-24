#!/usr/bin/env node
/**
 * XP-004 — Aikido X Publish CLI
 * Usage:
 *   npm run aikido:publish:x -- --id=<editorial-id>
 *   npm run aikido:publish:x -- --category=principle [--limit=N]
 *   npm run aikido:publish:x -- --id=<editorial-id> --confirm
 *
 * Default: dry-run (never posts). Real post requires --confirm.
 * --dry-run always wins over --confirm.
 */
try {
  require("dotenv").config({ quiet: true });
} catch (_error) {
  // optional
}

const { createEditorialStore } = require("../lib/editorial-store");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createXPostFormatter } = require("../lib/x-post-formatter");
const { createPublishLedger } = require("../lib/publish-ledger");
const { createXPublisher } = require("../lib/x-publisher");
const { createXPublisherFromEnv } = require("../lib/x-publisher-env");
const {
  parsePublishArgs,
  runAikidoPublish,
} = require("../lib/aikido-publish-cli");

async function main() {
  const argv = process.argv.slice(2);
  const args = parsePublishArgs(argv);
  const rootOpts = args.rootDir ? { rootDir: args.rootDir } : {};

  const editorialStore = createEditorialStore(rootOpts);
  const knowledgeStore = createAikidoKnowledgeStore(rootOpts);
  const formatter = createXPostFormatter();
  const ledger = createPublishLedger(rootOpts);

  const execute = args.confirm === true && args.dryRun !== true;
  let publisher;
  if (execute) {
    publisher = createXPublisherFromEnv(rootOpts);
  } else {
    // Dry-run never needs a real token/client.
    publisher = createXPublisher({
      client: {
        async createPost() {
          const err = new Error(
            "dry-run publisher must not call client.createPost"
          );
          err.code = "aikido-publish-dry-run-guard";
          throw err;
        },
      },
      clock: () => new Date().toISOString(),
    });
  }

  const result = await runAikidoPublish({
    argv,
    editorialStore,
    knowledgeStore,
    formatter,
    publisher,
    ledger,
  });
  process.exit(result.exitCode);
}

main().catch((error) => {
  process.stderr.write(
    `[aikido-publish] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
});
