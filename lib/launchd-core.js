/**
 * Launchd Adapter core — pure planning, plist model, XML, validation.
 * No filesystem I/O, no launchctl, no AI.
 */

const crypto = require("crypto");

const DEFAULT_LABEL = "com.personal-editorial-intelligence.daily-runner";
const DEFAULT_DAYS = 1;
const DEFAULT_CATEGORY = "other";
const DEFAULT_CONFIDENCE_THRESHOLD = 50;
const DEFAULT_STALE_LOCK_MINUTES = 180;
const DEFAULT_PURPOSE = "explain";
const DEFAULT_AUDIENCE = "一般読者";
const DEFAULT_LENGTH = 1200;
const DEFAULT_BASE_DIR_NAME = "knowledge-base";
const ADAPTER_CONFIG_VERSION = 1;
const MAX_LABEL_LENGTH = 128;

/**
 * launchd Weekday contract for this project (DATA_CONTRACT):
 * 1=Sunday, 2=Monday, 3=Tuesday, 4=Wednesday, 5=Thursday, 6=Friday, 7=Saturday
 */
const WEEKDAY_MIN = 1;
const WEEKDAY_MAX = 7;

const FORBIDDEN_PLIST_KEYS = new Set([
  "KeepAlive",
  "StartInterval",
  "ThrottleInterval",
  "EnvironmentVariables",
]);

const SECRET_OPTION_RE = /key|token|secret|password|cookie|authorization/i;

function rejectControlOrEmpty(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} は空でない文字列である必要があります。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${fieldName} に制御文字は使えません。`);
  }
  return value.trim();
}

function validateLabel(label) {
  const trimmed = rejectControlOrEmpty(label, "label");
  if (/\s/.test(trimmed)) {
    throw new Error("label に空白は使えません。");
  }
  if (/[/\\]/.test(trimmed)) {
    throw new Error("label にパス区切りは使えません。");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("label に . または .. は使えません。");
  }
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
    throw new Error("label の先頭・末尾にピリオドは使えません。");
  }
  if (trimmed.includes("..")) {
    throw new Error("label に連続ピリオドは使えません。");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "label は英数字・ハイフン・アンダースコア・ピリオドのみ使用できます。"
    );
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`label は ${MAX_LABEL_LENGTH} 文字以内である必要があります。`);
  }
  return trimmed;
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

function validateHour(hour) {
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error("hour は 0〜23 の整数である必要があります。");
  }
  return n;
}

function validateMinute(minute) {
  const n = Number(minute);
  if (!Number.isInteger(n) || n < 0 || n > 59) {
    throw new Error("minute は 0〜59 の整数である必要があります。");
  }
  return n;
}

/**
 * Parse weekdays CSV. Deduplicates and sorts ascending.
 * Empty/null → null (daily).
 */
function normalizeWeekdays(weekdaysInput) {
  if (weekdaysInput == null || weekdaysInput === "") {
    return null;
  }
  const raw =
    typeof weekdaysInput === "string"
      ? weekdaysInput.split(",")
      : Array.isArray(weekdaysInput)
        ? weekdaysInput
        : null;
  if (!raw) {
    throw new Error("weekdays は CSV または配列である必要があります。");
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = String(item).trim();
    if (!s) continue;
    if (!/^\d+$/.test(s)) {
      throw new Error(`weekdays の値が不正です: ${s}`);
    }
    const n = Number(s);
    if (!Number.isInteger(n) || n < WEEKDAY_MIN || n > WEEKDAY_MAX) {
      throw new Error(
        `weekdays は ${WEEKDAY_MIN}〜${WEEKDAY_MAX} である必要があります: ${n}`
      );
    }
    if (seen.has(n)) {
      throw new Error(`weekdays に重複があります: ${n}`);
    }
    seen.add(n);
    out.push(n);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a - b);
  return out;
}

function isAbsolutePath(p) {
  if (typeof p !== "string") return false;
  if (p.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

function assertSafeArg(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} に空文字は使えません。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${fieldName} に制御文字は使えません。`);
  }
  if (SECRET_OPTION_RE.test(value) && value.startsWith("--")) {
    throw new Error(`秘密情報らしきオプションは拒否されます: ${value}`);
  }
  return value;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistString(value) {
  return `<string>${escapeXml(value)}</string>`;
}

function plistInteger(value) {
  return `<integer>${Number(value)}</integer>`;
}

function plistTrue() {
  return "<true/>";
}

function indent(level) {
  return "  ".repeat(level);
}

/**
 * Build StartCalendarInterval model.
 * Daily: single { Hour, Minute }
 * Weekdays: array of { Hour, Minute, Weekday }
 */
function buildScheduleModel(hour, minute, weekdays) {
  const h = validateHour(hour);
  const m = validateMinute(minute);
  if (!weekdays || weekdays.length === 0) {
    return { kind: "daily", hour: h, minute: m, intervals: [{ Hour: h, Minute: m }] };
  }
  const intervals = weekdays.map((wd) => ({
    Hour: h,
    Minute: m,
    Weekday: wd,
  }));
  return { kind: "weekdays", hour: h, minute: m, weekdays: [...weekdays], intervals };
}

/**
 * Build ProgramArguments array (deterministic order).
 */
function buildProgramArguments(paths, runnerOptions) {
  const args = [];
  args.push(assertSafeArg(paths.nodePath, "nodePath"));
  args.push(assertSafeArg(paths.dailyRunnerPath, "dailyRunnerPath"));
  args.push("run");
  args.push("--timezone", assertSafeArg(runnerOptions.timezone, "timezone"));
  args.push("--runs-dir", assertSafeArg(paths.runsDir, "runsDir"));
  args.push("--days", String(runnerOptions.days));
  args.push("--base-dir", assertSafeArg(paths.baseDir, "baseDir"));
  if (runnerOptions.planTitle) {
    args.push("--plan-title", assertSafeArg(runnerOptions.planTitle, "planTitle"));
  }
  if (runnerOptions.purpose) {
    args.push("--purpose", assertSafeArg(runnerOptions.purpose, "purpose"));
  }
  if (runnerOptions.audience) {
    args.push("--audience", assertSafeArg(runnerOptions.audience, "audience"));
  }
  if (runnerOptions.length != null) {
    args.push("--length", String(runnerOptions.length));
  }
  args.push("--category", assertSafeArg(runnerOptions.category, "category"));
  args.push(
    "--confidence-threshold",
    String(runnerOptions.confidenceThreshold)
  );
  if (runnerOptions.noApi) {
    args.push("--no-api");
  }
  if (runnerOptions.fromEnriched && !runnerOptions.noApi) {
    args.push("--from-enriched");
  }
  args.push(
    "--stale-lock-minutes",
    String(runnerOptions.staleLockMinutes)
  );

  for (const a of args) {
    assertSafeArg(a, "programArgument");
  }
  return args;
}

/**
 * Build in-memory plist model.
 */
function buildPlistModel({
  label,
  programArguments,
  workingDirectory,
  schedule,
  standardOutPath,
  standardErrorPath,
  runAtLoad = false,
}) {
  const model = {
    Label: label,
    ProgramArguments: [...programArguments],
    WorkingDirectory: workingDirectory,
    StartCalendarInterval:
      schedule.intervals.length === 1
        ? { ...schedule.intervals[0] }
        : schedule.intervals.map((i) => ({ ...i })),
    StandardOutPath: standardOutPath,
    StandardErrorPath: standardErrorPath,
    ProcessType: "Background",
  };
  if (runAtLoad === true) {
    model.RunAtLoad = true;
  }
  return model;
}

function renderCalendarIntervalXml(interval, level) {
  const lines = [];
  lines.push(`${indent(level)}<dict>`);
  const keys = Object.keys(interval).sort();
  // Deterministic key order: Hour, Minute, Weekday
  const order = ["Hour", "Minute", "Weekday"];
  for (const key of order) {
    if (interval[key] == null) continue;
    lines.push(`${indent(level + 1)}<key>${key}</key>`);
    lines.push(`${indent(level + 1)}${plistInteger(interval[key])}`);
  }
  lines.push(`${indent(level)}</dict>`);
  return lines;
}

/**
 * Render plist XML (deterministic, UTF-8).
 */
function renderPlistXml(model) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  );
  lines.push('<plist version="1.0">');
  lines.push("<dict>");

  lines.push(`${indent(1)}<key>Label</key>`);
  lines.push(`${indent(1)}${plistString(model.Label)}`);

  lines.push(`${indent(1)}<key>ProcessType</key>`);
  lines.push(`${indent(1)}${plistString(model.ProcessType)}`);

  lines.push(`${indent(1)}<key>ProgramArguments</key>`);
  lines.push(`${indent(1)}<array>`);
  for (const arg of model.ProgramArguments) {
    lines.push(`${indent(2)}${plistString(arg)}`);
  }
  lines.push(`${indent(1)}</array>`);

  if (model.RunAtLoad === true) {
    lines.push(`${indent(1)}<key>RunAtLoad</key>`);
    lines.push(`${indent(1)}${plistTrue()}`);
  }

  lines.push(`${indent(1)}<key>StandardErrorPath</key>`);
  lines.push(`${indent(1)}${plistString(model.StandardErrorPath)}`);

  lines.push(`${indent(1)}<key>StandardOutPath</key>`);
  lines.push(`${indent(1)}${plistString(model.StandardOutPath)}`);

  lines.push(`${indent(1)}<key>StartCalendarInterval</key>`);
  const intervals = Array.isArray(model.StartCalendarInterval)
    ? model.StartCalendarInterval
    : [model.StartCalendarInterval];
  if (intervals.length === 1) {
    lines.push(...renderCalendarIntervalXml(intervals[0], 1));
  } else {
    lines.push(`${indent(1)}<array>`);
    for (const interval of intervals) {
      lines.push(...renderCalendarIntervalXml(interval, 2));
    }
    lines.push(`${indent(1)}</array>`);
  }

  lines.push(`${indent(1)}<key>WorkingDirectory</key>`);
  lines.push(`${indent(1)}${plistString(model.WorkingDirectory)}`);

  lines.push("</dict>");
  lines.push("</plist>");
  lines.push("");
  return lines.join("\n");
}

function hashPlist(plistXml) {
  return crypto.createHash("sha256").update(plistXml, "utf8").digest("hex");
}

/**
 * Normalize launchd adapter options (pure; paths may still be relative until adapter resolves).
 */
function normalizeLaunchdOptions(raw = {}) {
  const errors = [];

  let label = DEFAULT_LABEL;
  try {
    if (raw.label != null) label = validateLabel(raw.label);
    else label = validateLabel(DEFAULT_LABEL);
  } catch (error) {
    errors.push(error.message);
  }

  let timezone = null;
  try {
    if (raw.timezone == null || !String(raw.timezone).trim()) {
      errors.push("timezone は必須です。");
    } else {
      timezone = validateTimezone(raw.timezone);
    }
  } catch (error) {
    errors.push(error.message);
  }

  let hour = null;
  let minute = null;
  try {
    if (raw.hour == null) errors.push("hour は必須です。");
    else hour = validateHour(raw.hour);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    if (raw.minute == null) errors.push("minute は必須です。");
    else minute = validateMinute(raw.minute);
  } catch (error) {
    errors.push(error.message);
  }

  let weekdays = null;
  try {
    weekdays = normalizeWeekdays(raw.weekdays);
  } catch (error) {
    errors.push(error.message);
  }

  let days = DEFAULT_DAYS;
  if (raw.days != null) {
    const n = Number(raw.days);
    if (!Number.isInteger(n) || n < 1) {
      errors.push("days は 1 以上の整数である必要があります。");
    } else days = n;
  }

  let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
  if (raw.confidenceThreshold != null) {
    const n = Number(raw.confidenceThreshold);
    if (!Number.isInteger(n) || n < 0) {
      errors.push("confidence-threshold は 0 以上の整数である必要があります。");
    } else confidenceThreshold = n;
  }

  let staleLockMinutes = DEFAULT_STALE_LOCK_MINUTES;
  if (raw.staleLockMinutes != null) {
    const n = Number(raw.staleLockMinutes);
    if (!Number.isInteger(n) || n < 1) {
      errors.push("stale-lock-minutes は 1 以上の整数である必要があります。");
    } else staleLockMinutes = n;
  }

  let length = DEFAULT_LENGTH;
  if (raw.length != null) {
    const n = Number(raw.length);
    if (!Number.isInteger(n) || n < 1) {
      errors.push("length は 1 以上の整数である必要があります。");
    } else length = n;
  }

  let category = DEFAULT_CATEGORY;
  try {
    if (raw.category != null) {
      category = rejectControlOrEmpty(raw.category, "category");
    }
  } catch (error) {
    errors.push(error.message);
  }

  if (errors.length > 0) {
    return { ok: false, options: null, errors };
  }

  const schedule = buildScheduleModel(hour, minute, weekdays);

  return {
    ok: true,
    options: {
      label,
      timezone,
      hour,
      minute,
      weekdays,
      schedule,
      nodePath: raw.nodePath || null,
      projectDir: raw.projectDir || null,
      runsDir: raw.runsDir || null,
      baseDir: raw.baseDir || null,
      logDir: raw.logDir || null,
      days,
      planTitle:
        typeof raw.planTitle === "string" && raw.planTitle.trim()
          ? raw.planTitle.trim()
          : null,
      purpose:
        typeof raw.purpose === "string" && raw.purpose.trim()
          ? raw.purpose.trim()
          : DEFAULT_PURPOSE,
      audience:
        typeof raw.audience === "string" && raw.audience.trim()
          ? raw.audience.trim()
          : DEFAULT_AUDIENCE,
      length,
      category,
      confidenceThreshold,
      noApi: raw.noApi === true || raw.fromEnriched === true,
      fromEnriched: raw.fromEnriched === true,
      staleLockMinutes,
      runAtLoad: raw.runAtLoad === true,
      replace: raw.replace === true,
    },
    errors: [],
  };
}

/**
 * Build path plan from absolute resolved paths (caller resolves).
 */
function buildPathPlan({
  label,
  projectDir,
  nodePath,
  runsDir,
  baseDir,
  logDir,
  launchAgentsDir,
}) {
  if (!isAbsolutePath(nodePath)) {
    throw new Error("nodePath は絶対パスである必要があります。");
  }
  if (!isAbsolutePath(projectDir)) {
    throw new Error("projectDir は絶対パスである必要があります。");
  }
  if (!isAbsolutePath(runsDir)) {
    throw new Error("runsDir は絶対パスである必要があります。");
  }
  if (!isAbsolutePath(baseDir)) {
    throw new Error("baseDir は絶対パスである必要があります。");
  }
  if (!isAbsolutePath(logDir)) {
    throw new Error("logDir は絶対パスである必要があります。");
  }
  if (!isAbsolutePath(launchAgentsDir)) {
    throw new Error("launchAgentsDir は絶対パスである必要があります。");
  }

  const validatedLabel = validateLabel(label);
  const dailyRunnerPath = joinPosix(projectDir, "daily-runner.js");
  const plistPath = joinPosix(launchAgentsDir, `${validatedLabel}.plist`);
  const configPath = joinPosix(
    projectDir,
    ".runtime",
    "launchd",
    `${validatedLabel}.json`
  );
  const stdoutLog = joinPosix(logDir, "daily-runner.stdout.log");
  const stderrLog = joinPosix(logDir, "daily-runner.stderr.log");

  return {
    label: validatedLabel,
    projectDir,
    nodePath,
    dailyRunnerPath,
    workingDirectory: projectDir,
    runsDir,
    baseDir,
    logDir,
    launchAgentsDir,
    plistPath,
    configPath,
    standardOutPath: stdoutLog,
    standardErrorPath: stderrLog,
  };
}

function joinPosix(...parts) {
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

function buildInstallPlan(options, paths) {
  const programArguments = buildProgramArguments(paths, {
    timezone: options.timezone,
    days: options.days,
    planTitle: options.planTitle,
    purpose: options.purpose,
    audience: options.audience,
    length: options.length,
    category: options.category,
    confidenceThreshold: options.confidenceThreshold,
    noApi: options.noApi,
    fromEnriched: options.fromEnriched,
    staleLockMinutes: options.staleLockMinutes,
  });

  const model = buildPlistModel({
    label: paths.label,
    programArguments,
    workingDirectory: paths.workingDirectory,
    schedule: options.schedule,
    standardOutPath: paths.standardOutPath,
    standardErrorPath: paths.standardErrorPath,
    runAtLoad: options.runAtLoad,
  });

  const plistXml = renderPlistXml(model);
  const plistHash = hashPlist(plistXml);

  const warnings = [];
  if (options.runAtLoad) {
    warnings.push("RunAtLoad=true のため load 直後に実行される可能性があります。");
  }
  if (!options.noApi) {
    warnings.push(
      "API / Chrome 接続が必要な場合があります。launchd は Chrome を自動起動しません。"
    );
  }

  return {
    action: "install",
    label: paths.label,
    plistPath: paths.plistPath,
    configPath: paths.configPath,
    nodePath: paths.nodePath,
    dailyRunnerPath: paths.dailyRunnerPath,
    workingDirectory: paths.workingDirectory,
    schedule: {
      hour: options.hour,
      minute: options.minute,
      weekdays: options.weekdays,
      kind: options.schedule.kind,
    },
    programArguments,
    logPaths: {
      standardOutPath: paths.standardOutPath,
      standardErrorPath: paths.standardErrorPath,
      logDir: paths.logDir,
    },
    runsDir: paths.runsDir,
    baseDir: paths.baseDir,
    plistHash,
    plistXml,
    plistModel: model,
    runAtLoad: options.runAtLoad === true,
    replace: options.replace === true,
    commands: [
      { name: "bootstrap", args: ["bootstrap", "gui/<uid>", paths.plistPath] },
      { name: "print", args: ["print", "gui/<uid>/<label>"] },
    ],
    warnings,
  };
}

function buildAdapterConfig(plan, installedAt) {
  return {
    version: ADAPTER_CONFIG_VERSION,
    label: plan.label,
    plistPath: plan.plistPath,
    projectDir: plan.workingDirectory,
    nodePath: plan.nodePath,
    dailyRunnerPath: plan.dailyRunnerPath,
    timezone: extractTimezoneFromArgs(plan.programArguments),
    schedule: plan.schedule,
    runsDir: plan.runsDir,
    logDir: plan.logPaths.logDir,
    runnerOptions: {
      days: extractFlagValue(plan.programArguments, "--days"),
      category: extractFlagValue(plan.programArguments, "--category"),
      confidenceThreshold: extractFlagValue(
        plan.programArguments,
        "--confidence-threshold"
      ),
      noApi: plan.programArguments.includes("--no-api"),
      fromEnriched: plan.programArguments.includes("--from-enriched"),
      staleLockMinutes: extractFlagValue(
        plan.programArguments,
        "--stale-lock-minutes"
      ),
    },
    installedAt: installedAt || null,
    plistHash: plan.plistHash,
  };
}

function extractFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function extractTimezoneFromArgs(args) {
  return extractFlagValue(args, "--timezone");
}

/**
 * Minimal structural validation of plist XML text.
 */
function validatePlistXml(plistXml) {
  const errors = [];
  if (typeof plistXml !== "string" || !plistXml.trim()) {
    return { ok: false, errors: ["plist が空です。"], extracted: null };
  }

  if (!plistXml.includes('<?xml version="1.0"')) {
    errors.push("XML declaration がありません。");
  }
  if (!plistXml.includes("<!DOCTYPE plist")) {
    errors.push("DOCTYPE plist がありません。");
  }
  if (!/<plist\b/.test(plistXml) || !plistXml.includes("</plist>")) {
    errors.push("plist root がありません。");
  }
  if (!plistXml.includes("<dict>") || !plistXml.includes("</dict>")) {
    errors.push("dict がありません。");
  }

  for (const key of FORBIDDEN_PLIST_KEYS) {
    if (plistXml.includes(`<key>${key}</key>`)) {
      errors.push(`禁止キーが含まれています: ${key}`);
    }
  }

  if (/sh\s+-c|bash\s+-c|zsh\s+-c/.test(plistXml)) {
    errors.push("shell コマンドらしき内容が含まれています。");
  }

  const label = extractPlistStringValue(plistXml, "Label");
  if (!label) errors.push("Label がありません。");
  else {
    try {
      validateLabel(label);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const workingDirectory = extractPlistStringValue(plistXml, "WorkingDirectory");
  if (!workingDirectory) errors.push("WorkingDirectory がありません。");
  else if (!isAbsolutePath(workingDirectory)) {
    errors.push("WorkingDirectory は絶対パスである必要があります。");
  }

  const stdout = extractPlistStringValue(plistXml, "StandardOutPath");
  const stderr = extractPlistStringValue(plistXml, "StandardErrorPath");
  if (!stdout) errors.push("StandardOutPath がありません。");
  if (!stderr) errors.push("StandardErrorPath がありません。");
  if (stdout && !isAbsolutePath(stdout)) {
    errors.push("StandardOutPath は絶対パスである必要があります。");
  }
  if (stderr && !isAbsolutePath(stderr)) {
    errors.push("StandardErrorPath は絶対パスである必要があります。");
  }

  const processType = extractPlistStringValue(plistXml, "ProcessType");
  if (!processType) errors.push("ProcessType がありません。");

  if (!plistXml.includes("<key>StartCalendarInterval</key>")) {
    errors.push("StartCalendarInterval がありません。");
  }
  if (!plistXml.includes("<key>ProgramArguments</key>")) {
    errors.push("ProgramArguments がありません。");
  }

  const programArgs = extractProgramArguments(plistXml);
  if (!programArgs || programArgs.length < 3) {
    errors.push("ProgramArguments が不足しています。");
  } else {
    if (!isAbsolutePath(programArgs[0])) {
      errors.push("ProgramArguments[0] (node) は絶対パスである必要があります。");
    }
    if (!isAbsolutePath(programArgs[1])) {
      errors.push(
        "ProgramArguments[1] (daily-runner.js) は絶対パスである必要があります。"
      );
    }
    if (!String(programArgs[1]).endsWith("daily-runner.js")) {
      errors.push("ProgramArguments[1] は daily-runner.js である必要があります。");
    }
    if (programArgs[2] !== "run") {
      errors.push('ProgramArguments に "run" サブコマンドがありません。');
    }
    for (const arg of programArgs) {
      if (SECRET_OPTION_RE.test(arg) && arg.startsWith("--")) {
        errors.push(`秘密情報らしき引数があります: ${arg}`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, extracted: null };
  }

  return {
    ok: true,
    errors: [],
    extracted: {
      label,
      workingDirectory,
      standardOutPath: stdout,
      standardErrorPath: stderr,
      processType,
      programArguments: programArgs,
      plistHash: hashPlist(plistXml),
    },
  };
}

function extractPlistStringValue(xml, key) {
  const re = new RegExp(
    `<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`
  );
  const match = re.exec(xml);
  if (!match) return null;
  return unescapeXml(match[1]);
}

function extractProgramArguments(xml) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
    xml
  );
  if (!block) return null;
  const args = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    args.push(unescapeXml(m[1]));
  }
  return args;
}

function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeStatusResult(input) {
  return {
    label: input.label || null,
    installed: input.installed === true,
    loaded: input.loaded === true,
    plistExists: input.plistExists === true,
    configExists: input.configExists === true,
    plistValid: input.plistValid === true,
    hashMatches: input.hashMatches === true,
    schedule: input.schedule || null,
    paths: input.paths || {},
    lastExitStatus:
      input.lastExitStatus === undefined ? null : input.lastExitStatus,
    launchctl: input.launchctl || {},
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
  };
}

function backupPlistName(label, nowIso) {
  const stamp = String(nowIso || new Date().toISOString()).replace(
    /[:.]/g,
    "-"
  );
  return `${validateLabel(label)}.plist.backup-${stamp}`;
}

module.exports = {
  DEFAULT_LABEL,
  DEFAULT_DAYS,
  DEFAULT_CATEGORY,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_STALE_LOCK_MINUTES,
  DEFAULT_PURPOSE,
  DEFAULT_AUDIENCE,
  DEFAULT_LENGTH,
  DEFAULT_BASE_DIR_NAME,
  ADAPTER_CONFIG_VERSION,
  WEEKDAY_MIN,
  WEEKDAY_MAX,
  validateLabel,
  validateTimezone,
  validateHour,
  validateMinute,
  normalizeWeekdays,
  normalizeLaunchdOptions,
  buildScheduleModel,
  buildProgramArguments,
  buildPlistModel,
  renderPlistXml,
  hashPlist,
  buildPathPlan,
  buildInstallPlan,
  buildAdapterConfig,
  validatePlistXml,
  normalizeStatusResult,
  backupPlistName,
  escapeXml,
  isAbsolutePath,
  joinPosix,
  SECRET_OPTION_RE,
};
