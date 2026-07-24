/**
 * EP-022/023/024/028 — Local Digest Reader HTML builder.
 * Reuses digest.js filters (buildDigest). Today's Picks via rankEditorialPosts.
 * No AI. Writes only under output/digest-reader/.
 */

const fs = require("fs");
const path = require("path");
const { resolveLocalDateRange } = require("./date-range");
const { readJsonArrayRequired, ensureDir } = require("./pipeline-io");
const {
  getImportance,
  getPersonalScore,
  buildDigestSelection,
} = require("./digest-core");
const { buildDigest, loadConfig } = require("../digest");
const { DIGEST_READER_CSS } = require("./digest-reader-css");
const {
  rankEditorialPosts,
  getImportanceOrNull,
  getSummary,
  getReason,
  getCategory,
  getUrl,
} = require("./editorial-score");
const { buildTodayBrief } = require("./today-brief");
const {
  HISTORY_REL,
  loadHistory,
} = require("./api-usage-history");
const {
  buildUsageDashboard,
  renderUsageDashboard,
} = require("./usage-dashboard");

const DEFAULT_TOP = 5;
const DEFAULT_REL_OUTPUT = path.join("output", "digest-reader");
const NAV_CATEGORY_LIMIT = 5;

function fail(message) {
  const err = new Error(message);
  err.code = "digest-reader";
  throw err;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subtle importance marks: filled stars only, spaced. */
function formatStars(importance) {
  const value = Number(importance);
  const filled = Number.isInteger(value) ? Math.min(5, Math.max(0, value)) : 0;
  if (filled <= 0) return "・";
  return Array.from({ length: filled }, () => "★").join(" ");
}

function formatDateLabel(digest) {
  if (digest._labelFrom || digest._labelTo) {
    const fromLabel = digest._labelFrom || "(開始指定なし)";
    const toLabel = digest._labelTo || "(終了指定なし)";
    if (digest._rangeMode === "today") {
      return toLabel || fromLabel;
    }
    return `${fromLabel} 〜 ${toLabel}`;
  }
  return "全期間";
}

function formatGeneratedAt(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "(生成時刻不明)";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function selectedCount(digest) {
  const picks = Array.isArray(digest.todaysPicks) ? digest.todaysPicks.length : 0;
  const categories = Array.isArray(digest.categories) ? digest.categories : [];
  let categoryDisplayed = 0;
  for (const group of categories) {
    categoryDisplayed += Array.isArray(group.posts) ? group.posts.length : 0;
  }
  return {
    topCount: picks,
    categoryDisplayed,
    overviewSelected: picks,
  };
}

function categoriesWithCounts(digest) {
  const groups = Array.isArray(digest.categories) ? digest.categories : [];
  return groups
    .map((g, index) => ({
      category: String(g.category || "その他"),
      count: Number(g.count) || 0,
      index,
    }))
    .filter((g) => g.count > 0);
}

function categoriesByCountDesc(digest) {
  return [...categoriesWithCounts(digest)].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.category.localeCompare(b.category, "ja");
  });
}

/** Deterministic reading-time estimate: Picks-first skim + light category scan. */
function estimateReadingMinutes(digest) {
  const picks = Array.isArray(digest.todaysPicks) ? digest.todaysPicks : [];
  let pickChars = 0;
  for (const post of picks) {
    pickChars += String(post?.summary || "").length;
    pickChars += String(post?.text || "").length;
  }
  const pickMin = Math.max(
    picks.length === 0 ? 0 : 1,
    Math.ceil(pickChars / 400),
    Math.ceil(picks.length * 0.7)
  );

  let categoryDisplayed = 0;
  for (const group of digest.categories || []) {
    categoryDisplayed += Array.isArray(group.posts) ? group.posts.length : 0;
  }
  const scanMin =
    categoryDisplayed === 0 ? 0 : Math.max(1, Math.ceil(categoryDisplayed * 0.12));
  return Math.max(1, pickMin + scanMin);
}

function categoryAnchorId(index) {
  return `category-${index}`;
}

function normalizeCompareText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when summary and body are the same or nearly the same. */
function isNearlySameText(a, b) {
  const left = normalizeCompareText(a);
  const right = normalizeCompareText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (!longer.includes(shorter)) return false;
  return shorter.length / longer.length >= 0.9;
}

function isPlaceholderSummary(summary) {
  const value = String(summary || "").trim();
  if (!value) return true;
  return value === "要約なし";
}

function isValidHttpUrl(url) {
  const href = String(url || "").trim();
  if (!href || href === "(なし)") return false;
  return /^https?:\/\//i.test(href);
}

function renderSourceAction(url, { onlyIfPresent = false } = {}) {
  if (!isValidHttpUrl(url)) {
    if (onlyIfPresent) return "";
    return `<p class="card__actions"><span class="btn-source--missing">リンクなし</span></p>`;
  }
  return `<p class="card__actions"><a class="btn-source" href="${escapeHtml(
    String(url).trim()
  )}" rel="noopener noreferrer" target="_blank" aria-label="元の投稿をXで読む">Xで読む ↗</a></p>`;
}

/**
 * Build Today's Picks from filter-applied posts.
 * Does not drop posts solely for missing importance.
 *
 * @param {object[]} filteredPosts
 * @param {number} topN
 * @param {object} [config]
 * @returns {object[]}
 */
function selectTodaysPicks(filteredPosts, topN, config = null) {
  const limit = Math.max(0, Number(topN) || DEFAULT_TOP);
  const list = Array.isArray(filteredPosts) ? filteredPosts : [];
  if (list.length === 0 || limit === 0) return [];

  const ranked = rankEditorialPosts(list, (post) => {
    if (!config) return {};
    return { personalScore: getPersonalScore(post, config) };
  });

  return ranked.slice(0, Math.min(limit, ranked.length)).map((item) => {
    const post = item.post;
    const importance = getImportanceOrNull(post);
    return {
      category: getCategory(post),
      summary: getSummary(post),
      text: String(post.text || "").trim(),
      reason: getReason(post),
      importance,
      url: getUrl(post),
      // kept internally for tests; never rendered
      _editorialScore: item.editorialScore,
    };
  });
}

function renderPickCard(post) {
  const category = String(post.category || "その他");
  const summary = String(post.summary || "").trim();
  const text = String(post.text || "").trim();
  const reason = String(post.reason || "").trim();
  const importance = post.importance;
  const hasSummary = !isPlaceholderSummary(summary);
  const showBody =
    Boolean(text) && (!hasSummary || !isNearlySameText(summary, text));

  // Title = enrichment summary (or text fallback). Summary = distinct body text.
  const title = hasSummary ? summary : text;
  const dek = hasSummary && showBody ? text : "";

  const parts = [`<p class="card__category">${escapeHtml(category)}</p>`];
  if (title) {
    parts.push(`<p class="card__title">${escapeHtml(title)}</p>`);
  }
  if (dek) {
    parts.push(`<p class="card__summary">${escapeHtml(dek)}</p>`);
  }
  if (reason) {
    parts.push(`<div class="card__why">
    <p class="card__why-label">注目した理由</p>
    <p class="card__why-text">${escapeHtml(reason)}</p>
  </div>`);
  }
  if (importance != null) {
    const stars = formatStars(importance);
    parts.push(
      `<p class="card__importance"><span class="card__importance-label">重要度</span> <span class="card__stars" aria-label="重要度 ${escapeHtml(
        String(importance)
      )}">${escapeHtml(stars)}</span></p>`
    );
  }
  const link = renderSourceAction(post.url, { onlyIfPresent: true });
  if (link) parts.push(link);

  return `<article class="card card--top card--pick">
  ${parts.join("\n  ")}
</article>`;
}

function renderCard(post) {
  const summary = String(post.summary || "要約なし");
  const category = String(post.category || "その他");
  const importance = post.importance;
  const hasImportance =
    importance != null && Number.isFinite(Number(importance));
  const importanceHtml = hasImportance
    ? `<p class="card__importance"><span class="card__importance-label">重要度</span> <span class="card__stars" aria-label="重要度 ${escapeHtml(
        String(importance)
      )}">${escapeHtml(formatStars(importance))}</span></p>`
    : "";
  return `<article class="card card--more">
  <p class="card__category">${escapeHtml(category)}</p>
  <p class="card__summary">${escapeHtml(summary)}</p>
  ${importanceHtml}
  ${renderSourceAction(post.url)}
</article>`;
}

function renderCategoryNav(digest) {
  const ranked = categoriesByCountDesc(digest);
  if (ranked.length === 0) return "";

  const primary = ranked.slice(0, NAV_CATEGORY_LIMIT);
  const hasMore = ranked.length > NAV_CATEGORY_LIMIT;

  const items = [
    `<li><a href="#todays-picks">Picks</a></li>`,
    ...primary.map(
      (c) =>
        `<li><a href="#${categoryAnchorId(c.index)}">${escapeHtml(
          c.category
        )} (${escapeHtml(String(c.count))})</a></li>`
    ),
  ];
  if (hasMore) {
    items.push(
      `<li><a class="cat-nav__more" href="#all-categories">すべてのカテゴリ</a></li>`
    );
  }

  return `<nav class="cat-nav" aria-label="主要カテゴリ">
  <p class="cat-nav__label">Categories</p>
  <ul class="cat-nav__list">
    ${items.join("\n    ")}
  </ul>
</nav>`;
}

function renderTodayBrief(digest) {
  const lines = Array.isArray(digest.todayBrief) ? digest.todayBrief : [];
  const listHtml =
    lines.length === 0
      ? `<p class="empty">条件に一致する投稿がありません</p>`
      : `<ul class="brief__lines">${lines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`;

  return `<section class="section section--brief" aria-labelledby="brief-label">
  <h2 class="section__label" id="brief-label">Morning Brief</h2>
  <div class="brief">
    ${listHtml}
  </div>
</section>`;
}

function renderTodaysPicks(digest) {
  const posts = Array.isArray(digest.todaysPicks) ? digest.todaysPicks : [];
  const body =
    posts.length === 0
      ? `<p class="empty">表示できる投稿がありません。<br>対象期間またはフィルタ条件を確認してください。</p>`
      : posts.map((p) => renderPickCard(p)).join("\n");
  return `<section class="section section--top" id="todays-picks" aria-labelledby="picks-label">
  <h2 class="section__label" id="picks-label">Today's Picks（${posts.length}）</h2>
  <div class="picks-list">
  ${body}
  </div>
</section>`;
}

/**
 * Category Digest — category index (counts only; same categories as More News).
 */
function renderCategoryDigest(digest) {
  const groups = Array.isArray(digest.categories) ? digest.categories : [];
  if (groups.length === 0) {
    return `<section class="section section--digest" id="category-digest" aria-labelledby="digest-label">
  <h2 class="section__label" id="digest-label">Category Digest</h2>
  <p class="empty">カテゴリ別の投稿はありませんでした。</p>
</section>`;
  }

  const items = groups
    .map((group, index) => {
      const href = `#${categoryAnchorId(index)}`;
      return `<li><a href="${href}"><span class="digest-index__name">${escapeHtml(
        group.category
      )}</span><span class="digest-index__count">${escapeHtml(
        String(group.count || 0)
      )}</span></a></li>`;
    })
    .join("\n    ");

  return `<section class="section section--digest" id="category-digest" aria-labelledby="digest-label">
  <h2 class="section__label" id="digest-label">Category Digest</h2>
  <ul class="digest-index">
    ${items}
  </ul>
</section>`;
}

/**
 * More News — category headings + compact cards (same posts as before).
 */
function renderMoreNews(digest) {
  const groups = Array.isArray(digest.categories) ? digest.categories : [];
  if (groups.length === 0) {
    return `<section class="section section--more" id="more-news" aria-labelledby="more-label">
  <h2 class="section__label" id="more-label">More News</h2>
  <div id="all-categories"></div>
</section>`;
  }

  const sections = groups
    .map((group, index) => {
      const posts = Array.isArray(group.posts) ? group.posts : [];
      const remaining = Math.max(0, Number(group.count || 0) - posts.length);
      const cards =
        posts.length === 0
          ? `<p class="empty">このカテゴリに表示投稿はありません。</p>`
          : posts.map((p) => renderCard(p)).join("\n");
      const more =
        remaining > 0
          ? `<p class="more-read-wrap"><a class="more-read" href="#category-digest">さらに${escapeHtml(
              String(remaining)
            )}件読む →</a></p>`
          : "";
      const labelId = `cat-label-${index}`;
      const sectionId = categoryAnchorId(index);
      return `<section class="more-cat" id="${sectionId}" aria-labelledby="${labelId}">
  <h3 class="category-heading" id="${labelId}">${escapeHtml(
        group.category
      )} <span class="category-heading__count">(${escapeHtml(
        String(group.count || 0)
      )})</span></h3>
  <div class="more-cat__list">
  ${cards}
  ${more}
  </div>
</section>`;
    })
    .join("\n");

  return `<section class="section section--more" id="more-news" aria-labelledby="more-label">
  <h2 class="section__label" id="more-label">More News</h2>
  <div id="all-categories">
${sections}
  </div>
</section>`;
}

/** @deprecated alias kept for tests / callers */
function renderCategorySections(digest) {
  return `${renderCategoryDigest(digest)}
${renderMoreNews(digest)}`;
}

function buildHtmlDocument(digest, usageDashboard) {
  const counts = selectedCount(digest);
  const dateLabel = formatDateLabel(digest);
  const readingMinutes = estimateReadingMinutes(digest);
  const generatedLabel = formatGeneratedAt(digest.generatedAt);

  // EP-036 order: Brief → Picks → Category Nav → Digest → More News → Usage
  const nav = Number(digest.total) === 0 ? "" : renderCategoryNav(digest);
  const bodyContent =
    Number(digest.total) === 0
      ? `${renderTodayBrief(digest)}`
      : `${renderTodayBrief(digest)}
${renderTodaysPicks(digest)}
${nav}
${renderCategoryDigest(digest)}
${renderMoreNews(digest)}`;

  const usageHtml = renderUsageDashboard(usageDashboard);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="generator" content="x-timeline-collector digest-reader">
  <title>Timeline Digest</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<header class="site-header wrap">
  <p class="kicker">Local Private Digest</p>
  <h1>Timeline Digest</h1>
  <ul class="metrics" aria-label="主要指標">
    <li><span class="metrics__value">${escapeHtml(String(digest.total || 0))}件解析</span></li>
    <li><span class="metrics__value">注目${escapeHtml(
      String(counts.overviewSelected)
    )}件</span></li>
    <li><span class="metrics__value">約${escapeHtml(
      String(readingMinutes)
    )}分</span></li>
  </ul>
  <ul class="meta meta--secondary">
    <li><span class="badge">Local Private Digest</span></li>
    <li>日付: ${escapeHtml(dateLabel)}</li>
    <li>生成: ${escapeHtml(generatedLabel)}</li>
  </ul>
</header>
<main class="wrap">
${bodyContent}
${usageHtml}
</main>
<footer class="site-footer wrap">
  <p>Generated locally.</p>
  <p>Not published.</p>
</footer>
</body>
</html>
`;
}

/**
 * Load usage history for Reader. Missing/corrupt → unavailable (does not throw).
 */
function loadUsageDashboardForReader(rootDir, options = {}) {
  if (options.usageDashboard) {
    return options.usageDashboard;
  }
  if (Array.isArray(options.usageEntries)) {
    return buildUsageDashboard(options.usageEntries, {
      now: options.now,
      available: true,
    });
  }

  const historyPath = path.resolve(
    rootDir,
    options.usageHistoryPath || HISTORY_REL
  );
  try {
    if (!fs.existsSync(historyPath)) {
      return buildUsageDashboard([], { available: false });
    }
    const history = loadHistory(historyPath);
    return buildUsageDashboard(history.entries, {
      now: options.now,
      available: true,
    });
  } catch (_error) {
    return buildUsageDashboard([], { available: false });
  }
}

/**
 * Build local digest reader HTML/CSS.
 *
 * @param {object} options
 * @param {string} [options.rootDir]
 * @param {string} [options.inputPath]
 * @param {string} [options.outputDir]
 * @param {object} [options.digestOptions]
 * @param {object} [options.config]
 * @param {object[]} [options.posts]
 */
function buildDigestReader(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const inputPath = path.resolve(
    rootDir,
    options.inputPath || path.join("output", "timeline_enriched.json")
  );
  const outputDir = path.resolve(
    rootDir,
    options.outputDir || DEFAULT_REL_OUTPUT
  );

  const digestOptions = {
    today: false,
    from: null,
    to: null,
    category: null,
    minImportance: null,
    top: DEFAULT_TOP,
    full: false,
    explain: false,
    ...(options.digestOptions || {}),
  };
  if (digestOptions.top == null) digestOptions.top = DEFAULT_TOP;

  if (!fs.existsSync(inputPath) && !options.posts) {
    fail(`入力が見つかりません: ${inputPath}`);
  }

  const config = options.config || loadConfig();
  const range = resolveLocalDateRange(digestOptions, fail);
  const posts = options.posts
    ? options.posts
    : readJsonArrayRequired(inputPath, "入力ファイル");
  const digest = buildDigest(posts, digestOptions, range, config);
  const selection = buildDigestSelection(posts, digestOptions, range, config);
  digest.todaysPicks = selectTodaysPicks(
    selection.filtered,
    digestOptions.top,
    config
  );
  digest.todayBrief = buildTodayBrief(selection.filtered, digest.todaysPicks);

  const usageDashboard = loadUsageDashboardForReader(rootDir, options);
  const html = buildHtmlDocument(digest, usageDashboard);

  ensureDir(outputDir);
  const htmlPath = path.join(outputDir, "index.html");
  const cssPath = path.join(outputDir, "style.css");
  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(cssPath, `${DIGEST_READER_CSS}\n`, "utf8");

  const counts = selectedCount(digest);
  return {
    outputDir,
    htmlPath,
    cssPath,
    digest,
    summary: {
      total: digest.total,
      selected: counts.overviewSelected,
      topCount: counts.topCount,
      picksCount: digest.todaysPicks.length,
      categoryCount: categoriesWithCounts(digest).length,
      dateLabel: formatDateLabel(digest),
      readingMinutes: estimateReadingMinutes(digest),
      generatedAt: digest.generatedAt,
      brief: digest.todayBrief,
    },
  };
}

module.exports = {
  buildDigestReader,
  buildHtmlDocument,
  buildTodayBrief,
  selectTodaysPicks,
  isNearlySameText,
  renderPickCard,
  loadUsageDashboardForReader,
  renderCategoryDigest,
  renderMoreNews,
  renderCategorySections,
  DIGEST_READER_CSS,
  DEFAULT_TOP,
  DEFAULT_REL_OUTPUT,
  NAV_CATEGORY_LIMIT,
  escapeHtml,
  formatStars,
  formatGeneratedAt,
  estimateReadingMinutes,
  getImportance,
};
