#!/usr/bin/env node
/**
 * XP-003 — Publish Ledger list CLI
 * Usage:
 *   npm run aikido:publish:list -- [--provider=x] [--status=published] [--knowledgeId=] [--editorialId=] [--json]
 */
const { createPublishLedger } = require("../lib/publish-ledger");

function parseArgs(argv) {
  const out = {
    provider: undefined,
    status: undefined,
    knowledgeId: undefined,
    editorialId: undefined,
    limit: undefined,
    json: false,
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
      case "provider":
        out.provider = String(value).trim();
        break;
      case "status":
        out.status = String(value).trim();
        break;
      case "knowledgeId":
        out.knowledgeId = String(value).trim();
        break;
      case "editorialId":
        out.editorialId = String(value).trim();
        break;
      case "limit":
        out.limit = String(value).trim();
        break;
      case "json":
        out.json = value === true || value === "true" || value === "1";
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

function pad(str, width) {
  const s = str == null ? "" : String(str);
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function formatTable(rows) {
  const cols = [
    { key: "publishId", header: "PublishId", max: 28 },
    { key: "provider", header: "Provider", max: 10 },
    { key: "editorialId", header: "EditorialId", max: 24 },
    { key: "knowledgeId", header: "KnowledgeId", max: 20 },
    { key: "remoteId", header: "RemoteId", max: 20 },
    { key: "status", header: "Status", max: 12 },
    { key: "publishedAt", header: "PublishedAt", max: 24 },
  ];
  const widths = cols.map((col) => {
    let w = col.header.length;
    for (const row of rows) {
      const cell = row[col.key] == null ? "" : String(row[col.key]);
      w = Math.max(w, Math.min(cell.length, col.max));
    }
    return w;
  });
  const lines = [];
  lines.push(cols.map((c, i) => pad(c.header, widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    lines.push(
      cols
        .map((c, i) => {
          let cell = row[c.key] == null ? "" : String(row[c.key]);
          if (cell.length > c.max) cell = `${cell.slice(0, c.max - 1)}…`;
          return pad(cell, widths[i]);
        })
        .join("  ")
    );
  }
  if (rows.length === 0) lines.push("(none)");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = createPublishLedger(
    args.rootDir ? { rootDir: args.rootDir } : {}
  );
  const items = ledger.list({
    provider: args.provider,
    status: args.status,
    knowledgeId: args.knowledgeId,
    editorialId: args.editorialId,
    limit: args.limit,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
  } else {
    process.stdout.write("Publish Ledger\n\n");
    process.stdout.write(formatTable(items));
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[aikido-publish-list] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
}
