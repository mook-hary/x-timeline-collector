const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { writeJsonAtomic } = require("./lib/pipeline-io");
const {
  AUTH_ERROR,
  DEFAULT_STALE_MS,
  assessXSession,
  buildCollectMetrics,
  newestPostedAt,
  assessTimelineFreshness,
  buildCollectorHealth,
  formatCollectHealthLine,
} = require("./lib/x-collector-health");
const {
  COLLECT_STAGES,
  createCollectStageTracker,
} = require("./lib/collect-stage");
const {
  DEFAULT_CDP_CONNECT_TIMEOUT_MS,
  CDP_CONNECT_TIMEOUT,
  CDP_NOT_AVAILABLE,
} = require("./lib/collector-preflight");
const {
  SCROLL_TIMEOUT,
  DEFAULT_SCROLL_ITERATION_TIMEOUT_MS,
  runScrollingWithRecovery,
} = require("./lib/collect-scroll");
const {
  HOME_REFRESH_TIMEOUT,
  refreshXHomePage,
  refreshHomeThenCheckLogin,
} = require("./lib/collect-home-refresh");
const { saveDailyScope, buildDailyScope } = require("./lib/daily-scope");
const { canonicalizeMediaList } = require("./lib/tweet-media");

const TWEET_MEDIA_JS = fs.readFileSync(
  path.join(__dirname, "lib", "tweet-media.js"),
  "utf8"
);

const CDP_URL = "http://localhost:9222";
const MAX_POSTS = 50;
const MAX_SCROLLS = 15;
const OUTPUT_DIR = path.join(__dirname, "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "timeline.json");
const OUTPUT_CSV_FILE = path.join(OUTPUT_DIR, "timeline.csv");
const CSV_COLUMNS = [
  "authorName",
  "authorHandle",
  "postedAt",
  "text",
  "url",
  "collectedAt",
];

function printHelp() {
  console.log(`x-timeline-collector Collect (connect.js)

Usage:
  node connect.js [--once]
  node connect.js --help

Options:
  --once     Save JSON/CSV then exit (exit 0). For Morning / automation.
  --help, -h Show this help (does not collect)

Input:
  Existing output/timeline.json (merged by URL). Optional.

Output:
  output/timeline.json
  output/timeline.csv

API:
  None (OpenAI not used)

Chrome:
  Required. Start Google Chrome with remote debugging on port 9222,
  logged in to https://x.com/home.

  Example:
    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
      --remote-debugging-port=9222 \\
      --user-data-dir="$HOME/chrome-debug-profile"

Notes:
  Without --once, the process stays attached after save (Ctrl+C to stop).
  Max ${MAX_POSTS} posts / max ${MAX_SCROLLS} scrolls per run.
`);
}

function parseConnectArgs(argv) {
  const options = { help: false, once: false };
  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--once") {
      options.once = true;
      continue;
    }
    console.error(`不明なオプション: ${token}`);
    process.exit(1);
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function isXHomePage(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com\/home(\/|\?|$)/.test(url || "");
}

function isXPage(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com(\/|$)/.test(url || "");
}

function loadExistingPosts() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    return [];
  }

  let raw;
  try {
    raw = fs.readFileSync(OUTPUT_FILE, "utf8");
  } catch (error) {
    console.error(`既存ファイルの読み込みに失敗しました: ${error.message}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(
      "output/timeline.json の JSON が壊れているため、上書きせず終了します。\n" +
        "ファイルを確認または修復してから再実行してください。\n" +
        `詳細: ${error.message}`
    );
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error(
      "output/timeline.json の形式が不正です（配列ではありません）。上書きせず終了します。"
    );
    process.exit(1);
  }

  return data;
}

/**
 * Canonical Raw post for newly collected items.
 * Always includes the original six keys; missing values become "".
 * `media` is always an array (empty when none). Legacy stored posts are not backfilled.
 */
function toCanonicalNewPost(post, collectedAt) {
  return {
    authorName: post.authorName == null ? "" : String(post.authorName),
    authorHandle: post.authorHandle == null ? "" : String(post.authorHandle),
    postedAt: post.postedAt == null ? "" : String(post.postedAt),
    text: post.text == null ? "" : String(post.text),
    url: post.url == null ? "" : String(post.url),
    collectedAt: collectedAt == null ? "" : String(collectedAt),
    media: canonicalizeMediaList(post && post.media),
  };
}

function countEmptyField(posts, field) {
  return posts.filter((post) => !String(post[field] || "").trim()).length;
}

function printCollectionSummary({
  fetchedCount,
  newPosts,
  duplicateCount,
  totalCount,
}) {
  console.log("");
  console.log("Collection Summary");
  console.log(`Fetched from screen: ${fetchedCount}`);
  console.log(`New posts: ${newPosts.length}`);
  console.log(`Missing authorName: ${countEmptyField(newPosts, "authorName")}`);
  console.log(
    `Missing authorHandle: ${countEmptyField(newPosts, "authorHandle")}`
  );
  console.log(`Missing postedAt: ${countEmptyField(newPosts, "postedAt")}`);
  console.log(`Duplicate URLs skipped: ${duplicateCount}`);
  console.log(`Total posts after save: ${totalCount}`);
}

function mergeWithExisting(existingPosts, fetchedPosts, collectedAt) {
  const existingUrls = new Set(
    existingPosts.map((post) => post.url).filter(Boolean)
  );

  // Keep legacy objects as-is (no schema backfill on existing rows).
  const newPosts = [];
  let duplicateCount = 0;

  for (const post of fetchedPosts) {
    const canonical = toCanonicalNewPost(post, collectedAt);
    if (!canonical.url) {
      continue;
    }
    if (existingUrls.has(canonical.url)) {
      duplicateCount++;
      continue;
    }
    existingUrls.add(canonical.url);
    newPosts.push(canonical);
  }

  return {
    merged: [...newPosts, ...existingPosts],
    fetchedCount: fetchedPosts.length,
    addedCount: newPosts.length,
    duplicateCount,
    newPosts,
  };
}

async function ensureHomePage(browser) {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());

  console.log(`接続成功。開いているページ数: ${pages.length}`);
  for (const [i, page] of pages.entries()) {
    console.log(`  [${i}] ${page.url()}`);
  }

  let page = pages.find((p) => isXHomePage(p.url()));

  if (page) {
    console.log(`X ホームを選択しました: ${page.url()}`);
    await page.bringToFront();
    return page;
  }

  page = pages.find((p) => isXPage(p.url()));
  if (page) {
    console.log(`X のページをホームへ移動します: ${page.url()}`);
    await page.bringToFront();
    await page.goto("https://x.com/home");
    return page;
  }

  const context = contexts[0];
  if (!context) {
    throw new Error(
      "CDP 接続先に BrowserContext がありません。" +
        "リモートデバッグ中の Chrome で少なくとも1つのウィンドウ／タブを開いてから再実行してください。"
    );
  }

  page = await context.newPage();
  await page.goto("https://x.com/home");
  console.log("X のページが見つからなかったため、https://x.com/home を開きました。");
  return page;
}

async function connectToChrome(browserType = chromium, cdpUrl = CDP_URL, options = {}) {
  const timeout =
    options.timeout != null
      ? Number(options.timeout)
      : DEFAULT_CDP_CONNECT_TIMEOUT_MS;
  return browserType.connectOverCDP(cdpUrl, {
    noDefaults: true,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CDP_CONNECT_TIMEOUT_MS,
  });
}

async function extractVisiblePosts(page) {
  try {
    await page.evaluate(TWEET_MEDIA_JS);
  } catch (_error) {
    // Media helpers are optional; text collection still proceeds.
  }

  return page.evaluate(() => {
    const extractMedia =
      globalThis.__xTweetMedia &&
      typeof globalThis.__xTweetMedia.extractMediaFromArticle === "function"
        ? globalThis.__xTweetMedia.extractMediaFromArticle
        : () => [];
    const articles = Array.from(document.querySelectorAll("article"));
    const results = [];

    for (const article of articles) {
      const link = article.querySelector('a[href*="/status/"]');
      if (!link) continue;

      const href = link.getAttribute("href") || "";
      const match = href.match(/(\/([^/?#]+)\/status\/\d+)/);
      if (!match) continue;

      const statusPath = match[1];
      const url = new URL(statusPath, location.origin).href;

      let authorHandle = match[2] ? `@${match[2]}` : "";
      let authorName = "";

      const userNameEl = article.querySelector('[data-testid="User-Name"]');
      if (userNameEl) {
        const spans = Array.from(userNameEl.querySelectorAll("span"));
        for (const span of spans) {
          const t = (span.textContent || "").trim();
          if (!t || t === "·") continue;
          if (t.startsWith("@")) {
            authorHandle = t;
            continue;
          }
          if (!authorName && !span.querySelector("span")) {
            authorName = t;
          }
        }

        if (!authorName) {
          const firstLink = userNameEl.querySelector("a");
          const nameText = firstLink
            ? (firstLink.textContent || "").trim()
            : "";
          if (nameText && !nameText.startsWith("@")) {
            authorName = nameText;
          }
        }
      }

      const timeEl = article.querySelector("time");
      const postedAt = timeEl ? timeEl.getAttribute("datetime") || "" : "";

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText.trim() : "";

      results.push({
        authorName,
        authorHandle,
        postedAt,
        text,
        url,
        media: extractMedia(article),
      });
    }

    return results;
  });
}

function mergeFetchedPosts(posts, seen, rawPosts) {
  for (const post of rawPosts) {
    if (posts.length >= MAX_POSTS) break;
    const url = post.url == null ? "" : String(post.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // collectedAt is applied at merge/save time for new posts only.
    posts.push({
      authorName: post.authorName == null ? "" : String(post.authorName),
      authorHandle: post.authorHandle == null ? "" : String(post.authorHandle),
      postedAt: post.postedAt == null ? "" : String(post.postedAt),
      text: post.text == null ? "" : String(post.text),
      url,
      media: canonicalizeMediaList(post.media),
    });
  }
}

async function scrollDownSlowly(page) {
  const distance = Math.floor(randomBetween(700, 1000));
  await page.evaluate((deltaY) => {
    window.scrollBy(0, deltaY);
  }, distance);
}

async function collectPosts(page, tracker, options = {}) {
  await page.waitForSelector("article", { timeout: 30000 });

  const posts = [];
  const seen = new Set();

  mergeFetchedPosts(posts, seen, await extractVisiblePosts(page));
  if (tracker) tracker.mark(COLLECT_STAGES.INITIAL_POSTS);
  console.log(`初期表示・現在${posts.length}件`);

  if (tracker) tracker.mark(COLLECT_STAGES.SCROLLING);
  const { scrollRecovery } = await runScrollingWithRecovery({
    page,
    browser: options.browser,
    posts,
    seen,
    maxScrolls: MAX_SCROLLS,
    maxPosts: MAX_POSTS,
    iterationTimeoutMs:
      options.iterationTimeoutMs != null
        ? options.iterationTimeoutMs
        : DEFAULT_SCROLL_ITERATION_TIMEOUT_MS,
    scrollDown: options.scrollDownSlowly || scrollDownSlowly,
    waitAfterScroll:
      options.waitAfterScroll || (() => sleep(randomBetween(1500, 2500))),
    extractPosts: options.extractVisiblePosts || extractVisiblePosts,
    mergePosts: mergeFetchedPosts,
    ensureHomePage: options.ensureHomePage || ensureHomePage,
    assessSession: options.assessXSession || assessXSession,
    log: (line) => console.log(line),
  });

  return {
    posts: posts.slice(0, MAX_POSTS),
    scrollRecovery,
  };
}

function escapeCsvValue(value) {
  const str = value == null ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(posts) {
  const lines = [CSV_COLUMNS.join(",")];

  for (const post of posts) {
    const row = CSV_COLUMNS.map((column) =>
      escapeCsvValue(post[column] ?? "")
    );
    lines.push(row.join(","));
  }

  return lines.join("\n") + "\n";
}

function savePosts(posts) {
  writeJsonAtomic(OUTPUT_FILE, posts);
  // UTF-8 BOM for Excel / spreadsheet compatibility
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_CSV_FILE, "\uFEFF" + toCsv(posts), "utf8");
}

async function main() {
  const cli = parseConnectArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const existingPosts = loadExistingPosts();
  console.log(`既存投稿: ${existingPosts.length} 件`);

  const tracker = createCollectStageTracker((line) => console.error(line));
  let browser;

  tracker.mark(COLLECT_STAGES.CDP_CONNECT);
  try {
    browser = await connectToChrome();
  } catch (error) {
    tracker.writeLast();
    const msg = String((error && error.message) || "");
    const code = /timeout|timed out/i.test(msg)
      ? CDP_CONNECT_TIMEOUT
      : /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)
        ? CDP_NOT_AVAILABLE
        : null;
    console.error(
      "Chrome への接続に失敗しました。リモートデバッグモードで起動しているか確認してください。\n" +
        `接続先: ${CDP_URL}\n` +
        `詳細: ${error.message}`
    );
    if (code) console.error(`ERROR: ${code}`);
    process.exit(1);
  }

  let homeRefresh = null;
  try {
    tracker.mark(COLLECT_STAGES.CONTEXT_ACQUIRED);
    const page = await ensureHomePage(browser);
    tracker.mark(COLLECT_STAGES.X_HOME_SELECTED);
    const refreshed = await refreshHomeThenCheckLogin(page, {
      assessXSession,
      mark: (stage) => tracker.mark(stage),
    });
    homeRefresh = refreshed.homeRefresh;
    const session = refreshed.session;
    if (!session.authenticated || session.error === AUTH_ERROR) {
      const failedHealth = buildCollectorHealth({
        authenticated: false,
        timelineAvailable: false,
        status: "failed",
        error: AUTH_ERROR,
        reason: session.reason,
        homeRefresh,
      });
      tracker.writeLast();
      console.error(formatCollectHealthLine(failedHealth));
      console.error(`ERROR: ${AUTH_ERROR}`);
      console.error(
        "X にログインしていないか、Home Timeline を取得できません。" +
          "古い timeline.json は更新せず終了します。"
      );
      process.exit(1);
    }

    const collected = await collectPosts(page, tracker, { browser });
    const fetchedPosts = collected.posts;
    const scrollRecovery = collected.scrollRecovery;
    const collectedAt = new Date().toISOString();
    const { merged, fetchedCount, addedCount, duplicateCount, newPosts } =
      mergeWithExisting(existingPosts, fetchedPosts, collectedAt);

    tracker.mark(COLLECT_STAGES.SAVE);
    savePosts(merged);
    saveDailyScope(__dirname, buildDailyScope({
      collectedAt,
      fetchedFromScreen: fetchedCount,
      newPosts: addedCount,
      duplicateUrlsSkipped: duplicateCount,
      totalStored: merged.length,
      posts: newPosts,
    }));
    console.log(`Daily editorial scope: ${addedCount}`);

    const newest = newestPostedAt(fetchedPosts) || newestPostedAt(newPosts);
    const collect = buildCollectMetrics({
      fetchedFromScreen: fetchedCount,
      newPosts: addedCount,
      duplicateUrlsSkipped: duplicateCount,
      totalStored: merged.length,
      missingPostedAt: countEmptyField(newPosts, "postedAt"),
      newestPostAt: newest,
    });
    const staleMs =
      process.env.X_TIMELINE_STALE_MS != null
        ? Number(process.env.X_TIMELINE_STALE_MS)
        : DEFAULT_STALE_MS;
    const freshness = assessTimelineFreshness(newest, collectedAt, staleMs);
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect,
      warnings: freshness.warnings,
      status: freshness.warnings.length ? "warning" : "healthy",
      scrollRecovery,
      homeRefresh,
    });

    printCollectionSummary({
      fetchedCount,
      newPosts,
      duplicateCount,
      totalCount: merged.length,
    });
    console.log(`今回新しく追加した件数: ${addedCount}`);
    if (newest) console.log(`Newest postedAt: ${newest}`);
    if (freshness.warnings.includes("X_TIMELINE_STALE")) {
      console.log(`WARNING: X_TIMELINE_STALE (newestPostAt=${newest})`);
    }
    if (scrollRecovery && scrollRecovery.scrollRecovered) {
      console.log(
        `Scroll recovered after SCROLL_TIMEOUT iteration=${scrollRecovery.scrollTimeoutAt}`
      );
    }
    console.log(formatCollectHealthLine(health));
    console.log(`JSON保存先: ${OUTPUT_FILE}`);
    console.log(`CSV保存先: ${OUTPUT_CSV_FILE}`);

    if (cli.once) {
      process.exit(0);
    }

    // Do not close the browser; keep the Node process alive
    await new Promise(() => {});
  } catch (error) {
    tracker.writeLast();
    if (error && error.code === AUTH_ERROR) {
      const failedHealth = buildCollectorHealth({
        authenticated: false,
        timelineAvailable: false,
        status: "failed",
        error: AUTH_ERROR,
        scrollRecovery: error.scrollRecovery || null,
        homeRefresh,
      });
      console.error(formatCollectHealthLine(failedHealth));
      console.error(`ERROR: ${AUTH_ERROR}`);
      process.exit(1);
    }
    if (error && error.code === HOME_REFRESH_TIMEOUT) {
      const failedHealth = buildCollectorHealth({
        authenticated: false,
        timelineAvailable: false,
        status: "failed",
        error: HOME_REFRESH_TIMEOUT,
        homeRefresh: {
          homeRefreshed: false,
          homeRefreshedAt: null,
        },
      });
      console.error(formatCollectHealthLine(failedHealth));
      console.error(`ERROR: ${HOME_REFRESH_TIMEOUT}`);
      process.exit(1);
    }
    if (error && error.code === SCROLL_TIMEOUT) {
      const failedHealth = buildCollectorHealth({
        authenticated: true,
        timelineAvailable: true,
        status: "failed",
        error: SCROLL_TIMEOUT,
        scrollRecovery: error.scrollRecovery || null,
        homeRefresh,
      });
      console.error(formatCollectHealthLine(failedHealth));
      console.error(`ERROR: ${SCROLL_TIMEOUT}`);
      if (error.iteration != null) {
        console.error(`SCROLL_TIMEOUT iteration=${error.iteration}`);
      }
      process.exit(1);
    }
    console.error(`タイムラインの取得に失敗しました: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CDP_URL,
  connectToChrome,
  ensureHomePage,
  isXHomePage,
  isXPage,
  parseConnectArgs,
  assessXSession,
  mergeWithExisting,
  mergeFetchedPosts,
  toCanonicalNewPost,
  buildCollectMetrics,
  newestPostedAt,
  buildCollectorHealth,
  AUTH_ERROR,
  COLLECT_STAGES,
  createCollectStageTracker,
  DEFAULT_CDP_CONNECT_TIMEOUT_MS,
  SCROLL_TIMEOUT,
  DEFAULT_SCROLL_ITERATION_TIMEOUT_MS,
  collectPosts,
  scrollDownSlowly,
  refreshXHomePage,
  refreshHomeThenCheckLogin,
  HOME_REFRESH_TIMEOUT,
};
