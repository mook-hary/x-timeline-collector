/**
 * Short Collect preflight + one dedicated-Chrome restart for transient CDP hangs.
 * Does not touch the everyday Chrome profile. Infinite retry is forbidden.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { AUTH_ERROR, assessXSession } = require("./x-collector-health");
const {
  resolveCdpUrl,
  restartDedicatedCollectorChrome,
} = require("./collector-chrome");

const PREFLIGHT_JSON_PREFIX = "COLLECTOR_PREFLIGHT_JSON:";

const CDP_NOT_AVAILABLE = "CDP_NOT_AVAILABLE";
const CDP_CONNECT_TIMEOUT = "CDP_CONNECT_TIMEOUT";
const CDP_CONTEXT_TIMEOUT = "CDP_CONTEXT_TIMEOUT";
const X_HOME_UNAVAILABLE = "X_HOME_UNAVAILABLE";
const X_AUTH_REQUIRED = AUTH_ERROR;

const RESTARTABLE_CODES = new Set([
  CDP_NOT_AVAILABLE,
  CDP_CONNECT_TIMEOUT,
  CDP_CONTEXT_TIMEOUT,
  X_HOME_UNAVAILABLE,
]);

const DEFAULT_CDP_HTTP_TIMEOUT_MS = 5 * 1000;
const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_X_HOME_TIMEOUT_MS = 20 * 1000;
const DEFAULT_CHROME_RESTART_WAIT_MS = 8 * 1000;
const MAX_CHROME_RESTARTS = 1;

function resolveTimeoutMs(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolvePreflightTimeouts(env = process.env, overrides = {}) {
  return {
    cdpHttpMs: resolveTimeoutMs(
      overrides.cdpHttpMs != null
        ? overrides.cdpHttpMs
        : env && env.MORNING_CDP_HTTP_TIMEOUT_MS,
      DEFAULT_CDP_HTTP_TIMEOUT_MS
    ),
    cdpConnectMs: resolveTimeoutMs(
      overrides.cdpConnectMs != null
        ? overrides.cdpConnectMs
        : env && env.MORNING_CDP_CONNECT_TIMEOUT_MS,
      DEFAULT_CDP_CONNECT_TIMEOUT_MS
    ),
    xHomeMs: resolveTimeoutMs(
      overrides.xHomeMs != null
        ? overrides.xHomeMs
        : env && env.MORNING_X_HOME_TIMEOUT_MS,
      DEFAULT_X_HOME_TIMEOUT_MS
    ),
    restartWaitMs: resolveTimeoutMs(
      overrides.restartWaitMs != null
        ? overrides.restartWaitMs
        : env && env.COLLECTOR_CHROME_RESTART_WAIT_MS,
      DEFAULT_CHROME_RESTART_WAIT_MS
    ),
  };
}

function isRestartablePreflightError(code) {
  return RESTARTABLE_CODES.has(String(code || ""));
}

function codedError(code, cause) {
  const err = new Error(code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function isXHomePage(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com\/home(\/|\?|$)/.test(url || "");
}

function isXPage(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com(\/|$)/.test(url || "");
}

function pageUrl(page) {
  if (!page) return "";
  if (typeof page.url === "function") return String(page.url() || "");
  return String(page.url || "");
}

async function withTimeout(work, timeoutMs, code) {
  const ms = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(typeof work === "function" ? work() : work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codedError(code)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultFetchJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      done(codedError(CDP_NOT_AVAILABLE, error));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            done(codedError(CDP_NOT_AVAILABLE));
            return;
          }
          try {
            done(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            done(codedError(CDP_NOT_AVAILABLE, error));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      done(codedError(CDP_NOT_AVAILABLE));
    });
    req.on("error", (error) => done(codedError(CDP_NOT_AVAILABLE, error)));
    req.end();
  });
}

async function checkCdpHttp(deps = {}) {
  const cdpUrl = resolveCdpUrl(deps.env || process.env, deps.cdpUrl);
  const timeoutMs =
    deps.timeouts && deps.timeouts.cdpHttpMs != null
      ? deps.timeouts.cdpHttpMs
      : DEFAULT_CDP_HTTP_TIMEOUT_MS;
  const versionUrl = `${cdpUrl.replace(/\/$/, "")}/json/version`;
  const fetchJson =
    typeof deps.fetchJson === "function"
      ? deps.fetchJson
      : (url) => defaultFetchJson(url, timeoutMs);
  let json;
  try {
    json = await withTimeout(
      fetchJson(versionUrl),
      timeoutMs,
      CDP_NOT_AVAILABLE
    );
  } catch (error) {
    throw error && error.code === CDP_NOT_AVAILABLE
      ? error
      : codedError(CDP_NOT_AVAILABLE, error);
  }
  const ws =
    json &&
    (json.webSocketDebuggerUrl || json.webSocketUrl || json.websocketDebuggerUrl);
  if (!json || typeof json !== "object" || !ws) {
    throw codedError(CDP_NOT_AVAILABLE);
  }
  return { cdpUrl, version: json, webSocketDebuggerUrl: String(ws) };
}

async function defaultConnectOverCDP(cdpUrl, options) {
  const { chromium } = require("playwright");
  return chromium.connectOverCDP(cdpUrl, options);
}

function safeDisconnect(browser) {
  if (!browser || typeof browser.disconnect !== "function") return;
  try {
    browser.disconnect();
  } catch (_error) {
    /* leave Chrome running */
  }
}

async function checkPlaywrightCdp(deps = {}, cdpUrl) {
  const timeoutMs =
    deps.timeouts && deps.timeouts.cdpConnectMs != null
      ? deps.timeouts.cdpConnectMs
      : DEFAULT_CDP_CONNECT_TIMEOUT_MS;
  const connect =
    typeof deps.connectOverCDP === "function"
      ? deps.connectOverCDP
      : defaultConnectOverCDP;
  try {
    return await withTimeout(
      connect(cdpUrl, { noDefaults: true, timeout: timeoutMs }),
      timeoutMs,
      CDP_CONNECT_TIMEOUT
    );
  } catch (error) {
    if (error && error.code === CDP_CONNECT_TIMEOUT) throw error;
    const msg = String((error && error.message) || error || "");
    if (/timeout|timed out/i.test(msg)) throw codedError(CDP_CONNECT_TIMEOUT, error);
    throw codedError(CDP_NOT_AVAILABLE, error);
  }
}

async function checkContexts(browser, timeoutMs) {
  try {
    const contexts = await withTimeout(
      Promise.resolve().then(() =>
        typeof browser.contexts === "function" ? browser.contexts() : []
      ),
      timeoutMs,
      CDP_CONTEXT_TIMEOUT
    );
    if (!Array.isArray(contexts) || contexts.length === 0) {
      throw codedError(CDP_CONTEXT_TIMEOUT);
    }
    const pages = contexts.flatMap((context) =>
      context && typeof context.pages === "function" ? context.pages() : []
    );
    return { contexts, pages };
  } catch (error) {
    if (error && error.code === CDP_CONTEXT_TIMEOUT) throw error;
    throw codedError(CDP_CONTEXT_TIMEOUT, error);
  }
}

async function checkXHome(browser, pages, deps = {}) {
  const timeoutMs =
    deps.timeouts && deps.timeouts.xHomeMs != null
      ? deps.timeouts.xHomeMs
      : DEFAULT_X_HOME_TIMEOUT_MS;
  const assess =
    typeof deps.assessXSession === "function"
      ? deps.assessXSession
      : assessXSession;
  let page = (pages || []).find((p) => isXHomePage(pageUrl(p)));
  if (!page) {
    page = (pages || []).find((p) => isXPage(pageUrl(p)));
  }
  if (!page) {
    throw codedError(X_HOME_UNAVAILABLE);
  }
  if (typeof page.bringToFront === "function") {
    try {
      await withTimeout(page.bringToFront(), timeoutMs, X_HOME_UNAVAILABLE);
    } catch (error) {
      throw error && error.code === X_HOME_UNAVAILABLE
        ? error
        : codedError(X_HOME_UNAVAILABLE, error);
    }
  }
  let session;
  try {
    session = await withTimeout(
      assess(page, { waitTimeoutMs: Math.min(8000, timeoutMs) }),
      timeoutMs,
      X_HOME_UNAVAILABLE
    );
  } catch (error) {
    if (error && error.code === X_AUTH_REQUIRED) throw error;
    throw error && error.code === X_HOME_UNAVAILABLE
      ? error
      : codedError(X_HOME_UNAVAILABLE, error);
  }
  if (session && session.error === X_AUTH_REQUIRED) {
    throw codedError(X_AUTH_REQUIRED);
  }
  return { page, session };
}

function emptyFlags() {
  return {
    cdpAvailable: false,
    playwrightConnected: false,
    xHomeAvailable: false,
  };
}

function buildCollectorPreflight(input = {}) {
  const status = ["healthy", "recovered", "failed"].includes(input.status)
    ? input.status
    : input.ok === true
      ? input.chromeRestarted
        ? "recovered"
        : "healthy"
      : "failed";
  const out = {
    status,
    cdpAvailable: input.cdpAvailable === true,
    playwrightConnected: input.playwrightConnected === true,
    xHomeAvailable: input.xHomeAvailable === true,
    chromeRestarted: input.chromeRestarted === true,
    attempts: Number.isFinite(Number(input.attempts))
      ? Math.max(1, Math.floor(Number(input.attempts)))
      : 1,
  };
  if (input.error) out.error = String(input.error);
  if (input.initialError) out.initialError = String(input.initialError);
  if (input.lastStage) out.lastStage = String(input.lastStage);
  return out;
}

function formatPreflightLine(preflight) {
  return `${PREFLIGHT_JSON_PREFIX}${JSON.stringify(preflight)}`;
}

function parsePreflightFromOutput(output) {
  const text = String(output || "");
  const idx = text.lastIndexOf(PREFLIGHT_JSON_PREFIX);
  if (idx < 0) return null;
  const start = idx + PREFLIGHT_JSON_PREFIX.length;
  const rest = text.slice(start);
  const lineEnd = rest.search(/[\r\n]/);
  const jsonText = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object"
      ? buildCollectorPreflight(parsed)
      : null;
  } catch (_error) {
    return null;
  }
}

async function runCollectorPreflight(deps = {}) {
  const flags = emptyFlags();
  let browser;
  try {
    const httpInfo = await checkCdpHttp(deps);
    flags.cdpAvailable = true;
    browser = await checkPlaywrightCdp(deps, httpInfo.cdpUrl);
    flags.playwrightConnected = true;
    const contextTimeout =
      deps.timeouts && deps.timeouts.cdpConnectMs != null
        ? deps.timeouts.cdpConnectMs
        : DEFAULT_CDP_CONNECT_TIMEOUT_MS;
    const { pages } = await checkContexts(browser, contextTimeout);
    await checkXHome(browser, pages, deps);
    flags.xHomeAvailable = true;
    return {
      ok: true,
      error: null,
      ...flags,
    };
  } catch (error) {
    const code =
      (error && error.code) ||
      (/timeout|timed out/i.test(String(error && error.message))
        ? CDP_CONNECT_TIMEOUT
        : CDP_NOT_AVAILABLE);
    return {
      ok: false,
      error: String(code),
      ...flags,
    };
  } finally {
    safeDisconnect(browser);
  }
}

/**
 * Preflight; on transient CDP failure restart dedicated Chrome once and retry.
 */
async function ensureCollectorReady(deps = {}) {
  const env = deps.env || process.env;
  const timeouts = resolvePreflightTimeouts(env, deps.timeouts || {});
  const run =
    typeof deps.runCollectorPreflight === "function"
      ? deps.runCollectorPreflight
      : runCollectorPreflight;
  const restart =
    typeof deps.restartDedicatedCollectorChrome === "function"
      ? deps.restartDedicatedCollectorChrome
      : restartDedicatedCollectorChrome;

  const scoped = { ...deps, env, timeouts };
  let chromeRestarted = false;
  let initialError = null;
  let attempts = 0;
  let last = null;

  for (let i = 0; i < MAX_CHROME_RESTARTS + 1; i++) {
    attempts += 1;
    last = await run(scoped);
    if (last && last.ok) {
      return buildCollectorPreflight({
        status: chromeRestarted ? "recovered" : "healthy",
        cdpAvailable: last.cdpAvailable,
        playwrightConnected: last.playwrightConnected,
        xHomeAvailable: last.xHomeAvailable,
        chromeRestarted,
        attempts,
        initialError,
      });
    }
    const code = last && last.error;
    if (code === X_AUTH_REQUIRED || !isRestartablePreflightError(code)) {
      return buildCollectorPreflight({
        status: "failed",
        cdpAvailable: last && last.cdpAvailable,
        playwrightConnected: last && last.playwrightConnected,
        xHomeAvailable: last && last.xHomeAvailable,
        chromeRestarted,
        attempts,
        error: code || CDP_NOT_AVAILABLE,
        initialError: initialError || code,
      });
    }
    if (chromeRestarted) {
      return buildCollectorPreflight({
        status: "failed",
        cdpAvailable: last && last.cdpAvailable,
        playwrightConnected: last && last.playwrightConnected,
        xHomeAvailable: last && last.xHomeAvailable,
        chromeRestarted: true,
        attempts,
        error: code || CDP_NOT_AVAILABLE,
        initialError: initialError || code,
      });
    }
    initialError = code;
    restart({
      ...scoped,
      restartWaitMs: timeouts.restartWaitMs,
      sleep: deps.sleep,
      listProcesses: deps.listProcesses,
      kill: deps.kill,
      spawnChrome: deps.spawnChrome,
      userDataDir: deps.userDataDir,
      chromeBin: deps.chromeBin,
      cdpPort: deps.cdpPort,
      env,
    });
    chromeRestarted = true;
  }

  return buildCollectorPreflight({
    status: "failed",
    chromeRestarted,
    attempts,
    error: (last && last.error) || CDP_NOT_AVAILABLE,
    initialError,
    cdpAvailable: last && last.cdpAvailable,
    playwrightConnected: last && last.playwrightConnected,
    xHomeAvailable: last && last.xHomeAvailable,
  });
}

module.exports = {
  PREFLIGHT_JSON_PREFIX,
  CDP_NOT_AVAILABLE,
  CDP_CONNECT_TIMEOUT,
  CDP_CONTEXT_TIMEOUT,
  X_HOME_UNAVAILABLE,
  X_AUTH_REQUIRED,
  RESTARTABLE_CODES,
  DEFAULT_CDP_HTTP_TIMEOUT_MS,
  DEFAULT_CDP_CONNECT_TIMEOUT_MS,
  DEFAULT_X_HOME_TIMEOUT_MS,
  DEFAULT_CHROME_RESTART_WAIT_MS,
  MAX_CHROME_RESTARTS,
  resolvePreflightTimeouts,
  isRestartablePreflightError,
  isXHomePage,
  isXPage,
  withTimeout,
  checkCdpHttp,
  checkPlaywrightCdp,
  checkContexts,
  checkXHome,
  runCollectorPreflight,
  ensureCollectorReady,
  buildCollectorPreflight,
  formatPreflightLine,
  parsePreflightFromOutput,
};
