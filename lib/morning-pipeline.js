/**
 * EP-046 — Morning Pipeline: Collect → Analyze/Enrich → Publish (Pages).
 * EP-048 — Health report (.pipeline-work/history/) + CLI summary.
 * Reuses scripts/morning.js (--skip-reader) and lib/publish-reader.js.
 * Does not reimplement collect/AI/publish internals.
 */
const fs = require("fs");
const path = require("path");
const {
  AI_LIMIT,
  parseMorningArgs,
  buildMorningPlan,
  runMorning,
  formatCommand,
} = require("../scripts/morning");
const { createRunner } = require("./publish-reader");
const {
  HISTORY_DIR_REL,
  buildMorningHealthReport,
  saveMorningHealthReport,
  publishResultFromRunner,
  formatMorningPipelineSummary,
} = require("./morning-health");

const LOCK_REL = path.join(".pipeline-work", "morning-pipeline.lock");

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

function lockPath(rootDir) {
  return path.join(resolveRoot(rootDir), LOCK_REL);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * @param {string} rootDir
 * @param {object} [deps]
 */
function acquireMorningPipelineLock(rootDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const file = lockPath(rootDir);
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(file)) {
    let existingPid = null;
    try {
      const raw = JSON.parse(String(readFileSync(file, "utf8")));
      existingPid = Number(raw && raw.pid);
    } catch (_error) {
      existingPid = null;
    }
    if (isPidAlive(existingPid)) {
      const err = new Error(
        `Morning Pipeline already running (pid ${existingPid}).\n` +
          `If this is stale, remove ${LOCK_REL} and retry.`
      );
      err.code = "morning-pipeline-lock";
      err.exitCode = 1;
      throw err;
    }
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

function releaseMorningPipelineLock(rootDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;
  const file = lockPath(rootDir);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch (_error) {
    // ignore
  }
}

/**
 * @param {string[]} argv
 */
function parseMorningPipelineArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = {
    help: false,
    dryRun: false,
    morningArgv: [],
  };

  for (const token of list) {
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    // Forward morning runner flags (except --open / --from-enriched for full pipeline).
    options.morningArgv.push(token);
  }

  return options;
}

function printMorningPipelineHelp() {
  return `x-timeline-collector Morning Pipeline

Usage:
  npm run morning -- [options]
  node scripts/morning-pipeline.js [options]

Runs Collect → Analyze → AI Analyze → Enrich → Publish (Pages).
Publish reuses npm run publish (Reader generate → test → audit → commit → push).
Reader is not built twice.

Options:
  --dry-run          Print planned commands; no collect / commit / push
  --skip-collect     Forwarded to morning runner
  --skip-ai          Forwarded to morning runner
  --help, -h

Notes:
  Only one Morning Pipeline at a time (lock: ${LOCK_REL}).
  Health reports: ${HISTORY_DIR_REL}/YYYY-MM-DD-HHmmss.json
  Local-only runner without publish: npm run morning:runner
  Secrets (API keys) are never printed.
`;
}

/**
 * Build human-readable stage plan (for dry-run and docs).
 * @param {ReturnType<typeof parseMorningArgs>} morningOptions
 */
function buildMorningPipelinePlan(morningOptions) {
  const collectOptions = {
    ...morningOptions,
    skipReader: true,
    fromEnriched: false,
    open: false,
  };
  const morningPlan = buildMorningPlan(collectOptions);
  /** @type {{ id: string, label: string, command: string }[]} */
  const stages = [];

  for (const step of morningPlan.steps) {
    stages.push({
      id: step.id,
      label: step.label,
      command: formatCommand(step.script, step.args),
    });
  }

  stages.push({
    id: "publish",
    label: "Publish Digest Reader",
    command:
      "npm run publish  # Reader generate → test → audit → commit → push origin/main",
  });

  return { stages, morningPlan, aiLimit: AI_LIMIT };
}

function formatDryRunReport(plan) {
  const lines = [];
  lines.push("Morning Pipeline (dry-run)");
  lines.push("");
  lines.push("Planned stages:");
  lines.push("");
  plan.stages.forEach((stage, index) => {
    lines.push(`${index + 1}. ${stage.label}`);
    lines.push(`   ${stage.command}`);
    lines.push("");
  });
  lines.push("No collect / commit / push executed.");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function isoNow(deps) {
  if (typeof deps.now === "function") {
    const v = deps.now();
    return v instanceof Date ? v.toISOString() : String(v);
  }
  return new Date().toISOString();
}

/**
 * Persist health report + print summary. Never throws (history failure is soft).
 */
function finalizeHealth(rootDir, reportInput, deps, log) {
  const report = buildMorningHealthReport(reportInput);
  let relativePath = null;
  try {
    const saveFn =
      typeof deps.saveMorningHealthReport === "function"
        ? deps.saveMorningHealthReport
        : saveMorningHealthReport;
    const saved = saveFn(rootDir, report, {
      mkdirSync: deps.mkdirSync,
      writeFileSync: deps.writeFileSync,
      now:
        typeof deps.historyNow === "function"
          ? deps.historyNow
          : typeof deps.now === "function"
            ? () => {
                const v = deps.now();
                return v instanceof Date ? v : new Date(v);
              }
            : undefined,
    });
    relativePath = saved.relativePath;
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    log(`[morning-pipeline] WARNING: failed to save health history: ${reason}`);
  }

  const formatFn =
    typeof deps.formatMorningPipelineSummary === "function"
      ? deps.formatMorningPipelineSummary
      : formatMorningPipelineSummary;
  log(formatFn(report, relativePath).trimEnd());
  return { report, historyPath: relativePath };
}

/**
 * @param {object} options parseMorningPipelineArgs result (+ morning flags)
 * @param {object} [deps]
 */
function runMorningPipeline(options, deps = {}) {
  const rootDir = resolveRoot(deps.rootDir);
  const log = deps.log || ((line) => process.stdout.write(`${line}\n`));
  const logErr =
    deps.logErr || ((line) => process.stderr.write(`${line}\n`));

  if (options.help) {
    process.stdout.write(printMorningPipelineHelp());
    return { ok: true, dryRun: false, stagesRun: [] };
  }

  let morningOptions;
  try {
    morningOptions = parseMorningArgs(options.morningArgv || []);
  } catch (error) {
    const err = new Error(error.message);
    err.code = "morning-pipeline-parse";
    err.exitCode = 1;
    throw err;
  }

  // Full pipeline always skips in-morning Reader (publish owns Reader generate).
  morningOptions = {
    ...morningOptions,
    skipReader: true,
    fromEnriched: false,
    open: false,
  };

  const plan = buildMorningPipelinePlan(morningOptions);

  if (options.dryRun) {
    log(formatDryRunReport(plan).trimEnd());
    return { ok: true, dryRun: true, stagesRun: [], plan };
  }

  const lockDeps = {
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    writeFileSync: deps.writeFileSync,
    mkdirSync: deps.mkdirSync,
    unlinkSync: deps.unlinkSync,
  };

  acquireMorningPipelineLock(rootDir, lockDeps);
  /** @type {string[]} */
  const stagesRun = [];
  const pipelineStartedAt = isoNow(deps);
  /** @type {object[]} */
  let healthStages = [];
  /** @type {object} */
  let publishInfo = {
    ok: false,
    committed: false,
    pushed: false,
    pagesPublished: false,
  };

  try {
    log("[morning-pipeline] Start");
    log("[morning-pipeline] Stage: Collect → Analyze → Enrich");

    const runMorningFn = deps.runMorning || runMorning;
    let morningResult;
    try {
      morningResult = runMorningFn(morningOptions, {
        rootDir,
        spawn: deps.spawn,
        log: deps.morningLog || ((line) => logErr(line)),
        env: deps.env,
        existsSync: deps.existsSync,
        stdio: deps.morningStdio,
        now: deps.now,
      });
    } catch (error) {
      const step = error.step;
      const command = step
        ? formatCommand(step.script, step.args)
        : "(see Morning logs)";
      const label = (step && step.label) || "Collect/Analyze/Enrich";
      logErr(`[morning-pipeline] FAILED stage=${label}`);
      logErr(`[morning-pipeline] command=${command}`);

      healthStages = Array.isArray(error.stages) ? error.stages.slice() : [];
      const finishedAt = isoNow(deps);
      const cause = error.cause || error;
      finalizeHealth(
        rootDir,
        {
          startedAt: pipelineStartedAt,
          finishedAt,
          status: "FAILED",
          stages: healthStages,
          publish: publishInfo,
          failure: {
            stage: label,
            error: cause.message || String(cause),
            stack: cause.stack || null,
          },
        },
        deps,
        log
      );

      const err = new Error(`${label} failed`);
      err.code = "morning-pipeline-stage";
      err.stage = label;
      err.command = command;
      err.exitCode = error.exitCode != null ? error.exitCode : 1;
      err.cause = error;
      throw err;
    }

    if (morningResult && Array.isArray(morningResult.stages)) {
      healthStages = morningResult.stages.slice();
    }
    stagesRun.push("collect-analyze-enrich");
    log("[morning-pipeline] Collect → Enrich OK");

    log("[morning-pipeline] Stage: Publish Digest Reader");
    const publishStartedAt = isoNow(deps);
    const publishDeps = {
      rootDir,
      spawn: deps.spawn,
      env: deps.env,
      log: deps.publishLog || log,
      logErr,
      now: deps.now,
      generateReader: deps.generateReader,
      readerStdio: deps.readerStdio,
      testStdio: deps.testStdio,
      auditStdio: deps.auditStdio,
    };
    try {
      const publishRunner =
        typeof deps.createPublishRunner === "function"
          ? deps.createPublishRunner(publishDeps)
          : createRunner(publishDeps);
      const publishResult = publishRunner.runPublish(deps.publishOptions || {});
      const publishFinishedAt = isoNow(deps);
      publishInfo = publishResultFromRunner(publishResult);
      healthStages.push({
        id: "publish",
        label: "Publish Digest Reader",
        startedAt: publishStartedAt,
        finishedAt: publishFinishedAt,
        ok: true,
        itemCount: null,
      });
    } catch (error) {
      const publishFinishedAt = isoNow(deps);
      healthStages.push({
        id: "publish",
        label: "Publish Digest Reader",
        startedAt: publishStartedAt,
        finishedAt: publishFinishedAt,
        ok: false,
        itemCount: null,
      });
      logErr(`[morning-pipeline] FAILED stage=Publish Digest Reader`);
      logErr(`[morning-pipeline] command=npm run publish`);

      finalizeHealth(
        rootDir,
        {
          startedAt: pipelineStartedAt,
          finishedAt: publishFinishedAt,
          status: "FAILED",
          stages: healthStages,
          publish: publishInfo,
          failure: {
            stage: "Publish Digest Reader",
            error: error.message || String(error),
            stack: error.stack || null,
          },
        },
        deps,
        log
      );

      const err = new Error("Publish Digest Reader failed");
      err.code = "morning-pipeline-publish";
      err.stage = "Publish Digest Reader";
      err.command = "npm run publish";
      err.exitCode = error.exitCode != null ? error.exitCode : 1;
      err.cause = error;
      throw err;
    }
    stagesRun.push("publish");
    log("[morning-pipeline] Publish OK");
    log("[morning-pipeline] Done");

    const finishedAt = isoNow(deps);
    const health = finalizeHealth(
      rootDir,
      {
        startedAt: pipelineStartedAt,
        finishedAt,
        status: "SUCCESS",
        stages: healthStages,
        publish: publishInfo,
        failure: null,
      },
      deps,
      log
    );

    return {
      ok: true,
      dryRun: false,
      stagesRun,
      plan,
      healthReport: health.report,
      historyPath: health.historyPath,
    };
  } finally {
    releaseMorningPipelineLock(rootDir, lockDeps);
  }
}

module.exports = {
  LOCK_REL,
  HISTORY_DIR_REL,
  AI_LIMIT,
  parseMorningPipelineArgs,
  printMorningPipelineHelp,
  buildMorningPipelinePlan,
  formatDryRunReport,
  acquireMorningPipelineLock,
  releaseMorningPipelineLock,
  runMorningPipeline,
  resolveRoot,
  isPidAlive,
  finalizeHealth,
};
