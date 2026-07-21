const {
  validateArticleReport,
  extractMarkdownTitle,
  stripHtmlComments,
} = require("./article-report-core");

const DEFAULT_EDITION_TITLE = "Daily Edition";
const DEFAULT_INTRO =
  "本日の主要な話題を、確認済みの記事からまとめます。";
const DEFAULT_PRIORITY = 1000;
const EDITORIAL_WARNINGS_HEADING = "編集上の注意";

const DEFAULT_CATEGORY_ORDER = [
  "politics",
  "economy",
  "society",
  "international",
  "technology",
  "ai",
  "culture",
  "entertainment",
  "sports",
  "other",
];

const CATEGORY_LABELS = {
  politics: "政治",
  economy: "経済",
  society: "社会",
  international: "国際",
  technology: "テクノロジー",
  ai: "AI",
  culture: "文化",
  entertainment: "エンタメ",
  sports: "スポーツ",
  other: "その他",
};

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function isIso8601(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function isDateYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function rejectControlOrEmpty(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} は空でない文字列である必要があります。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${fieldName} に制御文字は使えません。`);
  }
  return value.trim();
}

function validateEditionId(id) {
  return rejectControlOrEmpty(id, "editionId");
}

function generateEditionId(date, now) {
  const stamp = nowIso(now).replace(/[:.]/g, "-");
  return `edition-${date}-${stamp}`;
}

function categoryLabel(category) {
  if (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category)) {
    return CATEGORY_LABELS[category];
  }
  return category;
}

function normalizeStringList(values, fieldName) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    throw new Error(`${fieldName} は配列である必要があります。`);
  }
  const seen = new Set();
  const out = [];
  for (const item of values) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${fieldName} に空文字は使えません。`);
    }
    if (/[\u0000-\u001f\u007f]/.test(item)) {
      throw new Error(`${fieldName} に制御文字は使えません。`);
    }
    const trimmed = item.trim();
    if (seen.has(trimmed)) {
      throw new Error(`${fieldName} に重複があります: ${trimmed}`);
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Validate Daily Edition Manifest (structure only; does not read files).
 */
function validateDailyEditionManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      ok: false,
      manifest: null,
      errors: ["Manifest はオブジェクトである必要があります。"],
    };
  }

  if (!isDateYmd(manifest.date)) {
    errors.push("date は YYYY-MM-DD 形式である必要があります。");
  }

  if (!Array.isArray(manifest.items)) {
    errors.push("items は配列である必要があります。");
  } else if (manifest.items.length === 0) {
    errors.push("items は 1 件以上必要です。");
  }

  if (manifest.title != null) {
    try {
      rejectControlOrEmpty(manifest.title, "title");
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (manifest.subtitle != null) {
    try {
      rejectControlOrEmpty(manifest.subtitle, "subtitle");
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (manifest.editionId != null) {
    try {
      validateEditionId(manifest.editionId);
    } catch (error) {
      errors.push(error.message);
    }
  }

  let categoryOrder = [];
  let excludedCategories = [];
  try {
    categoryOrder = normalizeStringList(
      manifest.categoryOrder,
      "categoryOrder"
    );
  } catch (error) {
    errors.push(error.message);
  }
  try {
    excludedCategories = normalizeStringList(
      manifest.excludedCategories,
      "excludedCategories"
    );
  } catch (error) {
    errors.push(error.message);
  }

  const articlePaths = new Set();
  const reportPaths = new Set();

  if (Array.isArray(manifest.items)) {
    for (let i = 0; i < manifest.items.length; i++) {
      const item = manifest.items[i];
      const prefix = `items[${i}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${prefix} はオブジェクトである必要があります。`);
        continue;
      }
      if (typeof item.article !== "string" || !item.article.trim()) {
        errors.push(`${prefix}.article は空でない文字列である必要があります。`);
      } else {
        const art = item.article.trim();
        if (articlePaths.has(art)) {
          errors.push(`article パスが重複しています: ${art}`);
        }
        articlePaths.add(art);
      }
      if (typeof item.report !== "string" || !item.report.trim()) {
        errors.push(`${prefix}.report は空でない文字列である必要があります。`);
      } else {
        const rep = item.report.trim();
        if (reportPaths.has(rep)) {
          errors.push(`report パスが重複しています: ${rep}`);
        }
        reportPaths.add(rep);
      }
      try {
        rejectControlOrEmpty(item.category, `${prefix}.category`);
      } catch (error) {
        errors.push(error.message);
      }
      if (item.priority != null) {
        if (typeof item.priority !== "number" || !Number.isFinite(item.priority)) {
          errors.push(`${prefix}.priority は有限数である必要があります。`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors };
  }

  const normalized = {
    date: manifest.date,
    title:
      typeof manifest.title === "string" && manifest.title.trim()
        ? manifest.title.trim()
        : DEFAULT_EDITION_TITLE,
    subtitle:
      typeof manifest.subtitle === "string" && manifest.subtitle.trim()
        ? manifest.subtitle.trim()
        : null,
    editionId:
      typeof manifest.editionId === "string" && manifest.editionId.trim()
        ? manifest.editionId.trim()
        : null,
    categoryOrder,
    excludedCategories,
    metadata:
      manifest.metadata &&
      typeof manifest.metadata === "object" &&
      !Array.isArray(manifest.metadata)
        ? { ...manifest.metadata }
        : {},
    items: manifest.items.map((item, index) => ({
      article: item.article.trim(),
      report: item.report.trim(),
      category: item.category.trim(),
      priority:
        item.priority == null ? DEFAULT_PRIORITY : Number(item.priority),
      manifestIndex: index,
    })),
  };

  return { ok: true, manifest: normalized, errors: [] };
}

/**
 * Resolve Manifest paths relative to the Manifest file directory.
 * Pure: returns resolved string paths (caller may pass already-absolute paths).
 */
function resolveManifestPaths(manifest, manifestDir) {
  const base = manifestDir || "";
  const resolveOne = (p) => {
    if (!p) return p;
    if (base && !isAbsolutePath(p)) {
      return joinPath(base, p);
    }
    return p;
  };
  return {
    ...manifest,
    items: manifest.items.map((item) => ({
      ...item,
      articlePath: resolveOne(item.article),
      reportPath: resolveOne(item.report),
    })),
  };
}

function isAbsolutePath(p) {
  if (typeof p !== "string") return false;
  if (p.startsWith("/")) return true;
  // Windows drive
  return /^[A-Za-z]:[\\/]/.test(p);
}

function joinPath(dir, file) {
  if (!dir) return file;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  if (dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${file}`;
  return `${dir}${sep}${file}`;
}

function normalizeCategoryOrder(manifestOrder, presentCategories) {
  const present = [...new Set(presentCategories)];
  const ordered = [];
  const seen = new Set();

  for (const cat of manifestOrder || []) {
    if (present.includes(cat) && !seen.has(cat)) {
      ordered.push(cat);
      seen.add(cat);
    }
  }
  for (const cat of DEFAULT_CATEGORY_ORDER) {
    if (present.includes(cat) && !seen.has(cat)) {
      ordered.push(cat);
      seen.add(cat);
    }
  }
  const unknown = present
    .filter((c) => !seen.has(c))
    .sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
  for (const cat of unknown) {
    ordered.push(cat);
    seen.add(cat);
  }
  return ordered;
}

function compareUnicode(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function sortArticles(articles) {
  return [...articles].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ca = a.confidenceAverage;
    const cb = b.confidenceAverage;
    const na = typeof ca === "number" ? ca : -Infinity;
    const nb = typeof cb === "number" ? cb : -Infinity;
    if (na !== nb) return nb - na;
    const titleCmp = compareUnicode(a.title, b.title);
    if (titleCmp !== 0) return titleCmp;
    return a.manifestIndex - b.manifestIndex;
  });
}

function groupArticlesByCategory(articles, categoryOrder) {
  const groups = [];
  const byCat = new Map();
  for (const cat of categoryOrder) {
    byCat.set(cat, []);
  }
  for (const article of articles) {
    if (!byCat.has(article.category)) {
      byCat.set(article.category, []);
    }
    byCat.get(article.category).push(article);
  }
  for (const cat of categoryOrder) {
    const items = byCat.get(cat) || [];
    if (items.length > 0) {
      groups.push({
        category: cat,
        label: categoryLabel(cat),
        articles: items,
      });
    }
  }
  return groups;
}

/**
 * Extract first H1 from markdown (comments stripped for lookup, but we scan visible).
 */
function extractH1Title(markdown) {
  return extractMarkdownTitle(markdown);
}

/**
 * Strip Writer trailing HTML comment metadata blocks; keep body comments inside content.
 * Removes all HTML comments (Writer metadata at end; any mid-body comments also removed
 * from Edition body per contract recommendation).
 */
function stripWriterMetadata(markdown) {
  return String(markdown || "").replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Remove leading H1 line from markdown (outside code/comment — comments already stripped).
 */
function removeLeadingH1(markdown) {
  const lines = String(markdown || "").split("\n");
  let removed = false;
  const out = [];
  for (const line of lines) {
    if (!removed && /^#\s+/.test(line) && !/^##/.test(line)) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

/**
 * Shift ATX headings for edition hierarchy.
 * H1→H3, H2→H4, H3→H5, H4→H5, H5→H6, H6→H6.
 * Skips fenced code blocks and HTML comments.
 */
function transformHeadings(markdown) {
  const lines = String(markdown || "").split("\n");
  const out = [];
  let inFence = false;
  let inComment = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (!inComment && fenceMatch) {
      if (!inFence) {
        inFence = true;
      } else {
        inFence = false;
      }
      out.push(line);
      continue;
    }

    if (!inFence) {
      if (!inComment && line.includes("<!--")) {
        inComment = true;
      }
      if (inComment) {
        out.push(line);
        if (line.includes("-->")) {
          inComment = false;
        }
        continue;
      }
    }

    if (!inFence && !inComment) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        let next;
        if (level === 1) next = 3;
        else if (level === 2) next = 4;
        else if (level === 3) next = 5;
        else if (level === 4) next = 5;
        else if (level === 5) next = 6;
        else next = 6;
        out.push(`${"#".repeat(next)} ${heading[2]}`);
        continue;
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

function transformArticleMarkdown(markdown) {
  const withoutMeta = stripWriterMetadata(markdown);
  const withoutH1 = removeLeadingH1(withoutMeta);
  const transformed = transformHeadings(withoutH1);
  return transformed.replace(/\s+$/, "");
}

function selectArticles(loadedItems, options = {}) {
  const excludeWarnings = options.excludeWarnings === true;
  const excludedCategories = new Set(options.excludedCategories || []);
  const selected = [];
  const reportIds = new Set();
  const titleCategory = new Set();

  for (const item of loadedItems) {
    const exclusionReasons = [];
    const report = item.report;
    const markdown = item.markdown;
    const h1 = extractH1Title(markdown);
    const reportTitle =
      report && report.article && typeof report.article.title === "string"
        ? report.article.title.trim()
        : null;

    let reportValidation = item.reportValidation;
    if (!reportValidation && report) {
      reportValidation = validateArticleReport(report);
    }

    if (!item.markdownReadable) {
      exclusionReasons.push("Markdown を読み込めませんでした。");
    }
    if (!item.reportReadable) {
      exclusionReasons.push("Article Report を読み込めませんでした。");
    }
    if (reportValidation && !reportValidation.ok) {
      exclusionReasons.push("Article Report validation に失敗しました。");
    }

    const status = report?.reviewSummary?.status;
    const ready = report?.reviewSummary?.readyForAiRewrite === true;
    const errorCount = report?.reviewSummary?.errorCount ?? null;
    const usableClaimCount =
      report?.statistics?.usableClaimCount ??
      report?.claims?.usable ??
      0;

    if (status === "fail") {
      exclusionReasons.push("reviewSummary.status が fail です。");
    } else if (status == null && reportValidation?.ok) {
      exclusionReasons.push("reviewSummary.status がありません。");
    } else if (status != null && status !== "pass" && status !== "warning") {
      exclusionReasons.push(`reviewSummary.status が不正です: ${status}`);
    }
    if (typeof errorCount === "number" && errorCount >= 1) {
      exclusionReasons.push("errorCount が 1 以上です。");
    }
    if (usableClaimCount < 1) {
      exclusionReasons.push("usableClaimCount が 0 です。");
    }
    if (!ready) {
      exclusionReasons.push("readyForAiRewrite が false です。");
    }
    if (excludeWarnings && status === "warning") {
      exclusionReasons.push("--exclude-warnings により warning を除外しました。");
    }
    if (excludeWarnings && status !== "pass" && status !== "fail" && status !== "warning") {
      exclusionReasons.push("--exclude-warnings により pass 以外を除外しました。");
    }

    if (h1 == null || reportTitle == null || h1 !== reportTitle) {
      exclusionReasons.push("Markdown H1 と Report article.title が一致しません。");
    }

    if (excludedCategories.has(item.category)) {
      exclusionReasons.push(
        `excludedCategories によりカテゴリ ${item.category} を除外しました。`
      );
    }

    if (report && typeof report.id === "string") {
      if (reportIds.has(report.id)) {
        exclusionReasons.push(`Report ID が重複しています: ${report.id}`);
      }
    }
    const titleCatKey = `${h1 || ""}::${item.category}`;
    if (h1 && titleCategory.has(titleCatKey)) {
      exclusionReasons.push(
        `同一 H1 + category が重複しています: ${h1} / ${item.category}`
      );
    }

    // Deduplicate reasons
    const uniqueReasons = [...new Set(exclusionReasons)];
    const included = uniqueReasons.length === 0;

    if (included) {
      if (report && typeof report.id === "string") {
        reportIds.add(report.id);
      }
      if (h1) {
        titleCategory.add(titleCatKey);
      }
    }

    const confidenceAverage =
      report?.confidence?.average != null
        ? report.confidence.average
        : null;

    selected.push({
      title: reportTitle || h1 || "(untitled)",
      markdownH1: h1,
      reportTitle,
      category: item.category,
      categoryDisplay: categoryLabel(item.category),
      priority: item.priority,
      manifestIndex: item.manifestIndex,
      articlePath: item.articlePath,
      reportPath: item.reportPath,
      reportId: report?.id || null,
      reportStatus: status || null,
      readyForAiRewrite: ready,
      included,
      exclusionReasons: uniqueReasons,
      confidence: report?.confidence || null,
      confidenceAverage,
      usableClaimCount,
      evidenceCount: report?.statistics?.evidenceCount ?? report?.evidence?.total ?? 0,
      errorCount: errorCount ?? 0,
      warningCount: report?.reviewSummary?.warningCount ?? 0,
      markdownReadable: item.markdownReadable === true,
      reportReadable: item.reportReadable === true,
      report,
      markdown,
      reportValidation,
      transformedBody: included ? transformArticleMarkdown(markdown) : null,
      strippedMetadata: extractWriterMetadataBlocks(markdown),
    });
  }

  return selected;
}

function extractWriterMetadataBlocks(markdown) {
  const blocks = [];
  const re = /<!--([\s\S]*?)-->/g;
  let match;
  while ((match = re.exec(String(markdown || ""))) !== null) {
    const body = match[1];
    if (
      /Constraints|Statistics|Source Snapshot/i.test(body) ||
      /^\s*\n?(Constraints|Statistics|Source Snapshot)/m.test(body)
    ) {
      blocks.push({
        kind: /Source Snapshot/i.test(body)
          ? "Source Snapshot"
          : /Statistics/i.test(body)
            ? "Statistics"
            : /Constraints/i.test(body)
              ? "Constraints"
              : "comment",
        text: body.trim(),
      });
    }
  }
  return blocks;
}

function collectEditorialWarningLines(article) {
  const lines = [];
  const seen = new Set();
  const push = (text) => {
    const t = String(text || "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    lines.push(`「${article.title}」: ${t}`);
  };

  const report = article.report;
  if (!report) return lines;

  if (Array.isArray(report.checks)) {
    for (const check of report.checks) {
      if (check && check.status === "warning" && check.message) {
        push(check.message);
      }
    }
  }

  if (report.reviewSummary && Array.isArray(report.reviewSummary.reasons)) {
    for (const reason of report.reviewSummary.reasons) {
      if (
        typeof reason === "string" &&
        reason !== "機械的条件を満たしています。"
      ) {
        push(reason);
      }
    }
  }

  if (Array.isArray(report.gaps)) {
    for (const gap of report.gaps) {
      if (gap && typeof gap.message === "string" && gap.message.trim()) {
        push(gap.message.trim());
      }
    }
  }

  return lines;
}

function renderEditorialWarnings(includedArticles) {
  const lines = [];
  for (const article of includedArticles) {
    if (article.reportStatus === "warning" || article.warningCount > 0) {
      lines.push(...collectEditorialWarningLines(article));
    } else {
      // Still surface gap messages if any on included pass articles? Only when warning present per task
    }
  }
  // Also include warning messages from checks even if status is pass but has warning checks
  if (lines.length === 0) {
    for (const article of includedArticles) {
      const hasWarningCheck =
        article.report &&
        Array.isArray(article.report.checks) &&
        article.report.checks.some((c) => c.status === "warning");
      if (hasWarningCheck) {
        lines.push(...collectEditorialWarningLines(article));
      }
    }
  }

  if (lines.length === 0) return null;
  return `## ${EDITORIAL_WARNINGS_HEADING}\n\n${lines
    .map((l) => `- ${l}`)
    .join("\n")}`;
}

function renderDailyEditionMetadata({
  id,
  date,
  generatedAt,
  included,
  excluded,
  categories,
  sourceReportIds,
}) {
  const catList = categories.join(", ");
  const reports =
    sourceReportIds.length > 0
      ? sourceReportIds.map((rid) => `- ${rid}`).join("\n")
      : "- (none)";
  return [
    "<!--",
    "",
    "Daily Edition",
    "",
    `ID: ${id}`,
    `Date: ${date}`,
    `Generated At: ${generatedAt}`,
    `Included Articles: ${included}`,
    `Excluded Articles: ${excluded}`,
    `Categories: ${catList}`,
    "Source Reports:",
    reports,
    "",
    "-->",
  ].join("\n");
}

function renderDailyEditionMarkdown({
  title,
  subtitle,
  date,
  groups,
  warningsSection,
  metadataBlock,
}) {
  const parts = [];
  parts.push(`# ${title}`);
  parts.push("");
  parts.push(date);
  if (subtitle) {
    parts.push("");
    parts.push(subtitle);
  }
  parts.push("");
  parts.push(DEFAULT_INTRO);
  parts.push("");
  parts.push("---");

  for (const group of groups) {
    parts.push("");
    parts.push(`## ${group.label}`);
    for (const article of group.articles) {
      parts.push("");
      parts.push(`### ${article.title}`);
      parts.push("");
      parts.push(article.transformedBody || "");
      parts.push("");
      parts.push("---");
    }
  }

  if (warningsSection) {
    parts.push("");
    parts.push(warningsSection);
    parts.push("");
    parts.push("---");
  }

  parts.push("");
  parts.push(metadataBlock);
  parts.push("");

  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

function buildEditionChecks({
  manifestValidation,
  articles,
  markdown,
  metadataPresent,
  excludeWarnings,
}) {
  const checks = [];
  const push = (type, status, severity, message, details = null) => {
    checks.push({ type, status, severity, message, details });
  };

  if (manifestValidation.ok) {
    push("manifest-valid", "pass", "info", "Manifest は valid です。");
  } else {
    push("manifest-valid", "error", "error", "Manifest が不正です。", {
      errors: manifestValidation.errors,
    });
  }

  const unreadMd = articles.filter((a) => !a.markdownReadable);
  push(
    "article-files-readable",
    unreadMd.length === 0 ? "pass" : "error",
    unreadMd.length === 0 ? "info" : "error",
    unreadMd.length === 0
      ? "すべての記事 Markdown を読み込めました。"
      : "読み込めない記事 Markdown があります。",
    { paths: unreadMd.map((a) => a.articlePath) }
  );

  const unreadRp = articles.filter((a) => !a.reportReadable);
  push(
    "report-files-readable",
    unreadRp.length === 0 ? "pass" : "error",
    unreadRp.length === 0 ? "info" : "error",
    unreadRp.length === 0
      ? "すべての Article Report を読み込めました。"
      : "読み込めない Article Report があります。",
    { paths: unreadRp.map((a) => a.reportPath) }
  );

  const invalidReports = articles.filter(
    (a) => a.reportValidation && !a.reportValidation.ok
  );
  push(
    "report-valid",
    invalidReports.length === 0 ? "pass" : "error",
    invalidReports.length === 0 ? "info" : "error",
    invalidReports.length === 0
      ? "すべての Article Report が valid です。"
      : "不正な Article Report があります。",
    { reportIds: invalidReports.map((a) => a.reportId) }
  );

  const titleMismatch = articles.filter(
    (a) =>
      a.markdownReadable &&
      a.reportReadable &&
      (a.markdownH1 == null ||
        a.reportTitle == null ||
        a.markdownH1 !== a.reportTitle)
  );
  push(
    "article-report-title-match",
    titleMismatch.length === 0 ? "pass" : "error",
    titleMismatch.length === 0 ? "info" : "error",
    titleMismatch.length === 0
      ? "Markdown H1 と Report title が一致します。"
      : "Markdown H1 と Report title が一致しない記事があります。",
    { titles: titleMismatch.map((a) => ({ h1: a.markdownH1, report: a.reportTitle })) }
  );

  push(
    "article-count",
    articles.length > 0 ? "pass" : "error",
    articles.length > 0 ? "info" : "error",
    `入力記事数: ${articles.length}`
  );

  const included = articles.filter((a) => a.included);
  push(
    "included-article-count",
    included.length > 0 ? "pass" : "warning",
    included.length > 0 ? "info" : "warning",
    `掲載記事数: ${included.length}`
  );

  const warningIncluded = included.filter((a) => a.reportStatus === "warning");
  if (warningIncluded.length > 0) {
    push(
      "included-warning-articles",
      "warning",
      "warning",
      `warning 記事が ${warningIncluded.length} 件掲載されています。`,
      { titles: warningIncluded.map((a) => a.title) }
    );
  }

  const dupReasons = articles.filter((a) =>
    a.exclusionReasons.some(
      (r) => r.includes("重複") || r.includes("duplicate")
    )
  );
  push(
    "duplicate-articles",
    dupReasons.length === 0 ? "pass" : "error",
    dupReasons.length === 0 ? "info" : "error",
    dupReasons.length === 0
      ? "重複記事はありません。"
      : "重複記事が検出されました。"
  );

  push("category-order", "pass", "info", "categoryOrder を適用しました。");

  const failedIncluded = included.filter(
    (a) => a.reportStatus === "fail" || a.errorCount > 0
  );
  push(
    "no-failed-articles-included",
    failedIncluded.length === 0 ? "pass" : "error",
    failedIncluded.length === 0 ? "info" : "error",
    failedIncluded.length === 0
      ? "fail 記事は掲載されていません。"
      : "fail 記事が掲載されています。"
  );

  if (excludeWarnings) {
    const warningIncluded = included.filter((a) => a.reportStatus === "warning");
    push(
      "exclude-warnings",
      warningIncluded.length === 0 ? "pass" : "error",
      warningIncluded.length === 0 ? "info" : "error",
      warningIncluded.length === 0
        ? "--exclude-warnings 条件下で warning 記事は未掲載です。"
        : "--exclude-warnings なのに warning 記事が掲載されています。"
    );
  }

  push(
    "edition-markdown-generated",
    typeof markdown === "string" && markdown.trim().length > 0
      ? "pass"
      : "error",
    typeof markdown === "string" && markdown.trim().length > 0
      ? "info"
      : "error",
    "Daily Edition Markdown を生成しました。"
  );

  push(
    "metadata-present",
    metadataPresent ? "pass" : "error",
    metadataPresent ? "info" : "error",
    metadataPresent
      ? "Daily Edition Metadata があります。"
      : "Daily Edition Metadata がありません。"
  );

  push(
    "input-files-read-only",
    "pass",
    "info",
    "入力は読み取り専用として扱い、Edition 生成では変更しません。"
  );

  return checks;
}

function buildEditionReviewSummary(checks, articles, options = {}) {
  const errorCount = checks.filter((c) => c.status === "error").length;
  const warningCount = checks.filter((c) => c.status === "warning").length;
  const passCount = checks.filter((c) => c.status === "pass").length;

  let status = "pass";
  if (errorCount > 0) status = "fail";
  else if (warningCount > 0) status = "warning";

  const included = articles.filter((a) => a.included);
  const failedIncluded = included.some(
    (a) => a.reportStatus === "fail" || a.errorCount > 0
  );
  const warningIncludedWhenExcluded =
    options.excludeWarnings === true &&
    included.some((a) => a.reportStatus === "warning");

  const markdownOk = checks.some(
    (c) => c.type === "edition-markdown-generated" && c.status === "pass"
  );
  const reportValidOk = !checks.some(
    (c) => c.type === "report-valid" && c.status === "error"
  );

  const publishable =
    errorCount === 0 &&
    included.length >= 1 &&
    !failedIncluded &&
    !warningIncludedWhenExcluded &&
    markdownOk &&
    reportValidOk;

  const reasons = [];
  if (errorCount > 0) reasons.push("error check があります。");
  if (included.length < 1) reasons.push("掲載記事がありません。");
  if (failedIncluded) reasons.push("fail 記事が掲載されています。");
  if (warningIncludedWhenExcluded) {
    reasons.push("--exclude-warnings なのに warning 記事が掲載されています。");
  }
  if (!markdownOk) reasons.push("Daily Edition Markdown 生成に失敗しました。");
  if (publishable) reasons.push("機械的 publishable 条件を満たしています。");

  return {
    status,
    errorCount,
    warningCount,
    passCount,
    publishable,
    reasons,
  };
}

function calculateEditionStatistics({
  articles,
  categories,
  checks,
  reviewSummary,
  markdown,
}) {
  const included = articles.filter((a) => a.included);
  const excluded = articles.filter((a) => !a.included);
  const visible = stripHtmlComments(markdown || "");
  const totalCharacterCount = Array.from(visible).length;

  return {
    inputArticleCount: articles.length,
    includedArticleCount: included.length,
    excludedArticleCount: excluded.length,
    categoryCount: categories.length,
    warningArticleCount: articles.filter((a) => a.reportStatus === "warning")
      .length,
    passArticleCount: articles.filter((a) => a.reportStatus === "pass").length,
    failArticleCount: articles.filter((a) => a.reportStatus === "fail").length,
    totalUsableClaimCount: included.reduce(
      (sum, a) => sum + (a.usableClaimCount || 0),
      0
    ),
    totalEvidenceCount: included.reduce(
      (sum, a) => sum + (a.evidenceCount || 0),
      0
    ),
    totalCharacterCount,
    checkCount: checks.length,
    errorCount: reviewSummary.errorCount,
    warningCount: reviewSummary.warningCount,
    passCount: reviewSummary.passCount,
  };
}

function buildEditionReport({
  id,
  date,
  generatedAt,
  title,
  manifest,
  articles,
  categories,
  checks,
  reviewSummary,
  statistics,
}) {
  return {
    id,
    date,
    generatedAt,
    title,
    manifest: {
      itemCount: manifest.items.length,
      categoryOrder: manifest.categoryOrder,
      excludedCategories: manifest.excludedCategories,
    },
    articles: {
      total: articles.length,
      included: articles.filter((a) => a.included).length,
      excluded: articles.filter((a) => !a.included).length,
      items: articles.map((a) => ({
        title: a.title,
        category: a.category,
        categoryDisplay: a.categoryDisplay,
        priority: a.priority,
        reportId: a.reportId,
        reportStatus: a.reportStatus,
        readyForAiRewrite: a.readyForAiRewrite,
        included: a.included,
        exclusionReasons: [...a.exclusionReasons],
        confidence: a.confidenceAverage,
        usableClaimCount: a.usableClaimCount,
        evidenceCount: a.evidenceCount,
        articlePath: a.articlePath,
        reportPath: a.reportPath,
        metadataBlocks: (a.strippedMetadata || []).map((b) => ({
          kind: b.kind,
        })),
      })),
    },
    categories: categories.map((c) => ({
      category: c.category,
      label: c.label,
      articleCount: c.articles.length,
      titles: c.articles.map((a) => a.title),
    })),
    checks,
    reviewSummary,
    statistics,
  };
}

function validateEditionReport(report) {
  const errors = [];

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      ok: false,
      report: null,
      errors: ["Edition Report はオブジェクトである必要があります。"],
    };
  }

  for (const forbidden of ["markdown", "articleBodies", "editionMarkdown"]) {
    if (Object.prototype.hasOwnProperty.call(report, forbidden)) {
      errors.push(`Edition Report に ${forbidden} を含めてはいけません。`);
    }
  }

  try {
    validateEditionId(report.id);
  } catch (error) {
    errors.push(error.message);
  }

  if (!isDateYmd(report.date)) {
    errors.push("date は YYYY-MM-DD 形式である必要があります。");
  }
  if (!isIso8601(report.generatedAt)) {
    errors.push("generatedAt は ISO8601 である必要があります。");
  }
  if (typeof report.title !== "string" || !report.title.trim()) {
    errors.push("title は空でない文字列である必要があります。");
  }

  if (!report.articles || typeof report.articles !== "object") {
    errors.push("articles はオブジェクトである必要があります。");
  } else if (!Array.isArray(report.articles.items)) {
    errors.push("articles.items は配列である必要があります。");
  } else {
    if (report.articles.total !== report.articles.items.length) {
      errors.push("articles.total が items 件数と一致しません。");
    }
    const inc = report.articles.items.filter((a) => a.included).length;
    const exc = report.articles.items.filter((a) => !a.included).length;
    if (report.articles.included !== inc) {
      errors.push("articles.included が不整合です。");
    }
    if (report.articles.excluded !== exc) {
      errors.push("articles.excluded が不整合です。");
    }
  }

  if (!Array.isArray(report.categories)) {
    errors.push("categories は配列である必要があります。");
  }

  if (!Array.isArray(report.checks)) {
    errors.push("checks は配列である必要があります。");
  }

  if (!report.reviewSummary || typeof report.reviewSummary !== "object") {
    errors.push("reviewSummary はオブジェクトである必要があります。");
  } else if (Array.isArray(report.checks)) {
    const ec = report.checks.filter((c) => c.status === "error").length;
    const wc = report.checks.filter((c) => c.status === "warning").length;
    const pc = report.checks.filter((c) => c.status === "pass").length;
    if (report.reviewSummary.errorCount !== ec) {
      errors.push("reviewSummary.errorCount が不整合です。");
    }
    if (report.reviewSummary.warningCount !== wc) {
      errors.push("reviewSummary.warningCount が不整合です。");
    }
    if (report.reviewSummary.passCount !== pc) {
      errors.push("reviewSummary.passCount が不整合です。");
    }
    const expectedStatus = ec > 0 ? "fail" : wc > 0 ? "warning" : "pass";
    if (report.reviewSummary.status !== expectedStatus) {
      errors.push("reviewSummary.status が不整合です。");
    }
    if (
      report.reviewSummary.errorCount > 0 &&
      report.reviewSummary.publishable === true
    ) {
      errors.push(
        "publishable が機械的規則と一致しません（error があるのに true）。"
      );
    }
    if (
      report.articles &&
      report.articles.included < 1 &&
      report.reviewSummary.publishable === true
    ) {
      errors.push(
        "publishable が機械的規則と一致しません（掲載記事なし）。"
      );
    }
  }

  if (!report.statistics || typeof report.statistics !== "object") {
    errors.push("statistics はオブジェクトである必要があります。");
  } else if (Array.isArray(report.checks) && report.reviewSummary) {
    if (report.statistics.checkCount !== report.checks.length) {
      errors.push("statistics.checkCount が不整合です。");
    }
    if (report.statistics.errorCount !== report.reviewSummary.errorCount) {
      errors.push("statistics.errorCount が不整合です。");
    }
    if (
      report.articles &&
      report.statistics.includedArticleCount !== report.articles.included
    ) {
      errors.push("statistics.includedArticleCount が不整合です。");
    }
  }

  if (Array.isArray(report.categories) && report.statistics) {
    if (report.statistics.categoryCount !== report.categories.length) {
      errors.push("statistics.categoryCount が不整合です。");
    }
  }

  if (errors.length > 0) {
    return { ok: false, report: null, errors };
  }

  return {
    ok: true,
    report: JSON.parse(JSON.stringify(report)),
    errors: [],
  };
}

/**
 * @param {object} manifestInput - raw or normalized manifest
 * @param {object[]} loadedItems - { markdown, report, articlePath, reportPath, category, priority, manifestIndex, markdownReadable, reportReadable }
 * @param {object} options
 * @param {object} context - { now }
 */
function buildDailyEdition(manifestInput, loadedItems, options = {}, context = {}) {
  const manifestValidation = validateDailyEditionManifest(manifestInput);
  if (!manifestValidation.ok) {
    const err = new Error(manifestValidation.errors.join("\n"));
    err.validation = manifestValidation;
    throw err;
  }
  const manifest = manifestValidation.manifest;

  const prepared = (loadedItems || []).map((item, index) => {
    const reportValidation =
      item.report != null
        ? validateArticleReport(item.report)
        : { ok: false, errors: ["Report がありません。"] };
    return {
      markdown: item.markdown,
      report: reportValidation.ok ? reportValidation.report : item.report,
      articlePath: item.articlePath || item.article,
      reportPath: item.reportPath || item.report,
      category: item.category || manifest.items[index]?.category,
      priority:
        item.priority != null
          ? item.priority
          : manifest.items[index]?.priority ?? DEFAULT_PRIORITY,
      manifestIndex:
        item.manifestIndex != null ? item.manifestIndex : index,
      markdownReadable: item.markdownReadable !== false && typeof item.markdown === "string",
      reportReadable: item.reportReadable !== false && item.report != null,
      reportValidation,
    };
  });

  // Path-level duplicates among resolved paths
  const artSeen = new Set();
  const repSeen = new Set();
  for (const item of prepared) {
    if (item.articlePath) {
      if (artSeen.has(item.articlePath)) {
        throw new Error(`article パスが重複しています: ${item.articlePath}`);
      }
      artSeen.add(item.articlePath);
    }
    if (item.reportPath) {
      if (repSeen.has(item.reportPath)) {
        throw new Error(`report パスが重複しています: ${item.reportPath}`);
      }
      repSeen.add(item.reportPath);
    }
  }

  const articles = selectArticles(prepared, {
    excludeWarnings: options.excludeWarnings === true,
    excludedCategories: manifest.excludedCategories,
  });

  const included = articles.filter((a) => a.included);
  const sortedIncluded = sortArticles(included);
  // Keep exclusion list in manifest order for report
  const orderedAll = [
    ...sortedIncluded,
    ...articles.filter((a) => !a.included),
  ];

  const presentCategories = sortedIncluded.map((a) => a.category);
  const categoryOrder = normalizeCategoryOrder(
    manifest.categoryOrder,
    presentCategories
  );
  const groups = groupArticlesByCategory(sortedIncluded, categoryOrder);

  const id =
    options.editionId != null
      ? validateEditionId(options.editionId)
      : manifest.editionId || generateEditionId(manifest.date, context.now);
  const generatedAt = nowIso(context.now);
  const title = manifest.title;

  const warningsSection = renderEditorialWarnings(sortedIncluded);
  const metadataBlock = renderDailyEditionMetadata({
    id,
    date: manifest.date,
    generatedAt,
    included: sortedIncluded.length,
    excluded: articles.length - sortedIncluded.length,
    categories: categoryOrder,
    sourceReportIds: sortedIncluded
      .map((a) => a.reportId)
      .filter(Boolean),
  });

  const markdown = renderDailyEditionMarkdown({
    title,
    subtitle: manifest.subtitle,
    date: manifest.date,
    groups,
    warningsSection,
    metadataBlock,
  });

  const checks = buildEditionChecks({
    manifestValidation,
    articles: orderedAll,
    markdown,
    metadataPresent: /<!--\s*\n?\s*Daily Edition/.test(markdown),
    excludeWarnings: options.excludeWarnings === true,
  });

  const reviewSummary = buildEditionReviewSummary(checks, orderedAll, {
    excludeWarnings: options.excludeWarnings === true,
  });

  const statistics = calculateEditionStatistics({
    articles: orderedAll,
    categories: groups,
    checks,
    reviewSummary,
    markdown,
  });

  const editionReport = buildEditionReport({
    id,
    date: manifest.date,
    generatedAt,
    title,
    manifest,
    articles: orderedAll,
    categories: groups,
    checks,
    reviewSummary,
    statistics,
  });

  const validated = validateEditionReport(editionReport);
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }

  return {
    markdown,
    report: validated.report,
    articles: orderedAll,
    groups,
  };
}

function validateDailyEditionResult(result) {
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      errors: ["結果オブジェクトが不正です。"],
    };
  }
  if (typeof result.markdown !== "string" || !result.markdown.trim()) {
    return { ok: false, errors: ["markdown が空です。"] };
  }
  if (!/<!--\s*\n?\s*Daily Edition/.test(result.markdown)) {
    return { ok: false, errors: ["Daily Edition Metadata がありません。"] };
  }
  const reportValidation = validateEditionReport(result.report);
  if (!reportValidation.ok) {
    return { ok: false, errors: reportValidation.errors };
  }
  return { ok: true, errors: [] };
}

module.exports = {
  DEFAULT_EDITION_TITLE,
  DEFAULT_INTRO,
  DEFAULT_PRIORITY,
  DEFAULT_CATEGORY_ORDER,
  CATEGORY_LABELS,
  EDITORIAL_WARNINGS_HEADING,
  validateDailyEditionManifest,
  resolveManifestPaths,
  buildDailyEdition,
  validateDailyEditionResult,
  selectArticles,
  sortArticles,
  groupArticlesByCategory,
  renderDailyEditionMarkdown,
  transformArticleMarkdown,
  transformHeadings,
  renderEditorialWarnings,
  renderDailyEditionMetadata,
  buildEditionReport,
  validateEditionReport,
  buildEditionChecks,
  buildEditionReviewSummary,
  calculateEditionStatistics,
  normalizeCategoryOrder,
  categoryLabel,
  extractH1Title,
  generateEditionId,
  validateEditionId,
};
