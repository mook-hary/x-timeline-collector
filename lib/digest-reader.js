/**
 * EP-022/023/024 — Local Digest Reader HTML builder.
 * Reuses digest.js selection (buildDigest). No AI. Writes only under output/digest-reader/.
 * EP-024: information hierarchy (HTML/CSS only; digest ranking unchanged).
 */

const fs = require("fs");
const path = require("path");
const { resolveLocalDateRange } = require("./date-range");
const { readJsonArrayRequired, ensureDir } = require("./pipeline-io");
const { getImportance } = require("./digest-core");
const { buildDigest, loadConfig } = require("../digest");
const { DIGEST_READER_CSS } = require("./digest-reader-css");

const DEFAULT_TOP = 8;
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
  const top = Array.isArray(digest.topPosts) ? digest.topPosts.length : 0;
  const categories = Array.isArray(digest.categories) ? digest.categories : [];
  let categoryDisplayed = 0;
  for (const group of categories) {
    categoryDisplayed += Array.isArray(group.posts) ? group.posts.length : 0;
  }
  return {
    topCount: top,
    categoryDisplayed,
    overviewSelected: top,
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

/** Deterministic reading-time estimate: Top-first skim + light category scan. */
function estimateReadingMinutes(digest) {
  const top = Array.isArray(digest.topPosts) ? digest.topPosts : [];
  let topChars = 0;
  for (const post of top) {
    topChars += String(post?.summary || "").length;
  }
  const topMin = Math.max(
    top.length === 0 ? 0 : 1,
    Math.ceil(topChars / 400),
    Math.ceil(top.length * 0.7)
  );

  let categoryDisplayed = 0;
  for (const group of digest.categories || []) {
    categoryDisplayed += Array.isArray(group.posts) ? group.posts.length : 0;
  }
  const scanMin =
    categoryDisplayed === 0 ? 0 : Math.max(1, Math.ceil(categoryDisplayed * 0.12));
  return Math.max(1, topMin + scanMin);
}

/**
 * Deterministic overview highlights (max 3). No AI. No past comparisons.
 */
function buildHighlights(digest, counts, readingMinutes) {
  const lines = [];
  const ranked = categoriesByCountDesc(digest);
  const used = new Set();

  if (ranked.length > 0) {
    const topCat = ranked[0].category;
    used.add(topCat);
    lines.push(`${topCat}の投稿が最も多い構成です`);
  }

  const companions = ranked
    .filter((c) => !used.has(c.category))
    .slice(0, 2)
    .map((c) => c.category);
  if (companions.length >= 2) {
    used.add(companions[0]);
    used.add(companions[1]);
    lines.push(`${companions[0]}と${companions[1]}が多く含まれています`);
  } else if (companions.length === 1) {
    used.add(companions[0]);
    lines.push(`${companions[0]}も含まれています`);
  }

  if (counts.overviewSelected > 0) {
    lines.push(
      `注目${counts.overviewSelected}件を約${readingMinutes}分で読めます`
    );
  } else if (Number(digest.total) > 0) {
    lines.push(`解析${digest.total}件から読める注目投稿はありません`);
  }

  return lines.slice(0, 3);
}

function categoryAnchorId(index) {
  return `category-${index}`;
}

function renderSourceAction(url) {
  const href = String(url || "").trim();
  if (!href || href === "(なし)" || !/^https?:\/\//i.test(href)) {
    return `<p class="card__actions"><span class="btn-source--missing">リンクなし</span></p>`;
  }
  return `<p class="card__actions"><a class="btn-source" href="${escapeHtml(
    href
  )}" rel="noopener noreferrer" target="_blank" aria-label="元の投稿をXで開く">Xで開く ↗</a></p>`;
}

function renderCard(post, { top = false } = {}) {
  const summary = String(post.summary || "要約なし");
  const category = String(post.category || "その他");
  const stars = formatStars(post.importance);
  const importance = post.importance ?? 0;
  const cls = top ? "card card--top" : "card";
  return `<article class="${cls}">
  <p class="card__category">${escapeHtml(category)}</p>
  <p class="card__summary">${escapeHtml(summary)}</p>
  <p class="card__importance"><span class="card__importance-label">重要度</span> <span class="card__stars" aria-label="重要度 ${escapeHtml(
    String(importance)
  )}">${escapeHtml(stars)}</span></p>
  ${renderSourceAction(post.url)}
</article>`;
}

function renderCategoryNav(digest) {
  const ranked = categoriesByCountDesc(digest);
  if (ranked.length === 0) return "";

  const primary = ranked.slice(0, NAV_CATEGORY_LIMIT);
  const hasMore = ranked.length > NAV_CATEGORY_LIMIT;

  const items = [
    `<li><a href="#top-stories">Top</a></li>`,
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

  return `<nav class="cat-nav wrap" aria-label="主要カテゴリ">
  <p class="cat-nav__label">Categories</p>
  <ul class="cat-nav__list">
    ${items.join("\n    ")}
  </ul>
</nav>`;
}

function renderOverview(digest, counts, readingMinutes) {
  const categoryCount = categoriesWithCounts(digest).length;
  const highlights = buildHighlights(digest, counts, readingMinutes);
  const highlightHtml =
    highlights.length === 0
      ? `<p class="empty">ハイライトはありません。</p>`
      : `<ul class="highlights">${highlights
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`;

  return `<section class="section" aria-labelledby="overview-label">
  <h2 class="section__label" id="overview-label">Overview</h2>
  <div class="overview">
    <ul class="overview__stats">
      <li>${escapeHtml(String(digest.total))}件解析</li>
      <li>注目${escapeHtml(String(counts.overviewSelected))}件</li>
      <li>カテゴリ${escapeHtml(String(categoryCount))}種</li>
    </ul>
    <p class="overview__sublabel">今日のハイライト</p>
    ${highlightHtml}
  </div>
</section>`;
}

function renderTopStories(digest) {
  const posts = Array.isArray(digest.topPosts) ? digest.topPosts : [];
  const body =
    posts.length === 0
      ? `<p class="empty">基準を満たす注目投稿はありませんでした。</p>`
      : posts.map((p) => renderCard(p, { top: true })).join("\n");
  return `<section class="section section--top" id="top-stories" aria-labelledby="top-label">
  <h2 class="section__label" id="top-label">Top Stories（${posts.length}）</h2>
  ${body}
</section>`;
}

function renderCategorySections(digest) {
  const groups = Array.isArray(digest.categories) ? digest.categories : [];
  if (groups.length === 0) {
    return `<section class="section" id="all-categories" aria-labelledby="cats-label">
  <h2 class="section__label" id="cats-label">Categories</h2>
  <p class="empty">カテゴリ別の投稿はありませんでした。</p>
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
          ? `<p class="empty">ほか ${escapeHtml(String(remaining))}件</p>`
          : "";
      const labelId = `cat-label-${index}`;
      const sectionId = categoryAnchorId(index);
      return `<section class="section" id="${sectionId}" aria-labelledby="${labelId}">
  <h2 class="section__label" id="${labelId}">${escapeHtml(group.category)} (${escapeHtml(
        String(group.count || 0)
      )})</h2>
  ${cards}
  ${more}
</section>`;
    })
    .join("\n");

  return `<div id="all-categories">
${sections}
</div>`;
}

function buildHtmlDocument(digest) {
  const counts = selectedCount(digest);
  const dateLabel = formatDateLabel(digest);
  const readingMinutes = estimateReadingMinutes(digest);
  const generatedLabel = formatGeneratedAt(digest.generatedAt);

  const bodyContent =
    Number(digest.total) === 0
      ? `<p class="empty">条件に一致する投稿はありませんでした。</p>`
      : `${renderOverview(digest, counts, readingMinutes)}
${renderTopStories(digest)}
${renderCategorySections(digest)}`;

  const nav = Number(digest.total) === 0 ? "" : renderCategoryNav(digest);

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
${nav}
<main class="wrap">
${bodyContent}
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
  const html = buildHtmlDocument(digest);

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
      categoryCount: categoriesWithCounts(digest).length,
      dateLabel: formatDateLabel(digest),
      readingMinutes: estimateReadingMinutes(digest),
      generatedAt: digest.generatedAt,
      highlights: buildHighlights(
        digest,
        counts,
        estimateReadingMinutes(digest)
      ),
    },
  };
}

module.exports = {
  buildDigestReader,
  buildHtmlDocument,
  buildHighlights,
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
