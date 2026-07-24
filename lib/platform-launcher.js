/**
 * DEV-001 — Platform Launcher (dev helper).
 * Starts Launcher → Editorial → Review as child processes; no HTTP server of its own.
 */
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn: defaultSpawn } = require("child_process");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_HEALTH_TIMEOUT_MS = 10000;
const DEFAULT_HEALTH_INTERVAL_MS = 200;
const DEFAULT_STOP_TIMEOUT_MS = 5000;

const ERROR_CODES = Object.freeze({
  PORT_ALREADY_IN_USE: "PORT_ALREADY_IN_USE",
  STARTUP_TIMEOUT: "STARTUP_TIMEOUT",
  STARTUP_FAILED: "STARTUP_FAILED",
  ALREADY_RUNNING: "ALREADY_RUNNING",
});

const SERVICES = Object.freeze([
  {
    id: "launcher",
    name: "Launcher",
    scriptRel: path.join("scripts", "launcher-dashboard.js"),
    port: 4173,
    url: "http://127.0.0.1:4173",
  },
  {
    id: "editorial",
    name: "Editorial",
    scriptRel: path.join("scripts", "editorial-dashboard.js"),
    port: 4174,
    url: "http://127.0.0.1:4174",
  },
  {
    id: "review",
    name: "Review",
    scriptRel: path.join("scripts", "aikido-review-dashboard.js"),
    port: 4175,
    url: "http://127.0.0.1:4175",
  },
]);

function defaultLogger() {
  return {
    info: (msg) => process.stdout.write(`${msg}\n`),
    error: (msg) => process.stderr.write(`${msg}\n`),
  };
}

/**
 * @param {number} port
 * @param {string} [host]
 * @param {object} [deps]
 * @returns {Promise<boolean>}
 */
function isPortInUse(port, host = DEFAULT_HOST, deps = {}) {
  const createServer = deps.createServer || net.createServer;
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve(true);
        return;
      }
      // Treat unexpected listen errors as occupied to be safe.
      resolve(true);
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    try {
      server.listen(port, host);
    } catch (_error) {
      resolve(true);
    }
  });
}

/**
 * @param {string} baseUrl
 * @param {object} [deps]
 * @returns {Promise<boolean>}
 */
function defaultHealthCheck(baseUrl, deps = {}) {
  const request = deps.request || http.request;
  const timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : 1500;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const target = new URL("/health", baseUrl);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "GET",
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (_error) {
              json = null;
            }
            done(res.statusCode === 200 && json && json.ok === true);
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
      req.end();
    } catch (_error) {
      done(false);
    }
  });
}

function sleep(ms, deps = {}) {
  const wait = deps.setTimeout || setTimeout;
  return new Promise((resolve) => wait(resolve, ms));
}

/**
 * @param {object} [options]
 * @param {function} [options.spawn]
 * @param {function} [options.healthCheck]
 * @param {object} [options.logger]
 * @param {string} [options.rootDir]
 * @param {number} [options.healthTimeoutMs]
 * @param {number} [options.healthIntervalMs]
 * @param {function} [options.isPortInUse]
 * @param {function} [options.now]
 * @param {object[]} [options.services]
 */
function createPlatformLauncher(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const spawnFn = options.spawn || defaultSpawn;
  const healthCheck = options.healthCheck || defaultHealthCheck;
  const logger = options.logger || defaultLogger();
  const portCheck = options.isPortInUse || isPortInUse;
  const healthTimeoutMs =
    options.healthTimeoutMs != null
      ? Number(options.healthTimeoutMs)
      : DEFAULT_HEALTH_TIMEOUT_MS;
  const healthIntervalMs =
    options.healthIntervalMs != null
      ? Number(options.healthIntervalMs)
      : DEFAULT_HEALTH_INTERVAL_MS;
  const stopTimeoutMs =
    options.stopTimeoutMs != null
      ? Number(options.stopTimeoutMs)
      : DEFAULT_STOP_TIMEOUT_MS;
  const services = Array.isArray(options.services)
    ? options.services.slice()
    : SERVICES.map((s) => ({ ...s }));

  /** @type {{ service: object, child: object }[]} */
  let running = [];
  let starting = false;
  let stopping = false;
  let started = false;

  async function waitForHealth(service) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < healthTimeoutMs) {
      const ok = await healthCheck(service.url, options.healthDeps || {});
      if (ok) return true;
      await sleep(healthIntervalMs, options);
    }
    const err = new Error(
      `Health check timed out for ${service.name} (${service.url}/health)`
    );
    err.code = ERROR_CODES.STARTUP_TIMEOUT;
    err.service = service.name;
    throw err;
  }

  async function assertPortsFree() {
    for (const service of services) {
      const inUse = await portCheck(service.port, DEFAULT_HOST, options.portDeps);
      if (inUse) {
        const err = new Error(
          `Port ${service.port} is already in use (${service.name}).`
        );
        err.code = ERROR_CODES.PORT_ALREADY_IN_USE;
        err.port = service.port;
        err.service = service.name;
        throw err;
      }
    }
  }

  function spawnService(service) {
    const scriptPath = path.join(rootDir, service.scriptRel);
    const child = spawnFn(process.execPath, [scriptPath], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
      shell: false,
    });
    return child;
  }

  function trackChild(service, child) {
    const entry = { service, child };
    running.push(entry);

    const onExit = (code, signal) => {
      if (stopping || starting) return;
      // Unexpected exit after platform is ready — no restart.
      const idx = running.indexOf(entry);
      if (idx >= 0) running.splice(idx, 1);
      if (typeof logger.error === "function") {
        logger.error(
          `ERROR ${service.name} exited unexpectedly` +
            (signal ? ` signal=${signal}` : "") +
            (code != null ? ` code=${code}` : "")
        );
      }
      if (!stopping) {
        stop().catch(() => {});
      }
    };
    if (typeof child.on === "function") {
      child.on("exit", onExit);
      child.on("error", (error) => {
        if (stopping) return;
        if (typeof logger.error === "function") {
          logger.error(
            `ERROR ${service.name}: ${
              error && error.message ? error.message : String(error)
            }`
          );
        }
      });
    }
    return entry;
  }

  async function startOne(service) {
    if (typeof logger.info === "function") {
      logger.info(`${service.name} ...`);
    }
    let child;
    try {
      child = spawnService(service);
    } catch (error) {
      const err = new Error(
        `Failed to start ${service.name}: ${
          error && error.message ? error.message : String(error)
        }`
      );
      err.code = ERROR_CODES.STARTUP_FAILED;
      err.service = service.name;
      err.cause = error;
      throw err;
    }

    trackChild(service, child);

    // If process exits before health, fail fast.
    let earlyExit = null;
    const onEarlyExit = (code, signal) => {
      earlyExit = { code, signal };
    };
    if (typeof child.once === "function") {
      child.once("exit", onEarlyExit);
    }

    try {
      await waitForHealth(service);
    } catch (error) {
      if (typeof child.removeListener === "function") {
        child.removeListener("exit", onEarlyExit);
      }
      throw error;
    }

    if (typeof child.removeListener === "function") {
      child.removeListener("exit", onEarlyExit);
    }

    if (earlyExit) {
      const err = new Error(
        `${service.name} exited before becoming healthy` +
          (earlyExit.signal ? ` signal=${earlyExit.signal}` : "") +
          (earlyExit.code != null ? ` code=${earlyExit.code}` : "")
      );
      err.code = ERROR_CODES.STARTUP_FAILED;
      err.service = service.name;
      throw err;
    }

    if (typeof logger.info === "function") {
      logger.info(`${service.name} ... OK`);
    }
  }

  /**
   * Stop children in reverse start order: Review → Editorial → Launcher.
   */
  async function stop() {
    if (stopping) return { ok: true, stopped: [] };
    stopping = true;
    started = false;
    if (typeof logger.info === "function") {
      logger.info("STOP");
    }

    const order = running.slice().reverse();
    const stopped = [];

    for (const entry of order) {
      const { service, child } = entry;
      try {
        await killChild(child, stopTimeoutMs, options);
        stopped.push(service.name);
      } catch (_error) {
        // continue stopping others
      }
    }
    running = [];
    stopping = false;
    starting = false;
    return { ok: true, stopped };
  }

  async function start() {
    if (started || starting) {
      const err = new Error("Platform is already running.");
      err.code = ERROR_CODES.ALREADY_RUNNING;
      throw err;
    }
    starting = true;
    running = [];

    if (typeof logger.info === "function") {
      logger.info("START");
      logger.info("Starting Platform...");
    }

    try {
      await assertPortsFree();

      for (const service of services) {
        await startOne(service);
      }

      started = true;
      starting = false;
      if (typeof logger.info === "function") {
        logger.info("READY");
        logger.info("Platform Ready");
        logger.info("http://127.0.0.1:4173");
      }
      return {
        ok: true,
        url: "http://127.0.0.1:4173",
        services: services.map((s) => ({
          name: s.name,
          port: s.port,
          url: s.url,
        })),
      };
    } catch (error) {
      starting = false;
      if (typeof logger.error === "function") {
        logger.error(
          `ERROR ${error && error.code ? error.code : "STARTUP_FAILED"}: ${
            error && error.message ? error.message : String(error)
          }`
        );
      }
      await stop();
      throw error;
    }
  }

  function getRunning() {
    return running.map((r) => ({
      name: r.service.name,
      port: r.service.port,
      pid: r.child && r.child.pid != null ? r.child.pid : null,
    }));
  }

  return {
    start,
    stop,
    getRunning,
    isStarted: () => started,
    services,
    ERROR_CODES,
  };
}

/**
 * @param {object} child
 * @param {number} timeoutMs
 * @param {object} [deps]
 */
function killChild(child, timeoutMs, deps = {}) {
  const wait = deps.setTimeout || setTimeout;
  const clear = deps.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    if (typeof child.once === "function") {
      child.once("exit", finish);
    }

    try {
      if (typeof child.kill === "function") {
        child.kill("SIGTERM");
      }
    } catch (_error) {
      finish();
      return;
    }

    const timer = wait(() => {
      try {
        if (typeof child.kill === "function") child.kill("SIGKILL");
      } catch (_error) {
        // ignore
      }
      finish();
    }, timeoutMs);

    if (typeof child.once === "function") {
      child.once("exit", () => clear(timer));
    }
  });
}

/**
 * Wire SIGINT/SIGTERM to stop(); used by CLI.
 * @param {ReturnType<typeof createPlatformLauncher>} launcher
 * @param {object} [deps]
 */
function installSignalHandlers(launcher, deps = {}) {
  const proc = deps.process || process;
  let handling = false;
  const handler = async () => {
    if (handling) return;
    handling = true;
    try {
      await launcher.stop();
    } catch (_error) {
      // ignore
    }
    proc.exit(0);
  };
  proc.on("SIGINT", handler);
  proc.on("SIGTERM", handler);
  return () => {
    proc.removeListener("SIGINT", handler);
    proc.removeListener("SIGTERM", handler);
  };
}

module.exports = {
  SERVICES,
  ERROR_CODES,
  DEFAULT_HOST,
  DEFAULT_HEALTH_TIMEOUT_MS,
  createPlatformLauncher,
  isPortInUse,
  defaultHealthCheck,
  installSignalHandlers,
  killChild,
};
