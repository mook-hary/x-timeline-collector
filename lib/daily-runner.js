const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { ensureDir } = require("./pipeline-io");
const {
  nowIso,
  normalizeRunnerOptions,
  buildPathPlan,
  buildManifestObject,
  buildRunConfig,
  buildRunPlan,
  createInitialRunReport,
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  buildRunChecks,
  calculateRunStatistics,
  finalizeRunReport,
  decideFinalStatus,
  evaluateRunGate,
  isLockStale,
  buildLockPayload,
  validateDailyRunReport,
  DEFAULT_STALE_LOCK_MINUTES,
} = require("./daily-runner-core");
const { validateDailyEditionManifest } = require("./daily-edition-core");

function logProgress(message, log = console.error) {
  if (typeof log === "function") {
    log(message);
  }
}

/** Atomic JSON write that throws (does not process.exit). */
function writeJsonAtomicSafe(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_e) {
      // best-effort
    }
    throw error;
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function listExistingAttempts(dateDirectory) {
  const attemptsDir = path.join(dateDirectory, "attempts");
  if (!fs.existsSync(attemptsDir)) return [];
  const entries = fs.readdirSync(attemptsDir, { withFileTypes: true });
  const attempts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) continue;
    const attempt = Number(entry.name);
    const reportPath = path.join(attemptsDir, entry.name, "run-report.json");
    const report = readJsonIfExists(reportPath);
    attempts.push({
      attempt,
      status: report?.status || null,
      reportPath,
      runDirectory: path.join(attemptsDir, entry.name),
    });
  }
  return attempts.sort((a, b) => a.attempt - b.attempt);
}

function readLock(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (_error) {
    return { startedAt: null, unreadable: true };
  }
}

/**
 * Acquire exclusive lock. Returns { ok, staleRecovered, error, exitCode }.
 */
function acquireLock(lockPath, payload, options, now) {
  ensureDir(path.dirname(lockPath));
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
      flag: "wx",
      encoding: "utf8",
    });
    return { ok: true, staleRecovered: false, error: null, exitCode: 0 };
  } catch (error) {
    if (error.code !== "EEXIST") {
      return { ok: false, staleRecovered: false, error, exitCode: 1 };
    }
    const existing = readLock(lockPath);
    const stale = isLockStale(
      existing,
      options.staleLockMinutes || DEFAULT_STALE_LOCK_MINUTES,
      now
    );
    if (stale && options.recoverStaleLock) {
      try {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
          flag: "wx",
          encoding: "utf8",
        });
        return { ok: true, staleRecovered: true, error: null, exitCode: 0 };
      } catch (recoverError) {
        return {
          ok: false,
          staleRecovered: false,
          error: recoverError,
          exitCode: 3,
        };
      }
    }
    return {
      ok: false,
      staleRecovered: false,
      error: new Error(
        stale
          ? "stale lock があります。--recover-stale-lock を指定してください。"
          : "実行中の lock があります。"
      ),
      exitCode: 3,
      stale,
    };
  }
}

function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

function spawnLogged(execPath, args, options) {
  return new Promise((resolve) => {
    const child = spawn(execPath, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      const text = chunk.toString("utf8");
      stdout += text;
      if (options.onStdout) options.onStdout(text);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      const text = chunk.toString("utf8");
      stderr += text;
      if (options.onStderr) options.onStderr(text);
    });

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch (_e) {
        // ignore
      }
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) killChild();
      else options.abortSignal.addEventListener("abort", killChild);
    }

    child.on("error", (error) => {
      resolve({
        status: null,
        signal: null,
        stdout,
        stderr,
        error,
        pid: child.pid,
      });
    });
    child.on("close", (status, signal) => {
      if (options.stdoutLogPath) {
        fs.writeFileSync(
          options.stdoutLogPath,
          Buffer.concat(stdoutChunks).toString("utf8"),
          "utf8"
        );
      }
      if (options.stderrLogPath) {
        fs.writeFileSync(
          options.stderrLogPath,
          Buffer.concat(stderrChunks).toString("utf8"),
          "utf8"
        );
      }
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: null,
        pid: child.pid,
      });
    });
  });
}

function createAbortController() {
  if (typeof AbortController !== "undefined") {
    return new AbortController();
  }
  // Minimal shim
  const listeners = new Set();
  return {
    signal: {
      aborted: false,
      addEventListener(_type, fn) {
        listeners.add(fn);
      },
    },
    abort() {
      this.signal.aborted = true;
      for (const fn of listeners) fn();
    },
  };
}

/**
 * Build run plan without side effects (for plan / dry-run).
 */
function planDailyRun(rawOptions, context = {}) {
  const rootDir = context.rootDir || process.cwd();
  const normalized = normalizeRunnerOptions(rawOptions, { now: context.now });
  if (!normalized.ok) {
    return { ok: false, errors: normalized.errors, plan: null };
  }
  const options = normalized.options;
  const dateDirectory = path.resolve(rootDir, options.runsDir, options.runDate);
  const existing = listExistingAttempts(dateDirectory);
  const lock = readLock(path.join(dateDirectory, ".lock"));
  const stale = lock
    ? isLockStale(lock, options.staleLockMinutes, context.now || new Date())
    : false;
  const gate = evaluateRunGate({
    existingAttempts: existing,
    lockInfo: lock ? { lock, stale } : null,
    options,
    now: context.now || new Date(),
  });

  const attempt = gate.nextAttempt || 1;
  const pathPlan = buildPathPlan(options, attempt, rootDir);
  const plan = buildRunPlan(
    { ...options, dryRun: true },
    pathPlan,
    rootDir
  );
  plan.gate = {
    allow: gate.allow,
    reason: gate.reason,
    message: gate.message,
    exitCode: gate.exitCode,
    existingAttempts: existing.map((a) => ({
      attempt: a.attempt,
      status: a.status,
    })),
    lockPresent: Boolean(lock),
    lockStale: stale,
  };
  return { ok: true, errors: [], plan, options, pathPlan, gate };
}

/**
 * Execute a Daily Run.
 */
async function runDailyRun(rawOptions, context = {}) {
  const rootDir = context.rootDir || process.cwd();
  const now = context.now instanceof Date ? context.now : new Date();
  const progress = (msg) => logProgress(msg, context.log);

  const normalized = normalizeRunnerOptions(rawOptions, { now });
  if (!normalized.ok) {
    const err = new Error(normalized.errors.join("\n"));
    err.exitCode = 2;
    err.validation = normalized;
    throw err;
  }
  const options = { ...normalized.options, dryRun: rawOptions.dryRun === true };

  if (options.dryRun) {
    const planned = planDailyRun({ ...rawOptions, dryRun: true }, { rootDir, now, log: context.log });
    return {
      success: true,
      status: "planned",
      dryRun: true,
      plan: planned.plan,
    };
  }

  const dateDirectory = path.resolve(rootDir, options.runsDir, options.runDate);
  const existing = listExistingAttempts(dateDirectory);
  const lockPath = path.join(dateDirectory, ".lock");
  const existingLock = readLock(lockPath);
  const stale = existingLock
    ? isLockStale(existingLock, options.staleLockMinutes, now)
    : false;

  const gate = evaluateRunGate({
    existingAttempts: existing,
    lockInfo: existingLock ? { lock: existingLock, stale } : null,
    options,
    now,
  });

  if (!gate.allow) {
    const err = new Error(gate.message || "実行できません。");
    err.exitCode = gate.exitCode || 1;
    err.reason = gate.reason;
    if (gate.status === "skipped") {
      err.skipped = true;
    }
    throw err;
  }

  const attempt = gate.nextAttempt || 1;
  const pathPlan = buildPathPlan(options, attempt, rootDir);
  let paths = pathPlan.paths;
  const startedAt = nowIso(now);

  const lockPayload = buildLockPayload({
    runId: pathPlan.runId,
    runDate: options.runDate,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt,
  });

  let report = createInitialRunReport({
    pathPlan,
    options,
    startedAt,
    status: "running",
  });
  let lockAcquired = false;
  let lockReleased = false;
  let staleLockRecovered = false;
  const abortController = createAbortController();
  let interrupted = false;

  const onSignal = () => {
    interrupted = true;
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const persistReport = () => {
    writeJsonAtomicSafe(paths.runReport, report);
  };

  const cleanup = (extraErrors = []) => {
    const release = releaseLock(lockPath);
    lockReleased = release.ok;
    if (!release.ok && release.error) {
      extraErrors.push(`lock 解除失敗: ${release.error.message}`);
    }
    return extraErrors;
  };

  try {
    // prepare directories
    report = markStepRunning(report, "prepare", nowIso());
    for (const dir of [
      paths.inputDirectory,
      paths.workDirectory,
      paths.outputDirectory,
      paths.logDirectory,
    ]) {
      ensureDir(dir);
    }

    const lockResult = acquireLock(lockPath, lockPayload, options, now);
    if (!lockResult.ok) {
      const err = new Error(lockResult.error?.message || "lock 取得失敗");
      err.exitCode = lockResult.exitCode || 3;
      throw err;
    }
    lockAcquired = true;
    staleLockRecovered = lockResult.staleRecovered;

    const config = buildRunConfig(options, pathPlan, startedAt);
    writeJsonAtomicSafe(paths.config, config);
    persistReport();

    report = markStepCompleted(report, "prepare", nowIso(), {
      outputs: { lockAcquired: true, staleLockRecovered },
    });
    persistReport();
    progress(`[daily-runner] prepare ok attempt=${attempt} runId=${pathPlan.runId}`);

    if (interrupted) {
      throw Object.assign(new Error("interrupted"), { interrupted: true });
    }

    // pipeline
    report = markStepRunning(report, "pipeline", nowIso());
    persistReport();
    progress("[daily-runner] pipeline start");

    const pipelineArgs = [
      path.join(rootDir, "pipeline.js"),
      "--days",
      String(options.days),
      "--base-dir",
      options.baseDir,
      "--plan-title",
      options.planTitle,
      "--purpose",
      options.purpose,
      "--audience",
      options.audience,
      "--length",
      String(options.length),
      "--confidence-threshold",
      String(options.confidenceThreshold),
      "--work-dir",
      paths.workDirectory,
      "--output",
      paths.article,
      "--report-output",
      paths.articleReport,
    ];
    if (options.noApi || options.fromEnriched) {
      pipelineArgs.push("--no-api");
    }

    const pipelineResult = await spawnLogged(process.execPath, pipelineArgs, {
      cwd: rootDir,
      stdoutLogPath: paths.pipelineStdoutLog,
      stderrLogPath: paths.pipelineStderrLog,
      onStderr: (text) => {
        process.stderr.write(text);
      },
      abortSignal: abortController.signal,
    });

    if (interrupted || pipelineResult.signal) {
      report = markStepFailed(
        report,
        "pipeline",
        nowIso(),
        "interrupted",
        pipelineResult.status ?? 1
      );
      throw Object.assign(new Error("interrupted during pipeline"), {
        interrupted: true,
      });
    }

    if (pipelineResult.error || pipelineResult.status !== 0) {
      const detail = (pipelineResult.stderr || pipelineResult.stdout || "").trim();
      report = markStepFailed(
        report,
        "pipeline",
        nowIso(),
        detail || `pipeline exit ${pipelineResult.status}`,
        pipelineResult.status ?? 1
      );
      persistReport();
      throw Object.assign(
        new Error(`Pipeline が失敗しました (exit ${pipelineResult.status})`),
        { exitCode: 1 }
      );
    }

    report = markStepCompleted(report, "pipeline", nowIso(), {
      exitCode: 0,
      outputs: {
        stdoutLog: paths.pipelineStdoutLog,
        stderrLog: paths.pipelineStderrLog,
      },
    });
    persistReport();

    // verify-article
    report = markStepRunning(report, "verify-article", nowIso());
    const articleExists = fs.existsSync(paths.article);
    const articleReportExists = fs.existsSync(paths.articleReport);
    let articleReportStatus = null;
    if (articleReportExists) {
      const ar = readJsonIfExists(paths.articleReport);
      articleReportStatus = ar?.reviewSummary?.status || null;
    }
    if (
      !articleExists ||
      !articleReportExists ||
      (articleReportStatus !== "pass" && articleReportStatus !== "warning")
    ) {
      report = markStepFailed(
        report,
        "verify-article",
        nowIso(),
        `article/report 検証失敗 status=${articleReportStatus}`
      );
      persistReport();
      throw Object.assign(new Error("article / article-report の検証に失敗しました。"), {
        exitCode: 1,
      });
    }
    report = markStepCompleted(report, "verify-article", nowIso(), {
      outputs: { articleReportStatus },
    });
    persistReport();

    // build-manifest
    report = markStepRunning(report, "build-manifest", nowIso());
    const manifest = buildManifestObject(options.runDate, options.category);
    const manifestValidation = validateDailyEditionManifest(manifest);
    if (!manifestValidation.ok) {
      report = markStepFailed(
        report,
        "build-manifest",
        nowIso(),
        manifestValidation.errors.join("\n")
      );
      persistReport();
      throw Object.assign(new Error("Manifest が不正です。"), { exitCode: 1 });
    }
    writeJsonAtomicSafe(paths.manifest, manifest);
    report = markStepCompleted(report, "build-manifest", nowIso(), {
      outputs: { manifest: paths.manifest },
    });
    persistReport();

    // daily-edition
    report = markStepRunning(report, "daily-edition", nowIso());
    progress("[daily-runner] daily-edition start");
    const editionArgs = [
      path.join(rootDir, "daily-edition.js"),
      "build",
      "--manifest",
      paths.manifest,
      "--output",
      paths.dailyEdition,
      "--report-output",
      paths.dailyEditionReport,
    ];
    const editionResult = await spawnLogged(process.execPath, editionArgs, {
      cwd: rootDir,
      stdoutLogPath: paths.dailyEditionStdoutLog,
      stderrLogPath: paths.dailyEditionStderrLog,
      onStderr: (text) => {
        process.stderr.write(text);
      },
      abortSignal: abortController.signal,
    });

    if (interrupted || editionResult.signal) {
      report = markStepFailed(
        report,
        "daily-edition",
        nowIso(),
        "interrupted",
        editionResult.status ?? 1
      );
      throw Object.assign(new Error("interrupted during daily-edition"), {
        interrupted: true,
      });
    }

    if (editionResult.error || editionResult.status !== 0) {
      report = markStepFailed(
        report,
        "daily-edition",
        nowIso(),
        (editionResult.stderr || "").trim() ||
          `daily-edition exit ${editionResult.status}`,
        editionResult.status ?? 1
      );
      persistReport();
      throw Object.assign(
        new Error(`Daily Edition が失敗しました (exit ${editionResult.status})`),
        { exitCode: 1 }
      );
    }
    report = markStepCompleted(report, "daily-edition", nowIso(), {
      exitCode: 0,
      outputs: {
        stdoutLog: paths.dailyEditionStdoutLog,
        stderrLog: paths.dailyEditionStderrLog,
      },
    });
    persistReport();

    // verify-edition
    report = markStepRunning(report, "verify-edition", nowIso());
    const dailyEditionExists = fs.existsSync(paths.dailyEdition);
    const dailyEditionReportExists = fs.existsSync(paths.dailyEditionReport);
    let editionPublishable = null;
    let editionStatus = null;
    if (dailyEditionReportExists) {
      const er = readJsonIfExists(paths.dailyEditionReport);
      editionPublishable = er?.reviewSummary?.publishable === true;
      editionStatus = er?.reviewSummary?.status || null;
    }
    if (!dailyEditionExists || !dailyEditionReportExists || !editionPublishable) {
      report = markStepFailed(
        report,
        "verify-edition",
        nowIso(),
        `edition 検証失敗 publishable=${editionPublishable} status=${editionStatus}`
      );
      persistReport();
      throw Object.assign(new Error("Daily Edition 成果物の検証に失敗しました。"), {
        exitCode: 1,
      });
    }
    report = markStepCompleted(report, "verify-edition", nowIso(), {
      status: editionStatus === "warning" ? "warning" : "completed",
      outputs: { editionPublishable, editionStatus },
    });
    persistReport();

    // finalize
    report = markStepRunning(report, "finalize", nowIso());
    const cleanupErrors = cleanup();
    const checks = buildRunChecks({
      report,
      artifacts: {
        articleExists: true,
        articleReportExists: true,
        manifestValid: true,
        dailyEditionExists: true,
        dailyEditionReportExists: true,
      },
      lockAcquired,
      lockReleased,
      staleLockRecovered,
      articleReportStatus,
      editionPublishable,
    });
    const errors = [...cleanupErrors];
    const status = decideFinalStatus(report, checks);
    report = markStepCompleted(report, "finalize", nowIso());
    report = finalizeRunReport(report, {
      status,
      completedAt: nowIso(),
      checks,
      errors,
    });

    const validated = validateDailyRunReport(report);
    if (!validated.ok) {
      report.status = "failed";
      report.errors = [...report.errors, ...validated.errors];
      persistReport();
      const err = new Error(
        `Run Report validation 失敗:\n${validated.errors.join("\n")}`
      );
      err.exitCode = 5;
      throw err;
    }
    report = validated.report;
    persistReport();
    progress(`[daily-runner] completed status=${report.status}`);

    return {
      success: true,
      status: report.status,
      runId: report.id,
      runDate: report.runDate,
      runReport: paths.runReport,
      dailyEdition: paths.dailyEdition,
      attempt,
      report,
    };
  } catch (error) {
    const at = nowIso();
    if (!report) {
      const err = new Error(error.message || String(error));
      err.exitCode = error.exitCode || 1;
      throw err;
    }
    if (interrupted || error.interrupted) {
      report = {
        ...report,
        status: "interrupted",
        completedAt: at,
        errors: [...(report.errors || []), error.message || "interrupted"],
      };
      const running = report.steps.find((s) => s.status === "running");
      if (running) {
        report = markStepFailed(report, running.name, at, "interrupted");
      }
    } else {
      const running = report.steps.find((s) => s.status === "running");
      if (running) {
        report = markStepFailed(report, running.name, at, error.message);
      }
      report = {
        ...report,
        status: "failed",
        completedAt: at,
        errors: [...(report.errors || []), error.message || String(error)],
      };
    }

    const cleanupErrors = lockAcquired ? cleanup() : [];
    if (cleanupErrors.length) {
      report.errors.push(...cleanupErrors);
    }
    if (paths) {
      report.checks = buildRunChecks({
        report,
        artifacts: {
          articleExists: fs.existsSync(paths.article),
          articleReportExists: fs.existsSync(paths.articleReport),
          manifestValid: fs.existsSync(paths.manifest),
          dailyEditionExists: fs.existsSync(paths.dailyEdition),
          dailyEditionReportExists: fs.existsSync(paths.dailyEditionReport),
        },
        lockAcquired,
        lockReleased,
        staleLockRecovered,
        articleReportStatus: readJsonIfExists(paths.articleReport)
          ?.reviewSummary?.status,
        editionPublishable: readJsonIfExists(paths.dailyEditionReport)
          ?.reviewSummary?.publishable,
      });
      report.statistics = calculateRunStatistics(report);
      try {
        persistReport();
      } catch (persistError) {
        progress(`[daily-runner] run-report 保存失敗: ${persistError.message}`);
      }
    }

    const err = new Error(error.message || String(error));
    err.exitCode = error.exitCode || 1;
    err.reason = error.reason;
    err.report = report;
    err.runReportPath = paths ? paths.runReport : null;
    throw err;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

module.exports = {
  planDailyRun,
  runDailyRun,
  listExistingAttempts,
  acquireLock,
  releaseLock,
  readLock,
  spawnLogged,
};
