#!/usr/bin/env node
/**
 * KP-006 — Knowledge Seed CLI
 * Usage:
 *   npm run aikido:knowledge:add -- --title="..." --category=principle --body="..."
 *   npm run aikido:knowledge:add -- --title="..." --category=principle --body="..." --dry-run
 */
const { runKnowledgeAdd } = require("../lib/aikido-knowledge-add");

const result = runKnowledgeAdd({
  argv: process.argv.slice(2),
});
process.exit(result.exitCode);
