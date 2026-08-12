/**
 * EP-048 — Morning Pipeline health report (JSON history + CLI summary).
 * Shared shape for future Reader ops / bots / dashboards.
 * History I/O failures must never fail the pipeline (caller swallows).
 */
const fs = require("fs");
const path = require("path");
const {
  parseCollectHealthFromOutput,
  formatXCollectorSummary,
  collectDetailFromHealth,
  buildCollectorHealth,
  buildCollectMetrics,
} = require("./x-collector-health");

const HISTORY_DIR_REL = path.join(".pipeline-work", "history");
const REPORT_VERSION = 1;

/**
 * Local timestamp filename: YYYY-MM-DD-HHmmss.json
 * @param {Date|string|number} [when]
 */
function formatHistoryFilename(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date for history filename: ${when}`);
  }
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${day}-${hh}${mm}${ss}.json`;
}

function resolveHistoryDir(rootDir) {
  return path.join(path.resolve(rootDir || process.cwd()), HISTORY_DIR_REL);
}

/**
 * @param {number} ms
 * @returns {string} e.g. "4m 12s", "45s", "1h 2m 3s"
 */
function formatDurationMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function durationBetween(startedAt, finishedAt) {
  const a = Date.parse(startedAt);
  const b = Date.parse(finishedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, b - a);
}

/**
 * Extract item counts from stage stdout/stderr.
 * @param {string} stageId
 * @param {string} output
 * @returns {number|null}
 */
function parseStageItemCount(stageId, output) {
  const text = String(output || "");
  const matchInt = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  if (stageId === "collect") {
    const health = parseCollectHealthFromOutput(text);
    if (health && health.totalStored != null && Number.isFinite(Number(health.totalStored))) {
      return Number(health.totalStored);
    }
    return (
      matchInt(/Total posts after save:\s*(\d+)/i) ??
      matchInt(/今回新しく追加した件数:\s*(\d+)/) ??
      null
    );
  }
  if (stageId === "analyze") {
    return matchInt(/分析対象:\s*(\d+)\s*件/);
  }
  if (stageId === "analyze-ai") {
    return (
      matchInt(/今回処理する件数:\s*(\d+)/) ??
      matchInt(/API成功件数:\s*(\d+)/) ??
      null
    );
  }
  if (stageId === "enrich") {
    return (
      matchInt(/今回処理する件数:\s*(\d+)/) ??
      matchInt(/API成功件数:\s*(\d+)/) ??
      null
    );
  }
  return null;
}

/**
 * @param {object} input
 */
function buildMorningHealthReport(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const finishedAt = input.finishedAt || new Date().toISOString();
  const status =
    input.status === "FAILED" || input.status === "SUCCESS"
      ? input.status
      : input.ok === false
        ? "FAILED"
        : "SUCCESS";

  const stages = Array.isArray(input.stages)
    ? input.stages.map((s) => normalizeStage(s))
    : [];

  const counts = {
    collect: pickCount(input.counts && input.counts.collect, stages, "collect"),
    analyze: pickCount(input.counts && input.counts.analyze, stages, "analyze"),
    analyzeAi: pickCount(
      input.counts && input.counts.analyzeAi,
      stages,
      "analyze-ai"
    ),
    enrich: pickCount(input.counts && input.counts.enrich, stages, "enrich"),
  };

  const publishIn = input.publish || {};
  const publish = {
    ok: publishIn.ok === true,
    committed: publishIn.committed === true,
    pushed: publishIn.pushed === true,
    pagesPublished: publishIn.pagesPublished === true,
  };

  /** @type {null|{ stage: string, error: string, stack: string|null }} */
  let failure = null;
  if (status === "FAILED") {
    const f = input.failure || {};
    failure = {
      stage: String(f.stage || "unknown"),
      error: String(f.error || "unknown error"),
      stack: f.stack != null ? String(f.stack) : null,
    };
  }

  const collectorHealth = normalizeCollectorHealth(
    input.collectorHealth,
    stages,
    status,
    failure
  );
  const collect =
    normalizeCollectDetail(input.collect, collectorHealth, counts.collect);

  return {
    version: REPORT_VERSION,
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    status,
    stages,
    counts,
    collect,
    collectorHealth,
    publish,
    failure,
  };
}

function findCollectStage(stages) {
  return (stages || []).find((s) => s && s.id === "collect") || null;
}

/**
 * Pull collect detail + collectorHealth from Morning stages / thrown error.
 * Used by Morning Pipeline when calling finalizeHealth (wiring).
 * @param {object[]|null|undefined} stages
 * @param {object|null|undefined} [errorOrResult]
 * @returns {{ collect: object|null, collectorHealth: object|null }}
 */
function extractCollectHealthFields(stages, errorOrResult = null) {
  const fromError =
    errorOrResult &&
    errorOrResult.collectorHealth &&
    typeof errorOrResult.collectorHealth === "object"
      ? errorOrResult.collectorHealth
      : null;
  const fromResultCollect =
    errorOrResult &&
    errorOrResult.collect &&
    typeof errorOrResult.collect === "object"
      ? errorOrResult.collect
      : null;
  const stage = findCollectStage(stages);
  const stageHealth =
    stage && stage.collectorHealth && typeof stage.collectorHealth === "object"
      ? stage.collectorHealth
      : null;
  const stageCollect =
    stage && stage.collect && typeof stage.collect === "object"
      ? stage.collect
      : null;

  const collectorHealthRaw = fromError || stageHealth || null;
  const collectorHealth = collectorHealthRaw
    ? buildCollectorHealth(collectorHealthRaw)
    : null;
  const collectRaw =
    fromResultCollect ||
    stageCollect ||
    collectDetailFromHealth(collectorHealth);
  const collect = collectRaw ? buildCollectMetrics(collectRaw) : null;

  return { collect, collectorHealth };
}

function normalizeCollectorHealth(explicit, stages, status, failure) {
  if (explicit && typeof explicit === "object") {
    return buildCollectorHealth(explicit);
  }
  const stage = findCollectStage(stages);
  if (stage && stage.collectorHealth && typeof stage.collectorHealth === "object") {
    return buildCollectorHealth(stage.collectorHealth);
  }
  if (
    status === "FAILED" &&
    failure &&
    /X_AUTH_REQUIRED/i.test(String(failure.error || ""))
  ) {
    return buildCollectorHealth({
      authenticated: false,
      timelineAvailable: false,
      status: "failed",
      error: "X_AUTH_REQUIRED",
    });
  }
  return null;
}

function normalizeCollectDetail(explicit, collectorHealth, totalFallback) {
  if (explicit && typeof explicit === "object") {
    return buildCollectMetrics(explicit);
  }
  const fromHealth = collectDetailFromHealth(collectorHealth);
  if (fromHealth) return fromHealth;
  if (totalFallback != null && Number.isFinite(Number(totalFallback))) {
    return buildCollectMetrics({
      totalStored: Number(totalFallback),
    });
  }
  return null;
}

function pickCount(explicit, stages, id) {
  if (explicit != null && Number.isFinite(Number(explicit))) {
    return Number(explicit);
  }
  const stage = stages.find((s) => s.id === id);
  if (stage && stage.itemCount != null && Number.isFinite(stage.itemCount)) {
    return stage.itemCount;
  }
  return null;
}

function normalizeStage(raw = {}) {
  const startedAt = raw.startedAt || null;
  const finishedAt = raw.finishedAt || null;
  let durationMs =
    raw.durationMs != null ? Number(raw.durationMs) : null;
  if (
    (durationMs == null || Number.isNaN(durationMs)) &&
    startedAt &&
    finishedAt
  ) {
    durationMs = durationBetween(startedAt, finishedAt);
  }
  const stage = {
    id: String(raw.id || "unknown"),
    label: String(raw.label || raw.id || "unknown"),
    startedAt,
    finishedAt,
    durationMs: durationMs == null || Number.isNaN(durationMs) ? 0 : durationMs,
    ok: raw.ok !== false,
    itemCount:
      raw.itemCount != null && Number.isFinite(Number(raw.itemCount))
        ? Number(raw.itemCount)
        : null,
    skipped: raw.skipped === true,
  };
  if (raw.collectorHealth && typeof raw.collectorHealth === "object") {
    stage.collectorHealth = buildCollectorHealth(raw.collectorHealth);
  }
  if (raw.collect && typeof raw.collect === "object") {
    stage.collect = buildCollectMetrics(raw.collect);
  }
  return stage;
}

/**
 * Save report under .pipeline-work/history/. May throw (caller must catch).
 * @returns {{ path: string, relativePath: string, report: object }}
 */
function saveMorningHealthReport(rootDir, report, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const now = typeof deps.now === "function" ? deps.now() : new Date();
  const dir = resolveHistoryDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filename = formatHistoryFilename(now);
  const filePath = path.join(dir, filename);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(filePath, payload, "utf8");
  const root = path.resolve(rootDir || process.cwd());
  const relativePath = path.join(HISTORY_DIR_REL, filename);
  return { path: filePath, relativePath, report };
}

/**
 * Build publish block from publish-reader result.
 */
function publishResultFromRunner(result) {
  if (!result || result.ok !== true) {
    return {
      ok: false,
      committed: false,
      pushed: false,
      pagesPublished: false,
    };
  }
  const committed = result.committed === true;
  const pushed = result.skippedPush !== true && committed;
  return {
    ok: true,
    committed,
    pushed,
    // Push triggers GitHub Pages workflow (deploy is async).
    pagesPublished: pushed,
  };
}

/**
 * CLI summary block shown at Morning Pipeline end.
 * @param {object} report
 * @param {string|null} historyRelativePath
 */
function formatMorningPipelineSummary(report, historyRelativePath) {
  const lines = [];
  lines.push("=================================");
  lines.push("");
  lines.push("Morning Pipeline Summary");
  lines.push("");
  lines.push(`Status: ${report.status}`);
  lines.push("");
  lines.push("Duration:");
  lines.push(formatDurationMs(report.durationMs));
  lines.push("");

  if (report.collectorHealth) {
    lines.push(formatXCollectorSummary(report.collectorHealth));
    lines.push("");
  } else {
    const collect = report.counts && report.counts.collect;
    if (collect != null) {
      lines.push("Collect:");
      lines.push(`${collect} items`);
      lines.push("");
    }
  }

  const analyze = report.counts && report.counts.analyze;
  if (analyze != null) {
    lines.push("Analyze:");
    lines.push(`${analyze} items`);
    lines.push("");
  }

  const analyzeAi = report.counts && report.counts.analyzeAi;
  if (analyzeAi != null) {
    lines.push("AI Analyze:");
    lines.push(`${analyzeAi} items`);
    lines.push("");
  }

  const enrich = report.counts && report.counts.enrich;
  if (enrich != null) {
    lines.push("AI Enrich:");
    lines.push(`${enrich} items`);
    lines.push("");
  }

  lines.push("Publish:");
  if (report.publish && report.publish.ok) {
    lines.push("Success");
  } else if (report.status === "SUCCESS") {
    lines.push("Skipped");
  } else {
    lines.push("Failed");
  }
  lines.push("");

  lines.push("History:");
  lines.push(historyRelativePath || "(not saved)");
  lines.push("");
  lines.push("=================================");
  return `${lines.join("\n")}\n`;
}

/**
 * Latest EP-048 health report (for Launcher Collector Health).
 * @param {string} [rootDir]
 * @param {object} [deps]
 * @returns {object|null}
 */
function loadLatestMorningHealthReport(rootDir, deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const dir = resolveHistoryDir(rootDir);
  if (!existsSync(dir)) return null;
  let names;
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch (_error) {
    return null;
  }
  if (!names.length) return null;
  const latest = names[names.length - 1];
  try {
    const raw = readFileSync(path.join(dir, latest), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ...parsed,
      _historyFile: path.join(HISTORY_DIR_REL, latest),
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Compact Collector Health for dashboards.
 * @param {object|null} report
 */
function collectorHealthForDashboard(report) {
  if (!report || typeof report !== "object") {
    return {
      xLogin: "—",
      lastCollect: null,
      newPosts: null,
      latestPost: null,
      status: "unknown",
      collectorHealth: null,
      historyFile: null,
    };
  }
  const health = report.collectorHealth || null;
  let xLogin = "—";
  let status = "unknown";
  if (health) {
    if (health.authenticated === true) xLogin = "OK";
    else if (health.authenticated === false) xLogin = "Failed";
    status = health.status || "unknown";
  } else if (report.status === "SUCCESS") {
    xLogin = "OK";
    status = "healthy";
  } else if (report.status === "FAILED") {
    status = "failed";
  }
  const collect = report.collect || {};
  return {
    xLogin,
    lastCollect: report.finishedAt || report.startedAt || null,
    newPosts:
      collect.newPosts != null
        ? collect.newPosts
        : health && health.newPosts != null
          ? health.newPosts
          : null,
    latestPost:
      collect.newestPostAt ||
      (health && health.newestPostAt) ||
      null,
    status,
    collectorHealth: health,
    historyFile: report._historyFile || null,
  };
}

module.exports = {
  HISTORY_DIR_REL,
  REPORT_VERSION,
  formatHistoryFilename,
  resolveHistoryDir,
  formatDurationMs,
  durationBetween,
  parseStageItemCount,
  parseCollectHealthFromOutput,
  buildMorningHealthReport,
  saveMorningHealthReport,
  publishResultFromRunner,
  formatMorningPipelineSummary,
  normalizeStage,
  loadLatestMorningHealthReport,
  collectorHealthForDashboard,
  extractCollectHealthFields,
  findCollectStage,
};
