/**
 * Writer ← Editorial Brief integration (EP-001).
 * Selects editorial.articles[] and builds an edit context for article rendering.
 * Deterministic. No AI.
 */

const GENERIC_CATEGORY_RE =
  /^(制作・クリエイティブ技術|アニメ・漫画|ゲーム・ゲーム開発|注目の話題|その他|テクノロジー|エンタメ)$/;

const BAD_LEAD_RE =
  /(確認済み投稿を整理|Storyをもとに紹介|Editorial Briefによると|関連投稿の重要度|Confidenceは|Evidenceは|について紹介します)/i;

const INTERNAL_TERM_RE =
  /\b(Story|Concept|Topic|Knowledge|Evidence|Confidence|Editorial Brief)\b|関連投稿|重要度/;

const PREDICTION_RE =
  /(今後広がる|成功する可能性|業界標準になる|だろう。|かもしれないが注目|将来的に)/;

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensurePeriod(text) {
  let t = asString(text);
  if (!t) return "";
  if (!/[。．!?？]$/.test(t)) t = `${t}。`;
  return t;
}

function normalizeKeyFacts(keyFacts) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(keyFacts) ? keyFacts : []) {
    const fact = asString(raw);
    if (!fact) continue;
    if (seen.has(fact)) continue;
    seen.add(fact);
    out.push(fact);
  }
  return out;
}

function normalizeRisks(risks) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(risks) ? risks : []) {
    const risk = asString(raw);
    if (!risk) continue;
    if (seen.has(risk)) continue;
    seen.add(risk);
    out.push(risk);
  }
  return out;
}

function isUsableHeadline(headline) {
  const h = asString(headline);
  if (!h) return false;
  if (GENERIC_CATEGORY_RE.test(h)) return false;
  if (/^(untitled|無題|カテゴリ)/i.test(h)) return false;
  if (h.length < 2) return false;
  return true;
}

function isUsableLead(lead) {
  const t = asString(lead);
  if (!t) return false;
  if (t.length < 8) return false;
  if (/^#+\s/.test(t) || t.includes("\n## ")) return false;
  if (BAD_LEAD_RE.test(t)) return false;
  if (INTERNAL_TERM_RE.test(t)) return false;
  const sentences = t.split(/[。．]/).filter((s) => s.trim());
  if (sentences.length >= 2 && sentences[0].trim() === sentences[1].trim()) {
    return false;
  }
  return true;
}

function hasEditorialContent(article) {
  if (!article || typeof article !== "object") return false;
  if (isUsableHeadline(article.headline)) return true;
  if (isUsableLead(article.lead)) return true;
  if (asString(article.angle)) return true;
  if (asString(article.whyNow)) return true;
  if (normalizeKeyFacts(article.keyFacts).length > 0) return true;
  if (normalizeRisks(article.risks).length > 0) return true;
  return false;
}

/**
 * Deterministic selection from brief.editorial.articles[].
 */
function selectEditorialArticle(brief, storyCtx, plan) {
  const editorial = brief && brief.editorial;
  if (!editorial || typeof editorial !== "object") return null;
  const articles = editorial.articles;
  if (!Array.isArray(articles) || articles.length === 0) return null;

  const storyId = asString(storyCtx?.story?.id);
  const knowledgeIds = new Set(
    (Array.isArray(brief.knowledge) ? brief.knowledge : [])
      .map((k) => asString(k && k.id))
      .filter(Boolean)
  );
  const briefTitle = asString(brief.title);
  const planTitle = asString(plan && plan.title);

  const usable = articles.filter((a) => a && typeof a === "object");

  for (const a of usable) {
    if (storyId && asString(a.storyId) === storyId && hasEditorialContent(a)) {
      return a;
    }
  }
  for (const a of usable) {
    const kid = asString(a.knowledgeId);
    if (kid && knowledgeIds.has(kid) && hasEditorialContent(a)) {
      return a;
    }
  }
  for (const a of usable) {
    if (
      briefTitle &&
      asString(a.headline) === briefTitle &&
      hasEditorialContent(a)
    ) {
      return a;
    }
  }
  for (const a of usable) {
    if (
      planTitle &&
      asString(a.headline) === planTitle &&
      hasEditorialContent(a)
    ) {
      return a;
    }
  }
  for (const a of usable) {
    if (hasEditorialContent(a)) return a;
  }
  return null;
}

function buildRiskFlags(risks) {
  const joined = risks.join("\n");
  return {
    noHoursTickets:
      /営業時間|チケット|料金|入場料|未確認の価格/.test(joined),
    questionOnly:
      /質問のみ|回答を作らない|回答を書かない|回答や歴史|質問投稿に回答/.test(
        joined
      ),
    noPrediction: /将来予測|予測をしない|予測しない/.test(joined),
    noUnconfirmedDate: /未確認の日付/.test(joined),
    noUnconfirmedPlace: /未確認の場所/.test(joined),
  };
}

/**
 * Short whyNow memos → reader prose (no new facts).
 */
function whyNowToProse(whyNow, angle) {
  const w = asString(whyNow);
  const a = asString(angle);
  if (!w && !a) return "";

  if (/終了日が近い|終了間近/.test(w) || a === "終了間近") {
    return "会期終了が近づいており、来場を検討している人にとって確認しておきたい情報です。";
  }
  if (/イベントが開催|開催されている/.test(w) || a === "イベント開催") {
    return ensurePeriod(w || "イベントが開催されています");
  }
  if (/アップデート/.test(w) || a === "アップデート") {
    return ensurePeriod(w || "アップデート情報があります");
  }
  if (/発表|公開/.test(w) || a === "新サービス発表") {
    return ensurePeriod(w);
  }
  if (/今日の話題|今日発表/.test(w)) {
    return ensurePeriod(w);
  }
  if (!w) return "";
  if (INTERNAL_TERM_RE.test(w) || BAD_LEAD_RE.test(w)) return "";
  return ensurePeriod(w);
}

function buildEditContext(article) {
  if (!hasEditorialContent(article)) return null;
  const keyFacts = normalizeKeyFacts(article.keyFacts);
  const risks = normalizeRisks(article.risks);
  return {
    headline: asString(article.headline),
    lead: asString(article.lead),
    angle: asString(article.angle),
    whyNow: asString(article.whyNow),
    audience: asString(article.audience),
    keyFacts,
    risks,
    evidence: Array.isArray(article.evidence) ? article.evidence : [],
    storyId: asString(article.storyId) || null,
    knowledgeId: asString(article.knowledgeId) || null,
    riskFlags: buildRiskFlags(risks),
    usedEditorial: true,
    validation: {
      matchedEvidenceCount: 0,
      rejectedKeyFacts: [],
      rejectedFields: [],
      conflicts: [],
      warnings: [],
      rejectedHeadline: "",
    },
  };
}

/**
 * Resolve edit context from Brief + Story context + Plan, or null → fallback.
 * EP-002: validates Editorial fields against Story before use.
 */
function resolveEditContext(brief, storyCtx, plan) {
  const article = selectEditorialArticle(brief, storyCtx, plan);
  if (!article) return null;
  // Lazy require avoids circular dependency with writer-editorial-validate.
  const {
    validateAndBuildEditContext,
  } = require("./writer-editorial-validate");
  return validateAndBuildEditContext(article, storyCtx);
}

/**
 * Prefer editorial headline when usable; else null (caller falls back).
 */
function resolveEditorialHeadline(edit) {
  if (!edit || !edit.usedEditorial) return null;
  if (!isUsableHeadline(edit.headline)) return null;
  return edit.headline.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "");
}

/**
 * Prefer editorial lead when usable; else null.
 */
function resolveEditorialLead(edit) {
  if (!edit || !edit.usedEditorial) return null;
  if (!isUsableLead(edit.lead)) return null;
  return ensurePeriod(edit.lead.replace(/\s*\n+\s*/g, ""));
}

/**
 * keyFacts not already covered in body text, for highlights.
 */
function uncoveredKeyFacts(edit, coveredText) {
  if (!edit) return [];
  const covered = asString(coveredText);
  const out = [];
  for (const fact of edit.keyFacts || []) {
    const core = fact.replace(/^(作品・イベント|会期|会場|状況|情報源投稿者|投稿日|価格):\s*/, "");
    if (covered.includes(fact) || (core && covered.includes(core))) continue;
    // Avoid restating long overlapping prefixes.
    if (core.length >= 6 && covered.includes(core.slice(0, Math.min(10, core.length)))) {
      continue;
    }
    out.push(fact);
  }
  return out.slice(0, 4);
}

function stripForbiddenByRisks(text, riskFlags) {
  let t = asString(text);
  if (!t) return "";
  if (riskFlags && riskFlags.noPrediction && PREDICTION_RE.test(t)) {
    return "";
  }
  if (riskFlags && riskFlags.noHoursTickets) {
    if (/営業時間|開館時間|チケット|入場料|購入方法|\d+\s*円/.test(t)) {
      return "";
    }
  }
  if (riskFlags && riskFlags.noUnconfirmedPlace) {
    // Do not invent venues; leave Story-sourced text alone unless it is
    // clearly an editorial-only place claim without Story support (handled upstream).
  }
  return t;
}

module.exports = {
  selectEditorialArticle,
  buildEditContext,
  resolveEditContext,
  resolveEditorialHeadline,
  resolveEditorialLead,
  whyNowToProse,
  uncoveredKeyFacts,
  stripForbiddenByRisks,
  hasEditorialContent,
  isUsableHeadline,
  isUsableLead,
  normalizeKeyFacts,
  normalizeRisks,
  buildRiskFlags,
  GENERIC_CATEGORY_RE,
};
