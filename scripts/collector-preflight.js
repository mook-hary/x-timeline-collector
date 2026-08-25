#!/usr/bin/env node
/**
 * Collect preflight + optional one-shot dedicated Chrome restart.
 * Prints COLLECTOR_PREFLIGHT_JSON and exits 0 when healthy/recovered.
 */
const {
  ensureCollectorReady,
  formatPreflightLine,
} = require("../lib/collector-preflight");

async function main() {
  const result = await ensureCollectorReady({});
  const line = formatPreflightLine(result);
  if (result.status === "failed") {
    process.stderr.write(`${line}\n`);
    process.stderr.write(`ERROR: ${result.error || "COLLECT_PREFLIGHT_FAILED"}\n`);
    process.exit(1);
  }
  process.stdout.write(`${line}\n`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(
    `${formatPreflightLine({
      status: "failed",
      error: (error && error.code) || "CDP_NOT_AVAILABLE",
      attempts: 1,
      chromeRestarted: false,
    })}\n`
  );
  process.stderr.write(`ERROR: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
