/**
 * EP-011 — Build human-readable Daily Edition HTML from daily-edition.json.
 * Sole entry: daily-edition.json. Articles/reports via paths in entries.
 * Deterministic. No AI. No SPA. No template engine.
 */

const fs = require("fs");
const path = require("path");
const {
  stripHtmlComments,
  extractMarkdownTitle,
} = require("./article-report-core");
const { escapeHtml, markdownToHtml } = require("./edition-markdown-html");
const { EDITION_CSS } = require("./edition-css");

const SECTIONS = ["top", "secondary", "brief"];
const SECTION_LABELS = {
  top: "Top",
  secondary: "Secondary",
  brief: "Brief",
};

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveUnderRoot(workRoot, relPath) {
  const rel = asString(relPath);
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[/\\]/).includes("..")) return null;
  return path.resolve(workRoot, rel);
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function readReportSummary(report) {
  if (!report || typeof report !== "object") {
    return {
      status: null,
      readyForAiRewrite: null,
      errorCount: null,
      warningCount: null,
      confidenceAvg: null,
      claimsUsable: null,
      claimsTotal: null,
      actualLength: null,
      reportId: null,
      generatedAt: null,
    };
  }
  const rs = report.reviewSummary || {};
  return {
    status: asString(rs.status) || null,
    readyForAiRewrite:
      typeof report.readyForAiRewrite === "boolean"
        ? report.readyForAiRewrite
        : null,
    errorCount: Number.isFinite(rs.errorCount) ? rs.errorCount : null,
    warningCount: Number.isFinite(rs.warningCount) ? rs.warningCount : null,
    confidenceAvg:
      report.confidence && Number.isFinite(report.confidence.average)
        ? report.confidence.average
        : null,
    claimsUsable:
      report.claims && Number.isFinite(report.claims.usable)
        ? report.claims.usable
        : null,
    claimsTotal:
      report.claims && Number.isFinite(report.claims.total)
        ? report.claims.total
        : null,
    actualLength:
      report.article && Number.isFinite(report.article.actualLength)
        ? report.article.actualLength
        : null,
    reportId: asString(report.id) || null,
    generatedAt: asString(report.generatedAt) || null,
  };
}

function statusBadgeClass(status) {
  if (status === "pass") return "badge badge--pass";
  if (status === "warning") return "badge badge--warning";
  if (status === "fail") return "badge badge--fail";
  return "badge";
}

function renderReportBlock(meta, entry) {
  const rows = [];
  if (meta.status != null) {
    rows.push(
      `<dt>Review</dt><dd><span class="${statusBadgeClass(meta.status)}">${escapeHtml(meta.status)}</span></dd>`
    );
  }
  if (meta.readyForAiRewrite != null) {
    rows.push(
      `<dt>readyForAiRewrite</dt><dd>${meta.readyForAiRewrite ? "true" : "false"}</dd>`
    );
  }
  if (entry.publishable != null) {
    rows.push(
      `<dt>publishable</dt><dd>${entry.publishable === true ? "true" : "false"}</dd>`
    );
  }
  if (meta.confidenceAvg != null) {
    rows.push(`<dt>Confidence avg</dt><dd>${escapeHtml(String(meta.confidenceAvg))}</dd>`);
  }
  if (meta.claimsUsable != null || meta.claimsTotal != null) {
    rows.push(
      `<dt>Claims</dt><dd>${escapeHtml(String(meta.claimsUsable ?? "—"))} / ${escapeHtml(String(meta.claimsTotal ?? "—"))}</dd>`
    );
  }
  if (meta.actualLength != null) {
    rows.push(`<dt>Length</dt><dd>${escapeHtml(String(meta.actualLength))}</dd>`);
  }
  if (meta.errorCount != null || meta.warningCount != null) {
    rows.push(
      `<dt>Errors / Warnings</dt><dd>${escapeHtml(String(meta.errorCount ?? 0))} / ${escapeHtml(String(meta.warningCount ?? 0))}</dd>`
    );
  }
  rows.push(
    `<dt>storyId</dt><dd>${escapeHtml(asString(entry.storyId) || "—")}</dd>`
  );
  if (entry.position != null) {
    rows.push(`<dt>position</dt><dd>${escapeHtml(String(entry.position))}</dd>`);
  }
  if (entry.rank != null) {
    rows.push(`<dt>rank</dt><dd>${escapeHtml(String(entry.rank))}</dd>`);
  }
  if (entry.score != null) {
    rows.push(`<dt>score</dt><dd>${escapeHtml(String(entry.score))}</dd>`);
  }
  rows.push(
    `<dt>articlePath</dt><dd>${escapeHtml(asString(entry.articlePath) || "—")}</dd>`
  );
  rows.push(
    `<dt>reportPath</dt><dd>${escapeHtml(asString(entry.reportPath) || "—")}</dd>`
  );

  return `<aside class="story__report" aria-label="Article report">
  <dl>
    ${rows.join("\n    ")}
  </dl>
</aside>`;
}

function renderStory(entry, loaded, section) {
  const title = loaded.title || asString(entry.storyId) || "Untitled";
  const badges = [];
  if (loaded.reportMeta.status) {
    badges.push(
      `<span class="${statusBadgeClass(loaded.reportMeta.status)}">${escapeHtml(loaded.reportMeta.status)}</span>`
    );
  }
  if (loaded.reportMeta.readyForAiRewrite === true) {
    badges.push(`<span class="badge">rewrite-ready</span>`);
  }
  if (entry.score != null) {
    badges.push(`<span class="badge">score ${escapeHtml(String(entry.score))}</span>`);
  }

  const bodyHtml = loaded.missingArticle
    ? `<p class="empty">記事ファイルが見つかりません。</p>`
    : loaded.bodyHtml || `<p class="empty">本文が空です。</p>`;

  return `<article class="story story--${escapeHtml(section)}" id="story-${escapeHtml(asString(entry.storyId) || "unknown")}">
  <header class="story__header">
    <h2 class="story__title">${escapeHtml(title)}</h2>
    <div class="story__badges">${badges.join("")}</div>
  </header>
  <div class="story__body">
${bodyHtml}
  </div>
  ${renderReportBlock(loaded.reportMeta, entry)}
</article>`;
}

function renderSection(section, storiesHtml) {
  const label = SECTION_LABELS[section] || section;
  const inner =
    storiesHtml.length > 0
      ? storiesHtml.join("\n")
      : `<p class="empty">このセクションに記事はありません。</p>`;
  const gridClass =
    section === "secondary"
      ? "grid-secondary"
      : section === "brief"
        ? "grid-brief"
        : "";
  return `<section class="section section--${section}" aria-labelledby="label-${section}">
  <h2 class="section__label" id="label-${section}">${escapeHtml(label)}</h2>
  <div class="${gridClass}">
${inner}
  </div>
</section>`;
}

function renderFooter(editionDoc, options) {
  const summary = editionDoc.summary || {};
  const sectionCounts = summary.sectionCounts || {};
  const warnings = Array.isArray(editionDoc.warnings)
    ? editionDoc.warnings
    : [];
  const warningItems = warnings
    .map((w) => {
      if (!w || typeof w !== "object") return null;
      const code = asString(w.code) || "warning";
      const storyId = asString(w.storyId);
      return `<li>${escapeHtml(code)}${storyId ? ` (${escapeHtml(storyId)})` : ""}</li>`;
    })
    .filter(Boolean);

  return `<footer class="edition-footer wrap">
  <h2>Edition Metadata</h2>
  <dl>
    <dt>version</dt><dd>${escapeHtml(asString(editionDoc.version) || "—")}</dd>
    <dt>date</dt><dd>${escapeHtml(asString(options.date) || "—")}</dd>
    <dt>articleCount</dt><dd>${escapeHtml(String(summary.articleCount ?? 0))}</dd>
    <dt>sectionCounts</dt><dd>top ${escapeHtml(String(sectionCounts.top ?? 0))} / secondary ${escapeHtml(String(sectionCounts.secondary ?? 0))} / brief ${escapeHtml(String(sectionCounts.brief ?? 0))}</dd>
    <dt>warningsCount</dt><dd>${escapeHtml(String(summary.warningsCount ?? warnings.length))}</dd>
    <dt>legacyPrimaryArticlePath</dt><dd>${escapeHtml(asString(editionDoc.legacyPrimaryArticlePath) || "—")}</dd>
    <dt>legacyPrimaryReportPath</dt><dd>${escapeHtml(asString(editionDoc.legacyPrimaryReportPath) || "—")}</dd>
  </dl>
  ${
    warningItems.length
      ? `<h2>Warnings</h2>\n  <ul class="warnings">\n    ${warningItems.join("\n    ")}\n  </ul>`
      : ""
  }
</footer>`;
}

function loadEntryContent(entry, workRoot, warnings) {
  const result = {
    title: null,
    bodyHtml: "",
    reportMeta: readReportSummary(null),
    missingArticle: false,
    missingReport: false,
  };

  const articleAbs = resolveUnderRoot(workRoot, entry.articlePath);
  if (!articleAbs || !fs.existsSync(articleAbs)) {
    result.missingArticle = true;
    warnings.push({
      code: "article-file-not-found",
      storyId: asString(entry.storyId) || null,
      articlePath: asString(entry.articlePath) || null,
    });
  } else {
    const md = fs.readFileSync(articleAbs, "utf8");
    const visible = stripHtmlComments(md).trim();
    result.title = extractMarkdownTitle(visible);
    result.bodyHtml = markdownToHtml(visible);
  }

  const reportAbs = resolveUnderRoot(workRoot, entry.reportPath);
  if (!reportAbs || !fs.existsSync(reportAbs)) {
    result.missingReport = true;
    warnings.push({
      code: "report-file-not-found",
      storyId: asString(entry.storyId) || null,
      reportPath: asString(entry.reportPath) || null,
    });
  } else {
    try {
      const report = loadJson(reportAbs);
      result.reportMeta = readReportSummary(report);
      if (!result.title && report.article && report.article.title) {
        result.title = asString(report.article.title);
      }
    } catch (error) {
      warnings.push({
        code: "report-parse-error",
        storyId: asString(entry.storyId) || null,
        message: error.message,
      });
    }
  }

  return result;
}

function buildHtmlDocument({ editionDoc, sectionsHtml, options }) {
  const pageTitle = asString(options.title) || "Daily Edition";
  const dateLine = asString(options.date) || "";
  const articleCount = editionDoc.summary?.articleCount ?? 0;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="generator" content="x-timeline-collector daily-edition-html">
  <title>${escapeHtml(pageTitle)}${dateLine ? ` — ${escapeHtml(dateLine)}` : ""}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="edition.css">
</head>
<body>
  <header class="masthead wrap">
    <p class="masthead__kicker">Personal Timeline Edition</p>
    <h1 class="masthead__title">${escapeHtml(pageTitle)}</h1>
    <div class="masthead__meta">
      ${dateLine ? `<span>${escapeHtml(dateLine)}</span>` : ""}
      <span>${escapeHtml(String(articleCount))} articles</span>
      <span>top ${escapeHtml(String(editionDoc.summary?.sectionCounts?.top ?? 0))} · secondary ${escapeHtml(String(editionDoc.summary?.sectionCounts?.secondary ?? 0))} · brief ${escapeHtml(String(editionDoc.summary?.sectionCounts?.brief ?? 0))}</span>
    </div>
  </header>
  <main class="wrap">
${
  articleCount === 0
    ? `<p class="empty">この号に掲載記事はありません。</p>\n`
    : ""
}${sectionsHtml.join("\n")}
  </main>
${renderFooter(editionDoc, options)}
</body>
</html>
`;
}

/**
 * Build Daily Edition HTML preview.
 *
 * @param {object} options
 * @param {string|object} options.edition - path to daily-edition.json or object
 * @param {string} [options.workRoot] - root for articlePath/reportPath (default: dirname of edition path)
 * @param {string} options.outputDir - directory for index.html + edition.css
 * @param {string} [options.title]
 * @param {string} [options.date] - YYYY-MM-DD
 * @returns {{ htmlPath: string, cssPath: string, html: string, warnings: object[], articleCount: number }}
 */
function buildDailyEditionHtml({
  edition,
  workRoot = null,
  outputDir,
  title = "Daily Edition",
  date = null,
} = {}) {
  if (!outputDir) {
    const err = new Error("outputDir は必須です。");
    err.code = "output-dir-required";
    throw err;
  }

  let editionDoc = edition;
  let editionPath = null;

  if (typeof edition === "string") {
    editionPath = path.resolve(edition);
    if (!fs.existsSync(editionPath)) {
      const err = new Error(`daily-edition.json が見つかりません: ${editionPath}`);
      err.code = "edition-not-found";
      throw err;
    }
    try {
      editionDoc = loadJson(editionPath);
    } catch (error) {
      const err = new Error(`daily-edition.json が不正です: ${error.message}`);
      err.code = "edition-invalid";
      throw err;
    }
  }

  if (!editionDoc || typeof editionDoc !== "object" || Array.isArray(editionDoc)) {
    const err = new Error("daily-edition.json はオブジェクトである必要があります。");
    err.code = "edition-invalid";
    throw err;
  }

  const root = workRoot
    ? path.resolve(workRoot)
    : editionPath
      ? path.dirname(editionPath)
      : process.cwd();

  const warnings = [];
  const entries = flattenEditionEntries(editionDoc);
  const bySection = { top: [], secondary: [], brief: [] };

  for (const entry of entries) {
    const section = SECTIONS.includes(entry.section) ? entry.section : "brief";
    const loaded = loadEntryContent(entry, root, warnings);
    bySection[section].push(renderStory(entry, loaded, section));
  }

  const sectionsHtml = SECTIONS.map((section) =>
    renderSection(section, bySection[section])
  );

  const html = buildHtmlDocument({
    editionDoc,
    sectionsHtml,
    options: { title, date },
  });

  const outDir = path.resolve(outputDir);
  ensureDir(outDir);
  const htmlPath = path.join(outDir, "index.html");
  const cssPath = path.join(outDir, "edition.css");
  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(cssPath, `${EDITION_CSS}\n`, "utf8");

  return {
    htmlPath,
    cssPath,
    html,
    warnings,
    articleCount: Number(editionDoc.summary?.articleCount) || entries.length,
  };
}

module.exports = {
  buildDailyEditionHtml,
  flattenEditionEntries,
  readReportSummary,
  SECTIONS,
  SECTION_LABELS,
};
