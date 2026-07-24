#!/usr/bin/env node
/**
 * EP-047 — Morning scheduler CLI (install / uninstall / status).
 */
const path = require("path");
const {
  installMorningScheduler,
  uninstallMorningScheduler,
  statusMorningScheduler,
  formatStatusReport,
  parseSchedulerArgs,
  printSchedulerHelp,
} = require("../lib/morning-scheduler");

function resolveCommand() {
  const base = path.basename(process.argv[1] || "");
  if (base.includes("uninstall")) return "uninstall";
  if (base.includes("status")) return "status";
  if (base.includes("install")) return "install";
  const arg = process.argv[2];
  if (arg === "uninstall" || arg === "status" || arg === "install") {
    return arg;
  }
  return "install";
}

function main() {
  const command = resolveCommand();
  const argv =
    process.argv[2] === "install" ||
    process.argv[2] === "uninstall" ||
    process.argv[2] === "status"
      ? process.argv.slice(3)
      : process.argv.slice(2);

  let options;
  try {
    options = parseSchedulerArgs(argv);
  } catch (error) {
    process.stderr.write(`[scheduler] ${error.message}\n`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(printSchedulerHelp(command));
    process.exit(0);
  }

  try {
    if (command === "install") {
      installMorningScheduler(options);
      process.exit(0);
    }
    if (command === "uninstall") {
      uninstallMorningScheduler(options);
      process.exit(0);
    }
    if (command === "status") {
      const status = statusMorningScheduler(options);
      process.stdout.write(formatStatusReport(status));
      process.exit(0);
    }
    process.stderr.write(`[scheduler] Unknown command: ${command}\n`);
    process.exit(2);
  } catch (error) {
    process.stderr.write(`[scheduler] ERROR: ${error.message}\n`);
    process.exit(error.exitCode != null ? error.exitCode : 1);
  }
}

main();
