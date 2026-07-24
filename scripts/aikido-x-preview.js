#!/usr/bin/env node
/**
 * XP-001 — X Post Formatter preview CLI
 * Usage:
 *   npm run aikido:x:preview -- --id=<editorial-id> [--json] [--includeHashtags]
 */
const { createEditorialStore } = require("../lib/editorial-store");
const { createXPostFormatter } = require("../lib/x-post-formatter");

function parseArgs(argv) {
  const out = {
    id: undefined,
    json: false,
    includeHashtags: false,
    maxLength: undefined,
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
      case "json":
        out.json = value === true || value === "true" || value === "1";
        break;
      case "includeHashtags":
        out.includeHashtags =
          value === true || value === "true" || value === "1";
        break;
      case "maxLength":
        out.maxLength = String(value).trim();
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
  if (!args.id) {
    process.stderr.write(
      "Usage: npm run aikido:x:preview -- --id=<editorial-id> [--json] [--includeHashtags]\n"
    );
    process.exit(2);
  }

  const store = createEditorialStore(
    args.rootDir ? { rootDir: args.rootDir } : {}
  );
  const item = store.find(args.id);
  if (!item) {
    process.stderr.write(`editorial item not found: ${args.id}\n`);
    process.exit(1);
  }

  const formatter = createXPostFormatter({
    includeHashtags: args.includeHashtags,
    maxLength:
      args.maxLength != null ? Number(args.maxLength) : undefined,
  });
  const formatted = formatter.formatPost(item, {
    includeHashtags: args.includeHashtags,
    maxLength:
      args.maxLength != null ? Number(args.maxLength) : undefined,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(formatted, null, 2)}\n`);
  } else {
    process.stdout.write("X Post Preview\n\n");
    process.stdout.write(`${formatted.text}\n`);
    if (formatted.warnings && formatted.warnings.length > 0) {
      process.stdout.write("\nWarnings:\n");
      for (const w of formatted.warnings) {
        process.stdout.write(`- ${w}\n`);
      }
    }
    process.stdout.write(
      `\n(${formatted.metadata.estimatedLength} chars)` +
        ` editorialId=${formatted.metadata.editorialId}\n`
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[aikido-x-preview] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
}
