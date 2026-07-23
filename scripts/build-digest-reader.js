#!/usr/bin/env node
/**
 * EP-022 — Build local Digest Reader HTML from timeline_enriched.json.
 * Does not touch site/, pipeline, or external APIs.
 */
const path = require("path");
const { buildDigestReader, DEFAULT_TOP } = require("../lib/digest-reader");
const { parseArgs, loadConfig } = require("../digest");

function printHelp() {
  process.stdout.write(`Digest Reader v1 (local only)

Usage:
  npm run build:digest-reader -- [digest options]
  node scripts/build-digest-reader.js [digest options]

Reads output/timeline_enriched.json via existing digest selection.
Writes output/digest-reader/index.html + style.css.

Accepted options (same family as digest.js):
  --today
  --from <YYYY-MM-DD>
  --to <YYYY-MM-DD>
  --category <name>
  --min-importance <1-5>
  --top <N>                 default ${DEFAULT_TOP}
  --full                    show more posts per category
  --help, -h

Does NOT accept --json / --explain / --output (reader has a fixed output dir).
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  // Reject digest flags that do not apply to the fixed reader output.
  for (const bad of ["--json", "--explain", "--output"]) {
    if (argv.includes(bad)) {
      process.stderr.write(
        `[build:digest-reader] ${bad} は使えません。Reader は output/digest-reader/ に固定出力します。\n`
      );
      process.exit(1);
    }
  }

  let digestOptions;
  try {
    digestOptions = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[build:digest-reader] ${error.message}\n`);
    process.exit(1);
  }

  // digest.js defaults --top to 5; reader prefers 8 unless user overrides.
  if (!argv.includes("--top")) {
    digestOptions.top = DEFAULT_TOP;
  }

  try {
    // Ensure config load works the same as digest CLI.
    loadConfig();
    const result = buildDigestReader({
      rootDir: process.cwd(),
      digestOptions,
    });
    process.stdout.write(
      `[build:digest-reader] wrote ${path.relative(process.cwd(), result.htmlPath)}\n`
    );
    process.stdout.write(
      `[build:digest-reader] total=${result.summary.total} selected=${result.summary.selected} date=${result.summary.dateLabel}\n`
    );
  } catch (error) {
    process.stderr.write(`[build:digest-reader] failed: ${error.message}\n`);
    process.exit(1);
  }
}

main();
