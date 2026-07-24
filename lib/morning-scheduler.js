/**
 * EP-047 — Morning Pipeline launchd scheduler (macOS user agent).
 * Does not modify Morning Pipeline. No sudo. No secrets in plist.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const {
  buildPlistModel,
  renderPlistXml,
  hashPlist,
  validateHour,
  validateMinute,
  validateTimezone,
  validateLabel,
} = require("./launchd-core");

const DEFAULT_LABEL = "com.x-timeline-collector.morning-pipeline";
const DEFAULT_HOUR = 7;
const DEFAULT_MINUTE = 0;
const DEFAULT_TIMEZONE = "Asia/Tokyo";
const PLIST_DIR_REL = path.join(".pipeline-work", "launchd");
const PLIST_BASENAME = `${DEFAULT_LABEL}.plist`;

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

function resolveNodePath(nodePath) {
  const candidate = nodePath || process.execPath;
  if (!path.isAbsolute(candidate)) {
    throw new Error(`node path must be absolute: ${candidate}`);
  }
  return candidate;
}

function guiDomain(uid = typeof process.getuid === "function" ? process.getuid() : 501) {
  return `gui/${uid}`;
}

/**
 * @param {object} [options]
 */
function buildMorningSchedulerPlan(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const label = validateLabel(options.label || DEFAULT_LABEL);
  const hour = validateHour(
    options.hour == null ? DEFAULT_HOUR : options.hour
  );
  const minute = validateMinute(
    options.minute == null ? DEFAULT_MINUTE : options.minute
  );
  const timezone = validateTimezone(options.timezone || DEFAULT_TIMEZONE);
  const nodePath = resolveNodePath(options.nodePath);
  const pipelineScript = path.join(rootDir, "scripts", "morning-pipeline.js");
  const plistDir = path.join(rootDir, PLIST_DIR_REL);
  const plistPath = path.join(plistDir, `${label}.plist`);
  const stdoutPath = path.join(plistDir, "morning.stdout.log");
  const stderrPath = path.join(plistDir, "morning.stderr.log");
  const launchAgentsPlist = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`
  );

  // Equivalent to `npm run morning` (absolute node + pipeline script for launchd).
  const programArguments = [nodePath, pipelineScript];
  const model = buildPlistModel({
    label,
    programArguments,
    workingDirectory: rootDir,
    schedule: { intervals: [{ Hour: hour, Minute: minute }] },
    standardOutPath: stdoutPath,
    standardErrorPath: stderrPath,
    runAtLoad: false,
  });
  const plistXml = renderPlistXml(model);
  const plistHash = hashPlist(plistXml);

  return {
    label,
    hour,
    minute,
    timezone,
    rootDir,
    nodePath,
    pipelineScript,
    programArguments,
    plistDir,
    plistPath,
    launchAgentsPlist,
    stdoutPath,
    stderrPath,
    plistXml,
    plistHash,
    npmEquivalent: "npm run morning",
  };
}

function runLaunchctl(args, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  return spawn("launchctl", args, {
    encoding: "utf8",
  });
}

function assertDarwin(platform = process.platform) {
  if (platform !== "darwin") {
    const err = new Error(
      "Morning scheduler supports macOS launchd only (darwin)."
    );
    err.code = "scheduler-os";
    err.exitCode = 3;
    throw err;
  }
}

function ensureDir(dir, mkdirSync = fs.mkdirSync) {
  mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(filePath, contents, writeFileSync = fs.writeFileSync) {
  writeFileSync(filePath, contents, "utf8");
}

/**
 * Install / refresh LaunchAgent. Idempotent when content unchanged.
 */
function installMorningScheduler(options = {}, deps = {}) {
  assertDarwin(deps.platform || process.platform);
  const plan = buildMorningSchedulerPlan(options);
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const copyFileSync = deps.copyFileSync || fs.copyFileSync;
  const log = deps.log || ((line) => process.stdout.write(`${line}\n`));

  ensureDir(plan.plistDir, mkdirSync);
  ensureDir(path.dirname(plan.launchAgentsPlist), mkdirSync);

  let previousHash = null;
  if (existsSync(plan.plistPath)) {
    previousHash = hashPlist(readFileSync(plan.plistPath, "utf8"));
  }

  const sameContent = previousHash === plan.plistHash;
  if (!sameContent) {
    writeFileAtomic(plan.plistPath, plan.plistXml, writeFileSync);
  }
  // Keep LaunchAgents copy in sync (launchd discovery path).
  copyFileSync(plan.plistPath, plan.launchAgentsPlist);

  const domain = guiDomain(deps.uid);
  const launchctl = deps.runLaunchctl || runLaunchctl;

  // Unload first if loaded (ignore errors) to avoid duplicate registration.
  launchctl(["bootout", domain, plan.launchAgentsPlist], deps);
  const bootstrap = launchctl(
    ["bootstrap", domain, plan.launchAgentsPlist],
    deps
  );
  if (bootstrap.error || (bootstrap.status != null && bootstrap.status !== 0)) {
    const err = new Error(
      `launchctl bootstrap failed (exit ${bootstrap.status}): ${String(
        bootstrap.stderr || bootstrap.stdout || bootstrap.error || ""
      ).trim()}`
    );
    err.code = "scheduler-launchctl";
    err.exitCode = 6;
    err.result = bootstrap;
    throw err;
  }

  log(
    `[scheduler] installed ${plan.label} at ${String(plan.hour).padStart(2, "0")}:${String(plan.minute).padStart(2, "0")} (${plan.timezone})`
  );
  log(`[scheduler] runs: ${plan.npmEquivalent}`);
  log(`[scheduler] plist: ${plan.plistPath}`);
  log(`[scheduler] agent: ${plan.launchAgentsPlist}`);

  return {
    ok: true,
    status: sameContent ? "refreshed" : "installed",
    plan,
  };
}

/**
 * Uninstall LaunchAgent. OK if not registered.
 */
function uninstallMorningScheduler(options = {}, deps = {}) {
  assertDarwin(deps.platform || process.platform);
  const plan = buildMorningSchedulerPlan(options);
  const existsSync = deps.existsSync || fs.existsSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;
  const log = deps.log || ((line) => process.stdout.write(`${line}\n`));
  const domain = guiDomain(deps.uid);
  const launchctl = deps.runLaunchctl || runLaunchctl;

  const bootout = launchctl(
    ["bootout", domain, plan.launchAgentsPlist],
    deps
  );
  // bootout non-zero when not loaded — treat as success
  if (existsSync(plan.launchAgentsPlist)) {
    try {
      unlinkSync(plan.launchAgentsPlist);
    } catch (_error) {
      // ignore
    }
  }
  // Keep generated project plist for inspection; optional remove
  if (options.removeGenerated === true && existsSync(plan.plistPath)) {
    try {
      unlinkSync(plan.plistPath);
    } catch (_error) {
      // ignore
    }
  }

  log(`[scheduler] uninstalled ${plan.label}`);
  if (bootout.status !== 0 && !bootout.error) {
    log("[scheduler] (was not loaded — ok)");
  }
  return { ok: true, plan, bootout };
}

/**
 * Status of LaunchAgent registration.
 */
function statusMorningScheduler(options = {}, deps = {}) {
  assertDarwin(deps.platform || process.platform);
  const plan = buildMorningSchedulerPlan(options);
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const domain = guiDomain(deps.uid);
  const launchctl = deps.runLaunchctl || runLaunchctl;

  const agentExists = existsSync(plan.launchAgentsPlist);
  const generatedExists = existsSync(plan.plistPath);
  let hashMatch = null;
  if (generatedExists && agentExists) {
    const a = hashPlist(readFileSync(plan.plistPath, "utf8"));
    const b = hashPlist(readFileSync(plan.launchAgentsPlist, "utf8"));
    hashMatch = a === b;
  }

  const print = launchctl(["print", `${domain}/${plan.label}`], deps);
  const loaded = print.status === 0;

  return {
    ok: true,
    label: plan.label,
    hour: plan.hour,
    minute: plan.minute,
    timezone: plan.timezone,
    npmEquivalent: plan.npmEquivalent,
    plistPath: plan.plistPath,
    launchAgentsPlist: plan.launchAgentsPlist,
    generatedExists,
    agentExists,
    hashMatch,
    loaded,
    schedule: `${String(plan.hour).padStart(2, "0")}:${String(plan.minute).padStart(2, "0")} ${plan.timezone} daily`,
  };
}

function formatStatusReport(status) {
  const lines = [];
  lines.push("Morning Scheduler Status");
  lines.push("");
  lines.push(`Label:     ${status.label}`);
  lines.push(`Schedule:  ${status.schedule}`);
  lines.push(`Command:   ${status.npmEquivalent}`);
  lines.push(`Loaded:    ${status.loaded ? "yes" : "no"}`);
  lines.push(`Agent:     ${status.agentExists ? "yes" : "no"} (${status.launchAgentsPlist})`);
  lines.push(
    `Generated: ${status.generatedExists ? "yes" : "no"} (${status.plistPath})`
  );
  if (status.hashMatch != null) {
    lines.push(`In sync:   ${status.hashMatch ? "yes" : "no"}`);
  }
  lines.push("");
  return lines.join("\n");
}

function parseSchedulerArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = {
    help: false,
    hour: DEFAULT_HOUR,
    minute: DEFAULT_MINUTE,
    timezone: DEFAULT_TIMEZONE,
    label: DEFAULT_LABEL,
    rootDir: process.cwd(),
    nodePath: process.execPath,
  };
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--hour") {
      options.hour = Number(list[++i]);
      continue;
    }
    if (token === "--minute") {
      options.minute = Number(list[++i]);
      continue;
    }
    if (token === "--timezone") {
      options.timezone = list[++i];
      continue;
    }
    if (token === "--label") {
      options.label = list[++i];
      continue;
    }
    if (token === "--project-dir") {
      options.rootDir = list[++i];
      continue;
    }
    if (token === "--node") {
      options.nodePath = list[++i];
      continue;
    }
    const err = new Error(`Unknown option: ${token}`);
    err.code = "scheduler-parse";
    throw err;
  }
  return options;
}

function printSchedulerHelp(command) {
  return `Morning Scheduler (${command})

Usage:
  npm run scheduler:install -- [--hour 7] [--minute 0] [--timezone Asia/Tokyo]
  npm run scheduler:uninstall
  npm run scheduler:status

Default: daily 07:00 Asia/Tokyo → npm run morning (via morning-pipeline.js)

Plist generated under: ${PLIST_DIR_REL}/
LaunchAgent: ~/Library/LaunchAgents/${DEFAULT_LABEL}.plist
`;
}

module.exports = {
  DEFAULT_LABEL,
  DEFAULT_HOUR,
  DEFAULT_MINUTE,
  DEFAULT_TIMEZONE,
  PLIST_DIR_REL,
  PLIST_BASENAME,
  buildMorningSchedulerPlan,
  installMorningScheduler,
  uninstallMorningScheduler,
  statusMorningScheduler,
  formatStatusReport,
  parseSchedulerArgs,
  printSchedulerHelp,
  guiDomain,
  resolveRoot,
};
