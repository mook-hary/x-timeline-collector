/**
 * COLLECT-FRESHNESS-001 — one Home reload before Collect.
 * No real Chrome / X. Run: node test/collect-home-refresh-test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  HOME_REFRESH_TIMEOUT,
  AUTH_ERROR,
  refreshXHomePage,
  refreshHomeThenCheckLogin,
  pickHomeRefresh,
  buildHomeRefresh,
} = require("../lib/collect-home-refresh");
const {
  COLLECT_STAGES,
  COLLECT_STAGE_ORDER,
  createCollectStageTracker,
} = require("../lib/collect-stage");
const {
  recoverXHomePage,
  runScrollingWithRecovery,
  MAX_SCROLL_RECOVERY,
} = require("../lib/collect-scroll");
const {
  DEFAULT_COLLECT_TIMEOUT_MS,
  isCollectCdpFailure,
  shouldRetryCollect,
} = require("../lib/morning-collect-policy");
const { MAX_CHROME_RESTARTS } = require("../lib/collector-preflight");
const { buildCollectorHealth } = require("../lib/x-collector-health");
const { buildMorningHealthReport } = require("../lib/morning-health");

function hang() {
  return new Promise(() => {});
}

function makePage(opts = {}) {
  const state = {
    reloadCalls: 0,
    waitCalls: 0,
    lastSelector: null,
  };
  const page = {
    url: () => opts.url || "https://x.com/home",
    reload: async () => {
      state.reloadCalls += 1;
      if (typeof opts.onReload === "function") opts.onReload();
      if (opts.reloadHang) return hang();
    },
    waitForSelector: async (selector, options) => {
      state.waitCalls += 1;
      state.lastSelector = selector;
      state.lastWaitOptions = options;
      if (typeof opts.onWait === "function") opts.onWait(selector, options);
      if (opts.waitHang) return hang();
      if (opts.waitFail) throw new Error("timeout");
      return true;
    },
  };
  page._state = state;
  return page;
}

async function main() {
  assert.strictEqual(DEFAULT_COLLECT_TIMEOUT_MS, 15 * 60 * 1000);
  assert.strictEqual(MAX_SCROLL_RECOVERY, 1);
  assert.strictEqual(MAX_CHROME_RESTARTS, 1);
  assert.notStrictEqual(refreshXHomePage, recoverXHomePage);
  console.log("freshness constants PASS");

  {
    const idxHome = COLLECT_STAGE_ORDER.indexOf(COLLECT_STAGES.X_HOME_SELECTED);
    const idxRefresh = COLLECT_STAGE_ORDER.indexOf(COLLECT_STAGES.HOME_REFRESH);
    const idxRefreshed = COLLECT_STAGE_ORDER.indexOf(
      COLLECT_STAGES.HOME_REFRESHED
    );
    const idxLogin = COLLECT_STAGE_ORDER.indexOf(COLLECT_STAGES.LOGIN_CHECKED);
    const idxPosts = COLLECT_STAGE_ORDER.indexOf(COLLECT_STAGES.INITIAL_POSTS);
    const idxScroll = COLLECT_STAGE_ORDER.indexOf(COLLECT_STAGES.SCROLLING);
    assert.ok(idxHome >= 0);
    assert.strictEqual(idxRefresh, idxHome + 1);
    assert.strictEqual(idxRefreshed, idxRefresh + 1);
    assert.strictEqual(idxLogin, idxRefreshed + 1);
    assert.strictEqual(idxPosts, idxLogin + 1);
    assert.strictEqual(idxScroll, idxPosts + 1);
    console.log("freshness stage order PASS");
  }

  {
    const connectSrc = fs.readFileSync(
      path.join(__dirname, "../connect.js"),
      "utf8"
    );
    const scrollSrc = fs.readFileSync(
      path.join(__dirname, "../lib/collect-scroll.js"),
      "utf8"
    );
    const refreshSrc = fs.readFileSync(
      path.join(__dirname, "../lib/collect-home-refresh.js"),
      "utf8"
    );
    assert.ok(connectSrc.includes("refreshHomeThenCheckLogin"));
    assert.ok(connectSrc.includes("runScrollingWithRecovery"));
    assert.ok(!connectSrc.includes("スクロール前に2秒待機"));
    assert.ok(!connectSrc.includes("recoverXHomePage"));
    assert.ok(!scrollSrc.includes("collect-home-refresh"));
    assert.ok(!scrollSrc.includes("refreshXHomePage"));
    assert.ok(!refreshSrc.includes("collect-scroll"));
    assert.ok(!refreshSrc.includes("collector-preflight"));
    console.log("freshness module split PASS");
  }

  {
    const events = [];
    const page = makePage({
      onReload: () => events.push("reload"),
      onWait: (selector) => events.push(`wait:${selector}`),
    });
    const started = Date.now();
    const result = await refreshHomeThenCheckLogin(page, {
      timeoutMs: 2000,
      now: () => "2026-08-28T04:00:00.000Z",
      assessXSession: async () => {
        events.push("login");
        return { authenticated: true, error: null };
      },
      mark: (stage) => events.push(stage),
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(page._state.reloadCalls, 1);
    assert.strictEqual(page._state.waitCalls, 1);
    assert.strictEqual(page._state.lastSelector, "article");
    assert.ok(elapsed < 1500, `expected no 2s sleep, elapsed=${elapsed}`);
    assert.deepStrictEqual(events, [
      "home_refresh",
      "reload",
      "wait:article",
      "home_refreshed",
      "login",
      "login_checked",
    ]);
    assert.strictEqual(result.homeRefresh.homeRefreshed, true);
    assert.strictEqual(result.homeRefresh.homeRefreshedAt, "2026-08-28T04:00:00.000Z");
    assert.strictEqual(result.session.authenticated, true);
    console.log("freshness reload once + login after PASS");
  }

  {
    const stages = [];
    const tracker = createCollectStageTracker((line) => stages.push(line));
    const page = makePage();
    await refreshHomeThenCheckLogin(page, {
      timeoutMs: 200,
      now: () => "2026-08-28T04:01:00.000Z",
      assessXSession: async () => ({ authenticated: true, error: null }),
      mark: (stage) => tracker.mark(stage),
    });
    assert.ok(stages.includes("COLLECT_STAGE:home_refresh"));
    assert.ok(stages.includes("COLLECT_STAGE:home_refreshed"));
    assert.ok(stages.includes("COLLECT_STAGE:login_checked"));
    const refreshAt = stages.indexOf("COLLECT_STAGE:home_refresh");
    const refreshedAt = stages.indexOf("COLLECT_STAGE:home_refreshed");
    const loginAt = stages.indexOf("COLLECT_STAGE:login_checked");
    assert.ok(refreshAt < refreshedAt);
    assert.ok(refreshedAt < loginAt);
    console.log("freshness diagnostics stages PASS");
  }

  {
    const page = makePage();
    const result = await refreshHomeThenCheckLogin(page, {
      timeoutMs: 200,
      now: () => "2026-08-28T04:02:00.000Z",
      assessXSession: async () => ({
        authenticated: false,
        error: AUTH_ERROR,
        reason: "login_ui",
      }),
    });
    assert.strictEqual(page._state.reloadCalls, 1);
    assert.strictEqual(result.session.error, AUTH_ERROR);
    assert.strictEqual(result.homeRefresh.homeRefreshed, true);
    console.log("freshness login fail no second refresh PASS");
  }

  {
    const events = [];
    const page = makePage({
      reloadHang: true,
      onReload: () => events.push("reload"),
    });
    await assert.rejects(
      () =>
        refreshHomeThenCheckLogin(page, {
          timeoutMs: 40,
          assessXSession: async () => {
            events.push("login");
            return { authenticated: true };
          },
          mark: (stage) => events.push(stage),
        }),
      (error) => {
        assert.strictEqual(error.code, HOME_REFRESH_TIMEOUT);
        return true;
      }
    );
    assert.strictEqual(page._state.reloadCalls, 1);
    assert.ok(events.includes("home_refresh"));
    assert.ok(events.includes("reload"));
    assert.ok(!events.includes("home_refreshed"));
    assert.ok(!events.includes("login"));
    console.log("freshness hung reload timeout PASS");
  }

  {
    const page = makePage({ waitHang: true });
    await assert.rejects(
      () =>
        refreshXHomePage(page, {
          timeoutMs: 40,
          now: () => "2026-08-28T04:03:00.000Z",
        }),
      (error) => error.code === HOME_REFRESH_TIMEOUT
    );
    assert.strictEqual(page._state.reloadCalls, 1);
    console.log("freshness hung ready timeout PASS");
  }

  {
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: { fetchedFromScreen: 15, newPosts: 2, totalStored: 100 },
      homeRefresh: {
        homeRefreshed: true,
        homeRefreshedAt: "2026-08-28T04:04:00.000Z",
      },
    });
    assert.strictEqual(health.homeRefreshed, true);
    assert.strictEqual(health.homeRefreshedAt, "2026-08-28T04:04:00.000Z");
    const picked = pickHomeRefresh(health);
    assert.deepStrictEqual(
      picked,
      buildHomeRefresh({
        homeRefreshed: true,
        homeRefreshedAt: "2026-08-28T04:04:00.000Z",
      })
    );
    const report = buildMorningHealthReport({
      startedAt: "2026-08-28T04:00:00.000Z",
      finishedAt: "2026-08-28T04:05:00.000Z",
      status: "SUCCESS",
      stages: [
        {
          id: "collect",
          ok: true,
          itemCount: 100,
          collectorHealth: health,
          lastStage: "save",
          homeRefresh: picked,
        },
      ],
      collectorHealth: health,
      homeRefresh: picked,
      publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
    });
    assert.strictEqual(report.homeRefreshed, true);
    assert.strictEqual(report.homeRefreshedAt, "2026-08-28T04:04:00.000Z");
    assert.strictEqual(report.homeRefresh.homeRefreshed, true);
    assert.strictEqual(report.stages[0].homeRefreshed, true);
    console.log("freshness history fields PASS");
  }

  {
    const cdpFail = {
      status: 1,
      stdout: "",
      stderr: "ERROR: HOME_REFRESH_TIMEOUT\n",
    };
    assert.ok(!isCollectCdpFailure(cdpFail));
    assert.ok(!shouldRetryCollect(cdpFail, 0));
    console.log("freshness not cdp restart PASS");
  }

  {
    let recovered = false;
    let recoveries = 0;
    const page = {
      url: () => "https://x.com/home",
      reload: async () => {
        recoveries += 1;
      },
    };
    const result = await runScrollingWithRecovery({
      page,
      posts: [],
      seen: new Set(),
      maxScrolls: 2,
      maxPosts: 50,
      iterationTimeoutMs: 40,
      scrollDown: async (_p, i) => {
        if (i === 1 && !recovered) return hang();
      },
      waitAfterScroll: async () => {},
      extractPosts: async () => [],
      mergePosts: () => {},
      assessSession: async () => {
        recovered = true;
        return { authenticated: true, error: null };
      },
      log: () => {},
    });
    assert.strictEqual(recoveries, 1);
    assert.strictEqual(result.scrollRecovery.scrollRecovered, true);
    assert.strictEqual(result.scrollRecovery.scrollingAttempts, 2);
    console.log("freshness scroll recovery independent PASS");
  }

  console.log("collect-home-refresh-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
