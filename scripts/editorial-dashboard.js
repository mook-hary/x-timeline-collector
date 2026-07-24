#!/usr/bin/env node
/**
 * ED-001 — Editorial Dashboard
 * Local-only UI for Editorial → X Preview → Confirm → Publish.
 *
 *   npm run editorial:dashboard
 *   http://127.0.0.1:4174
 */
try {
  require("dotenv").config({ quiet: true });
} catch (_error) {
  // optional
}

const path = require("path");
const {
  createEditorialDashboardServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
} = require("../lib/editorial-dashboard-server");

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const host = process.env.EDITORIAL_DASHBOARD_HOST || DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(
      "ED-001 binds local-only. Use 127.0.0.1 (refusing other hosts).\n"
    );
    process.exit(1);
  }
  const port = process.env.EDITORIAL_DASHBOARD_PORT
    ? Number(process.env.EDITORIAL_DASHBOARD_PORT)
    : DEFAULT_PORT;

  const dashboard = createEditorialDashboardServer({
    host: "127.0.0.1",
    port,
    rootDir,
    staticDir: path.join(rootDir, "dashboard"),
  });

  const info = await dashboard.listen();
  process.stdout.write("Editorial Dashboard\n");
  process.stdout.write(`${info.url}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    try {
      await dashboard.close();
    } catch (_error) {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `[editorial-dashboard] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
});
