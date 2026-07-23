const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { writeJsonAtomic } = require("./lib/pipeline-io");

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
 * Always includes all six keys; missing values become "".
 * Does not mutate or upgrade existing/legacy posts.
 */
function toCanonicalNewPost(post, collectedAt) {
  return {
    authorName: post.authorName == null ? "" : String(post.authorName),
    authorHandle: post.authorHandle == null ? "" : String(post.authorHandle),
    postedAt: post.postedAt == null ? "" : String(post.postedAt),
    text: post.text == null ? "" : String(post.text),
    url: post.url == null ? "" : String(post.url),
    collectedAt: collectedAt == null ? "" : String(collectedAt),
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

  const context = contexts[0] || (await browser.newContext());
  page = await context.newPage();
  await page.goto("https://x.com/home");
  console.log("X のページが見つからなかったため、https://x.com/home を開きました。");
  return page;
}

async function extractVisiblePosts(page) {
  return page.evaluate(() => {
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
    });
  }
}

async function scrollDownSlowly(page) {
  const distance = Math.floor(randomBetween(700, 1000));

  await page.evaluate(async (distance) => {
    const step = 40;
    const stepDelayMs = 45;
    let scrolled = 0;

    while (scrolled < distance) {
      const amount = Math.min(step, distance - scrolled);
      window.scrollBy(0, amount);
      scrolled += amount;
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }
  }, distance);
}

async function collectPosts(page) {
  await page.waitForSelector("article", { timeout: 30000 });

  console.log("スクロール前に2秒待機します...");
  await sleep(2000);

  const posts = [];
  const seen = new Set();

  mergeFetchedPosts(posts, seen, await extractVisiblePosts(page));
  console.log(`初期表示・現在${posts.length}件`);

  for (let i = 1; i <= MAX_SCROLLS; i++) {
    if (posts.length >= MAX_POSTS) {
      console.log(`${MAX_POSTS}件に達したためスクロールを終了します。`);
      break;
    }

    await scrollDownSlowly(page);
    await sleep(randomBetween(1500, 2500));

    mergeFetchedPosts(posts, seen, await extractVisiblePosts(page));
    console.log(`スクロール${i}回目・現在${posts.length}件`);
  }

  return posts.slice(0, MAX_POSTS);
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

(async () => {
  const cli = parseConnectArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const existingPosts = loadExistingPosts();
  console.log(`既存投稿: ${existingPosts.length} 件`);

  let browser;

  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (error) {
    console.error(
      "Chrome への接続に失敗しました。リモートデバッグモードで起動しているか確認してください。\n" +
        `接続先: ${CDP_URL}\n` +
        `詳細: ${error.message}`
    );
    process.exit(1);
  }

  try {
    const page = await ensureHomePage(browser);
    const fetchedPosts = await collectPosts(page);
    const collectedAt = new Date().toISOString();
    const { merged, fetchedCount, addedCount, duplicateCount, newPosts } =
      mergeWithExisting(existingPosts, fetchedPosts, collectedAt);

    savePosts(merged);

    printCollectionSummary({
      fetchedCount,
      newPosts,
      duplicateCount,
      totalCount: merged.length,
    });
    console.log(`今回新しく追加した件数: ${addedCount}`);
    console.log(`JSON保存先: ${OUTPUT_FILE}`);
    console.log(`CSV保存先: ${OUTPUT_CSV_FILE}`);

    if (cli.once) {
      process.exit(0);
    }

    // Do not close the browser; keep the Node process alive
    await new Promise(() => {});
  } catch (error) {
    console.error(`タイムラインの取得に失敗しました: ${error.message}`);
    process.exit(1);
  }
})();
