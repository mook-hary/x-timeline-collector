/**
 * EP-031 — Chrome CDP connection helpers.
 * Does not launch Chrome or open real CDP.
 * Run: node test/connect-test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  CDP_URL,
  connectToChrome,
  ensureHomePage,
  assessXSession,
  AUTH_ERROR,
  COLLECT_STAGES,
  createCollectStageTracker,
  scrollDownSlowly,
} = require("../connect");
const { parseCollectLastStage } = require("../lib/collect-stage");

function makePage(url) {
  return {
    url: () => url,
    bringToFront: async () => {},
    goto: async (target) => {
      makePage.lastGoto = target;
      url = target;
    },
  };
}

function makeContext(pages = []) {
  const context = {
    pages: () => pages,
    newPage: async () => {
      const page = makePage("about:blank");
      pages.push(page);
      context.lastNewPage = page;
      return page;
    },
  };
  return context;
}

function makeBrowser(contexts) {
  return {
    contexts: () => contexts,
    newContext: async () => {
      makeBrowser.newContextCalls += 1;
      throw new Error("browser.newContext() must not be called");
    },
  };
}
makeBrowser.newContextCalls = 0;

async function run() {
  // --- connectOverCDP receives noDefaults: true ---
  {
    const calls = [];
    const fakeChromium = {
      connectOverCDP: async (url, options) => {
        calls.push({ url, options });
        return { ok: true };
      },
    };

    const browser = await connectToChrome(fakeChromium, "http://localhost:9222");
    assert.deepStrictEqual(browser, { ok: true });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "http://localhost:9222");
    assert.deepStrictEqual(calls[0].options, {
      noDefaults: true,
      timeout: 20000,
    });
    assert.strictEqual(CDP_URL, "http://localhost:9222");
    console.log("connectOverCDP noDefaults PASS");
  }

  // --- reuse existing X home page ---
  {
    makeBrowser.newContextCalls = 0;
    const home = makePage("https://x.com/home");
    const context = makeContext([home, makePage("https://example.com")]);
    const browser = makeBrowser([context]);

    const page = await ensureHomePage(browser);
    assert.strictEqual(page, home);
    assert.strictEqual(makeBrowser.newContextCalls, 0);
    assert.strictEqual(context.lastNewPage, undefined);
    console.log("reuse X home PASS");
  }

  // --- reuse existing non-home X page (navigates to home) ---
  {
    makeBrowser.newContextCalls = 0;
    const xPage = makePage("https://x.com/notifications");
    const context = makeContext([xPage]);
    const browser = makeBrowser([context]);

    const page = await ensureHomePage(browser);
    assert.strictEqual(page, xPage);
    assert.strictEqual(makePage.lastGoto, "https://x.com/home");
    assert.strictEqual(makeBrowser.newContextCalls, 0);
    console.log("reuse X page PASS");
  }

  // --- no X page: create page on existing context ---
  {
    makeBrowser.newContextCalls = 0;
    makePage.lastGoto = null;
    const context = makeContext([makePage("https://example.com")]);
    const browser = makeBrowser([context]);

    const page = await ensureHomePage(browser);
    assert.ok(context.lastNewPage);
    assert.strictEqual(page, context.lastNewPage);
    assert.strictEqual(makePage.lastGoto, "https://x.com/home");
    assert.strictEqual(makeBrowser.newContextCalls, 0);
    console.log("newPage on existing context PASS");
  }

  // --- no context: clear failure, no newContext ---
  {
    makeBrowser.newContextCalls = 0;
    const browser = makeBrowser([]);

    await assert.rejects(
      () => ensureHomePage(browser),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /BrowserContext/);
        assert.match(error.message, /リモートデバッグ|ウィンドウ|タブ/);
        return true;
      }
    );
    assert.strictEqual(makeBrowser.newContextCalls, 0);
    console.log("missing context fails clearly PASS");
  }

  // --- COLLECT-HEALTH: session probe on home ---
  {
    const page = makePage("https://x.com/home");
    page.evaluate = async () => ({
      hasArticles: true,
      loginHints: false,
      homeChrome: true,
    });
    page.waitForSelector = async () => true;
    const session = await assessXSession(page);
    assert.strictEqual(session.authenticated, true);
    assert.strictEqual(session.error, null);
    console.log("session login-ok PASS");
  }

  // --- COLLECT-HEALTH: login wall ---
  {
    const page = makePage("https://x.com/i/flow/login");
    page.evaluate = async () => ({
      hasArticles: false,
      loginHints: true,
      homeChrome: false,
    });
    page.waitForSelector = async () => {
      throw new Error("timeout");
    };
    const session = await assessXSession(page, { waitTimeoutMs: 10 });
    assert.strictEqual(session.authenticated, false);
    assert.strictEqual(session.error, AUTH_ERROR);
    console.log("session auth-required PASS");
  }

  // --- stage tracker last-stage ---
  {
    const lines = [];
    const tracker = createCollectStageTracker((line) => lines.push(line));
    tracker.mark(COLLECT_STAGES.CDP_CONNECT);
    tracker.mark(COLLECT_STAGES.CONTEXT_ACQUIRED);
    tracker.writeLast();
    assert.strictEqual(tracker.lastStage, "context_acquired");
    assert.ok(lines.includes("COLLECT_STAGE:cdp_connect"));
    assert.ok(lines.includes("COLLECT_LAST_STAGE:context_acquired"));
    const parsed = parseCollectLastStage(lines.join("\n"));
    assert.strictEqual(parsed, "context_acquired");
    console.log("collect stage tracker PASS");
  }

  // --- COLLECT-SCROLL-STABILITY: short scroll, no page-context timer ---
  {
    const connectSrc = fs.readFileSync(
      path.join(__dirname, "../connect.js"),
      "utf8"
    );
    const start = connectSrc.indexOf("async function scrollDownSlowly");
    const end = connectSrc.indexOf("async function collectPosts");
    assert.ok(start >= 0 && end > start);
    const body = connectSrc.slice(start, end);
    assert.ok(!body.includes("setTimeout"));
    assert.ok(!body.includes("stepDelayMs"));
    assert.ok(body.includes("scrollBy"));
    assert.ok(!body.includes("mouse.wheel"));

    const calls = [];
    const page = {
      evaluate: async (fn, arg) => {
        calls.push({
          source: Function.prototype.toString.call(fn),
          arg,
          ctor: fn.constructor.name,
        });
        assert.strictEqual(fn.constructor.name, "Function");
        return undefined;
      },
    };
    await scrollDownSlowly(page);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].arg >= 700 && calls[0].arg <= 1000);
    assert.ok(!/setTimeout/.test(calls[0].source));
    assert.ok(!/async\s*\(/.test(calls[0].source));
    assert.ok(calls[0].source.includes("scrollBy"));
    console.log("scrollDownSlowly short evaluate PASS");
  }

  console.log("connect-test PASS");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
