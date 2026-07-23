/**
 * EP-034 — AI Usage Dashboard data + HTML for Digest Reader.
 * Reads Morning history only; no graphs / no Morning changes.
 */
const {
  normalizeEntry,
  summarizeUsageEntries,
} = require("./api-usage-history");
const { startOfLocalDay, endOfLocalDay } = require("./date-range");

function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Token counts: 12,345 */
function formatTokenCount(value) {
  return toNonNegInt(value).toLocaleString("en-US");
}

/** Costs: $0.1167 (4 decimals). */
function formatDashboardCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

function sortEntriesByFinishedAtDesc(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((e) => normalizeEntry(e))
    .sort((a, b) => {
      if (a.finishedAt !== b.finishedAt) {
        return a.finishedAt < b.finishedAt ? 1 : -1;
      }
      if (a.id !== b.id) {
        return a.id < b.id ? 1 : -1;
      }
      return 0;
    });
}

/**
 * Most recent N runs by finishedAt (desc). Does not mutate input.
 */
function selectLastNRuns(entries, n) {
  const limit = Math.max(0, toNonNegInt(n));
  return sortEntriesByFinishedAtDesc(entries).slice(0, limit);
}

/**
 * Entries whose finishedAt falls on the local calendar day of `now`.
 */
function filterEntriesForLocalToday(entries, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return [];
  const fromMs = startOfLocalDay(
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate()
  ).getTime();
  const toMs = endOfLocalDay(
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate()
  ).getTime();

  return (Array.isArray(entries) ? entries : [])
    .map((e) => normalizeEntry(e))
    .filter((e) => {
      const ms = Date.parse(e.finishedAt);
      return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs;
    });
}

function summarizeWithAverages(entries) {
  const summary = summarizeUsageEntries(entries);
  const runs = summary.runs;
  return {
    ...summary,
    averageCostPerRun: runs === 0 ? 0 : summary.estimatedCostUsd.total / runs,
    averageTokensPerRun: runs === 0 ? 0 : summary.totalTokens / runs,
  };
}

/**
 * @param {object[]} entries
 * @param {{ now?: Date|string|number, available?: boolean }} [options]
 */
function buildUsageDashboard(entries, options = {}) {
  if (options.available === false) {
    return {
      available: false,
      today: null,
      last7: null,
      allTime: null,
    };
  }

  const list = Array.isArray(entries) ? entries.map((e) => normalizeEntry(e)) : [];
  const now = options.now != null ? options.now : new Date();
  const todayEntries = filterEntriesForLocalToday(list, now);
  const last7Entries = selectLastNRuns(list, 7);
  const todaySorted = sortEntriesByFinishedAtDesc(todayEntries);
  const todaySummary = summarizeWithAverages(todayEntries);

  return {
    available: true,
    today: {
      empty: todayEntries.length === 0,
      model: todaySorted[0] ? todaySorted[0].model : "",
      ...todaySummary,
    },
    last7: summarizeWithAverages(last7Entries),
    allTime: summarizeWithAverages(list),
  };
}

function renderStatRows(rows) {
  const items = rows
    .map(
      ([label, value]) =>
        `<div class="usage-dash__row"><dt>${escapeHtml(
          label
        )}</dt><dd>${escapeHtml(value)}</dd></div>`
    )
    .join("\n      ");
  return `<dl class="usage-dash__stats">
      ${items}
    </dl>`;
}

function renderPeriodStats(summary, { includeAverages = false } = {}) {
  const rows = [
    ["Runs", formatTokenCount(summary.runs)],
    ["Requests", formatTokenCount(summary.requests)],
    ["Input Tokens", formatTokenCount(summary.inputTokens)],
    ["Output Tokens", formatTokenCount(summary.outputTokens)],
    ["Total Tokens", formatTokenCount(summary.totalTokens)],
    ["Estimated Cost", formatDashboardCost(summary.estimatedCostUsd.total)],
  ];
  if (includeAverages) {
    rows.push(
      ["Average Cost / Run", formatDashboardCost(summary.averageCostPerRun)],
      [
        "Average Tokens / Run",
        formatTokenCount(Math.round(summary.averageTokensPerRun)),
      ]
    );
  }
  return renderStatRows(rows);
}

/**
 * HTML block for Digest Reader (always safe; empty states included).
 * @param {ReturnType<typeof buildUsageDashboard>} dashboard
 */
function renderUsageDashboard(dashboard) {
  const title = `<h2 class="section__label" id="usage-label">AI Usage Dashboard</h2>`;

  if (!dashboard || dashboard.available === false) {
    return `<section class="section usage-dash" id="ai-usage" aria-labelledby="usage-label">
  ${title}
  <p class="empty">No usage history available.</p>
</section>`;
  }

  const today = dashboard.today;
  const todayBody =
    !today || today.empty
      ? `<p class="empty">No usage today.</p>`
      : renderStatRows([
          ["Model", today.model || "—"],
          ["Runs", formatTokenCount(today.runs)],
          ["Requests", formatTokenCount(today.requests)],
          ["Input Tokens", formatTokenCount(today.inputTokens)],
          ["Output Tokens", formatTokenCount(today.outputTokens)],
          ["Total Tokens", formatTokenCount(today.totalTokens)],
          ["Estimated Cost", formatDashboardCost(today.estimatedCostUsd.total)],
        ]);

  return `<section class="section usage-dash" id="ai-usage" aria-labelledby="usage-label">
  ${title}
  <div class="usage-dash__block">
    <h3 class="usage-dash__heading" id="usage-today-label">Today's Run</h3>
    ${todayBody}
  </div>
  <div class="usage-dash__block">
    <h3 class="usage-dash__heading" id="usage-last7-label">Last 7 Runs</h3>
    ${renderPeriodStats(dashboard.last7, { includeAverages: true })}
  </div>
  <div class="usage-dash__block">
    <h3 class="usage-dash__heading" id="usage-all-label">All Time</h3>
    ${renderPeriodStats(dashboard.allTime, { includeAverages: true })}
  </div>
</section>`;
}

module.exports = {
  formatTokenCount,
  formatDashboardCost,
  sortEntriesByFinishedAtDesc,
  selectLastNRuns,
  filterEntriesForLocalToday,
  summarizeWithAverages,
  buildUsageDashboard,
  renderUsageDashboard,
  escapeHtml,
};
