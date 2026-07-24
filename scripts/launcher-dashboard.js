#!/usr/bin/env node
/**
 * EA-004 — Launcher Dashboard
 *   npm run dashboard
 *   http://127.0.0.1:4173
 */
try {
  require("dotenv").config({ quiet: true });
} catch (_error) {
  // optional
}

const path = require("path");
const {
  createLauncherDashboardServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
} = require("../lib/launcher-dashboard-server");

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const host = process.env.LAUNCHER_DASHBOARD_HOST || DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(
      "EA-004 binds local-only. Use 127.0.0.1 (refusing other hosts).\n"
    );
    process.exit(1);
  }
  const port = process.env.LAUNCHER_DASHBOARD_PORT
    ? Number(process.env.LAUNCHER_DASHBOARD_PORT)
    : DEFAULT_PORT;

  const dashboard = createLauncherDashboardServer({
    host: "127.0.0.1",
    port,
    rootDir,
    staticDir: path.join(rootDir, "launcher"),
    apiOptions: {
      reviewUrl:
        process.env.AIKIDO_REVIEW_DASHBOARD_URL || "http://127.0.0.1:4175",
      editorialUrl:
        process.env.EDITORIAL_DASHBOARD_URL || "http://127.0.0.1:4174",
      morningUrls: process.env.AIKIDO_MORNING_URLS
        ? String(process.env.AIKIDO_MORNING_URLS)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    },
  });

  const info = await dashboard.listen();
  process.stdout.write("Aikido Knowledge Platform — Launcher\n");
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
  process.stderr.write(`[launcher-dashboard] ${error.message}\n`);
  process.exit(1);
});
