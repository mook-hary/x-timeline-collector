/**
 * EP-031 — Chrome CDP connection helpers.
 * Does not launch Chrome or open real CDP.
 * Run: node test/connect-test.js
 */
const assert = require("assert");
const {
  CDP_URL,
  connectToChrome,
  ensureHomePage,
} = require("../connect");

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
    assert.deepStrictEqual(calls[0].options, { noDefaults: true });
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

  console.log("connect-test PASS");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
