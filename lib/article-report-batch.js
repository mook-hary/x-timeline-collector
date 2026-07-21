/**
 * EP-009 — Multi-Article Report batch runner.
 * 1 generated article = 1 Article Report. Does not re-run Writer / Edition.
 * Deterministic when context.now is fixed. No AI.
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./pipeline-io");
const {
  buildArticleReport,
  validateArticleReport,
} = require("./article-report-core");

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function emptyReportSummary() {
  return {
    requestedCount: 0,
    generatedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    publishableCount: 0,
    readyForAiRewriteCount: 0,
  };
}

/**
 * Resolve report filename from article path basename.
 * articles/01-foo.md → 01-foo.report.json
 */
function resolveReportFileName(articlePath) {
  const base = path.basename(asString(articlePath) || "article.md");
  const stem = base.replace(/\.md$/i, "") || "article";
  // Prevent path traversal in basename
  const safe = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return `${safe || "article"}.report.json`;
}

function resolveReportRelativePath(outputDirName, articlePath) {
  const fileName = resolveReportFileName(articlePath);
  return `${outputDirName}/${fileName}`.replace(/\\/g, "/");
}

function isValidReportObject(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return false;
  }
  if (!report.reviewSummary || typeof report.reviewSummary !== "object") {
    return false;
  }
  return true;
}

function resolveWorkRoot(manifestPath, articlesDir) {
  if (manifestPath) return path.dirname(path.resolve(manifestPath));
  if (articlesDir) return path.dirname(path.resolve(articlesDir));
  return process.cwd();
}

function resolveArticleAbsolutePath(workRoot, articlePath) {
  const rel = asString(articlePath);
  if (!rel) return null;
  // Disallow absolute / parent traversal
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[/\\]/).includes("..")) return null;
  return path.resolve(workRoot, rel);
}

/**
 * Run Article Report for each generated manifest article.
 *
 * @param {object} options
 * @param {object} options.manifest - articles-manifest.json object
 * @param {object} options.brief
 * @param {object} options.plan
 * @param {string} options.outputDir - article-reports/
 * @param {string} [options.manifestPath] - write updated manifest here
 * @param {string} [options.legacyReportPath] - primary report copy (article-report.json)
 * @param {string} [options.articlesDir] - optional, for resolving relative paths
 * @param {number} [options.confidenceThreshold]
 * @param {Date|string} [options.now] - fixed clock for determinism
 * @param {function} [options.buildFn] - inject for tests
 * @returns {{
 *   manifest: object,
 *   reportSummary: object,
 *   legacyPrimaryReport: object|null,
 *   legacyPrimaryReportPath: string|null,
 * }}
 */
function runArticleReportBatch({
  manifest,
  brief,
  plan,
  outputDir,
  manifestPath = null,
  legacyReportPath = null,
  articlesDir = null,
  confidenceThreshold = 50,
  now = null,
  buildFn = null,
} = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    const err = new Error("articles-manifest が不正です。");
    err.code = "article-manifest-invalid";
    throw err;
  }

  const build =
    typeof buildFn === "function" ? buildFn : buildArticleReport;
  const workRoot = resolveWorkRoot(manifestPath, articlesDir || outputDir);
  const outputDirName = path.basename(path.resolve(outputDir));
  ensureDir(outputDir);

  const articles = Array.isArray(manifest.articles)
    ? manifest.articles.map((a) => ({ ...a }))
    : [];
  const reportSummary = emptyReportSummary();
  const fixedNow = now != null ? now : brief?.generatedAt || "2026-07-21T00:00:00.000Z";

  let legacyPrimaryReport = null;
  let legacyPrimaryReportRel = null;
  const primaryArticlePath = asString(manifest.legacyPrimaryArticlePath);

  for (const entry of articles) {
    if (!entry || typeof entry !== "object") continue;

    // Never mutate article Writer status; only attach report.
    if (entry.status !== "generated") {
      // Writer failed/skipped — do not evaluate
      continue;
    }

    reportSummary.requestedCount += 1;

    const absArticle = resolveArticleAbsolutePath(workRoot, entry.articlePath);
    if (!absArticle || !fs.existsSync(absArticle)) {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-file-not-found",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    const reportFileName = resolveReportFileName(entry.articlePath);
    const absReport = path.join(path.resolve(outputDir), reportFileName);
    // Ensure still under outputDir
    if (!absReport.startsWith(path.resolve(outputDir) + path.sep) &&
        absReport !== path.resolve(outputDir)) {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-report-write-failed",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    const relReport = resolveReportRelativePath(
      outputDirName,
      entry.articlePath
    );

    let markdown = "";
    try {
      markdown = fs.readFileSync(absArticle, "utf8");
    } catch {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-file-not-found",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    let report = null;
    try {
      report = build(
        brief,
        plan,
        markdown,
        { confidenceThreshold },
        { now: fixedNow }
      );
    } catch {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-report-generation-failed",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    if (!isValidReportObject(report)) {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-report-empty-output",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    const validated = validateArticleReport(report);
    if (!validated.ok) {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-report-generation-failed",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    try {
      writeJsonAtomic(absReport, report);
    } catch {
      entry.report = {
        status: "failed",
        reportPath: null,
        errorCode: "article-report-write-failed",
      };
      reportSummary.failedCount += 1;
      continue;
    }

    const ready =
      report.reviewSummary && report.reviewSummary.readyForAiRewrite === true;
    const publishable =
      report.reviewSummary && report.reviewSummary.publishable === true;

    entry.report = {
      status: "generated",
      reportPath: relReport,
      readyForAiRewrite: ready,
    };
    if (
      report.reviewSummary &&
      Object.prototype.hasOwnProperty.call(report.reviewSummary, "publishable")
    ) {
      entry.report.publishable = publishable;
    }

    reportSummary.generatedCount += 1;
    if (ready) reportSummary.readyForAiRewriteCount += 1;
    if (publishable) reportSummary.publishableCount += 1;

    if (
      primaryArticlePath &&
      asString(entry.articlePath) === primaryArticlePath
    ) {
      legacyPrimaryReport = report;
      legacyPrimaryReportRel = relReport;
    }
  }

  // If primary path unset, fall back to first generated report with path
  if (!legacyPrimaryReport) {
    const first = articles.find(
      (a) => a && a.report && a.report.status === "generated" && a.report.reportPath
    );
    if (first) {
      const abs = path.resolve(workRoot, first.report.reportPath);
      try {
        legacyPrimaryReport = JSON.parse(fs.readFileSync(abs, "utf8"));
        legacyPrimaryReportRel = first.report.reportPath;
      } catch {
        legacyPrimaryReport = null;
      }
    }
  }

  const updatedManifest = {
    ...manifest,
    articles,
    reportSummary,
    legacyPrimaryReportPath: legacyPrimaryReportRel,
  };

  if (manifestPath) {
    writeJsonAtomic(path.resolve(manifestPath), updatedManifest);
  }

  if (legacyReportPath && legacyPrimaryReport) {
    writeJsonAtomic(path.resolve(legacyReportPath), legacyPrimaryReport);
  } else if (legacyReportPath && !legacyPrimaryReport) {
    // empty selection / no primary — write minimal warning report for DE compat
    const empty = {
      reviewSummary: {
        status: "warning",
        errorCount: 0,
        warningCount: 1,
        passCount: 0,
        readyForAiRewrite: false,
        reasons: ["article-report-batch: no generated articles"],
      },
    };
    writeJsonAtomic(path.resolve(legacyReportPath), empty);
    legacyPrimaryReport = empty;
  }

  return {
    manifest: updatedManifest,
    reportSummary,
    legacyPrimaryReport,
    legacyPrimaryReportPath: legacyPrimaryReportRel,
  };
}

module.exports = {
  runArticleReportBatch,
  resolveReportFileName,
  resolveReportRelativePath,
  emptyReportSummary,
  isValidReportObject,
};
