/**
 * Fixed thresholds for slow Morning Pipeline stages (warning only).
 */

const SLOW_STAGE_THRESHOLDS_MS = Object.freeze({
  collect: 5 * 60 * 1000,
  "analyze-ai": 30 * 60 * 1000,
  enrich: 45 * 60 * 1000,
  publish: 10 * 60 * 1000,
});

const SLOW_STAGE_WARNING_PREFIX = "SLOW_STAGE_";

function stageWarningCode(stageId) {
  const id = String(stageId || "unknown")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  return `${SLOW_STAGE_WARNING_PREFIX}${id}`;
}

/**
 * @param {object[]} stages
 * @param {object} [thresholdsMs]
 * @returns {string[]}
 */
function detectSlowStageWarnings(stages, thresholdsMs = SLOW_STAGE_THRESHOLDS_MS) {
  const list = Array.isArray(stages) ? stages : [];
  const warnings = [];
  const seen = new Set();
  for (const stage of list) {
    if (!stage || stage.ok === false || stage.skipped === true) continue;
    const id = String(stage.id || "");
    const limit = thresholdsMs[id];
    if (limit == null) continue;
    const duration = Number(stage.durationMs);
    if (!Number.isFinite(duration) || duration <= limit) continue;
    const code = stageWarningCode(id);
    if (seen.has(code)) continue;
    seen.add(code);
    warnings.push(code);
  }
  return warnings;
}

module.exports = {
  SLOW_STAGE_THRESHOLDS_MS,
  SLOW_STAGE_WARNING_PREFIX,
  stageWarningCode,
  detectSlowStageWarnings,
};
