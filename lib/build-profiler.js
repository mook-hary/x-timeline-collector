/**
 * EP-042 — Lightweight build timing profiler.
 * Uses performance.now() (high-resolution). No I/O in measure().
 */
const { performance } = require("perf_hooks");

/** Display order for Reader build phases. */
const READER_PHASE_ORDER = [
  "Load Data",
  "Editorial",
  "Morning Brief",
  "Today's Picks",
  "Category Digest",
  "HTML Render",
  "Write File",
];

/**
 * Default: profiling ON. Set READER_PROFILE=false to disable.
 * @param {NodeJS.ProcessEnv} [env]
 */
function isReaderProfileEnabled(env = process.env) {
  const raw = env?.READER_PROFILE;
  if (raw == null || String(raw).trim() === "") return true;
  return String(raw).trim().toLowerCase() !== "false";
}

function roundMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n < 10) return Math.round(n * 10) / 10; // one decimal for tiny spans
  return Math.round(n);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {string[]} [options.phaseOrder]
 */
function createBuildProfiler(options = {}) {
  const enabled =
    options.enabled != null ? Boolean(options.enabled) : isReaderProfileEnabled();
  const phaseOrder = Array.isArray(options.phaseOrder)
    ? options.phaseOrder
    : READER_PHASE_ORDER;

  /** @type {Map<string, number>} */
  const timings = new Map();
  /** @type {string[]} */
  const seen = [];
  let wallStart = null;
  let wallEnd = null;

  function startWall() {
    if (!enabled) return;
    wallStart = performance.now();
    wallEnd = null;
  }

  function endWall() {
    if (!enabled || wallStart == null) return;
    wallEnd = performance.now();
  }

  /**
   * @template T
   * @param {string} label
   * @param {() => T} fn
   * @returns {T}
   */
  function measure(label, fn) {
    if (!enabled) return fn();
    const name = String(label || "Unknown");
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      const elapsed = performance.now() - t0;
      timings.set(name, (timings.get(name) || 0) + elapsed);
      if (!seen.includes(name)) seen.push(name);
    }
  }

  function getTimingMs(label) {
    return roundMs(timings.get(label) || 0);
  }

  function getTotalMs() {
    if (wallStart != null && wallEnd != null) {
      return roundMs(wallEnd - wallStart);
    }
    let sum = 0;
    for (const ms of timings.values()) sum += ms;
    return roundMs(sum);
  }

  /**
   * @returns {Record<string, number>}
   */
  function toJSON() {
    /** @type {Record<string, number>} */
    const out = {};
    const labels = [
      ...phaseOrder.filter((l) => timings.has(l)),
      ...seen.filter((l) => !phaseOrder.includes(l)),
    ];
    for (const label of labels) {
      out[label] = getTimingMs(label);
    }
    out.Total = getTotalMs();
    return out;
  }

  function formatReport() {
    if (!enabled) return "";
    const lines = [];
    lines.push("Reader Build");
    lines.push("");

    const labels = [
      ...phaseOrder.filter((l) => timings.has(l) || phaseOrder.includes(l)),
    ];
    // Always show known phases (0 ms if skipped)
    const known = phaseOrder.length ? phaseOrder : seen;
    for (const label of known) {
      const dots = ".".repeat(Math.max(2, 20 - label.length));
      lines.push(`${label}${dots} ${getTimingMs(label)} ms`);
    }
    for (const label of seen) {
      if (known.includes(label)) continue;
      const dots = ".".repeat(Math.max(2, 20 - label.length));
      lines.push(`${label}${dots} ${getTimingMs(label)} ms`);
    }

    lines.push("");
    lines.push("----------------------------");
    lines.push("");
    const totalLabel = "Total";
    const totalDots = ".".repeat(Math.max(2, 20 - totalLabel.length));
    lines.push(`${totalLabel}${totalDots} ${getTotalMs()} ms`);
    lines.push("");
    return lines.join("\n");
  }

  /**
   * @param {NodeJS.WritableStream|{write:(s:string)=>any}} [stream]
   */
  function report(stream = process.stderr) {
    if (!enabled) return false;
    const text = formatReport();
    if (!text) return false;
    stream.write(text.endsWith("\n") ? text : `${text}\n`);
    return true;
  }

  return {
    enabled,
    measure,
    startWall,
    endWall,
    getTimingMs,
    getTotalMs,
    toJSON,
    formatReport,
    report,
  };
}

module.exports = {
  READER_PHASE_ORDER,
  isReaderProfileEnabled,
  createBuildProfiler,
  roundMs,
};
