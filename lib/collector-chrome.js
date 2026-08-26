/**
 * Dedicated collector Chrome only:
 *   --remote-debugging-port=9222
 *   --user-data-dir=~/x-timeline-chrome (resolved via os.homedir() at runtime)
 *
 * Never killall. Never touch the everyday Chrome profile.
 */

const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { sleepSync } = require("./morning-collect-policy");

const COLLECTOR_USER_DATA_DIR_NAME = "x-timeline-chrome";
const DEFAULT_CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_CDP_URL = "http://localhost:9222";

function defaultCollectorUserDataDir() {
  return path.join(os.homedir(), COLLECTOR_USER_DATA_DIR_NAME);
}

function resolveCollectorUserDataDir(env = process.env, explicit) {
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).trim();
  }
  const raw = env && env.COLLECTOR_CHROME_USER_DATA_DIR;
  if (raw != null && String(raw).trim()) return String(raw).trim();
  return defaultCollectorUserDataDir();
}

function resolveChromeBin(env = process.env, explicit) {
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).trim();
  }
  const raw = env && env.COLLECTOR_CHROME_BIN;
  if (raw != null && String(raw).trim()) return String(raw).trim();
  return DEFAULT_CHROME_BIN;
}

function resolveCdpPort(env = process.env, explicit) {
  if (explicit != null && Number.isFinite(Number(explicit))) {
    return Math.floor(Number(explicit));
  }
  const raw = env && env.COLLECTOR_CDP_PORT;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_CDP_PORT;
}

function resolveCdpUrl(env = process.env, explicit) {
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).trim().replace(/\/$/, "");
  }
  const raw = env && env.COLLECTOR_CDP_URL;
  if (raw != null && String(raw).trim()) {
    return String(raw).trim().replace(/\/$/, "");
  }
  return `${DEFAULT_CDP_URL.replace(/\/$/, "")}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandHasExactUserDataDir(command, userDataDir) {
  const dir = String(userDataDir || "").trim();
  if (!dir) return false;
  const re = new RegExp(
    `--user-data-dir(?:=|\\s+)["']?${escapeRegExp(dir)}["']?(?=\\s|$)`
  );
  return re.test(String(command || ""));
}

function isChromeLikeCommand(command) {
  const c = String(command || "");
  if (/killall/i.test(c)) return false;
  if (/Google Chrome/i.test(c)) return true;
  if (/Chromium/i.test(c) && !/\bnode\b/i.test(c)) return true;
  return false;
}

function isDedicatedCollectorChromeCommand(command, userDataDir) {
  return (
    isChromeLikeCommand(command) &&
    commandHasExactUserDataDir(command, userDataDir)
  );
}

function parsePsOutput(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    entries.push({ pid, command: m[2] });
  }
  return entries;
}

function listProcessEntries(deps = {}) {
  if (typeof deps.listProcesses === "function") {
    const listed = deps.listProcesses();
    return Array.isArray(listed) ? listed : [];
  }
  const spawnFn = deps.spawnSync || spawnSync;
  const result = spawnFn("ps", ["-ax", "-o", "pid=", "-o", "command="], {
    encoding: "utf8",
  });
  if (result && result.error) {
    throw result.error;
  }
  return parsePsOutput(result && result.stdout);
}

function listDedicatedCollectorChromeProcesses(deps = {}) {
  const userDataDir = resolveCollectorUserDataDir(
    deps.env || process.env,
    deps.userDataDir
  );
  return listProcessEntries(deps).filter((entry) =>
    isDedicatedCollectorChromeCommand(entry && entry.command, userDataDir)
  );
}

function sleepMs(ms, deps = {}) {
  sleepSync(ms, deps);
}

function killPid(pid, signal, deps = {}) {
  if (typeof deps.kill === "function") {
    deps.kill(pid, signal);
    return;
  }
  process.kill(pid, signal);
}

/**
 * SIGTERM then SIGKILL only PIDs whose command has the dedicated user-data-dir.
 * Never uses killall. Never kills the current Node process.
 */
function killDedicatedCollectorChrome(deps = {}) {
  const selfPid = process.pid;
  const term = listDedicatedCollectorChromeProcesses(deps);
  const killed = [];
  const seen = new Set();

  const signalAll = (entries, signal) => {
    for (const entry of entries) {
      const pid = entry && entry.pid;
      if (!Number.isFinite(pid) || pid <= 0 || pid === selfPid) continue;
      if (seen.has(pid) && signal === "SIGTERM") continue;
      try {
        killPid(pid, signal, deps);
        if (!seen.has(pid)) {
          killed.push(pid);
          seen.add(pid);
        }
      } catch (error) {
        if (error && error.code === "ESRCH") continue;
        throw error;
      }
    }
  };

  signalAll(term, "SIGTERM");
  sleepMs(deps.termWaitMs != null ? deps.termWaitMs : 400, deps);
  const remaining = listDedicatedCollectorChromeProcesses(deps);
  signalAll(remaining, "SIGKILL");
  return {
    userDataDir: resolveCollectorUserDataDir(
      deps.env || process.env,
      deps.userDataDir
    ),
    pids: killed.slice(),
  };
}

function launchDedicatedCollectorChrome(deps = {}) {
  const env = deps.env || process.env;
  const bin = resolveChromeBin(env, deps.chromeBin);
  const userDataDir = resolveCollectorUserDataDir(env, deps.userDataDir);
  const port = resolveCdpPort(env, deps.cdpPort);
  if (/killall/i.test(bin)) {
    throw new Error("killall is forbidden for collector Chrome restart");
  }
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
  ];
  if (typeof deps.spawnChrome === "function") {
    return deps.spawnChrome(bin, args);
  }
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
  });
  if (typeof child.unref === "function") child.unref();
  return child;
}

/**
 * Restart only the dedicated collector Chrome, then wait a short time.
 */
function restartDedicatedCollectorChrome(deps = {}) {
  const killed = killDedicatedCollectorChrome(deps);
  const waitMs =
    deps.restartWaitMs != null ? Number(deps.restartWaitMs) : 8000;
  sleepMs(waitMs, deps);
  launchDedicatedCollectorChrome(deps);
  return {
    chromeRestarted: true,
    userDataDir: killed.userDataDir,
    killedPids: killed.pids,
  };
}

module.exports = {
  COLLECTOR_USER_DATA_DIR_NAME,
  defaultCollectorUserDataDir,
  DEFAULT_CHROME_BIN,
  DEFAULT_CDP_PORT,
  DEFAULT_CDP_URL,
  resolveCollectorUserDataDir,
  resolveChromeBin,
  resolveCdpPort,
  resolveCdpUrl,
  commandHasExactUserDataDir,
  isChromeLikeCommand,
  isDedicatedCollectorChromeCommand,
  parsePsOutput,
  listProcessEntries,
  listDedicatedCollectorChromeProcesses,
  killDedicatedCollectorChrome,
  launchDedicatedCollectorChrome,
  restartDedicatedCollectorChrome,
};
