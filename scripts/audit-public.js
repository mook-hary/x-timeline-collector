#!/usr/bin/env node
/**
 * Audit tracked files intended for public release.
 * Exits nonzero on critical findings. Does not print secret values.
 */
const {
  auditTrackedPublicTree,
  formatFindings,
} = require("../lib/public-audit");

function main() {
  const rootDir = process.cwd();
  const { findings, trackedCount } = auditTrackedPublicTree(rootDir);
  const critical = findings.filter((f) => f.severity === "critical");

  process.stdout.write(`[audit:public] tracked files: ${trackedCount}\n`);
  if (findings.length === 0) {
    process.stdout.write("[audit:public] PASS\n");
    process.exit(0);
  }

  for (const line of formatFindings(findings)) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write(
    `[audit:public] ${critical.length ? "FAIL" : "WARNINGS"} ` +
      `(${findings.length} finding(s), ${critical.length} critical)\n`
  );
  process.exit(critical.length ? 1 : 0);
}

main();
