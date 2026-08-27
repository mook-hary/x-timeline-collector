/**
 * Per-scroll-iteration timeout + one Home reload recovery.
 * Does not restart Chrome. Infinite retry is forbidden.
 */

const SCROLL_TIMEOUT = "SCROLL_TIMEOUT";
const AUTH_ERROR = "X_AUTH_REQUIRED";
const DEFAULT_SCROLL_ITERATION_TIMEOUT_MS = 25 * 1000;
const MAX_SCROLL_RECOVERY = 1;

function resolveScrollIterationTimeoutMs(env = process.env, explicit) {
  if (explicit != null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const raw = env && env.MORNING_SCROLL_ITERATION_TIMEOUT_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_SCROLL_ITERATION_TIMEOUT_MS;
}

function codedError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

async function withTimeout(work, timeoutMs, code, extra = {}) {
  const ms = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(typeof work === "function" ? work() : work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codedError(code, extra)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildScrollRecovery(input = {}) {
  const attempts = Number(input.scrollingAttempts);
  const last = Number(input.lastSuccessfulScroll);
  const timeoutAt = input.scrollTimeoutAt;
  return {
    scrollingAttempts:
      Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1,
    scrollTimeoutAt:
      timeoutAt == null || timeoutAt === ""
        ? null
        : Number.isFinite(Number(timeoutAt))
          ? Math.floor(Number(timeoutAt))
          : null,
    scrollRecovered: input.scrollRecovered === true,
    lastSuccessfulScroll:
      Number.isFinite(last) && last >= 0 ? Math.floor(last) : 0,
  };
}

function pickScrollRecovery(input) {
  if (!input || typeof input !== "object") return null;
  if (input.scrollRecovery && typeof input.scrollRecovery === "object") {
    return buildScrollRecovery(input.scrollRecovery);
  }
  if (
    input.scrollingAttempts != null ||
    input.scrollTimeoutAt != null ||
    input.scrollRecovered != null ||
    input.lastSuccessfulScroll != null
  ) {
    return buildScrollRecovery(input);
  }
  return null;
}

async function runScrollLoop(options) {
  const {
    page,
    startAt = 1,
    posts,
    seen,
    maxScrolls,
    maxPosts,
    iterationTimeoutMs,
    scrollDown,
    waitAfterScroll,
    extractPosts,
    mergePosts,
    log,
  } = options;
  let lastSuccessfulScroll = Math.max(0, startAt - 1);

  for (let i = startAt; i <= maxScrolls; i++) {
    if (Array.isArray(posts) && posts.length >= maxPosts) break;
    try {
      await withTimeout(
        async () => {
          if (typeof scrollDown === "function") {
            await scrollDown(page, i);
          }
          if (typeof waitAfterScroll === "function") {
            await waitAfterScroll(i);
          }
          if (typeof extractPosts === "function" && typeof mergePosts === "function") {
            mergePosts(posts, seen, await extractPosts(page, i));
          }
        },
        iterationTimeoutMs,
        SCROLL_TIMEOUT,
        { iteration: i }
      );
    } catch (error) {
      if (error && error.code === SCROLL_TIMEOUT) {
        error.iteration = error.iteration || i;
        error.lastSuccessfulScroll = lastSuccessfulScroll;
        throw error;
      }
      throw error;
    }
    lastSuccessfulScroll = i;
    if (typeof log === "function") {
      const count = Array.isArray(posts) ? posts.length : 0;
      log(`スクロール${i}回目・現在${count}件`);
    }
  }

  return { lastSuccessfulScroll };
}

async function recoverXHomePage(page, options = {}) {
  const timeoutMs =
    options.reloadTimeoutMs != null
      ? options.reloadTimeoutMs
      : options.iterationTimeoutMs;
  if (page && typeof page.reload === "function") {
    try {
      await withTimeout(
        () => page.reload({ waitUntil: "domcontentloaded" }),
        timeoutMs,
        SCROLL_TIMEOUT,
        { iteration: options.iteration }
      );
      return page;
    } catch (_error) {
      /* reacquire below */
    }
  }
  if (typeof options.ensureHomePage === "function" && options.browser) {
    return withTimeout(
      () => options.ensureHomePage(options.browser),
      timeoutMs,
      SCROLL_TIMEOUT,
      { iteration: options.iteration }
    );
  }
  return page;
}

/**
 * Scroll with a per-iteration timeout. On first SCROLL_TIMEOUT, reload Home,
 * re-check login, and retry remaining scrolls once. Never restarts Chrome.
 */
async function runScrollingWithRecovery(options = {}) {
  const iterationTimeoutMs = resolveScrollIterationTimeoutMs(
    options.env || process.env,
    options.iterationTimeoutMs
  );
  const recovery = buildScrollRecovery({
    scrollingAttempts: 1,
    scrollTimeoutAt: null,
    scrollRecovered: false,
    lastSuccessfulScroll: 0,
  });
  const loopOptions = {
    ...options,
    iterationTimeoutMs,
  };

  const finishOk = (lastSuccessfulScroll, recovered) => {
    recovery.lastSuccessfulScroll = lastSuccessfulScroll;
    recovery.scrollRecovered = recovered === true;
    return { page: loopOptions.page, scrollRecovery: recovery };
  };

  try {
    const first = await runScrollLoop({ ...loopOptions, startAt: 1 });
    return finishOk(first.lastSuccessfulScroll, false);
  } catch (error) {
    if (!error || error.code !== SCROLL_TIMEOUT) throw error;

    recovery.scrollTimeoutAt = error.iteration != null ? error.iteration : null;
    recovery.lastSuccessfulScroll =
      error.lastSuccessfulScroll != null
        ? error.lastSuccessfulScroll
        : Math.max(0, (error.iteration || 1) - 1);
    if (typeof options.log === "function") {
      options.log(
        `SCROLL_TIMEOUT iteration=${recovery.scrollTimeoutAt}`
      );
    }

    let recoveredPage;
    try {
      recoveredPage = await recoverXHomePage(loopOptions.page, {
        ...options,
        iterationTimeoutMs,
        iteration: recovery.scrollTimeoutAt,
      });
    } catch (_recoverError) {
      const fail = codedError(SCROLL_TIMEOUT, {
        iteration: recovery.scrollTimeoutAt,
      });
      fail.scrollRecovery = recovery;
      throw fail;
    }
    loopOptions.page = recoveredPage;

    if (typeof options.assessSession === "function") {
      let session;
      try {
        session = await withTimeout(
          () => options.assessSession(recoveredPage),
          iterationTimeoutMs,
          SCROLL_TIMEOUT,
          { iteration: recovery.scrollTimeoutAt }
        );
      } catch (assessError) {
        if (assessError && assessError.code === AUTH_ERROR) {
          assessError.scrollRecovery = recovery;
          throw assessError;
        }
        const fail = codedError(SCROLL_TIMEOUT, {
          iteration: recovery.scrollTimeoutAt,
        });
        fail.scrollRecovery = recovery;
        throw fail;
      }
      if (
        !session ||
        session.authenticated === false ||
        session.error === AUTH_ERROR
      ) {
        const authErr = codedError(AUTH_ERROR);
        authErr.scrollRecovery = recovery;
        throw authErr;
      }
    }

    recovery.scrollingAttempts = 1 + MAX_SCROLL_RECOVERY;
    const retryStart = Math.max(1, recovery.lastSuccessfulScroll + 1);
    try {
      const retry = await runScrollLoop({
        ...loopOptions,
        startAt: retryStart,
      });
      return finishOk(retry.lastSuccessfulScroll, true);
    } catch (retryError) {
      if (retryError && retryError.code === AUTH_ERROR) {
        retryError.scrollRecovery = recovery;
        throw retryError;
      }
      if (retryError && retryError.code === SCROLL_TIMEOUT) {
        recovery.scrollRecovered = false;
        recovery.scrollTimeoutAt =
          retryError.iteration != null
            ? retryError.iteration
            : recovery.scrollTimeoutAt;
        recovery.lastSuccessfulScroll =
          retryError.lastSuccessfulScroll != null
            ? retryError.lastSuccessfulScroll
            : recovery.lastSuccessfulScroll;
        const fail = codedError(SCROLL_TIMEOUT, {
          iteration: retryError.iteration,
        });
        fail.scrollRecovery = recovery;
        throw fail;
      }
      throw retryError;
    }
  }
}

function formatScrollSummaryLabel(scrollRecovery) {
  if (!scrollRecovery || typeof scrollRecovery !== "object") return null;
  if (scrollRecovery.scrollRecovered === true) return "Recovered";
  if (scrollRecovery.scrollTimeoutAt != null) return "FAILED";
  return "OK";
}

function scrollRetryCount(scrollRecovery) {
  if (!scrollRecovery || typeof scrollRecovery !== "object") return 0;
  const attempts = Number(scrollRecovery.scrollingAttempts) || 1;
  return Math.max(0, attempts - 1);
}

module.exports = {
  SCROLL_TIMEOUT,
  AUTH_ERROR,
  DEFAULT_SCROLL_ITERATION_TIMEOUT_MS,
  MAX_SCROLL_RECOVERY,
  resolveScrollIterationTimeoutMs,
  withTimeout,
  buildScrollRecovery,
  pickScrollRecovery,
  runScrollLoop,
  recoverXHomePage,
  runScrollingWithRecovery,
  formatScrollSummaryLabel,
  scrollRetryCount,
};
