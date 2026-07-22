/**
 * EP-013 — Personal Dashboard builder.
 * Reads finalized Daily Edition + Archive manifests. No Writer/Report/AI.
 * Deterministic. Offline CSS. Reader-facing UI.
 */

const fs = require("fs");
const path = require("path");
const {
  stripHtmlComments,
  extractMarkdownTitle,
} = require("./article-report-core");
const { escapeHtml } = require("./edition-markdown-html");
const { DASHBOARD_CSS } = require("./personal-dashboard-css");
const { ensurePwaHeadTags, THEME_COLOR } = require("./site-builder");

const SECTIONS = ["top", "secondary", "brief"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_READ_NEXT = 5;
const MAX_TOPICS = 8;
const MAX_RECENT = 7;
const PICK_SUMMARY_MAX = 200;
const NEXT_SUMMARY_MAX = 120;

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isDateYmd(value) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function resolveSafeUnderRoot(rootDir, relPath) {
  const rel = asString(relPath);
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[/\\]/).includes("..")) return null;
  if (rel.includes("\0")) return null;
  const rootAbs = path.resolve(rootDir);
  const abs = path.resolve(rootAbs, rel);
  const relToRoot = path.relative(rootAbs, abs);
  if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return null;
  }
  return abs;
}

function stripMarkdownNoise(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLen) {
  const s = asString(text);
  if (!s) return "";
  if ([...s].length <= maxLen) return s;
  const chars = [...s].slice(0, maxLen);
  const joined = chars.join("").replace(/\s+\S*$/, "").trim();
  return `${joined || chars.join("")}…`;
}

/**
 * Title priority: metadata title → H1 → first non-empty line → storyId → Untitled
 */
function extractArticleTitle({ entry = {}, markdown = "", metadata = null } = {}) {
  const metaTitle =
    asString(metadata?.title) ||
    asString(entry.title) ||
    asString(entry.articleTitle);
  if (metaTitle) return metaTitle;

  const visible = stripHtmlComments(markdown);
  const h1 = extractMarkdownTitle(visible);
  if (h1) return h1;

  for (const line of visible.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s+/.test(t)) continue;
    if (/^[-*_]{3,}$/.test(t)) continue;
    return stripMarkdownNoise(t);
  }

  const storyId = asString(entry.storyId);
  if (storyId) return storyId;
  return "Untitled";
}

/**
 * Summary priority: metadata → entry.summary → first body paragraph → ""
 */
function extractArticleSummary({
  entry = {},
  markdown = "",
  metadata = null,
  maxLen = NEXT_SUMMARY_MAX,
} = {}) {
  const meta =
    asString(metadata?.summary) ||
    asString(entry.summary) ||
    asString(entry.lead);
  if (meta) return truncateText(stripMarkdownNoise(meta), maxLen);

  const visible = stripHtmlComments(markdown);
  const lines = visible.split(/\r?\n/);
  let i = 0;
  // skip title heading
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i < lines.length && /^#\s+/.test(lines[i].trim())) i += 1;
  while (i < lines.length && !lines[i].trim()) i += 1;

  const para = [];
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) {
      if (para.length) break;
      i += 1;
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) {
      if (para.length) break;
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      if (para.length) break;
      i += 1;
      continue;
    }
    para.push(t);
    i += 1;
  }
  return truncateText(stripMarkdownNoise(para.join(" ")), maxLen);
}

function flattenEditionEntries(editionDoc) {
  const edition = editionDoc?.edition || {};
  const items = [];
  for (const section of SECTIONS) {
    const list = Array.isArray(edition[section]) ? edition[section] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      items.push({
        ...entry,
        section: asString(entry.section) || section,
      });
    }
  }
  return items;
}

function selectTodaysPick(entries) {
  for (const section of SECTIONS) {
    const found = entries.find((e) => e.section === section);
    if (found) return found;
  }
  return null;
}

function selectReadNext(entries, pick) {
  const pickKey = pick
    ? `${pick.section}::${asString(pick.storyId)}::${asString(pick.articlePath)}`
    : null;
  const rest = [];
  for (const section of SECTIONS) {
    for (const entry of entries) {
      if (entry.section !== section) continue;
      const key = `${entry.section}::${asString(entry.storyId)}::${asString(entry.articlePath)}`;
      if (pickKey && key === pickKey) continue;
      rest.push(entry);
      if (rest.length >= MAX_READ_NEXT) return rest;
    }
  }
  return rest;
}

function collectTopicLabels(entry, report) {
  const labels = [];
  const pushList = (value) => {
    if (Array.isArray(value)) {
      for (const v of value) {
        const s = asString(v);
        if (s) labels.push(s);
      }
    } else {
      const s = asString(value);
      if (s) labels.push(s);
    }
  };

  pushList(entry.category);
  pushList(entry.categories);
  pushList(entry.topics);
  pushList(entry.tags);
  if (report && typeof report === "object") {
    pushList(report.category);
    pushList(report.categories);
    pushList(report.topics);
    pushList(report.tags);
    if (report.article) {
      pushList(report.article.category);
      pushList(report.article.topics);
      pushList(report.article.tags);
    }
  }
  return labels;
}

/**
 * Topics from existing metadata only. Fallback to section counts.
 * Skip solo "other". Max 8. Count desc, then first-seen order.
 */
function buildTopics(cards) {
  const counts = new Map();
  const order = [];
  let meaningful = 0;

  for (const card of cards) {
    const labels = collectTopicLabels(card.entry, card.report);
    for (const label of labels) {
      if (!counts.has(label)) {
        counts.set(label, 0);
        order.push(label);
      }
      counts.set(label, counts.get(label) + 1);
      if (label.toLowerCase() !== "other") meaningful += 1;
    }
  }

  let topics = order.map((name) => ({ name, count: counts.get(name) }));
  const onlyOther =
    topics.length > 0 &&
    topics.every((t) => t.name.toLowerCase() === "other");

  if (topics.length === 0 || onlyOther || meaningful === 0) {
    const sectionCounts = { top: 0, secondary: 0, brief: 0 };
    for (const card of cards) {
      const s = card.entry.section;
      if (Object.prototype.hasOwnProperty.call(sectionCounts, s)) {
        sectionCounts[s] += 1;
      }
    }
    topics = SECTIONS.filter((s) => sectionCounts[s] > 0).map((s) => ({
      name: s === "top" ? "Top" : s === "secondary" ? "Secondary" : "Brief",
      count: sectionCounts[s],
      _section: s,
    }));
  } else {
    topics = topics.filter((t) => t.name.toLowerCase() !== "other" || topics.length === 1);
  }

  topics.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    if (ai !== -1 && bi !== -1 && ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });

  return topics.slice(0, MAX_TOPICS).map(({ name, count }) => ({ name, count }));
}

function loadJsonSafe(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function discoverArchives(archiveRoot, warnings) {
  const root = path.resolve(archiveRoot);
  if (!fs.existsSync(root)) return [];

  const dirs = fs
    .readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .sort(); // deterministic filesystem order before date sort

  const seenIds = new Map();
  const editions = [];

  for (const name of dirs) {
    const dir = path.join(root, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch (_e) {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const manifestPath = path.join(dir, "archive-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      warnings.push({ code: "archive-manifest-missing", dir: name });
      continue;
    }

    let manifest;
    try {
      manifest = loadJsonSafe(manifestPath);
    } catch (error) {
      warnings.push({
        code: "archive-manifest-invalid",
        dir: name,
        message: error.message,
      });
      continue;
    }

    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      warnings.push({ code: "archive-manifest-invalid", dir: name });
      continue;
    }

    const editionId = asString(manifest.editionId) || asString(name);
    const editionDate =
      asString(manifest.editionDate) || asString(manifest.editionId);
    if (!isDateYmd(editionDate)) {
      warnings.push({
        code: "archive-date-invalid",
        dir: name,
        editionDate: editionDate || null,
      });
      continue;
    }

    // Prevent linking outside archive root
    const htmlRel = asString(manifest.files?.html) || "index.html";
    if (
      path.isAbsolute(htmlRel) ||
      htmlRel.split(/[/\\]/).includes("..")
    ) {
      warnings.push({ code: "archive-html-unsafe", dir: name });
      continue;
    }
    const htmlAbs = resolveSafeUnderRoot(dir, htmlRel);
    if (!htmlAbs || !fs.existsSync(htmlAbs)) {
      warnings.push({ code: "archive-html-missing", dir: name });
      continue;
    }

    if (seenIds.has(editionId)) {
      warnings.push({
        code: "duplicate-edition-id",
        editionId,
        dir: name,
      });
      // keep first (deterministic by sorted dir name), skip later
      continue;
    }
    seenIds.set(editionId, name);

    const summary = manifest.summary || {};
    editions.push({
      editionId,
      editionDate,
      articleCount: Number(summary.articleCount) || 0,
      warningsCount: Number(summary.warningsCount) || 0,
      href: path.posix.join("archive", editionId, "index.html"),
    });
  }

  editions.sort((a, b) => {
    if (a.editionDate !== b.editionDate) {
      return a.editionDate < b.editionDate ? 1 : -1;
    }
    return a.editionId < b.editionId ? 1 : -1;
  });

  return editions.slice(0, MAX_RECENT);
}

function safeHref(href) {
  const h = asString(href);
  if (!h) return null;
  if (/^javascript:/i.test(h)) return null;
  if (path.isAbsolute(h)) return null;
  if (h.split(/[/\\]/).includes("..")) return null;
  return h.replace(/\\/g, "/");
}

function loadEntryCard(entry, workRoot, warnings) {
  const card = {
    entry,
    title: "Untitled",
    summary: "",
    report: null,
    href: null,
    missingArticle: false,
  };

  const storyId = asString(entry.storyId);
  const anchor = storyId
    ? `edition/index.html#story-${encodeURIComponent(storyId)}`
    : "edition/index.html";
  card.href = safeHref(anchor);

  let markdown = "";
  const articleAbs = resolveSafeUnderRoot(workRoot, entry.articlePath);
  if (!articleAbs || !fs.existsSync(articleAbs)) {
    card.missingArticle = true;
    warnings.push({
      code: "article-file-not-found",
      storyId: storyId || null,
      articlePath: asString(entry.articlePath) || null,
    });
  } else {
    markdown = fs.readFileSync(articleAbs, "utf8");
  }

  let metadata = null;
  const reportAbs = resolveSafeUnderRoot(workRoot, entry.reportPath);
  if (reportAbs && fs.existsSync(reportAbs)) {
    try {
      card.report = loadJsonSafe(reportAbs);
      if (card.report?.article) {
        metadata = {
          title: card.report.article.title,
          summary: card.report.article.summary,
        };
      }
    } catch (error) {
      warnings.push({
        code: "report-parse-error",
        storyId: storyId || null,
        message: error.message,
      });
    }
  }

  card.title = extractArticleTitle({ entry, markdown, metadata });
  card.summary = extractArticleSummary({
    entry,
    markdown,
    metadata,
    maxLen: NEXT_SUMMARY_MAX,
  });
  return card;
}

function renderHeader(dateLabel) {
  return `<header class="site-header wrap">
  <p class="site-header__kicker">Personal Dashboard</p>
  <h1 class="site-header__title">Personal Timeline</h1>
  <p class="site-header__lede">Your X timeline, edited for today.</p>
  ${
    dateLabel
      ? `<p class="site-header__date"><time datetime="${escapeHtml(dateLabel)}">${escapeHtml(dateLabel)}</time></p>`
      : ""
  }
</header>`;
}

function renderToday(today, hasHtml) {
  if (!today) {
    return `<section class="section wrap" aria-labelledby="today-label">
  <h2 class="section__label" id="today-label">Today</h2>
  <p class="empty">今日の号データがありません。</p>
</section>`;
  }

  const counts = today.sectionCounts || {};
  const link =
    hasHtml && today.href
      ? `<p class="today__actions"><a class="btn btn--compact" href="${escapeHtml(today.href)}">今日の号を読む</a></p>`
      : "";

  if (today.articleCount === 0) {
    return `<section class="section wrap" aria-labelledby="today-label">
  <h2 class="section__label" id="today-label">Today</h2>
  <div class="card card--today">
    <p class="empty">今日の掲載記事はありません。</p>
    ${link}
  </div>
</section>`;
  }

  return `<section class="section wrap" aria-labelledby="today-label">
  <h2 class="section__label" id="today-label">Today</h2>
  <div class="card card--today">
    <ul class="today__meta">
      <li><time datetime="${escapeHtml(today.editionDate || "")}">${escapeHtml(today.editionDate || "—")}</time></li>
      <li>記事 ${escapeHtml(String(today.articleCount))}件</li>
      <li>Top ${escapeHtml(String(counts.top || 0))} / Secondary ${escapeHtml(String(counts.secondary || 0))} / Brief ${escapeHtml(String(counts.brief || 0))}</li>
      ${
        today.warningsCount
          ? `<li>${escapeHtml(String(today.warningsCount))} warning</li>`
          : ""
      }
    </ul>
    ${link}
  </div>
</section>`;
}

function renderPick(pickCard) {
  if (!pickCard) {
    return `<section class="section wrap" aria-labelledby="pick-label">
  <h2 class="section__label" id="pick-label">Today’s Pick</h2>
  <p class="empty">今日のもっとも優先する記事はありません。</p>
</section>`;
  }

  // Reader-facing: do not surface internal score numbers.
  const href = pickCard.href ? safeHref(pickCard.href) : null;
  const action = href
    ? `<div class="pick__actions"><a class="btn" href="${escapeHtml(href)}">この記事を読む</a></div>`
    : "";

  return `<section class="section wrap" aria-labelledby="pick-label">
  <h2 class="section__label" id="pick-label">Today’s Pick</h2>
  <article class="card pick">
    <p class="pick__section">${escapeHtml(pickCard.entry.section)}</p>
    <h3 class="pick__title">${escapeHtml(pickCard.title)}</h3>
    ${
      pickCard.summary
        ? `<p class="pick__summary">${escapeHtml(pickCard.summary)}</p>`
        : ""
    }
    ${action}
  </article>
</section>`;
}

function renderReadNext(cards) {
  if (!cards.length) {
    return `<section class="section wrap" aria-labelledby="next-label">
  <h2 class="section__label" id="next-label">Read Next</h2>
  <p class="empty">次に読む記事はまだありません。</p>
</section>`;
  }

  const items = cards
    .map((card) => {
      const href = card.href ? safeHref(card.href) : null;
      const link = href
        ? `<a class="read-next__link" href="${escapeHtml(href)}">読む →</a>`
        : "";
      return `<li class="read-next__item card">
  <span class="chip">${escapeHtml(card.entry.section)}</span>
  <h3 class="read-next__title">${escapeHtml(card.title)}</h3>
  ${
    card.summary
      ? `<p class="read-next__summary">${escapeHtml(card.summary)}</p>`
      : ""
  }
  ${link}
</li>`;
    })
    .join("\n");

  return `<section class="section wrap" aria-labelledby="next-label">
  <h2 class="section__label" id="next-label">Read Next</h2>
  <ul class="read-next">
${items}
  </ul>
</section>`;
}

function renderTopics(topics) {
  if (!topics.length) {
    return `<section class="section wrap" aria-labelledby="topics-label">
  <h2 class="section__label" id="topics-label">Topics</h2>
  <p class="empty">今日の話題はありません。</p>
</section>`;
  }
  const items = topics
    .map(
      (t) =>
        `<li class="topic"><span class="topic__name">${escapeHtml(t.name)}</span><span class="topic__count">${escapeHtml(String(t.count))}</span></li>`
    )
    .join("\n");
  return `<section class="section wrap" aria-labelledby="topics-label">
  <h2 class="section__label" id="topics-label">Topics</h2>
  <ul class="topics">
${items}
  </ul>
</section>`;
}

function renderRecent(editions) {
  if (!editions.length) {
    return `<section class="section wrap" aria-labelledby="recent-label">
  <h2 class="section__label" id="recent-label">Recent Editions</h2>
  <p class="empty">保存された過去号はまだありません。</p>
</section>`;
  }
  const items = editions
    .map((ed) => {
      const href = safeHref(ed.href);
      const link = href
        ? `<a href="${escapeHtml(href)}">号を読む</a>`
        : "";
      return `<li class="edition-row">
  <div class="edition-row__main">
    <span class="edition-row__date"><time datetime="${escapeHtml(ed.editionDate)}">${escapeHtml(ed.editionDate)}</time></span>
    <span class="edition-row__meta">記事 ${escapeHtml(String(ed.articleCount))}件${
        ed.warningsCount
          ? ` · ${escapeHtml(String(ed.warningsCount))} warning`
          : ""
      }</span>
  </div>
  ${link}
</li>`;
    })
    .join("\n");

  return `<section class="section wrap" aria-labelledby="recent-label">
  <h2 class="section__label" id="recent-label">Recent Editions</h2>
  <nav aria-label="Recent editions">
    <ul class="editions">
${items}
    </ul>
  </nav>
</section>`;
}

function renderFooter(summary) {
  const bits = [];
  if (summary.warningsCount) {
    bits.push(`${summary.warningsCount} warning`);
  }
  bits.push(`${summary.archiveCount} archive`);
  return `<footer class="site-footer wrap">
  <p>${escapeHtml(bits.join(" · "))}</p>
</footer>`;
}

function buildDashboardHtml(model) {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="${THEME_COLOR}">
  <meta name="generator" content="x-timeline-collector personal-dashboard">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Timeline">
  <title>Personal Timeline</title>
  <link rel="stylesheet" href="dashboard.css">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
</head>
<body>
${renderHeader(model.today?.editionDate || model.dateLabel || "")}
<main>
${renderToday(model.today, model.hasLatestHtml)}
${renderPick(model.pick)}
${renderReadNext(model.readNext)}
${renderTopics(model.topics)}
${renderRecent(model.recent)}
</main>
${renderFooter(model.summary)}
</body>
</html>
`;
  return ensurePwaHeadTags(html);
}

/**
 * Build Personal Dashboard.
 *
 * @param {object} options
 * @param {string|object|null} options.edition - daily-edition.json path/object (null if missing)
 * @param {string} [options.workRoot]
 * @param {string} [options.outputDir] - writes index.html + dashboard.css here
 * @param {string} [options.archiveRoot]
 * @param {string} [options.latestHtmlPath]
 * @param {boolean} [options.requireEdition=false]
 */
function buildPersonalDashboard({
  edition = null,
  workRoot = null,
  outputDir,
  archiveRoot = null,
  latestHtmlPath = null,
  requireEdition = false,
} = {}) {
  if (!outputDir) {
    const err = new Error("outputDir は必須です。");
    err.code = "output-dir-required";
    throw err;
  }

  const warnings = [];
  let editionDoc = null;
  let editionPath = null;

  if (typeof edition === "string") {
    editionPath = path.resolve(edition);
    if (!fs.existsSync(editionPath)) {
      if (requireEdition) {
        const err = new Error(`daily-edition.json が見つかりません: ${editionPath}`);
        err.code = "edition-not-found";
        throw err;
      }
      warnings.push({ code: "edition-missing", path: editionPath });
    } else {
      try {
        editionDoc = loadJsonSafe(editionPath);
      } catch (error) {
        if (requireEdition) {
          const err = new Error(`daily-edition.json が不正です: ${error.message}`);
          err.code = "edition-invalid";
          throw err;
        }
        warnings.push({ code: "edition-invalid", message: error.message });
      }
    }
  } else if (edition && typeof edition === "object") {
    editionDoc = edition;
  } else if (requireEdition) {
    const err = new Error("daily-edition.json が必要です。");
    err.code = "edition-not-found";
    throw err;
  } else {
    warnings.push({ code: "edition-missing" });
  }

  if (
    editionDoc &&
    (typeof editionDoc !== "object" || Array.isArray(editionDoc))
  ) {
    if (requireEdition) {
      const err = new Error("daily-edition.json はオブジェクトである必要があります。");
      err.code = "edition-invalid";
      throw err;
    }
    warnings.push({ code: "edition-invalid" });
    editionDoc = null;
  }

  const root = workRoot
    ? path.resolve(workRoot)
    : editionPath
      ? path.dirname(editionPath)
      : process.cwd();

  const outDir = path.resolve(outputDir);
  const archivesDir = archiveRoot
    ? path.resolve(archiveRoot)
    : path.join(outDir, "archive");

  const htmlPath = latestHtmlPath
    ? path.resolve(latestHtmlPath)
    : path.join(outDir, "edition", "index.html");
  const hasLatestHtml = fs.existsSync(htmlPath);
  if (!hasLatestHtml) {
    warnings.push({ code: "latest-html-missing", path: htmlPath });
  }

  const entries = editionDoc ? flattenEditionEntries(editionDoc) : [];
  const cards = [];
  for (const entry of entries) {
    const card = loadEntryCard(entry, root, warnings);
    // Longer summary for pick candidate; recompute later for pick
    cards.push(card);
  }

  const pickEntry = selectTodaysPick(entries);
  let pick = null;
  if (pickEntry) {
    pick = cards.find(
      (c) =>
        c.entry === pickEntry ||
        (c.entry.storyId === pickEntry.storyId &&
          c.entry.section === pickEntry.section &&
          c.entry.articlePath === pickEntry.articlePath)
    );
    if (pick) {
      // refresh longer summary for pick
      const articleAbs = resolveSafeUnderRoot(root, pick.entry.articlePath);
      const markdown =
        articleAbs && fs.existsSync(articleAbs)
          ? fs.readFileSync(articleAbs, "utf8")
          : "";
      let metadata = null;
      if (pick.report?.article) {
        metadata = {
          title: pick.report.article.title,
          summary: pick.report.article.summary,
        };
      }
      pick.summary = extractArticleSummary({
        entry: pick.entry,
        markdown,
        metadata,
        maxLen: PICK_SUMMARY_MAX,
      });
      if (!hasLatestHtml) {
        // fallback to markdown file relative from output/ if present in work — keep edition link off
        pick.href = null;
      }
    }
  }

  const readNextEntries = selectReadNext(entries, pickEntry);
  const readNext = readNextEntries
    .map((entry) =>
      cards.find(
        (c) =>
          c.entry.storyId === entry.storyId &&
          c.entry.section === entry.section &&
          c.entry.articlePath === entry.articlePath
      )
    )
    .filter(Boolean)
    .map((card) => {
      if (!hasLatestHtml) return { ...card, href: null };
      return card;
    });

  const topics = buildTopics(cards);
  const recent = discoverArchives(archivesDir, warnings);

  const summary = editionDoc?.summary || {};
  const sectionCounts = summary.sectionCounts || {
    top: 0,
    secondary: 0,
    brief: 0,
  };
  const editionDate =
    asString(editionDoc?.editionDate) ||
    asString(editionDoc?.date) ||
    null;

  const today = editionDoc
    ? {
        editionDate,
        articleCount: Number(summary.articleCount) || entries.length,
        sectionCounts: {
          top: Number(sectionCounts.top) || 0,
          secondary: Number(sectionCounts.secondary) || 0,
          brief: Number(sectionCounts.brief) || 0,
        },
        warningsCount: Number(summary.warningsCount) || 0,
        href: hasLatestHtml ? "edition/index.html" : null,
      }
    : null;

  // Clear article links when latest HTML missing
  if (!hasLatestHtml && pick) pick.href = null;

  const model = {
    today,
    pick,
    readNext,
    topics,
    recent,
    hasLatestHtml,
    dateLabel: editionDate,
    summary: {
      todayCount: pick ? 1 : 0,
      readNextCount: readNext.length,
      topicCount: topics.length,
      archiveCount: recent.length,
      warningsCount: warnings.length,
    },
  };

  const html = buildDashboardHtml(model);
  ensureDir(outDir);
  const htmlOut = path.join(outDir, "index.html");
  const cssOut = path.join(outDir, "dashboard.css");
  fs.writeFileSync(htmlOut, html, "utf8");
  fs.writeFileSync(cssOut, `${DASHBOARD_CSS}\n`, "utf8");

  return {
    htmlPath: htmlOut,
    cssPath: cssOut,
    html,
    css: DASHBOARD_CSS,
    warnings,
    summary: model.summary,
    model,
  };
}

module.exports = {
  buildPersonalDashboard,
  extractArticleTitle,
  extractArticleSummary,
  selectTodaysPick,
  selectReadNext,
  buildTopics,
  discoverArchives,
  flattenEditionEntries,
  safeHref,
  truncateText,
  stripMarkdownNoise,
  SECTIONS,
  MAX_READ_NEXT,
  MAX_TOPICS,
  MAX_RECENT,
};
