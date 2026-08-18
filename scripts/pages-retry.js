#!/usr/bin/env node
/**
 * Retry GitHub Pages deployment for the current (or given) commit.
 * Does NOT re-run Collect / Analyze / AI Enrich / Reader generate.
 *
 * Usage:
 *   npm run pages:retry
 *   npm run pages:retry -- --sha <commitSha>
 *
 * Requires GITHUB_TOKEN (or GH_TOKEN) with actions:write.
 */
const {
  retryPagesDeployment,
  resolveCommitSha,
  redactSecrets,
} = require("../lib/pages-deploy");

function parseArgs(argv) {
  const options = { sha: null, help: false };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--sha") {
      options.sha = list[++i];
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[pages:retry] ${error.message}\n`);
    process.exit(1);
  }

  if (options.help) {
    process.stdout.write(`Retry GitHub Pages deploy (no Collect/AI).

Usage:
  npm run pages:retry
  npm run pages:retry -- --sha <commitSha>

Requires GITHUB_TOKEN or GH_TOKEN with actions:write.
`);
    process.exit(0);
  }

  try {
    const commitSha =
      options.sha ||
      resolveCommitSha({ rootDir: process.cwd() });
    process.stdout.write(
      `[pages:retry] Verifying/retrying Pages for ${commitSha.slice(0, 12)}…\n`
    );
    const result = await retryPagesDeployment({
      rootDir: process.cwd(),
      commitSha,
      env: process.env,
    });
    process.stdout.write(
      `[pages:retry] status=${result.status} attempts=${result.attempts} pagesPublished=${result.pagesPublished}\n`
    );
    if (result.errorMessage) {
      process.stdout.write(
        `[pages:retry] detail=${redactSecrets(result.errorMessage)}\n`
      );
    }
    process.exit(result.pagesPublished ? 0 : 1);
  } catch (error) {
    process.stderr.write(
      `[pages:retry] ERROR: ${redactSecrets(error.message || error)}\n`
    );
    process.exit(1);
  }
}

main();
