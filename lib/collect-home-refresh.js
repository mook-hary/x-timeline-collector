/**
 * COLLECT-FRESHNESS-001 — one X Home reload before collecting posts.
 * Separate from Scroll Recovery reload and Preflight CDP restart.
 * Infinite retry is forbidden: reload runs at most once per Collect.
 */

const HOME_REFRESH_TIMEOUT = "HOME_REFRESH_TIMEOUT";
const AUTH_ERROR = "X_AUTH_REQUIRED";
const DEFAULT_HOME_REFRESH_TIMEOUT_MS = 25 * 1000;
const LOGIN_URL_RE =
  /\/(i\/flow\/login|login|account\/access|logout)(\/|\?|$)/i;

function isXHomePage(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com\/home(\/|\?|$)/.test(url || "");
}

function isLoginUrl(url) {
  return LOGIN_URL_RE.test(String(url || ""));
}

function pageUrl(page) {
  if (!page) return "";
  if (typeof page.url === "function") return String(page.url() || "");
  return String(page.url || "");
}

function resolveHomeRefreshTimeoutMs(env = process.env, explicit) {
  if (explicit != null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const raw = env && env.MORNING_HOME_REFRESH_TIMEOUT_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_HOME_REFRESH_TIMEOUT_MS;
}

function codedError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
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

function buildHomeRefresh(input = {}) {
  const at =
    input.homeRefreshedAt == null || input.homeRefreshedAt === ""
      ? null
      : String(input.homeRefreshedAt);
  return {
    homeRefreshed: input.homeRefreshed === true,
    homeRefreshedAt: at,
  };
}

function pickHomeRefresh(input) {
  if (!input || typeof input !== "object") return null;
  if (input.homeRefresh && typeof input.homeRefresh === "object") {
    return buildHomeRefresh(input.homeRefresh);
  }
  if (input.homeRefreshed != null || input.homeRefreshedAt != null) {
    return buildHomeRefresh(input);
  }
  return null;
}

/**
 * Confirm X Home finished loading. Does not retry.
 * Login walls are treated as load-complete so the caller can AUTH-fail.
 */
async function waitForHomeReady(page, options = {}) {
  const timeoutMs = resolveHomeRefreshTimeoutMs(
    options.env || process.env,
    options.timeoutMs
  );
  const url = pageUrl(page);
  if (isLoginUrl(url)) {
    return {
      ready: true,
      reason: "login_url",
      timelineAvailable: false,
    };
  }

  if (typeof page.waitForSelector === "function") {
    try {
      await page.waitForSelector("article", { timeout: timeoutMs });
      return {
        ready: true,
        reason: "timeline_articles",
        timelineAvailable: true,
      };
    } catch (_error) {
      /* probe chrome / login without another long wait */
    }
  }

  if (typeof options.assessXSession === "function") {
    const session = await options.assessXSession(page, { waitTimeoutMs: 0 });
    if (
      session &&
      session.error === AUTH_ERROR &&
      (session.reason === "login_url" || session.reason === "login_ui")
    ) {
      return {
        ready: true,
        reason: session.reason,
        timelineAvailable: false,
        session,
      };
    }
    if (
      session &&
      (session.timelineAvailable === true || session.authenticated === true)
    ) {
      return {
        ready: true,
        reason: session.reason || "home_ready",
        timelineAvailable: true,
        session,
      };
    }
  }

  const homeCheck = options.isXHomePage || isXHomePage;
  if (homeCheck(url) && typeof page.waitForSelector !== "function") {
    return {
      ready: true,
      reason: "home_url",
      timelineAvailable: false,
    };
  }

  throw codedError(HOME_REFRESH_TIMEOUT);
}

/**
 * Reload X Home exactly once, then wait until posts/home chrome are usable.
 */
async function refreshXHomePage(page, options = {}) {
  const timeoutMs = resolveHomeRefreshTimeoutMs(
    options.env || process.env,
    options.timeoutMs
  );
  if (!page || typeof page.reload !== "function") {
    throw codedError(HOME_REFRESH_TIMEOUT);
  }

  await withTimeout(
    () => page.reload({ waitUntil: "domcontentloaded" }),
    timeoutMs,
    HOME_REFRESH_TIMEOUT
  );

  const ready = await withTimeout(
    () =>
      waitForHomeReady(page, {
        ...options,
        timeoutMs,
      }),
    timeoutMs,
    HOME_REFRESH_TIMEOUT
  );
  const now =
    typeof options.now === "function"
      ? options.now()
      : new Date().toISOString();
  return {
    page,
    homeRefreshed: true,
    homeRefreshedAt: String(now),
    reason: ready && ready.reason ? ready.reason : null,
  };
}

/**
 * One Home reload, then login re-check. Used by Collect start — not Scroll Recovery.
 */
async function refreshHomeThenCheckLogin(page, options = {}) {
  const mark = typeof options.mark === "function" ? options.mark : () => {};
  mark("home_refresh");
  const homeRefresh = await refreshXHomePage(page, options);
  mark("home_refreshed");
  if (typeof options.assessXSession !== "function") {
    throw codedError(HOME_REFRESH_TIMEOUT);
  }
  const session = await options.assessXSession(page);
  mark("login_checked");
  return { homeRefresh, session };
}

module.exports = {
  HOME_REFRESH_TIMEOUT,
  AUTH_ERROR,
  DEFAULT_HOME_REFRESH_TIMEOUT_MS,
  isXHomePage,
  isLoginUrl,
  buildHomeRefresh,
  pickHomeRefresh,
  waitForHomeReady,
  refreshXHomePage,
  refreshHomeThenCheckLogin,
  resolveHomeRefreshTimeoutMs,
};
