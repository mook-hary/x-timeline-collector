#!/usr/bin/env node
/**
 * KS-001 — Knowledge Session CLI
 * Usage:
 *   node scripts/aikido-session.js source [--status=...] [--type=...] [--limit=N] [--id=...] [--json]
 *   node scripts/aikido-session.js review [--status=...] [--category=...] [--hasWarnings] [--id=...] [--json]
 *   node scripts/aikido-session.js knowledge [--category=...] [--difficulty=N] [--tag=...] [--id=...] [--json]
 */
const { runSessionCli, KINDS } = require("../lib/aikido-session-cli");

const kind = process.argv[2];
if (!kind || !KINDS.includes(kind)) {
  process.stderr.write(
    `Usage: node scripts/aikido-session.js <${KINDS.join("|")}> [options]\n`
  );
  process.exit(2);
}

const result = runSessionCli({
  kind,
  argv: process.argv.slice(3),
});
process.exit(result.exitCode);
