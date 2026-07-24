/**
 * EP-034 / EP-037 — AI Usage Dashboard data + HTML for Digest Reader.
 * Reads Morning history only; JPY is display-only (not stored).
 */
const {
  normalizeEntry,
  summarizeUsageEntries,
} = require("./api-usage-history");
const { startOfLocalDay, endOfLocalDay } = require("./date-range");

const DEFAULT_USD_JPY_RATE = 150;

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

/**
 * Resolve USD→JPY rate from env / explicit value.
 * Invalid / missing / ≤0 → DEFAULT_USD_JPY_RATE (never throws).
 */
function resolveUsdJpyRate(raw) {
  if (raw === undefined) {
    raw =
      typeof process !== "undefined" && process.env
        ? process.env.USD_JPY_RATE
        : undefined;
  }
  if (raw == null || String(raw).trim() === "") {
    return DEFAULT_USD_JPY_RATE;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_USD_JPY_RATE;
  }
  return n;
}

/** USD × rate, rounded to nearest yen (half up via Math.round). */
function usdToJpy(usd, rate) {
  const dollars = Number(usd);
  const r = Number(rate);
  if (!Number.isFinite(dollars) || !Number.isFinite(r) || r <= 0) {
    return null;
  }
  return Math.round(dollars * r);
}

/** Costs: $0.1167 (4 decimals). */
function formatDashboardCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

/** 約¥20 / 約¥1,234 */
function formatJpyApprox(jpy) {
  if (jpy == null || !Number.isFinite(Number(jpy))) return null;
  const yen = Math.round(Number(jpy));
  return `約¥${yen.toLocaleString("en-US")}`;
}

/**
 * Combined display HTML: 約¥20（$0.1348）
 * Missing/non-finite USD → Unavailable (no invented JPY).
 */
function formatDashboardCostHtml(usd, rate) {
  if (usd == null || !Number.isFinite(Number(usd))) {
    return `<span class="cost-unavailable">Unavailable</span>`;
  }
  const usdStr = formatDashboardCost(usd);
  const jpy = usdToJpy(usd, rate);
  if (jpy == null) {
    return `<span class="cost-unavailable">Unavailable</span>`;
  }
  const jpyStr = formatJpyApprox(jpy);
  return `<span class="cost-jpy">${escapeHtml(
    jpyStr
  )}</span><span class="cost-usd">（${escapeHtml(usdStr)}）</span>`;
}

/** Plain combined string for tests / logs. */
function formatDashboardCostCombined(usd, rate) {
  if (usd == null || !Number.isFinite(Number(usd))) return "Unavailable";
  const jpy = usdToJpy(usd, rate);
  if (jpy == null) return "Unavailable";
  return `${formatJpyApprox(jpy)}（${formatDashboardCost(usd)}）`;
}

function formatExchangeRateNote(rate) {
  const r = resolveUsdJpyRate(rate);
  const label = Number.isInteger(r) ? String(r) : String(r);
  return `円換算: $1 = ¥${label}（概算）`;
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

  const list = Array.isArray(entries)
    ? entries.map((e) => normalizeEntry(e))
    : [];
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

/**
 * @param {Array<[string, string|{html:string}]>} rows
 */
function renderStatRows(rows) {
  const items = rows
    .map(([label, value]) => {
      const dd =
        value && typeof value === "object" && value.html != null
          ? value.html
          : escapeHtml(value);
      return `<div class="usage-dash__row"><dt>${escapeHtml(
        label
      )}</dt><dd>${dd}</dd></div>`;
    })
    .join("\n      ");
  return `<dl class="usage-dash__stats">
      ${items}
    </dl>`;
}

function costCell(usd, rate) {
  return { html: formatDashboardCostHtml(usd, rate) };
}

function renderPeriodStats(summary, { includeAverages = false, rate } = {}) {
  const rows = [
    ["Runs", formatTokenCount(summary.runs)],
    ["Requests", formatTokenCount(summary.requests)],
    ["Input Tokens", formatTokenCount(summary.inputTokens)],
    ["Output Tokens", formatTokenCount(summary.outputTokens)],
    ["Total Tokens", formatTokenCount(summary.totalTokens)],
    ["Estimated Cost", costCell(summary.estimatedCostUsd.total, rate)],
  ];
  if (includeAverages) {
    rows.push(
      ["Average Cost / Run", costCell(summary.averageCostPerRun, rate)],
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
 * @param {{ usdJpyRate?: number|string }} [options]
 */
function renderUsageDashboard(dashboard, options = {}) {
  const title = `<h2 class="section__label" id="usage-label">AI Usage Dashboard</h2>`;
  const rate = resolveUsdJpyRate(
    options.usdJpyRate !== undefined
      ? options.usdJpyRate
      : typeof process !== "undefined" && process.env
        ? process.env.USD_JPY_RATE
        : undefined
  );

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
          ["Estimated Cost", costCell(today.estimatedCostUsd.total, rate)],
        ]);

  const rateNote = escapeHtml(formatExchangeRateNote(rate));

  return `<section class="section usage-dash" id="ai-usage" aria-labelledby="usage-label">
  ${title}
  <div class="usage-dash__block">
    <h3 class="usage-dash__heading" id="usage-today-label">Today's Run</h3>
    ${todayBody}
  </div>
  <div class="usage-dash__block">
    <h3 class="usage-dash__heading" id="usage-last7-label">Last 7 Runs</h3>
    ${renderPeriodStats(dashboard.last7, { includeAverages: true, rate })}
  </div>
  <div class="usage-dash__block">
    <h3 class="usage-dash__heading" id="usage-all-label">All Time</h3>
    ${renderPeriodStats(dashboard.allTime, { includeAverages: true, rate })}
  </div>
  <p class="usage-dash__rate-note">${rateNote}</p>
</section>`;
}

module.exports = {
  DEFAULT_USD_JPY_RATE,
  formatTokenCount,
  formatDashboardCost,
  formatJpyApprox,
  formatDashboardCostHtml,
  formatDashboardCostCombined,
  formatExchangeRateNote,
  resolveUsdJpyRate,
  usdToJpy,
  sortEntriesByFinishedAtDesc,
  selectLastNRuns,
  filterEntriesForLocalToday,
  summarizeWithAverages,
  buildUsageDashboard,
  renderUsageDashboard,
  escapeHtml,
};
