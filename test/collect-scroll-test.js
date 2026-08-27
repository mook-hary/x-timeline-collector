/**
 * COLLECT-SCROLL-RECOVERY-001 — per-iteration scroll timeout + one Home recovery.
 * No real Chrome / X. Run: node test/collect-scroll-test.js
 */
const assert = require("assert");
const {
  SCROLL_TIMEOUT,
  AUTH_ERROR,
  DEFAULT_SCROLL_ITERATION_TIMEOUT_MS,
  MAX_SCROLL_RECOVERY,
  runScrollingWithRecovery,
  buildScrollRecovery,
  formatScrollSummaryLabel,
  scrollRetryCount,
} = require("../lib/collect-scroll");
const { DEFAULT_COLLECT_TIMEOUT_MS } = require("../lib/morning-collect-policy");
const { isCollectCdpFailure, shouldRetryCollect } = require("../lib/morning-collect-policy");
const { formatXCollectorSummary, buildCollectorHealth } = require("../lib/x-collector-health");
const {
  buildMorningHealthReport,
  collectorHealthForDashboard,
  formatMorningPipelineSummary,
} = require("../lib/morning-health");
const { MAX_CHROME_RESTARTS } = require("../lib/collector-preflight");

function hang() {
  return new Promise(() => {});
}

function makePage() {
  return {
    url: () => "https://x.com/home",
    reload: async () => {
      makePage.reloadCalls += 1;
    },
  };
}
makePage.reloadCalls = 0;

async function main() {
  assert.ok(DEFAULT_SCROLL_ITERATION_TIMEOUT_MS >= 20000);
  assert.ok(DEFAULT_SCROLL_ITERATION_TIMEOUT_MS <= 30000);
  assert.strictEqual(MAX_SCROLL_RECOVERY, 1);
  assert.strictEqual(DEFAULT_COLLECT_TIMEOUT_MS, 15 * 60 * 1000);
  assert.strictEqual(MAX_CHROME_RESTARTS, 1);
  console.log("scroll constants PASS");

  {
    const posts = [];
    const seen = new Set();
    const scrolls = [];
    const result = await runScrollingWithRecovery({
      page: makePage(),
      posts,
      seen,
      maxScrolls: 15,
      maxPosts: 50,
      iterationTimeoutMs: 50,
      scrollDown: async (_page, i) => {
        scrolls.push(i);
      },
      waitAfterScroll: async () => {},
      extractPosts: async (_page, i) => [
        { url: `https://x.com/a/status/${i}`, text: "t", authorName: "a", authorHandle: "@a", postedAt: "" },
      ],
      mergePosts: (out, seenSet, raw) => {
        for (const post of raw) {
          if (seenSet.has(post.url)) continue;
          seenSet.add(post.url);
          out.push(post);
        }
      },
      assessSession: async () => ({ authenticated: true, error: null }),
      log: () => {},
    });
    assert.deepStrictEqual(scrolls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.strictEqual(result.scrollRecovery.scrollingAttempts, 1);
    assert.strictEqual(result.scrollRecovery.scrollRecovered, false);
    assert.strictEqual(result.scrollRecovery.scrollTimeoutAt, null);
    assert.strictEqual(result.scrollRecovery.lastSuccessfulScroll, 15);
    assert.strictEqual(posts.length, 15);
    console.log("scroll normal 15 PASS");
  }

  {
    makePage.reloadCalls = 0;
    let recovered = false;
    const posts = [];
    const seen = new Set();
    const scrolls = [];
    const result = await runScrollingWithRecovery({
      page: makePage(),
      browser: {},
      posts,
      seen,
      maxScrolls: 15,
      maxPosts: 50,
      iterationTimeoutMs: 25,
      scrollDown: async (_page, i) => {
        scrolls.push(i);
        if (i === 4 && !recovered) return hang();
      },
      waitAfterScroll: async () => {},
      extractPosts: async (_page, i) => [
        { url: `https://x.com/a/status/${i}` },
      ],
      mergePosts: (out, seenSet, raw) => {
        for (const post of raw) {
          if (seenSet.has(post.url)) continue;
          seenSet.add(post.url);
          out.push(post);
        }
      },
      ensureHomePage: async () => {
        throw new Error("should use reload first");
      },
      assessSession: async () => {
        recovered = true;
        return { authenticated: true, error: null };
      },
      log: () => {},
    });
    assert.strictEqual(makePage.reloadCalls, 1);
    assert.strictEqual(result.scrollRecovery.scrollRecovered, true);
    assert.strictEqual(result.scrollRecovery.scrollingAttempts, 2);
    assert.strictEqual(result.scrollRecovery.scrollTimeoutAt, 4);
    assert.strictEqual(result.scrollRecovery.lastSuccessfulScroll, 15);
    assert.ok(scrolls.filter((n) => n === 4).length === 2);
    assert.strictEqual(formatScrollSummaryLabel(result.scrollRecovery), "Recovered");
    assert.strictEqual(scrollRetryCount(result.scrollRecovery), 1);
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: { fetchedFromScreen: 15, newPosts: 15, totalStored: 15 },
      scrollRecovery: result.scrollRecovery,
    });
    const summary = formatXCollectorSummary(health);
    assert.ok(summary.includes("Scroll: Recovered"));
    assert.ok(summary.includes("Retry: 1"));
    assert.ok(summary.includes("Login: OK"));
    assert.ok(summary.includes("Collect: Healthy"));
    console.log("scroll timeout recover PASS");
  }

  {
    let recoveries = 0;
    const posts = [];
    const seen = new Set();
    let threw = null;
    try {
      await runScrollingWithRecovery({
        page: makePage(),
        browser: {},
        posts,
        seen,
        maxScrolls: 15,
        maxPosts: 50,
        iterationTimeoutMs: 20,
        scrollDown: async (_page, i) => {
          if (i === 2) return hang();
        },
        waitAfterScroll: async () => {},
        extractPosts: async () => [],
        mergePosts: () => {},
        ensureHomePage: async (browser) => {
          recoveries += 1;
          return makePage();
        },
        assessSession: async () => ({ authenticated: true, error: null }),
        log: () => {},
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw);
    assert.strictEqual(threw.code, SCROLL_TIMEOUT);
    assert.strictEqual(threw.scrollRecovery.scrollRecovered, false);
    assert.strictEqual(threw.scrollRecovery.scrollingAttempts, 2);
    assert.strictEqual(threw.scrollRecovery.scrollTimeoutAt, 2);
    assert.strictEqual(recoveries, 0);
    assert.strictEqual(makePage.reloadCalls >= 1, true);
    console.log("scroll retry also fails PASS");
  }

  {
    makePage.reloadCalls = 0;
    let scrollAfterAuth = 0;
    let threw = null;
    try {
      await runScrollingWithRecovery({
        page: makePage(),
        posts: [],
        seen: new Set(),
        maxScrolls: 15,
        maxPosts: 50,
        iterationTimeoutMs: 20,
        scrollDown: async (_page, i) => {
          if (i === 1) return hang();
          scrollAfterAuth += 1;
        },
        waitAfterScroll: async () => {},
        extractPosts: async () => [],
        mergePosts: () => {},
        assessSession: async () => ({
          authenticated: false,
          error: AUTH_ERROR,
        }),
        log: () => {},
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw);
    assert.strictEqual(threw.code, AUTH_ERROR);
    assert.strictEqual(threw.scrollRecovery.scrollingAttempts, 1);
    assert.strictEqual(threw.scrollRecovery.scrollRecovered, false);
    assert.strictEqual(scrollAfterAuth, 0);
    console.log("scroll auth no retry PASS");
  }

  {
    makePage.reloadCalls = 0;
    let recoveries = 0;
    try {
      await runScrollingWithRecovery({
        page: {
          reload: async () => {
            recoveries += 1;
          },
        },
        posts: [],
        seen: new Set(),
        maxScrolls: 5,
        maxPosts: 50,
        iterationTimeoutMs: 20,
        scrollDown: async () => hang(),
        waitAfterScroll: async () => {},
        extractPosts: async () => [],
        mergePosts: () => {},
        assessSession: async () => ({ authenticated: true, error: null }),
        log: () => {},
      });
    } catch (error) {
      assert.strictEqual(error.code, SCROLL_TIMEOUT);
      assert.strictEqual(recoveries, 1);
      assert.strictEqual(error.scrollRecovery.scrollingAttempts, 2);
    }
    console.log("scroll max retry 1 PASS");
  }

  {
    const cdpFail = {
      status: 1,
      stdout: "",
      stderr: "ERROR: SCROLL_TIMEOUT\n",
    };
    assert.ok(!isCollectCdpFailure(cdpFail));
    assert.ok(!shouldRetryCollect(cdpFail, 0));
    console.log("scroll not cdp restart PASS");
  }

  {
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: { fetchedFromScreen: 15, newPosts: 2, totalStored: 100 },
      scrollRecovery: buildScrollRecovery({
        scrollingAttempts: 2,
        scrollTimeoutAt: 4,
        scrollRecovered: true,
        lastSuccessfulScroll: 15,
      }),
    });
    const report = buildMorningHealthReport({
      startedAt: "2026-08-27T03:00:00.000Z",
      finishedAt: "2026-08-27T03:02:00.000Z",
      status: "SUCCESS",
      stages: [
        {
          id: "collect",
          ok: true,
          itemCount: 100,
          collectorHealth: health,
          lastStage: "save",
          scrollRecovery: health.scrollRecovery,
        },
      ],
      collectorHealth: health,
      scrollRecovery: health.scrollRecovery,
      collectorPreflight: {
        status: "healthy",
        cdpAvailable: true,
        playwrightConnected: true,
        xHomeAvailable: true,
        chromeRestarted: false,
        attempts: 1,
      },
      publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
    });
    assert.strictEqual(report.scrollRecovery.scrollRecovered, true);
    assert.strictEqual(report.scrollRecovery.scrollingAttempts, 2);
    assert.strictEqual(report.scrollRecovery.scrollTimeoutAt, 4);
    assert.strictEqual(report.scrollRecovery.lastSuccessfulScroll, 15);
    const summary = formatMorningPipelineSummary(report, "hist.json");
    assert.ok(summary.includes("Scroll: Recovered"));
    assert.ok(summary.includes("Retry: 1"));
    assert.ok(summary.includes("CDP: OK"));
    assert.ok(summary.includes("Chrome Restart: No"));
    const dash = collectorHealthForDashboard(report);
    assert.strictEqual(dash.scroll, "Recovered");
    assert.strictEqual(dash.scrollRetry, 1);
    assert.strictEqual(dash.cdp, "OK");
    assert.strictEqual(dash.chromeRestart, "No");
    console.log("scroll history launcher PASS");
  }

  console.log("collect-scroll-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
