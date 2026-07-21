/**
 * Daily Runner core — pure planning, report building, and validation.
 * No filesystem I/O, no subprocess, no AI.
 */

const DEFAULT_DAYS = 1;
const DEFAULT_CATEGORY = "other";
const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_STALE_LOCK_MINUTES = 180;
const DEFAULT_CONFIDENCE_THRESHOLD = 50;
const DEFAULT_PURPOSE = "explain";
const DEFAULT_AUDIENCE = "一般読者";
const DEFAULT_LENGTH = 1200;
const DEFAULT_BASE_DIR = "knowledge-base";

const RUN_STATUSES = new Set([
  "planned",
  "running",
  "completed",
  "completed_with_warnings",
  "failed",
  "skipped",
  "interrupted",
]);

const STEP_NAMES = [
  "prepare",
  "pipeline",
  "verify-article",
  "build-manifest",
  "daily-edition",
  "verify-edition",
  "finalize",
];

const STEP_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "warning",
  "failed",
  "skipped",
]);

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function isIso8601(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function isDateYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function rejectControlOrEmpty(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} は空でない文字列である必要があります。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${fieldName} に制御文字は使えません。`);
  }
  return value.trim();
}

function validateRunId(id) {
  const trimmed = rejectControlOrEmpty(id, "runId");
  if (trimmed === "." || trimmed === "..") {
    throw new Error("runId に . または .. は使えません。");
  }
  if (/[/\\]/.test(trimmed)) {
    throw new Error("runId にパス区切りは使えません。");
  }
  return trimmed;
}

function getSystemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (_error) {
    return "UTC";
  }
}

function validateTimezone(timezone) {
  const tz = rejectControlOrEmpty(timezone, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch (_error) {
    throw new Error(`不正な timezone です: ${tz}`);
  }
  return tz;
}

/**
 * Resolve local calendar date in the given IANA timezone (not UTC conversion of wall clock).
 */
function resolveRunDate(now, timezone) {
  const tz = validateTimezone(timezone || getSystemTimezone());
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  const runDate = `${y}-${m}-${d}`;
  if (!isDateYmd(runDate)) {
    throw new Error(`runDate の解決に失敗しました: ${runDate}`);
  }
  return runDate;
}

function validateRunDate(runDate) {
  if (!isDateYmd(runDate)) {
    throw new Error("runDate は実在する YYYY-MM-DD である必要があります。");
  }
  return runDate;
}

function defaultRunId(runDate, attempt = 1) {
  if (attempt <= 1) return `daily-run-${runDate}`;
  return `daily-run-${runDate}-r${attempt}`;
}

/**
 * Join path segments with / for plan paths (POSIX-style relative within run).
 */
function joinPlanPath(...parts) {
  return parts
    .filter((p) => p != null && String(p).length > 0)
    .map((p, i) => {
      let s = String(p).replace(/\\/g, "/");
      if (i > 0) s = s.replace(/^\/+/, "");
      return s.replace(/\/+$/, "");
    })
    .join("/");
}

function assertPathInsideRoot(rootDir, targetPath, label) {
  const root = String(rootDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const target = String(targetPath).replace(/\\/g, "/");
  if (target === root || target.startsWith(`${root}/`)) {
    return true;
  }
  throw new Error(`${label} が run directory 外です: ${targetPath}`);
}

/**
 * Normalize CLI options into a stable config object (no secrets).
 */
function normalizeRunnerOptions(raw = {}, context = {}) {
  const errors = [];
  const now = context.now instanceof Date ? context.now : new Date();

  let timezone;
  try {
    timezone = raw.timezone
      ? validateTimezone(raw.timezone)
      : getSystemTimezone();
  } catch (error) {
    errors.push(error.message);
    timezone = getSystemTimezone();
  }

  let runDate;
  try {
    runDate = raw.date
      ? validateRunDate(raw.date)
      : resolveRunDate(now, timezone);
  } catch (error) {
    errors.push(error.message);
    runDate = null;
  }

  let days = DEFAULT_DAYS;
  if (raw.days != null) {
    const n = Number(raw.days);
    if (!Number.isInteger(n) || n < 1) {
      errors.push("--days は 1 以上の整数である必要があります。");
    } else {
      days = n;
    }
  }

  let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
  if (raw.confidenceThreshold != null) {
    const n = Number(raw.confidenceThreshold);
    if (!Number.isInteger(n) || n < 0) {
      errors.push("--confidence-threshold は 0 以上の整数である必要があります。");
    } else {
      confidenceThreshold = n;
    }
  }

  let length = DEFAULT_LENGTH;
  if (raw.length != null) {
    const n = Number(raw.length);
    if (!Number.isInteger(n) || n < 1) {
      errors.push("--length は 1 以上の整数である必要があります。");
    } else {
      length = n;
    }
  }

  let staleLockMinutes = DEFAULT_STALE_LOCK_MINUTES;
  if (raw.staleLockMinutes != null) {
    const n = Number(raw.staleLockMinutes);
    if (!Number.isInteger(n) || n < 1) {
      errors.push("--stale-lock-minutes は 1 以上の整数である必要があります。");
    } else {
      staleLockMinutes = n;
    }
  }

  let category = DEFAULT_CATEGORY;
  try {
    if (raw.category != null) {
      category = rejectControlOrEmpty(raw.category, "category");
    }
  } catch (error) {
    errors.push(error.message);
  }

  let runId = null;
  if (raw.runId != null) {
    try {
      runId = validateRunId(raw.runId);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const runsDir =
    typeof raw.runsDir === "string" && raw.runsDir.trim()
      ? raw.runsDir.trim()
      : DEFAULT_RUNS_DIR;

  const baseDir =
    typeof raw.baseDir === "string" && raw.baseDir.trim()
      ? raw.baseDir.trim()
      : DEFAULT_BASE_DIR;

  const planTitle =
    typeof raw.planTitle === "string" && raw.planTitle.trim()
      ? raw.planTitle.trim()
      : `Daily ${runDate || "Edition"}`;

  const purpose =
    typeof raw.purpose === "string" && raw.purpose.trim()
      ? raw.purpose.trim()
      : DEFAULT_PURPOSE;

  const audience =
    typeof raw.audience === "string" && raw.audience.trim()
      ? raw.audience.trim()
      : DEFAULT_AUDIENCE;

  const noApi = raw.noApi === true || raw.fromEnriched === true;
  const fromEnriched = raw.fromEnriched === true || noApi;

  if (errors.length > 0) {
    return { ok: false, options: null, errors };
  }

  return {
    ok: true,
    options: {
      runDate,
      timezone,
      runId,
      runsDir,
      baseDir,
      days,
      planTitle,
      purpose,
      audience,
      length,
      category,
      confidenceThreshold,
      noApi,
      fromEnriched,
      retry: raw.retry === true,
      recoverStaleLock: raw.recoverStaleLock === true,
      staleLockMinutes,
      dryRun: raw.dryRun === true,
    },
    errors: [],
  };
}

/**
 * Build deterministic path plan for a run attempt.
 * attempt >= 1. First attempt lives under dateDir/attempts/1.
 */
function buildPathPlan(options, attempt, rootDir) {
  const runDate = options.runDate;
  const runsDirAbs = isAbsolutePath(options.runsDir)
    ? options.runsDir
    : joinAbs(rootDir, options.runsDir);
  const dateDirectory = joinAbs(runsDirAbs, runDate);
  const attemptDirectory = joinAbs(dateDirectory, "attempts", String(attempt));
  const runId = options.runId || defaultRunId(runDate, attempt);

  const paths = {
    runsDirectory: runsDirAbs,
    dateDirectory,
    runDirectory: attemptDirectory,
    inputDirectory: joinAbs(attemptDirectory, "input"),
    workDirectory: joinAbs(attemptDirectory, "work"),
    outputDirectory: joinAbs(attemptDirectory, "output"),
    logDirectory: joinAbs(attemptDirectory, "logs"),
    article: joinAbs(attemptDirectory, "output", "article.md"),
    articleReport: joinAbs(attemptDirectory, "output", "article-report.json"),
    dailyEdition: joinAbs(attemptDirectory, "output", "daily-edition.md"),
    dailyEditionReport: joinAbs(
      attemptDirectory,
      "output",
      "daily-edition-report.json"
    ),
    manifest: joinAbs(attemptDirectory, "manifest.json"),
    config: joinAbs(attemptDirectory, "run-config.json"),
    runReport: joinAbs(attemptDirectory, "run-report.json"),
    lock: joinAbs(dateDirectory, ".lock"),
    pipelineStdoutLog: joinAbs(
      attemptDirectory,
      "logs",
      "pipeline.stdout.log"
    ),
    pipelineStderrLog: joinAbs(
      attemptDirectory,
      "logs",
      "pipeline.stderr.log"
    ),
    dailyEditionStdoutLog: joinAbs(
      attemptDirectory,
      "logs",
      "daily-edition.stdout.log"
    ),
    dailyEditionStderrLog: joinAbs(
      attemptDirectory,
      "logs",
      "daily-edition.stderr.log"
    ),
  };

  for (const [key, value] of Object.entries(paths)) {
    if (key === "runsDirectory" || key === "dateDirectory" || key === "lock") {
      continue;
    }
    assertPathInsideRoot(attemptDirectory, value, `paths.${key}`);
  }
  assertPathInsideRoot(dateDirectory, paths.lock, "paths.lock");

  return { runId, attempt, paths };
}

function isAbsolutePath(p) {
  if (typeof p !== "string") return false;
  if (p.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

function joinAbs(...parts) {
  // Pure join without requiring path module — use / and normalize
  let out = "";
  for (const part of parts) {
    if (part == null || part === "") continue;
    const s = String(part).replace(/\\/g, "/");
    if (!out) {
      out = s.replace(/\/+$/, "") || s;
      continue;
    }
    out = `${out.replace(/\/+$/, "")}/${s.replace(/^\/+/, "")}`;
  }
  return out;
}

function buildPipelineArgs(options, paths) {
  const args = [];
  args.push("--days", String(options.days));
  args.push("--base-dir", options.baseDir);
  args.push("--plan-title", options.planTitle);
  args.push("--purpose", options.purpose);
  args.push("--audience", options.audience);
  args.push("--length", String(options.length));
  args.push("--confidence-threshold", String(options.confidenceThreshold));
  args.push("--work-dir", paths.workDirectory);
  args.push("--output", paths.article);
  args.push("--report-output", paths.articleReport);
  if (options.noApi || options.fromEnriched) {
    args.push("--no-api");
  }
  return args;
}

function buildDailyEditionArgs(paths) {
  return [
    "build",
    "--manifest",
    paths.manifest,
    "--output",
    paths.dailyEdition,
    "--report-output",
    paths.dailyEditionReport,
  ];
}

function buildManifestObject(runDate, category) {
  return {
    date: runDate,
    title: "Daily Edition",
    items: [
      {
        article: "./output/article.md",
        report: "./output/article-report.json",
        category,
        priority: 1000,
      },
    ],
  };
}

function buildRunConfig(options, pathPlan, createdAt) {
  return {
    runId: pathPlan.runId,
    runDate: options.runDate,
    timezone: options.timezone,
    days: options.days,
    baseDir: options.baseDir,
    runsDir: options.runsDir,
    category: options.category,
    attempt: pathPlan.attempt,
    pipelineOptions: {
      days: options.days,
      baseDir: options.baseDir,
      planTitle: options.planTitle,
      purpose: options.purpose,
      audience: options.audience,
      length: options.length,
      confidenceThreshold: options.confidenceThreshold,
      noApi: options.noApi,
      fromEnriched: options.fromEnriched,
    },
    createdAt: createdAt || nowIso(),
  };
}

function buildRunPlan(options, pathPlan, rootDir) {
  return {
    runId: pathPlan.runId,
    runDate: options.runDate,
    timezone: options.timezone,
    attempt: pathPlan.attempt,
    dryRun: options.dryRun === true,
    paths: { ...pathPlan.paths },
    options: {
      days: options.days,
      category: options.category,
      noApi: options.noApi,
      fromEnriched: options.fromEnriched,
      confidenceThreshold: options.confidenceThreshold,
      planTitle: options.planTitle,
      purpose: options.purpose,
      audience: options.audience,
      length: options.length,
      baseDir: options.baseDir,
      retry: options.retry === true,
      recoverStaleLock: options.recoverStaleLock === true,
      staleLockMinutes: options.staleLockMinutes,
    },
    commands: {
      pipeline: {
        executable: "node",
        script: "pipeline.js",
        args: buildPipelineArgs(options, pathPlan.paths),
      },
      dailyEdition: {
        executable: "node",
        script: "daily-edition.js",
        args: buildDailyEditionArgs(pathPlan.paths),
      },
    },
    rootDir: rootDir || null,
  };
}

function createInitialSteps() {
  return STEP_NAMES.map((name) => ({
    name,
    status: "pending",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    outputs: null,
    error: null,
  }));
}

function createInitialRunReport({
  pathPlan,
  options,
  startedAt,
  status = "planned",
}) {
  return {
    id: pathPlan.runId,
    runDate: options.runDate,
    timezone: options.timezone,
    attempt: pathPlan.attempt,
    startedAt: startedAt || null,
    completedAt: null,
    status,
    paths: {
      runDirectory: pathPlan.paths.runDirectory,
      workDirectory: pathPlan.paths.workDirectory,
      outputDirectory: pathPlan.paths.outputDirectory,
      logDirectory: pathPlan.paths.logDirectory,
      article: pathPlan.paths.article,
      articleReport: pathPlan.paths.articleReport,
      dailyEdition: pathPlan.paths.dailyEdition,
      dailyEditionReport: pathPlan.paths.dailyEditionReport,
      manifest: pathPlan.paths.manifest,
      config: pathPlan.paths.config,
    },
    options: {
      days: options.days,
      category: options.category,
      noApi: options.noApi,
      fromEnriched: options.fromEnriched,
      confidenceThreshold: options.confidenceThreshold,
    },
    steps: createInitialSteps(),
    checks: [],
    statistics: {
      stepCount: STEP_NAMES.length,
      completedStepCount: 0,
      failedStepCount: 0,
      warningCount: 0,
      durationMs: null,
    },
    errors: [],
  };
}

function updateStep(report, stepName, patch) {
  const steps = report.steps.map((step) => {
    if (step.name !== stepName) return step;
    return { ...step, ...patch };
  });
  return { ...report, steps };
}

function markStepRunning(report, stepName, at) {
  return updateStep(report, stepName, {
    status: "running",
    startedAt: at,
    error: null,
  });
}

function markStepCompleted(report, stepName, at, extra = {}) {
  const step = report.steps.find((s) => s.name === stepName);
  const started = step?.startedAt ? Date.parse(step.startedAt) : NaN;
  const completed = Date.parse(at);
  const durationMs =
    Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : null;
  return updateStep(report, stepName, {
    status: extra.status || "completed",
    completedAt: at,
    durationMs,
    exitCode: extra.exitCode != null ? extra.exitCode : 0,
    outputs: extra.outputs != null ? extra.outputs : step?.outputs,
    error: extra.error != null ? extra.error : null,
  });
}

function markStepFailed(report, stepName, at, error, exitCode = 1) {
  const step = report.steps.find((s) => s.name === stepName);
  const started = step?.startedAt ? Date.parse(step.startedAt) : NaN;
  const completed = Date.parse(at);
  const durationMs =
    Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : null;
  return updateStep(report, stepName, {
    status: "failed",
    completedAt: at,
    durationMs,
    exitCode,
    error: typeof error === "string" ? error : error?.message || String(error),
  });
}

function pushCheck(checks, type, status, severity, message, details = null) {
  checks.push({ type, status, severity, message, details });
  return checks;
}

function buildRunChecks({
  report,
  artifacts = {},
  lockAcquired = false,
  lockReleased = false,
  staleLockRecovered = false,
  articleReportStatus = null,
  editionPublishable = null,
}) {
  const checks = [];

  pushCheck(checks, "config-valid", "pass", "info", "run-config は正規化済みです。");
  pushCheck(
    checks,
    "run-date-valid",
    isDateYmd(report.runDate) ? "pass" : "error",
    isDateYmd(report.runDate) ? "info" : "error",
    "runDate は YYYY-MM-DD です。"
  );
  pushCheck(checks, "timezone-valid", "pass", "info", `timezone=${report.timezone}`);
  pushCheck(
    checks,
    "directory-plan-valid",
    report.paths?.runDirectory ? "pass" : "error",
    report.paths?.runDirectory ? "info" : "error",
    "ディレクトリ計画は有効です。"
  );

  pushCheck(
    checks,
    "lock-acquired",
    lockAcquired ? "pass" : "error",
    lockAcquired ? "info" : "error",
    lockAcquired ? "lock を取得しました。" : "lock を取得できませんでした。"
  );
  if (staleLockRecovered) {
    pushCheck(
      checks,
      "stale-lock-recovered",
      "warning",
      "warning",
      "stale lock を --recover-stale-lock で回収しました。"
    );
  }

  const pipelineStep = report.steps.find((s) => s.name === "pipeline");
  pushCheck(
    checks,
    "pipeline-exit-success",
    pipelineStep?.status === "completed" || pipelineStep?.status === "warning"
      ? "pass"
      : pipelineStep?.status === "failed"
        ? "error"
        : "warning",
    pipelineStep?.status === "failed" ? "error" : "info",
    `pipeline step: ${pipelineStep?.status || "pending"}`
  );

  pushCheck(
    checks,
    "article-exists",
    artifacts.articleExists ? "pass" : "error",
    artifacts.articleExists ? "info" : "error",
    "article.md"
  );
  pushCheck(
    checks,
    "article-report-exists",
    artifacts.articleReportExists ? "pass" : "error",
    artifacts.articleReportExists ? "info" : "error",
    "article-report.json"
  );

  const articlePassed =
    articleReportStatus === "pass" || articleReportStatus === "warning";
  pushCheck(
    checks,
    "article-report-passed",
    articlePassed ? "pass" : artifacts.articleReportExists ? "error" : "error",
    articlePassed ? "info" : "error",
    `Article Report status=${articleReportStatus || "unknown"}`
  );

  pushCheck(
    checks,
    "manifest-valid",
    artifacts.manifestValid ? "pass" : "error",
    artifacts.manifestValid ? "info" : "error",
    "manifest.json"
  );

  const editionStep = report.steps.find((s) => s.name === "daily-edition");
  pushCheck(
    checks,
    "daily-edition-exit-success",
    editionStep?.status === "completed" || editionStep?.status === "warning"
      ? "pass"
      : editionStep?.status === "failed"
        ? "error"
        : "warning",
    editionStep?.status === "failed" ? "error" : "info",
    `daily-edition step: ${editionStep?.status || "pending"}`
  );

  pushCheck(
    checks,
    "daily-edition-exists",
    artifacts.dailyEditionExists ? "pass" : "error",
    artifacts.dailyEditionExists ? "info" : "error",
    "daily-edition.md"
  );
  pushCheck(
    checks,
    "daily-edition-report-exists",
    artifacts.dailyEditionReportExists ? "pass" : "error",
    artifacts.dailyEditionReportExists ? "info" : "error",
    "daily-edition-report.json"
  );

  pushCheck(
    checks,
    "daily-edition-publishable",
    editionPublishable === true
      ? "pass"
      : editionPublishable === false
        ? "error"
        : "warning",
    editionPublishable === true ? "info" : "error",
    `Edition publishable=${editionPublishable}`
  );

  pushCheck(
    checks,
    "input-files-read-only",
    "pass",
    "info",
    "Runner は入力を読み取り専用として扱います。"
  );

  pushCheck(
    checks,
    "lock-released",
    lockReleased ? "pass" : "warning",
    lockReleased ? "info" : "warning",
    lockReleased ? "lock を解除しました。" : "lock 解除を確認できません。"
  );

  return checks;
}

function calculateRunStatistics(report) {
  const completedStepCount = report.steps.filter(
    (s) => s.status === "completed" || s.status === "warning"
  ).length;
  const failedStepCount = report.steps.filter((s) => s.status === "failed")
    .length;
  const warningCount = (report.checks || []).filter(
    (c) => c.status === "warning"
  ).length;
  let durationMs = null;
  if (report.startedAt && report.completedAt) {
    const a = Date.parse(report.startedAt);
    const b = Date.parse(report.completedAt);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      durationMs = Math.max(0, b - a);
    }
  }
  return {
    stepCount: report.steps.length,
    completedStepCount,
    failedStepCount,
    warningCount,
    durationMs,
  };
}

function finalizeRunReport(report, { status, completedAt, checks, errors }) {
  const next = {
    ...report,
    status,
    completedAt,
    checks: checks || report.checks || [],
    errors: errors || report.errors || [],
  };
  next.statistics = calculateRunStatistics(next);
  return next;
}

function decideFinalStatus(report, checks) {
  const hasFailedStep = report.steps.some((s) => s.status === "failed");
  const errorChecks = (checks || []).filter((c) => c.status === "error").length;
  const warningChecks = (checks || []).filter(
    (c) => c.status === "warning"
  ).length;
  if (hasFailedStep || errorChecks > 0) return "failed";
  if (warningChecks > 0) return "completed_with_warnings";
  return "completed";
}

/**
 * Decide whether a new attempt may proceed given existing date-dir state.
 * existingAttempts: [{ attempt, status }]
 * lockInfo: null | { lock, stale }
 */
function evaluateRunGate({
  existingAttempts,
  lockInfo,
  options,
  now,
}) {
  if (lockInfo && lockInfo.lock && !lockInfo.stale) {
    return {
      allow: false,
      reason: "lock_conflict",
      message: "実行中の lock があります。",
      exitCode: 3,
      status: null,
    };
  }
  if (lockInfo && lockInfo.lock && lockInfo.stale && !options.recoverStaleLock) {
    return {
      allow: false,
      reason: "stale_lock",
      message:
        "stale lock があります。--recover-stale-lock を指定してください。",
      exitCode: 3,
      status: null,
    };
  }

  const completed = (existingAttempts || []).find(
    (a) =>
      a.status === "completed" || a.status === "completed_with_warnings"
  );
  if (completed) {
    return {
      allow: false,
      reason: "already_completed",
      message: `同日 run はすでに完了しています (attempt ${completed.attempt})。`,
      exitCode: 4,
      status: "skipped",
    };
  }

  const failed = (existingAttempts || [])
    .filter((a) => a.status === "failed" || a.status === "interrupted")
    .sort((a, b) => b.attempt - a.attempt)[0];

  if (failed && !options.retry) {
    return {
      allow: false,
      reason: "failed_needs_retry",
      message:
        "失敗済み run があります。再実行するには --retry を指定してください。",
      exitCode: 1,
      status: null,
    };
  }

  let nextAttempt = 1;
  if (existingAttempts && existingAttempts.length > 0) {
    const maxAttempt = Math.max(...existingAttempts.map((a) => a.attempt));
    if (failed && options.retry) {
      nextAttempt = maxAttempt + 1;
    } else if (!failed && !completed) {
      // running/interrupted without lock? treat as next attempt if retry
      nextAttempt = maxAttempt + 1;
    }
  }

  return {
    allow: true,
    reason: null,
    message: null,
    exitCode: 0,
    nextAttempt,
    recoverStaleLock: Boolean(lockInfo && lockInfo.stale && options.recoverStaleLock),
  };
}

function isLockStale(lock, staleLockMinutes, now) {
  if (!lock || !lock.startedAt) return false;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return false;
  const thresholdMs = Number(staleLockMinutes) * 60 * 1000;
  const t = now instanceof Date ? now.getTime() : Date.now();
  return t - started >= thresholdMs;
}

function buildLockPayload({ runId, runDate, pid, hostname, startedAt }) {
  return {
    runId,
    runDate,
    pid,
    hostname,
    startedAt,
  };
}

function looksLikeSecretKey(key) {
  const k = String(key || "").toLowerCase();
  return (
    k.includes("api_key") ||
    k.includes("apikey") ||
    k.includes("authorization") ||
    k.includes("cookie") ||
    k.includes("secret") ||
    k.includes("password") ||
    k.includes("token")
  );
}

function assertNoSecrets(obj, pathLabel = "root") {
  const errors = [];
  if (!obj || typeof obj !== "object") return errors;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      errors.push(...assertNoSecrets(item, `${pathLabel}[${i}]`));
    });
    return errors;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (looksLikeSecretKey(key)) {
      errors.push(`秘密情報の可能性があるキーがあります: ${pathLabel}.${key}`);
    }
    if (value && typeof value === "object") {
      errors.push(...assertNoSecrets(value, `${pathLabel}.${key}`));
    }
  }
  return errors;
}

function validateDailyRunReport(report) {
  const errors = [];

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      ok: false,
      report: null,
      errors: ["Daily Run Report はオブジェクトである必要があります。"],
    };
  }

  try {
    validateRunId(report.id);
  } catch (error) {
    errors.push(error.message);
  }

  if (!isDateYmd(report.runDate)) {
    errors.push("runDate は YYYY-MM-DD である必要があります。");
  }
  if (typeof report.timezone !== "string" || !report.timezone.trim()) {
    errors.push("timezone は空でない文字列である必要があります。");
  }
  if (!Number.isInteger(report.attempt) || report.attempt < 1) {
    errors.push("attempt は 1 以上の整数である必要があります。");
  }
  if (!RUN_STATUSES.has(report.status)) {
    errors.push(`status が不正です: ${report.status}`);
  }

  if (report.startedAt != null && !isIso8601(report.startedAt)) {
    errors.push("startedAt は ISO8601 である必要があります。");
  }
  if (report.completedAt != null && !isIso8601(report.completedAt)) {
    errors.push("completedAt は ISO8601 である必要があります。");
  }

  if (
    ["completed", "completed_with_warnings", "failed", "skipped", "interrupted"].includes(
      report.status
    ) &&
    !report.completedAt
  ) {
    errors.push(`${report.status} では completedAt が必要です。`);
  }

  if (!report.paths || typeof report.paths !== "object") {
    errors.push("paths はオブジェクトである必要があります。");
  }
  if (!report.options || typeof report.options !== "object") {
    errors.push("options はオブジェクトである必要があります。");
  }

  if (!Array.isArray(report.steps)) {
    errors.push("steps は配列である必要があります。");
  } else {
    const names = new Set();
    for (const step of report.steps) {
      if (!step || typeof step !== "object") {
        errors.push("step が不正です。");
        continue;
      }
      if (names.has(step.name)) {
        errors.push(`step 名が重複しています: ${step.name}`);
      }
      names.add(step.name);
      if (!STEP_STATUSES.has(step.status)) {
        errors.push(`step.status が不正です: ${step.name}`);
      }
      if (
        step.durationMs != null &&
        (!Number.isInteger(step.durationMs) || step.durationMs < 0)
      ) {
        errors.push(`step.durationMs が不正です: ${step.name}`);
      }
    }

    if (report.status === "failed") {
      const hasFailed = report.steps.some((s) => s.status === "failed");
      if (!hasFailed && !(report.errors && report.errors.length > 0)) {
        errors.push("failed status なのに failed step / errors がありません。");
      }
    }

    if (
      report.status === "completed" ||
      report.status === "completed_with_warnings"
    ) {
      for (const required of STEP_NAMES) {
        const step = report.steps.find((s) => s.name === required);
        if (
          !step ||
          (step.status !== "completed" && step.status !== "warning")
        ) {
          errors.push(`完了 status なのに必須 step が未完了です: ${required}`);
        }
      }
    }
  }

  if (!Array.isArray(report.checks)) {
    errors.push("checks は配列である必要があります。");
  }
  if (!Array.isArray(report.errors)) {
    errors.push("errors は配列である必要があります。");
  }

  if (!report.statistics || typeof report.statistics !== "object") {
    errors.push("statistics はオブジェクトである必要があります。");
  } else if (Array.isArray(report.steps)) {
    const expected = calculateRunStatistics(report);
    if (report.statistics.stepCount !== expected.stepCount) {
      errors.push("statistics.stepCount が不整合です。");
    }
    if (report.statistics.completedStepCount !== expected.completedStepCount) {
      errors.push("statistics.completedStepCount が不整合です。");
    }
    if (report.statistics.failedStepCount !== expected.failedStepCount) {
      errors.push("statistics.failedStepCount が不整合です。");
    }
  }

  if (report.paths && report.paths.runDirectory) {
    for (const key of [
      "workDirectory",
      "outputDirectory",
      "logDirectory",
      "article",
      "articleReport",
      "dailyEdition",
      "dailyEditionReport",
      "manifest",
      "config",
    ]) {
      const value = report.paths[key];
      if (!value) continue;
      try {
        assertPathInsideRoot(report.paths.runDirectory, value, `paths.${key}`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  errors.push(...assertNoSecrets(report, "report"));

  if (errors.length > 0) {
    return { ok: false, report: null, errors };
  }

  return {
    ok: true,
    report: JSON.parse(JSON.stringify(report)),
    errors: [],
  };
}

module.exports = {
  DEFAULT_DAYS,
  DEFAULT_CATEGORY,
  DEFAULT_RUNS_DIR,
  DEFAULT_STALE_LOCK_MINUTES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_PURPOSE,
  DEFAULT_AUDIENCE,
  DEFAULT_LENGTH,
  DEFAULT_BASE_DIR,
  RUN_STATUSES,
  STEP_NAMES,
  nowIso,
  isDateYmd,
  validateRunId,
  validateTimezone,
  validateRunDate,
  getSystemTimezone,
  resolveRunDate,
  defaultRunId,
  normalizeRunnerOptions,
  buildPathPlan,
  buildPipelineArgs,
  buildDailyEditionArgs,
  buildManifestObject,
  buildRunConfig,
  buildRunPlan,
  createInitialRunReport,
  updateStep,
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
  assertPathInsideRoot,
  assertNoSecrets,
  joinAbs,
  isAbsolutePath,
};
