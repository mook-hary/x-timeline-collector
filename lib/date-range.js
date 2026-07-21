/**
 * Local-calendar date boundaries for search.js and digest.js.
 * --from / --to / --today mean the user's local calendar day.
 */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfLocalDay(year, month, day) {
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function endOfLocalDay(year, month, day) {
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/**
 * @param {string} value
 * @param {string} optionName
 * @param {(message: string) => never} fail
 * @returns {{ year: number, month: number, day: number, label: string }}
 */
function parseDateOnly(value, optionName, fail) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(
      `${optionName} の日付形式が不正です。YYYY-MM-DD 形式で指定してください（例: 2026-07-01）。`
    );
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    fail(`${optionName} に存在しない日付が指定されています: ${value}`);
  }

  return { year, month, day, label: value };
}

/**
 * @param {{ today?: boolean, from?: { year: number, month: number, day: number, label: string } | null, to?: { year: number, month: number, day: number, label: string } | null }} options
 * @param {(message: string) => never} fail
 */
function resolveLocalDateRange(options, fail) {
  if (options.today) {
    const now = new Date();
    const label = formatLocalDate(now);
    const fromDate = startOfLocalDay(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate()
    );
    const toDate = endOfLocalDay(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate()
    );
    return {
      labelFrom: label,
      labelTo: label,
      fromMs: fromDate.getTime(),
      toMs: toDate.getTime(),
      rangeJson: {
        from: `${label}T00:00:00`,
        to: `${label}T23:59:59`,
      },
      hasRange: true,
      mode: "today",
    };
  }

  if (!options.from && !options.to) {
    return {
      labelFrom: null,
      labelTo: null,
      fromMs: null,
      toMs: null,
      rangeJson: { from: null, to: null },
      hasRange: false,
      mode: "all",
    };
  }

  const from = options.from || null;
  const to = options.to || null;
  const fromDate = from
    ? startOfLocalDay(from.year, from.month, from.day)
    : null;
  const toDate = to ? endOfLocalDay(to.year, to.month, to.day) : null;

  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    fail("--from は --to 以前の日付を指定してください。");
  }

  return {
    labelFrom: from ? from.label : null,
    labelTo: to ? to.label : null,
    fromMs: fromDate ? fromDate.getTime() : null,
    toMs: toDate ? toDate.getTime() : null,
    rangeJson: {
      from: from ? `${from.label}T00:00:00` : null,
      to: to ? `${to.label}T23:59:59` : null,
    },
    hasRange: true,
    mode: "range",
  };
}

function parsePostedAtMs(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * When range.hasRange is true, missing/invalid postedAt is outside the range.
 * When no range, always true (caller decides whether to apply).
 */
function isPostedAtInLocalRange(postedAtValue, range) {
  if (!range || !range.hasRange) return true;

  const postedAtMs = parsePostedAtMs(postedAtValue);
  if (postedAtMs == null) return false;
  if (range.fromMs != null && postedAtMs < range.fromMs) return false;
  if (range.toMs != null && postedAtMs > range.toMs) return false;
  return true;
}

module.exports = {
  pad2,
  formatLocalDate,
  startOfLocalDay,
  endOfLocalDay,
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
  isPostedAtInLocalRange,
};
