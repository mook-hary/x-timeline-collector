/**
 * EP-053 — Editorial Ranking.
 * Score + breakdown only (no workflow mutation / auto-publish).
 */

const METRIC_KEYS = Object.freeze([
  "quality",
  "novelty",
  "freshness",
  "readiness",
]);

const DEFAULT_WEIGHTS = Object.freeze({
  quality: 0.4,
  novelty: 0.25,
  freshness: 0.2,
  readiness: 0.15,
});

const READINESS_BY_STATUS = Object.freeze({
  approved: 100,
  scheduled: 100,
  review: 75,
  draft: 50,
  published: 30,
  archived: 0,
});

const KNOWN_STATUSES = Object.freeze(Object.keys(READINESS_BY_STATUS));

const WEIGHT_SUM_TOLERANCE = 0.0001;

function getDefaultRankingWeights() {
  return { ...DEFAULT_WEIGHTS };
}

function clamp01to100(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function roundScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * @param {object} [weights]
 */
function normalizeWeights(weights) {
  const source = weights == null ? DEFAULT_WEIGHTS : weights;
  if (!source || typeof source !== "object") {
    const err = new Error("weights must be an object");
    err.code = "editorial-ranking-weights";
    throw err;
  }
  const out = {};
  let sum = 0;
  for (const key of METRIC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      const err = new Error(`weights.${key} is required`);
      err.code = "editorial-ranking-weights";
      throw err;
    }
    const n = Number(source[key]);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error(`weights.${key} must be a number >= 0`);
      err.code = "editorial-ranking-weights";
      throw err;
    }
    out[key] = n;
    sum += n;
  }
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    const err = new Error(
      `weights must sum to 1 (got ${sum}, tolerance ${WEIGHT_SUM_TOLERANCE})`
    );
    err.code = "editorial-ranking-weights";
    throw err;
  }
  return out;
}

/**
 * @param {object|null|undefined} evaluation Rules Engine report
 * @returns {{ score: number, unevaluated: boolean, errors: number, warnings: number, infos: number }}
 */
function calculateQuality(evaluation) {
  if (evaluation == null) {
    return {
      score: 100,
      unevaluated: true,
      errors: 0,
      warnings: 0,
      infos: 0,
    };
  }
  const counts = evaluation.counts || {};
  // Prefer failed counts from results when counts missing
  let errors = Number(counts.error) || 0;
  let warnings = Number(counts.warning) || 0;
  let infos = Number(counts.info) || 0;

  if (
    evaluation.counts == null &&
    Array.isArray(evaluation.results)
  ) {
    errors = 0;
    warnings = 0;
    infos = 0;
    for (const r of evaluation.results) {
      if (!r || r.status !== "failed") continue;
      if (r.severity === "error") errors += 1;
      else if (r.severity === "warning") warnings += 1;
      else if (r.severity === "info") infos += 1;
    }
  }

  let score = 100 - errors * 40 - warnings * 10 - infos * 2;
  score = clamp01to100(score);
  return { score, unevaluated: false, errors, warnings, infos };
}

/**
 * @param {unknown} maxSimilarity
 */
function calculateNovelty(maxSimilarity) {
  if (maxSimilarity == null || maxSimilarity === "") {
    return { score: 100, maxSimilarity: null, unspecified: true };
  }
  const max = Number(maxSimilarity);
  if (!Number.isFinite(max) || max < 0 || max > 1) {
    const err = new Error(
      `maxSimilarity must be a number between 0 and 1 (got ${maxSimilarity})`
    );
    err.code = "editorial-ranking-novelty";
    throw err;
  }
  return {
    score: roundScore((1 - max) * 100),
    maxSimilarity: max,
    unspecified: false,
  };
}

function resolveFreshnessDate(item) {
  if (!item || typeof item !== "object") return null;
  for (const key of ["publishedAt", "updatedAt", "createdAt"]) {
    if (item[key] != null && String(item[key]).trim() !== "") {
      const ms = Date.parse(String(item[key]));
      if (!Number.isNaN(ms)) return { key, ms, iso: new Date(ms).toISOString() };
    }
  }
  return null;
}

/**
 * @param {object} item
 * @param {string|Date|number} [nowValue]
 */
function calculateFreshness(item, nowValue) {
  const nowMs =
    nowValue == null
      ? Date.now()
      : nowValue instanceof Date
        ? nowValue.getTime()
        : typeof nowValue === "number"
          ? nowValue
          : Date.parse(String(nowValue));
  if (Number.isNaN(nowMs)) {
    const err = new Error(`invalid now: ${nowValue}`);
    err.code = "editorial-ranking-freshness";
    throw err;
  }

  const resolved = resolveFreshnessDate(item);
  if (!resolved) {
    return {
      score: 50,
      bucket: "unknown",
      reason: "Datetime unknown",
      ageMs: null,
    };
  }

  const ageMs = nowMs - resolved.ms;
  if (ageMs < 0) {
    return {
      score: 100,
      bucket: "future",
      reason: "Timestamp is in the future",
      ageMs,
      field: resolved.key,
    };
  }

  const hour = 3600000;
  const day = 24 * hour;
  let score;
  let bucket;
  let reason;
  if (ageMs <= 1 * day) {
    score = 100;
    bucket = "24h";
    reason = "Updated within 24 hours";
  } else if (ageMs <= 3 * day) {
    score = 85;
    bucket = "3d";
    reason = "Updated within 3 days";
  } else if (ageMs <= 7 * day) {
    score = 70;
    bucket = "7d";
    reason = "Updated within 7 days";
  } else if (ageMs <= 14 * day) {
    score = 50;
    bucket = "14d";
    reason = "Updated within 14 days";
  } else if (ageMs <= 30 * day) {
    score = 25;
    bucket = "30d";
    reason = "Updated within 30 days";
  } else {
    score = 10;
    bucket = "30d+";
    reason = "Older than 30 days";
  }

  // Prefer wording that matches the field used
  if (resolved.key === "publishedAt") {
    reason = reason.replace("Updated", "Published");
  } else if (resolved.key === "createdAt" && !item.updatedAt) {
    reason = reason.replace("Updated", "Created");
  }

  return { score, bucket, reason, ageMs, field: resolved.key };
}

function calculateReadiness(status) {
  const value = String(status == null ? "" : status).trim();
  if (!Object.prototype.hasOwnProperty.call(READINESS_BY_STATUS, value)) {
    const err = new Error(
      `unknown status for readiness: ${status} (allowed: ${KNOWN_STATUSES.join(", ")})`
    );
    err.code = "editorial-ranking-readiness";
    throw err;
  }
  return {
    score: READINESS_BY_STATUS[value],
    status: value,
    reason: `Status is ${value}`,
  };
}

function buildReasons({ quality, novelty, freshness, readiness }) {
  const reasons = [];
  if (quality.unevaluated) {
    reasons.push("Rules evaluation not provided");
  } else {
    const parts = [];
    if (quality.errors) {
      parts.push(
        `${quality.errors} error rule${quality.errors === 1 ? "" : "s"} failed`
      );
    }
    if (quality.warnings) {
      parts.push(
        `${quality.warnings} warning rule${quality.warnings === 1 ? "" : "s"} failed`
      );
    }
    if (quality.infos) {
      parts.push(
        `${quality.infos} info rule${quality.infos === 1 ? "" : "s"} failed`
      );
    }
    if (parts.length === 0) {
      reasons.push("No rule failures");
    } else {
      reasons.push(parts.join(", "));
    }
  }

  if (novelty.unspecified) {
    reasons.push("Maximum similarity: unspecified (novelty 100)");
  } else {
    reasons.push(
      `Maximum similarity: ${Number(novelty.maxSimilarity).toFixed(2)}`
    );
  }

  reasons.push(freshness.reason);
  reasons.push(readiness.reason);
  return reasons;
}

/**
 * @param {object} item
 * @param {object} [context]
 * @param {object} [context.evaluation]
 * @param {number} [context.maxSimilarity]
 * @param {string|Date|number} [context.now]
 * @param {object} [context.weights]
 */
function calculateRanking(item, context = {}) {
  const weights = normalizeWeights(context && context.weights);
  const quality = calculateQuality(context && context.evaluation);
  const novelty = calculateNovelty(context && context.maxSimilarity);
  const freshness = calculateFreshness(item, context && context.now);
  const readiness = calculateReadiness(item && item.status);

  const metrics = {
    quality: roundScore(quality.score),
    novelty: roundScore(novelty.score),
    freshness: roundScore(freshness.score),
    readiness: roundScore(readiness.score),
  };

  const score = roundScore(
    metrics.quality * weights.quality +
      metrics.novelty * weights.novelty +
      metrics.freshness * weights.freshness +
      metrics.readiness * weights.readiness
  );

  return {
    item,
    score,
    metrics,
    weights: { ...weights },
    reasons: buildReasons({ quality, novelty, freshness, readiness }),
  };
}

/**
 * @param {object[]} items
 * @param {object} [options]
 */
function rankItems(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const weights = normalizeWeights(options.weights);
  const sourceFilter =
    options.source != null && String(options.source).trim()
      ? String(options.source).trim()
      : null;
  const typeFilter =
    options.type != null && String(options.type).trim()
      ? String(options.type).trim()
      : null;
  /** @type {Set<string>|null} */
  let statusFilter = null;
  if (options.statuses != null) {
    if (!Array.isArray(options.statuses)) {
      const err = new Error("statuses must be an array");
      err.code = "editorial-ranking-options";
      throw err;
    }
    statusFilter = new Set(options.statuses.map((s) => String(s)));
  }

  const defaultContext = { ...(options.defaultContext || {}), weights };
  const contextById =
    options.contextById && typeof options.contextById === "object"
      ? options.contextById
      : {};

  const filtered = list.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (sourceFilter != null && item.source !== sourceFilter) return false;
    if (typeFilter != null && item.type !== typeFilter) return false;
    if (statusFilter != null && !statusFilter.has(String(item.status))) {
      return false;
    }
    return true;
  });

  const ranked = filtered.map((item) => {
    const id = item.id != null ? String(item.id) : "";
    const perItem = contextById[id] || {};
    return calculateRanking(item, {
      ...defaultContext,
      ...perItem,
      weights,
    });
  });

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ua = String((a.item && a.item.updatedAt) || "");
    const ub = String((b.item && b.item.updatedAt) || "");
    if (ua !== ub) return ub < ua ? -1 : 1;
    return String((a.item && a.item.id) || "").localeCompare(
      String((b.item && b.item.id) || "")
    );
  });

  if (options.limit == null) return ranked;
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 0) {
    const err = new Error("limit must be a non-negative integer");
    err.code = "editorial-ranking-options";
    throw err;
  }
  return ranked.slice(0, limit);
}

module.exports = {
  METRIC_KEYS,
  DEFAULT_WEIGHTS,
  READINESS_BY_STATUS,
  getDefaultRankingWeights,
  normalizeWeights,
  calculateQuality,
  calculateNovelty,
  calculateFreshness,
  calculateReadiness,
  calculateRanking,
  rankItems,
  roundScore,
};
