#!/usr/bin/env node
/**
 * EA-001 — Aikido Candidate Review Dashboard
 *   npm run aikido:review:dashboard
 *   http://127.0.0.1:4175
 */
const path = require("path");
const {
  createAikidoReviewDashboardServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
} = require("../lib/aikido-review-dashboard-server");

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const host = process.env.AIKIDO_REVIEW_DASHBOARD_HOST || DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(
      "EA-001 binds local-only. Use 127.0.0.1 (refusing other hosts).\n"
    );
    process.exit(1);
  }
  const port = process.env.AIKIDO_REVIEW_DASHBOARD_PORT
    ? Number(process.env.AIKIDO_REVIEW_DASHBOARD_PORT)
    : DEFAULT_PORT;

  const dashboard = createAikidoReviewDashboardServer({
    host: "127.0.0.1",
    port,
    rootDir,
    staticDir: path.join(rootDir, "review-dashboard"),
  });

  const info = await dashboard.listen();
  process.stdout.write("Aikido Candidate Review Dashboard\n");
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
    `[aikido-review-dashboard] ${error && error.message ? error.message : error}\n`
  );
  process.exit(1);
});
