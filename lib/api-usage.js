/**
 * EP-030 — OpenAI API usage aggregation helpers.
 * No pricing. Safe when usage is missing.
 */

const USAGE_MARKER_PREFIX = "[api-usage]";

function emptyUsage() {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Extract token usage from an OpenAI response object.
 * Supports Responses API (input_tokens/output_tokens) and
 * Chat Completions-style (prompt_tokens/completion_tokens).
 * Missing usage → zeros (does not throw).
 *
 * @param {object|null|undefined} response
 * @returns {{ requests: number, input_tokens: number, output_tokens: number, total_tokens: number }}
 */
function extractUsageFromResponse(response) {
  const usage =
    response && typeof response === "object" && response.usage
      ? response.usage
      : null;

  if (!usage || typeof usage !== "object") {
    return {
      requests: 1,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
  }

  const input = toNonNegInt(
    usage.input_tokens != null ? usage.input_tokens : usage.prompt_tokens
  );
  const output = toNonNegInt(
    usage.output_tokens != null ? usage.output_tokens : usage.completion_tokens
  );
  let total = toNonNegInt(usage.total_tokens);
  if (total === 0 && (input > 0 || output > 0)) {
    total = input + output;
  }

  return {
    requests: 1,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

/**
 * @param {ReturnType<typeof emptyUsage>} totals
 * @param {ReturnType<typeof extractUsageFromResponse>|null|undefined} piece
 */
function addUsage(totals, piece) {
  const base = totals && typeof totals === "object" ? totals : emptyUsage();
  const next = piece && typeof piece === "object" ? piece : null;
  if (!next) return base;
  return {
    requests: toNonNegInt(base.requests) + toNonNegInt(next.requests),
    input_tokens:
      toNonNegInt(base.input_tokens) + toNonNegInt(next.input_tokens),
    output_tokens:
      toNonNegInt(base.output_tokens) + toNonNegInt(next.output_tokens),
    total_tokens:
      toNonNegInt(base.total_tokens) + toNonNegInt(next.total_tokens),
  };
}

/**
 * Human-readable usage block.
 * @param {string} title e.g. "Analyze" or "Enrich"
 * @param {ReturnType<typeof emptyUsage>} usage
 */
function formatUsageBlock(title, usage) {
  const u = usage && typeof usage === "object" ? usage : emptyUsage();
  return [
    `${title} Usage`,
    "",
    `Requests : ${toNonNegInt(u.requests)}`,
    `Input     : ${toNonNegInt(u.input_tokens)}`,
    `Output    : ${toNonNegInt(u.output_tokens)}`,
    `Total     : ${toNonNegInt(u.total_tokens)}`,
  ].join("\n");
}

/**
 * Machine-readable marker line for Morning to parse.
 * @param {string} label
 * @param {ReturnType<typeof emptyUsage>} usage
 */
function formatUsageMarker(label, usage) {
  const u = usage && typeof usage === "object" ? usage : emptyUsage();
  const payload = {
    label: String(label || ""),
    requests: toNonNegInt(u.requests),
    input_tokens: toNonNegInt(u.input_tokens),
    output_tokens: toNonNegInt(u.output_tokens),
    total_tokens: toNonNegInt(u.total_tokens),
  };
  return `${USAGE_MARKER_PREFIX} ${JSON.stringify(payload)}`;
}

/**
 * @param {string} text
 * @returns {ReturnType<typeof emptyUsage>|null}
 */
function parseUsageMarkerLine(text) {
  const line = String(text || "").trim();
  if (!line.startsWith(USAGE_MARKER_PREFIX)) return null;
  const jsonPart = line.slice(USAGE_MARKER_PREFIX.length).trim();
  try {
    const data = JSON.parse(jsonPart);
    if (!data || typeof data !== "object") return null;
    return {
      label: String(data.label || ""),
      requests: toNonNegInt(data.requests),
      input_tokens: toNonNegInt(data.input_tokens),
      output_tokens: toNonNegInt(data.output_tokens),
      total_tokens: toNonNegInt(data.total_tokens),
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Find the last usage marker in combined stdout/stderr text.
 * @param {string} text
 * @returns {(ReturnType<typeof emptyUsage> & { label: string })|null}
 */
function parseUsageFromOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  let found = null;
  for (const line of lines) {
    const parsed = parseUsageMarkerLine(line);
    if (parsed) found = parsed;
  }
  return found;
}

/**
 * @param {{ analyze?: object, enrich?: object }} parts
 */
function formatMorningUsageSummary(parts = {}) {
  const analyze = parts.analyze || emptyUsage();
  const enrich = parts.enrich || emptyUsage();
  const grand = addUsage(analyze, enrich);
  return [
    "Morning Summary",
    "",
    "Analyze",
    `Requests : ${toNonNegInt(analyze.requests)}`,
    `Input    : ${toNonNegInt(analyze.input_tokens)}`,
    `Output   : ${toNonNegInt(analyze.output_tokens)}`,
    `Total    : ${toNonNegInt(analyze.total_tokens)}`,
    "",
    "Enrich",
    `Requests : ${toNonNegInt(enrich.requests)}`,
    `Input    : ${toNonNegInt(enrich.input_tokens)}`,
    `Output   : ${toNonNegInt(enrich.output_tokens)}`,
    `Total    : ${toNonNegInt(enrich.total_tokens)}`,
    "",
    "Grand Total",
    "",
    `Requests : ${toNonNegInt(grand.requests)}`,
    `Input    : ${toNonNegInt(grand.input_tokens)}`,
    `Output   : ${toNonNegInt(grand.output_tokens)}`,
    `Total    : ${toNonNegInt(grand.total_tokens)}`,
  ].join("\n");
}

function printUsageSummary(title, usage, { stdout = console.log } = {}) {
  stdout(formatUsageBlock(title, usage));
  stdout(formatUsageMarker(title, usage));
}

module.exports = {
  USAGE_MARKER_PREFIX,
  emptyUsage,
  extractUsageFromResponse,
  addUsage,
  formatUsageBlock,
  formatUsageMarker,
  parseUsageMarkerLine,
  parseUsageFromOutput,
  formatMorningUsageSummary,
  printUsageSummary,
};
