/**
 * COLLECT-HEALTH-001 — X Collector session + collect metrics + freshness.
 * Used by connect.js and Morning Pipeline health history.
 * Never logs secret values.
 */

const AUTH_ERROR = "X_AUTH_REQUIRED";
const STALE_WARNING = "X_TIMELINE_STALE";
/** Default: 24h — warning only; does not fail the pipeline. */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

const LOGIN_URL_RE =
  /\/(i\/flow\/login|login|account\/access|logout)(\/|\?|$)/i;

const COLLECT_HEALTH_PREFIX = "COLLECT_HEALTH_JSON:";

/**
 * @param {string|null|undefined} url
 */
function isLoginUrl(url) {
  return LOGIN_URL_RE.test(String(url || ""));
}

/**
 * Probe DOM markers (runs in page.evaluate).
 * @returns {{ hasArticles: boolean, loginHints: boolean, homeChrome: boolean }}
 */
function probeSessionDom() {
  const bodyText = document.body ? document.body.innerText || "" : "";
  const hasArticles = document.querySelectorAll("article").length > 0;
  const loginHints = !!(
    document.querySelector('input[autocomplete="username"]') ||
    document.querySelector('[data-testid="loginButton"]') ||
    document.querySelector('a[href="/login"]') ||
    document.querySelector('a[href*="/i/flow/login"]') ||
    /Sign in to X|Log in to X|Xにログイン|アカウントを作成/i.test(bodyText)
  );
  const homeChrome = !!(
    document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
    document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
    document.querySelector('[aria-label="Home timeline"]') ||
    document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
  );
  return { hasArticles, loginHints, homeChrome };
}

/**
 * Assess login / Home Timeline availability after ensureHomePage.
 * @param {object} page Playwright-like page
 * @param {object} [options]
 */
async function assessXSession(page, options = {}) {
  const waitTimeoutMs =
    options.waitTimeoutMs != null ? Number(options.waitTimeoutMs) : 8000;
  const url = typeof page.url === "function" ? page.url() : "";

  if (isLoginUrl(url)) {
    return {
      authenticated: false,
      timelineAvailable: false,
      error: AUTH_ERROR,
      reason: "login_url",
      url: String(url),
    };
  }

  let probe = { hasArticles: false, loginHints: false, homeChrome: false };
  if (typeof page.evaluate === "function") {
    try {
      probe = await page.evaluate(probeSessionDom);
    } catch (_error) {
      probe = { hasArticles: false, loginHints: false, homeChrome: false };
    }
  }

  if (probe.hasArticles || probe.homeChrome) {
    return {
      authenticated: true,
      timelineAvailable: !!probe.hasArticles || !!probe.homeChrome,
      error: null,
      reason: probe.hasArticles ? "timeline_articles" : "home_chrome",
      url: String(url),
    };
  }

  if (probe.loginHints) {
    return {
      authenticated: false,
      timelineAvailable: false,
      error: AUTH_ERROR,
      reason: "login_ui",
      url: String(url),
    };
  }

  if (typeof page.waitForSelector === "function" && waitTimeoutMs > 0) {
    try {
      await page.waitForSelector("article", { timeout: waitTimeoutMs });
      return {
        authenticated: true,
        timelineAvailable: true,
        error: null,
        reason: "timeline_wait",
        url: String(url),
      };
    } catch (_error) {
      // fall through
    }
  }

  return {
    authenticated: false,
    timelineAvailable: false,
    error: AUTH_ERROR,
    reason: "timeline_unavailable",
    url: String(url),
  };
}

/**
 * @param {object} input
 */
function buildCollectMetrics(input = {}) {
  const fetchedFromScreen = Number(input.fetchedFromScreen || 0);
  const newPosts = Number(input.newPosts || 0);
  const duplicateUrlsSkipped = Number(input.duplicateUrlsSkipped || 0);
  const totalStored = Number(input.totalStored || 0);
  const missingPostedAt = Number(input.missingPostedAt || 0);
  const newestPostAt =
    input.newestPostAt == null || input.newestPostAt === ""
      ? null
      : String(input.newestPostAt);

  return {
    fetchedFromScreen: Number.isFinite(fetchedFromScreen)
      ? fetchedFromScreen
      : 0,
    newPosts: Number.isFinite(newPosts) ? newPosts : 0,
    duplicateUrlsSkipped: Number.isFinite(duplicateUrlsSkipped)
      ? duplicateUrlsSkipped
      : 0,
    totalStored: Number.isFinite(totalStored) ? totalStored : 0,
    missingPostedAt: Number.isFinite(missingPostedAt) ? missingPostedAt : 0,
    newestPostAt,
  };
}

/**
 * Newest postedAt among posts (ISO preferred).
 * @param {object[]} posts
 * @returns {string|null}
 */
function newestPostedAt(posts) {
  let best = null;
  let bestMs = NaN;
  for (const post of Array.isArray(posts) ? posts : []) {
    const raw = post && post.postedAt != null ? String(post.postedAt).trim() : "";
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) continue;
    if (Number.isNaN(bestMs) || ms > bestMs) {
      bestMs = ms;
      best = raw;
    }
  }
  return best;
}

/**
 * @param {string|null} newestPostAt
 * @param {Date|string|number} [now]
 * @param {number} [staleMs]
 */
function assessTimelineFreshness(newestPostAt, now = new Date(), staleMs = DEFAULT_STALE_MS) {
  const warnings = [];
  if (newestPostAt == null || newestPostAt === "") {
    return { fresh: null, ageMs: null, warnings };
  }
  const postMs = Date.parse(String(newestPostAt));
  if (Number.isNaN(postMs)) {
    return { fresh: null, ageMs: null, warnings };
  }
  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.parse(String(now));
  if (Number.isNaN(nowMs)) {
    return { fresh: null, ageMs: null, warnings };
  }
  const ageMs = Math.max(0, nowMs - postMs);
  const threshold = Number.isFinite(Number(staleMs))
    ? Number(staleMs)
    : DEFAULT_STALE_MS;
  if (ageMs > threshold) {
    warnings.push(STALE_WARNING);
    return { fresh: false, ageMs, warnings };
  }
  return { fresh: true, ageMs, warnings };
}

/**
 * @param {object} input
 */
function buildCollectorHealth(input = {}) {
  const authenticated = input.authenticated === true;
  const timelineAvailable = input.timelineAvailable === true;
  const hasFlatMetrics =
    input.fetchedFromScreen != null ||
    input.newPosts != null ||
    input.totalStored != null ||
    input.duplicateUrlsSkipped != null ||
    input.missingPostedAt != null ||
    (input.newestPostAt != null && input.newestPostAt !== "");
  const collect = input.collect
    ? buildCollectMetrics(input.collect)
    : hasFlatMetrics
      ? buildCollectMetrics(input)
      : null;
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.map(String)
    : [];
  const error =
    input.error != null && input.error !== ""
      ? String(input.error)
      : null;

  let status = "healthy";
  if (!authenticated || error === AUTH_ERROR || input.status === "failed") {
    status = "failed";
  } else if (warnings.length > 0 || input.status === "warning") {
    status = "warning";
  }

  /** @type {object} */
  const out = {
    authenticated,
    timelineAvailable,
    status,
    warnings,
  };

  if (collect) {
    out.fetchedFromScreen = collect.fetchedFromScreen;
    out.newPosts = collect.newPosts;
    out.duplicateUrlsSkipped = collect.duplicateUrlsSkipped;
    out.totalStored = collect.totalStored;
    out.missingPostedAt = collect.missingPostedAt;
    out.newestPostAt = collect.newestPostAt;
  } else if (input.newestPostAt != null) {
    out.newestPostAt = input.newestPostAt;
  }

  if (error) out.error = error;
  if (input.reason) out.reason = String(input.reason);

  return out;
}

/**
 * Machine-readable line for Morning health parsers.
 * @param {object} health
 */
function formatCollectHealthLine(health) {
  return `${COLLECT_HEALTH_PREFIX}${JSON.stringify(health)}`;
}

/**
 * @param {string} output
 * @returns {object|null}
 */
function parseCollectHealthFromOutput(output) {
  const text = String(output || "");
  const idx = text.lastIndexOf(COLLECT_HEALTH_PREFIX);
  if (idx < 0) return null;
  const start = idx + COLLECT_HEALTH_PREFIX.length;
  const rest = text.slice(start);
  const lineEnd = rest.search(/[\r\n]/);
  const jsonText = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Human summary block for Morning Pipeline / CLI.
 * @param {object|null} health
 */
function formatXCollectorSummary(health) {
  const lines = ["X Collector"];
  if (!health || typeof health !== "object") {
    lines.push("Login: —");
    return lines.join("\n");
  }
  if (health.status === "failed" || health.authenticated === false) {
    lines.push("Login: FAILED");
    lines.push(`Reason: ${health.error || AUTH_ERROR}`);
    return lines.join("\n");
  }
  lines.push("Login: OK");
  if (health.fetchedFromScreen != null) {
    lines.push(`Fetched: ${health.fetchedFromScreen}`);
  }
  if (health.newPosts != null) {
    lines.push(`New: ${health.newPosts}`);
  }
  if (health.totalStored != null) {
    lines.push(`Total: ${health.totalStored}`);
  }
  const freshness =
    health.status === "warning" &&
    Array.isArray(health.warnings) &&
    health.warnings.includes(STALE_WARNING)
      ? "WARNING"
      : "OK";
  lines.push(`Freshness: ${freshness}`);
  return lines.join("\n");
}

/**
 * Collect detail object for History (separate from cumulative counts.collect).
 * @param {object|null} health
 */
function collectDetailFromHealth(health) {
  if (!health || typeof health !== "object") return null;
  if (
    health.fetchedFromScreen == null &&
    health.newPosts == null &&
    health.totalStored == null
  ) {
    return null;
  }
  return buildCollectMetrics({
    fetchedFromScreen: health.fetchedFromScreen,
    newPosts: health.newPosts,
    duplicateUrlsSkipped: health.duplicateUrlsSkipped,
    totalStored: health.totalStored,
    missingPostedAt: health.missingPostedAt,
    newestPostAt: health.newestPostAt,
  });
}

module.exports = {
  AUTH_ERROR,
  STALE_WARNING,
  DEFAULT_STALE_MS,
  COLLECT_HEALTH_PREFIX,
  LOGIN_URL_RE,
  isLoginUrl,
  probeSessionDom,
  assessXSession,
  buildCollectMetrics,
  newestPostedAt,
  assessTimelineFreshness,
  buildCollectorHealth,
  formatCollectHealthLine,
  parseCollectHealthFromOutput,
  formatXCollectorSummary,
  collectDetailFromHealth,
};
