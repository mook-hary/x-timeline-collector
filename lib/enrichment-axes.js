/**
 * Multi-axis enrichment evaluation (IMPORTANCE-AUDIT follow-up).
 * Separates information value from attention signal.
 * Pure helpers — no I/O, no AI.
 */

const AXIS_KEYS = Object.freeze([
  "informationValue",
  "personalRelevance",
  "impact",
  "attentionSignal",
]);

/** Weights for legacy importance derivation (attentionSignal excluded). */
const IMPORTANCE_WEIGHTS = Object.freeze({
  informationValue: 0.55,
  personalRelevance: 0.25,
  impact: 0.2,
});

function clampAxis(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return Math.min(5, Math.max(1, rounded));
}

function enrichmentOf(post) {
  if (!post || typeof post !== "object") return null;
  if (post.enrichment && typeof post.enrichment === "object") return post.enrichment;
  return post;
}

function getLegacyImportanceRaw(post) {
  const e = enrichmentOf(post);
  if (!e) return null;
  if (e.importance == null || e.importance === "") return null;
  const n = Number(e.importance);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(0, n));
}

function hasMultiAxisEnrichment(post) {
  const e = enrichmentOf(post);
  if (!e) return false;
  return AXIS_KEYS.every((key) => clampAxis(e[key]) != null);
}

/**
 * Derive legacy importance 1–5 from value axes.
 * attentionSignal must not raise importance.
 */
function deriveLegacyImportance(axes) {
  const iv = clampAxis(axes && axes.informationValue);
  const pr = clampAxis(axes && axes.personalRelevance);
  const im = clampAxis(axes && axes.impact);
  if (iv == null || pr == null || im == null) return null;
  const raw =
    iv * IMPORTANCE_WEIGHTS.informationValue +
    pr * IMPORTANCE_WEIGHTS.personalRelevance +
    im * IMPORTANCE_WEIGHTS.impact;
  return clampAxis(raw);
}

/**
 * @returns {number|null} 1–5, or null if unavailable
 */
function getInformationValue(post) {
  const e = enrichmentOf(post);
  const direct = e ? clampAxis(e.informationValue) : null;
  if (direct != null) return direct;
  const legacy = getLegacyImportanceRaw(post);
  if (legacy == null || legacy <= 0) return null;
  return clampAxis(legacy);
}

function getPersonalRelevance(post) {
  const e = enrichmentOf(post);
  const direct = e ? clampAxis(e.personalRelevance) : null;
  if (direct != null) return direct;
  const legacy = getLegacyImportanceRaw(post);
  if (legacy == null || legacy <= 0) return null;
  return clampAxis(legacy);
}

function getImpact(post) {
  const e = enrichmentOf(post);
  const direct = e ? clampAxis(e.impact) : null;
  if (direct != null) return direct;
  const legacy = getLegacyImportanceRaw(post);
  if (legacy == null || legacy <= 0) return null;
  // Conservative: legacy importance is not pure impact.
  return clampAxis(Math.max(1, Math.round(legacy * 0.75)));
}

/**
 * Attention is not a quality score. Missing → neutral 2 (do not invent outrage).
 */
function getAttentionSignal(post) {
  const e = enrichmentOf(post);
  const direct = e ? clampAxis(e.attentionSignal) : null;
  if (direct != null) return direct;
  return 2;
}

/**
 * Low substance + high attention → should not dominate Picks.
 */
function isAttentionWithoutValue(post) {
  const iv = getInformationValue(post);
  const att = getAttentionSignal(post);
  if (iv == null) return false;
  return iv <= 2 && att >= 4;
}

/**
 * Normalize AI enrich payload: validate axes, derive importance, strip AI importance.
 * @param {object} data — parsed AI JSON
 */
function normalizeEnrichAxesResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AI応答がオブジェクトではありません");
  }

  const axes = {};
  for (const key of AXIS_KEYS) {
    const value = clampAxis(data[key]);
    if (value == null) {
      throw new Error(`${key} は 1〜5 の整数である必要があります`);
    }
    axes[key] = value;
  }

  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw new Error("summary が空です");
  }
  if (typeof data.reason !== "string" || !data.reason.trim()) {
    throw new Error("reason が空です");
  }
  if (!Array.isArray(data.tags)) {
    throw new Error("tags が配列ではありません");
  }
  if (data.tags.length > 5) {
    throw new Error("tags は最大5個までです");
  }
  if (!data.tags.every((tag) => typeof tag === "string")) {
    throw new Error("tags の要素は文字列である必要があります");
  }

  const importance = deriveLegacyImportance(axes);
  if (importance == null) {
    throw new Error("importance を派生できませんでした");
  }

  return {
    ...axes,
    importance,
    summary: String(data.summary).trim(),
    tags: data.tags.slice(0, 5).map((tag) => String(tag).trim()).filter(Boolean),
    reason: String(data.reason).trim(),
  };
}

/**
 * Fixture helpers: expected axis ranges for regression cases (no AI).
 */
const FIXTURE_CASES = Object.freeze({
  A: {
    id: "A",
    label: "薄い刺激的主張",
    text: "老人を減らすしかないんよな。法は無力。",
    axes: {
      informationValue: 1,
      personalRelevance: 2,
      impact: 1,
      attentionSignal: 5,
    },
  },
  B: {
    id: "B",
    label: "地味な制度変更",
    text: "〇〇法改正が閣議決定。施行は2027年4月、対象は中小企業、届出義務が追加される。",
    axes: {
      informationValue: 5,
      personalRelevance: 4,
      impact: 5,
      attentionSignal: 2,
    },
  },
  C: {
    id: "C",
    label: "専門家の考察",
    text: "現場でLLM評価を回した経験から、レイテンシとコストのトレードオフを整理する。測定手順と失敗パターン付き。",
    axes: {
      informationValue: 5,
      personalRelevance: 5,
      impact: 3,
      attentionSignal: 2,
    },
  },
  D: {
    id: "D",
    label: "重大速報",
    text: "速報: 首都圏で震度6強。交通機関が計画運休、インフラ被害の確認が続いている。",
    axes: {
      informationValue: 5,
      personalRelevance: 5,
      impact: 5,
      attentionSignal: 5,
    },
  },
  E: {
    id: "E",
    label: "日常感想",
    text: "今日は疲れた。この作品好き。",
    axes: {
      informationValue: 1,
      personalRelevance: 1,
      impact: 1,
      attentionSignal: 1,
    },
  },
  F: {
    id: "F",
    label: "根拠ある批判",
    text: "昨年度の公開データでは費用対効果が目標を下回り、現場でも同種の遅延が続いている。政策の前提を見直すべきだ。",
    axes: {
      informationValue: 4,
      personalRelevance: 3,
      impact: 4,
      attentionSignal: 3,
    },
  },
});

function fixturePost(caseId, overrides = {}) {
  const fixture = FIXTURE_CASES[caseId];
  if (!fixture) throw new Error(`unknown fixture ${caseId}`);
  const axes = fixture.axes;
  const importance = deriveLegacyImportance(axes);
  return {
    url: `https://x.com/fixture/status/${caseId.charCodeAt(0)}`,
    text: fixture.text,
    authorHandle: `@fixture_${caseId}`,
    postedAt: "2026-08-15T01:00:00.000Z",
    finalAnalysis: {
      category: overrides.category || "政治・社会",
      tags: ["fixture"],
    },
    enrichment: {
      source: "fixture",
      ...axes,
      importance,
      summary: overrides.summary || fixture.text.slice(0, 80),
      reason: overrides.reason || `fixture ${caseId}`,
      tags: ["fixture", caseId],
      ...((overrides.enrichment && typeof overrides.enrichment === "object")
        ? overrides.enrichment
        : {}),
    },
    ...overrides,
  };
}

module.exports = {
  AXIS_KEYS,
  IMPORTANCE_WEIGHTS,
  clampAxis,
  hasMultiAxisEnrichment,
  deriveLegacyImportance,
  getInformationValue,
  getPersonalRelevance,
  getImpact,
  getAttentionSignal,
  isAttentionWithoutValue,
  normalizeEnrichAxesResult,
  FIXTURE_CASES,
  fixturePost,
  getLegacyImportanceRaw,
};
