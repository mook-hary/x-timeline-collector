/**
 * Collect stage timeout / CDP retry helpers for Morning Runner.
 * Infinite retry is forbidden. X_AUTH_REQUIRED never retries.
 */

const DEFAULT_COLLECT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_COLLECT_RETRY_WAIT_MS = 8 * 1000;
const COLLECT_TIMEOUT_CODE = "COLLECT_TIMEOUT";
const AUTH_ERROR = "X_AUTH_REQUIRED";

function resolveCollectTimeoutMs(env = process.env) {
  const raw = env && env.MORNING_COLLECT_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_COLLECT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_COLLECT_TIMEOUT_MS;
}

function resolveCollectRetryWaitMs(env = process.env) {
  const raw = env && env.MORNING_COLLECT_RETRY_WAIT_MS;
  if (raw == null || raw === "") return DEFAULT_COLLECT_RETRY_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_COLLECT_RETRY_WAIT_MS;
}

function combinedOutput(result) {
  if (!result) return "";
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function isCollectAuthFailure(result) {
  const out = combinedOutput(result);
  return (
    /X_AUTH_REQUIRED/.test(out) ||
    (result && result.authError === AUTH_ERROR)
  );
}

function isCollectTimeout(result) {
  if (!result) return false;
  if (result.error && result.error.code === "ETIMEDOUT") return true;
  if (result.timedOut === true) return true;
  const out = combinedOutput(result);
  return /COLLECT_TIMEOUT/.test(out);
}

/**
 * Chrome/CDP connection failure (not auth, not timeout).
 */
function isCollectCdpFailure(result) {
  if (!result) return false;
  if (isCollectAuthFailure(result)) return false;
  if (isCollectTimeout(result)) return false;
  const out = combinedOutput(result);
  if (/Chrome への接続に失敗|接続先:.*9222|connectToChrome|ECONNREFUSED/i.test(out)) {
    return true;
  }
  if (
    result.error &&
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(String(result.error.message || ""))
  ) {
    return true;
  }
  return false;
}

/**
 * Allow at most one retry for CDP connection failures only.
 * @param {object} result
 * @param {number} attempt — 0-based
 */
function shouldRetryCollect(result, attempt) {
  if (attempt !== 0) return false;
  if (isCollectAuthFailure(result)) return false;
  if (isCollectTimeout(result)) return false;
  return isCollectCdpFailure(result);
}

function sleepSync(ms, deps = {}) {
  if (typeof deps.sleep === "function") {
    deps.sleep(ms);
    return;
  }
  const wait = Math.max(0, Math.floor(Number(ms) || 0));
  if (wait <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch (_error) {
    const end = Date.now() + wait;
    while (Date.now() < end) {
      /* busy wait fallback for environments without Atomics.wait */
    }
  }
}

module.exports = {
  DEFAULT_COLLECT_TIMEOUT_MS,
  DEFAULT_COLLECT_RETRY_WAIT_MS,
  COLLECT_TIMEOUT_CODE,
  AUTH_ERROR,
  resolveCollectTimeoutMs,
  resolveCollectRetryWaitMs,
  isCollectAuthFailure,
  isCollectTimeout,
  isCollectCdpFailure,
  shouldRetryCollect,
  sleepSync,
  combinedOutput,
};
