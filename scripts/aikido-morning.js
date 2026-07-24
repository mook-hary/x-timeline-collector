#!/usr/bin/env node
/**
 * EA-003 — Aikido Morning Pipeline CLI
 *
 *   npm run aikido:morning
 *   npm run aikido:morning -- --dry-run
 *   npm run aikido:morning -- --url=https://example.com/a --url=https://example.com/b
 */
try {
  require("dotenv").config({ quiet: true });
} catch (_error) {
  // optional
}

const path = require("path");
const {
  createMorningPipeline,
  ERROR_CODES,
} = require("../lib/aikido-morning-pipeline");

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    urls: [],
  };
  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token.startsWith("--url=")) {
      const u = token.slice("--url=".length).trim();
      if (u) options.urls.push(u);
      continue;
    }
    if (!token.startsWith("-")) {
      options.urls.push(token);
    }
  }
  return options;
}

function printHelp() {
  return `Aikido Morning Pipeline (EA-003)

Usage:
  npm run aikido:morning
  npm run aikido:morning -- --dry-run
  npm run aikido:morning -- --url=<URL> [--url=<URL>...]

Runs Collect → Analyze → Candidate in order.
Review / Approve is human-only (Review Dashboard).

Env:
  OPENAI_API_KEY   required for Analyze (unless dry-run)
  OPENAI_MODEL     optional (default gpt-5-mini)
  AIKIDO_MORNING_URLS  comma-separated default URLs

Dry-run does not collect, save candidates, or write logs.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(printHelp());
    process.exit(0);
  }

  const rootDir = path.resolve(__dirname, "..");
  const envUrls = process.env.AIKIDO_MORNING_URLS
    ? String(process.env.AIKIDO_MORNING_URLS)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const urls = args.urls.length ? args.urls : envUrls;

  const pipeline = createMorningPipeline({
    rootDir,
    urls,
    logger: {
      info: (msg) => process.stdout.write(`${msg}\n`),
      error: (msg) => process.stderr.write(`${msg}\n`),
    },
  });

  process.stdout.write("Morning Pipeline\n\n");
  if (args.dryRun) {
    process.stdout.write("Mode: Dry Run\n\n");
  }

  const result = await pipeline.run({
    dryRun: args.dryRun,
    urls,
  });

  for (const step of result.steps || []) {
    const mark =
      step.status === "success"
        ? "✓"
        : step.status === "failed"
          ? "✗"
          : step.status === "skipped"
            ? "–"
            : "?";
    process.stdout.write(`${step.name} ${mark}\n`);
  }
  process.stdout.write("\n");
  process.stdout.write(result.success ? "Completed\n" : "Failed\n");

  if (!result.success) {
    const code =
      (result.error && result.error.code) || ERROR_CODES.COLLECT_FAILED;
    process.stderr.write(
      `[aikido-morning] ${code}: ${(result.error && result.error.message) || "failed"}\n`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`[aikido-morning] ${error.message}\n`);
  process.exit(1);
});
