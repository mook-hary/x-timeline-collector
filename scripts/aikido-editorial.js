#!/usr/bin/env node
/**
 * KS-002 — Aikido Editorial Bridge CLI
 * Usage:
 *   npm run aikido:editorial -- --id=<knowledge-id>
 *   npm run aikido:editorial -- --category=principle [--limit=N] [--dry-run] [--json]
 */
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createEditorialStore } = require("../lib/editorial-store");
const {
  createAikidoEditorialBridge,
} = require("../lib/aikido-editorial-bridge");

function parseArgs(argv) {
  const out = {
    id: undefined,
    category: undefined,
    difficulty: undefined,
    tag: undefined,
    status: undefined,
    limit: undefined,
    dryRun: false,
    json: false,
    allowDuplicateDraft: false,
    rootDir: undefined,
  };
  for (const raw of argv) {
    if (!raw || !raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    let key;
    let value;
    if (eq === -1) {
      key = raw.slice(2);
      value = true;
    } else {
      key = raw.slice(2, eq);
      value = raw.slice(eq + 1);
    }
    switch (key) {
      case "id":
        out.id = String(value).trim();
        break;
      case "category":
        out.category = String(value).trim();
        break;
      case "difficulty":
        out.difficulty = String(value).trim();
        break;
      case "tag":
        out.tag = String(value).trim();
        break;
      case "status":
        out.status = String(value).trim();
        break;
      case "limit":
        out.limit = String(value).trim();
        break;
      case "dry-run":
      case "dryRun":
        out.dryRun =
          value === true || value === "true" || value === "1";
        break;
      case "json":
        out.json = value === true || value === "true" || value === "1";
        break;
      case "allowDuplicateDraft":
        out.allowDuplicateDraft =
          value === true || value === "true" || value === "1";
        break;
      case "rootDir":
        out.rootDir = String(value).trim();
        break;
      default:
        break;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hasBatchSelector =
    args.category != null ||
    args.tag != null ||
    args.difficulty != null ||
    args.status != null ||
    args.limit != null;

  if (!args.id && !hasBatchSelector && !args.dryRun) {
    process.stderr.write(
      "Usage: npm run aikido:editorial -- --id=<knowledge-id>\n" +
        "   or: npm run aikido:editorial -- --category=<category> [--limit=N] [--dry-run] [--json]\n"
    );
    process.exit(2);
  }

  const rootOpts = args.rootDir ? { rootDir: args.rootDir } : {};
  const editorialStore = createEditorialStore(rootOpts);
  const bridge = createAikidoEditorialBridge({ editorialStore });
  const knowledge = createAikidoKnowledgeStore({
    ...rootOpts,
    editorialBridge: bridge,
  });

  const common = {
    dryRun: args.dryRun,
    allowDuplicateDraft: args.allowDuplicateDraft,
    limit: args.limit,
    category: args.category,
    difficulty: args.difficulty,
    tag: args.tag,
    status: args.status,
  };

  let result;
  if (args.id) {
    result = knowledge.publishDraft(args.id, common);
  } else {
    result = knowledge.publishDrafts(common);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (args.id) {
    if (result.dryRun) {
      process.stdout.write("Aikido Editorial Bridge (dry-run)\n\n");
      process.stdout.write(`Knowledge: ${result.knowledgeId}\n`);
      process.stdout.write(
        `Draft title: ${result.draft && result.draft.title}\n`
      );
      process.stdout.write("Not saved.\n");
    } else {
      process.stdout.write("Aikido Editorial Bridge\n\n");
      process.stdout.write(`Created: ${result.editorialId}\n`);
      process.stdout.write(`Knowledge: ${result.knowledgeId}\n`);
    }
  } else {
    const summary = result.summary || {};
    process.stdout.write(
      args.dryRun
        ? "Aikido Editorial Bridge (dry-run)\n\n"
        : "Aikido Editorial Bridge\n\n"
    );
    if (args.dryRun) {
      process.stdout.write(`Drafts: ${summary.draftCount || 0}\n`);
      process.stdout.write("Not saved.\n");
    } else {
      process.stdout.write(`Created: ${summary.createdCount || 0}\n`);
      process.stdout.write(`Skipped: ${summary.skippedCount || 0}\n`);
      process.stdout.write(`Errors: ${summary.errorCount || 0}\n`);
    }
  }

  const errorCount =
    result && result.summary ? result.summary.errorCount || 0 : 0;
  process.exit(errorCount > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[aikido-editorial] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
}
