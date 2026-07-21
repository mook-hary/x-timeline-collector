/**
 * EP-002 — Validate Editorial Brief against Story before Writer use.
 * Deterministic. No AI. Story wins on conflict.
 */

const {
  isUsableHeadline,
  isUsableLead,
  normalizeKeyFacts,
  normalizeRisks,
  hasEditorialContent,
  buildRiskFlags,
} = require("./writer-editorial");

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWhitespace(text) {
  return asString(text)
    .replace(/\u3000/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHandle(handle) {
  return normalizeWhitespace(handle).replace(/^@/, "").toLowerCase();
}

function normalizeUrl(url) {
  return normalizeWhitespace(url);
}

function normalizeFactCore(text) {
  return normalizeWhitespace(text)
    .replace(
      /^(作品・イベント|会期|会場|状況|情報源投稿者|投稿日|価格|問い)\s*[:：]\s*/,
      ""
    )
    .replace(/から/g, "〜")
    .replace(/～/g, "〜")
    .replace(/[\/／]/g, "〜")
    .replace(/まで/g, "")
    .replace(/開催/g, "")
    .replace(/で開催/g, "")
    .replace(/\s+/g, "");
}

/**
 * Extract month/day tokens as "M-D" for conflict checks.
 */
function extractDateKeys(text) {
  const t = asString(text);
  const keys = [];
  const seen = new Set();
  const push = (m, d) => {
    const key = `${Number(m)}-${Number(d)}`;
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  let m;
  const reJp = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = reJp.exec(t)) !== null) push(m[1], m[2]);
  const reSlash = /(\d{1,2})\s*[\/／]\s*(\d{1,2})(?!\d)/g;
  while ((m = reSlash.exec(t)) !== null) push(m[1], m[2]);
  return keys;
}

function extractPrices(text) {
  const t = asString(text);
  const out = [];
  const re = /(\d{1,3}(?:,\d{3})*\s*円|\d+\s*円)/g;
  let m;
  while ((m = re.exec(t)) !== null) out.push(normalizeWhitespace(m[1]));
  return out;
}

function extractVenues(text) {
  const t = asString(text);
  const out = [];
  const re = /([\u3000-\u9fffA-Za-z0-9「」『』・ー−-]{2,40}(?:美術館|博物館|ギャラリー|会場|ホール|劇場))/g;
  let m;
  while ((m = re.exec(t)) !== null) out.push(normalizeWhitespace(m[1]));
  if (/東京都現代美術館/.test(t)) out.push("東京都現代美術館");
  return [...new Set(out)];
}

function emptyValidation() {
  return {
    matchedEvidenceCount: 0,
    rejectedKeyFacts: [],
    rejectedFields: [],
    conflicts: [],
    warnings: [],
    rejectedHeadline: "",
  };
}

/**
 * Build searchable fact corpus from Story context.
 */
function buildStoryCorpus(storyCtx) {
  const chunks = [];
  const push = (v) => {
    const s = asString(v);
    if (s) chunks.push(s);
  };

  const story = storyCtx && storyCtx.story;
  const concept = storyCtx && storyCtx.concept;
  const topic = storyCtx && storyCtx.topic;
  const posts = Array.isArray(storyCtx?.posts) ? storyCtx.posts : [];

  push(story?.label);
  push(story?.description);
  push(story?.title);
  push(concept?.label);
  push(concept?.summary);
  push(concept?.title);
  push(topic?.label);
  push(topic?.summary);
  push(topic?.title);

  for (const post of posts) {
    push(post?.text);
    push(post?.authorName);
    push(post?.authorHandle);
    push(post?.postedAt);
    push(post?.url);
    const enr = post?.enrichment;
    if (enr && typeof enr === "object") {
      push(enr.summary);
      push(enr.reason);
      if (enr.facts && typeof enr.facts === "object") {
        for (const v of Object.values(enr.facts)) push(v);
      }
    }
  }

  const raw = chunks.join("\n");
  const normalized = normalizeWhitespace(raw);
  const compact = normalized.replace(/\s+/g, "");
  return {
    raw,
    normalized,
    compact,
    dateKeys: new Set(extractDateKeys(raw)),
    prices: new Set(extractPrices(raw)),
    venues: new Set(extractVenues(raw)),
    posts,
  };
}

function postMatchKey(post) {
  const url = normalizeUrl(post?.url);
  if (url) return `url:${url}`;
  return `t:${normalizeHandle(post?.authorHandle)}|${normalizeWhitespace(
    post?.postedAt
  )}|${normalizeWhitespace(post?.text)}`;
}

/**
 * Match editorial evidence[] to Story posts. Deterministic priority.
 */
function matchEvidence(evidenceList, posts) {
  const list = Array.isArray(evidenceList) ? evidenceList : [];
  const postList = Array.isArray(posts) ? posts : [];
  const matched = [];
  const matchedKeys = new Set();
  const unmatched = [];

  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    const evUrl = normalizeUrl(ev.url);
    const evHandle = normalizeHandle(ev.authorHandle);
    const evPosted = normalizeWhitespace(ev.postedAt);
    const evText = normalizeWhitespace(ev.text);

    let found = null;
    // 1. URL exact
    if (evUrl) {
      found = postList.find((p) => normalizeUrl(p.url) === evUrl) || null;
    }
    // 2. handle + postedAt + text
    if (!found && evHandle && evPosted && evText) {
      found =
        postList.find(
          (p) =>
            normalizeHandle(p.authorHandle) === evHandle &&
            normalizeWhitespace(p.postedAt) === evPosted &&
            normalizeWhitespace(p.text) === evText
        ) || null;
    }
    // 3. handle + text
    if (!found && evHandle && evText) {
      found =
        postList.find(
          (p) =>
            normalizeHandle(p.authorHandle) === evHandle &&
            normalizeWhitespace(p.text) === evText
        ) || null;
    }
    // 4. postedAt + text
    if (!found && evPosted && evText) {
      found =
        postList.find(
          (p) =>
            normalizeWhitespace(p.postedAt) === evPosted &&
            normalizeWhitespace(p.text) === evText
        ) || null;
    }
    // 5. text exact
    if (!found && evText) {
      found =
        postList.find((p) => normalizeWhitespace(p.text) === evText) || null;
    }

    if (found) {
      const key = postMatchKey(found);
      if (!matchedKeys.has(key)) {
        matchedKeys.add(key);
        matched.push(found);
      }
    } else {
      unmatched.push(ev);
    }
  }

  return { matched, unmatched };
}

function corpusContainsFact(corpus, fact) {
  const core = normalizeFactCore(fact);
  if (!core || core.length < 2) return false;
  if (corpus.compact.includes(core)) return true;

  // Closing-status facts grounded by 閉幕 / 来週閉幕 / 終了間近 in Story.
  if (/閉幕が近い|終了間近|来週閉幕/.test(fact)) {
    if (/(来週閉幕|閉幕|終了間近|会期終了)/.test(corpus.raw)) return true;
  }

  // Date-normalized: 5月26日〜7月26日 vs 5/26〜7/26
  const dates = extractDateKeys(fact);
  if (dates.length > 0) {
    const allInStory = dates.every((d) => corpus.dateKeys.has(d));
    if (allInStory && /会期|開催|閉幕|まで|〜/.test(fact)) return true;
  }

  const venues = extractVenues(fact);
  if (venues.length > 0 && venues.every((v) => corpus.venues.has(v) || corpus.normalized.includes(v))) {
    if (/会場|美術館|開催/.test(fact) || venues.some((v) => fact.includes(v))) {
      return true;
    }
  }

  // Loose: significant contiguous substring (≥6) from core in corpus
  if (core.length >= 6) {
    const probe = core.slice(0, Math.min(core.length, 16));
    if (corpus.compact.includes(probe)) return true;
  }

  const plain = normalizeWhitespace(fact);
  if (plain.length >= 4 && corpus.normalized.includes(plain)) return true;

  return false;
}

function factConflictsWithStory(fact, corpus) {
  const dates = extractDateKeys(fact);
  const prices = extractPrices(fact);

  // Price not in story → unconfirmed (reject), not necessarily conflict
  for (const p of prices) {
    if (!corpus.prices.has(p) && !corpus.normalized.includes(p.replace(/\s/g, ""))) {
      if (/価格|円|料金|入場/.test(fact) || prices.length > 0) {
        return { type: "unconfirmed-price", detail: p };
      }
    }
  }

  // Dates in keyFact that Story never mentions, while Story has other dates
  // for the same period/closing context → conflict
  if (dates.length > 0 && corpus.dateKeys.size > 0) {
    const foreign = dates.filter((d) => !corpus.dateKeys.has(d));
    if (foreign.length > 0 && /会期|閉幕|まで|開催|開始/.test(fact)) {
      return {
        type: "date-conflict",
        detail: `editorial=${foreign.join(",")} story=[${[...corpus.dateKeys].join(",")}]`,
      };
    }
  }

  return null;
}

function semanticFactKey(fact) {
  const dates = extractDateKeys(fact);
  const venues = extractVenues(fact);
  if ((/会期|開催|閉幕|〜|から/.test(fact) || dates.length >= 2) && dates.length > 0) {
    return `period:${dates.slice().sort().join("|")}`;
  }
  if (venues.length > 0 && /会場|美術館|で開催|開催/.test(fact)) {
    return `venue:${venues[0]}`;
  }
  if (/状況|閉幕が近い|終了間近/.test(fact)) return "status:closing";
  if (/情報源投稿者|投稿者/.test(fact)) {
    return `author:${normalizeFactCore(fact)}`;
  }
  if (/投稿日/.test(fact)) return `posted:${normalizeFactCore(fact)}`;
  return `exact:${normalizeWhitespace(fact)}`;
}

function validateKeyFacts(keyFacts, corpus) {
  const accepted = [];
  const rejected = [];
  const conflicts = [];
  const seenSig = new Set();

  for (const raw of normalizeKeyFacts(keyFacts)) {
    const conflict = factConflictsWithStory(raw, corpus);
    if (conflict && conflict.type === "date-conflict") {
      rejected.push(raw);
      conflicts.push({ field: "keyFacts", fact: raw, ...conflict });
      continue;
    }
    if (conflict && conflict.type === "unconfirmed-price") {
      rejected.push(raw);
      conflicts.push({ field: "keyFacts", fact: raw, ...conflict });
      continue;
    }
    if (!corpusContainsFact(corpus, raw)) {
      rejected.push(raw);
      continue;
    }
    const sig = semanticFactKey(raw);
    if (seenSig.has(sig)) {
      rejected.push(raw);
      continue;
    }
    seenSig.add(sig);
    accepted.push(raw);
  }

  return { accepted, rejected, conflicts };
}

function validateHeadline(headline, corpus) {
  const h = asString(headline);
  if (!isUsableHeadline(h)) {
    return { ok: false, reason: "unusable" };
  }
  const dates = extractDateKeys(h);
  if (dates.length > 0 && corpus.dateKeys.size > 0) {
    const foreign = dates.filter((d) => !corpus.dateKeys.has(d));
    if (foreign.length > 0 && /閉幕|開催|まで|開始|発表/.test(h)) {
      return {
        ok: false,
        reason: "date-conflict",
        detail: `editorial=${foreign.join(",")} story=[${[...corpus.dateKeys].join(",")}]`,
      };
    }
  }
  const prices = extractPrices(h);
  for (const p of prices) {
    if (![...corpus.prices].some((x) => x.replace(/\s/g, "") === p.replace(/\s/g, ""))) {
      return { ok: false, reason: "unconfirmed-price", detail: p };
    }
  }
  return { ok: true, headline: h };
}

const UNCONFIRMED_LEAD_RE =
  /(円|料金|入場料|チケット|営業時間|開館時間)/;

function sentenceSupported(sentence, corpus) {
  const s = asString(sentence);
  if (!s) return false;
  if (UNCONFIRMED_LEAD_RE.test(s)) {
    const prices = extractPrices(s);
    if (prices.length > 0) {
      const ok = prices.every((p) =>
        [...corpus.prices].some(
          (x) => x.replace(/\s/g, "") === p.replace(/\s/g, "")
        )
      );
      if (!ok) return false;
    } else if (/料金|入場料|チケット|営業時間|開館時間/.test(s)) {
      return false;
    }
  }
  const dates = extractDateKeys(s);
  if (dates.length > 0 && corpus.dateKeys.size > 0) {
    if (dates.some((d) => !corpus.dateKeys.has(d))) return false;
  }
  // Place: if sentence asserts a venue not in story
  const venues = extractVenues(s);
  for (const v of venues) {
    if (!corpus.venues.has(v) && !corpus.normalized.includes(v)) return false;
  }
  return true;
}

function validateLead(lead, corpus) {
  const t = asString(lead);
  if (!isUsableLead(t)) {
    return { ok: false, reason: "unusable", lead: "" };
  }
  const parts = t.split(/(?<=[。．])/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, reason: "empty", lead: "" };
  }
  const kept = [];
  let dropped = false;
  for (const part of parts) {
    if (sentenceSupported(part, corpus)) {
      kept.push(part);
    } else {
      dropped = true;
    }
  }
  if (kept.length === 0) {
    return { ok: false, reason: "unsupported", lead: "" };
  }
  // If we dropped material and remaining is too thin, fallback
  if (dropped && kept.join("").length < 12) {
    return { ok: false, reason: "thin-after-filter", lead: "" };
  }
  let out = kept.join("");
  if (!/[。．!?？]$/.test(out)) out = `${out}。`;
  return { ok: true, lead: out, partial: dropped };
}

const WHY_NOW_HYPE_RE =
  /^(今注目されている|業界に大きな影響を与える|多くの人が関心を持っている|今後重要になる)/;

const WHY_NOW_TIME_RE =
  /(終了日が近い|終了間近|開催開始|開催中|開催されている|発表|公開|アップデート|締切|開始日|イベントが開催)/;

function storyHasTemporalGround(corpus) {
  return /(会期|閉幕|終了|開催|開始|締切|公開|発表|来週|今夏|〜|から.*まで)/.test(
    corpus.raw
  );
}

function validateWhyNow(whyNow, angle, corpus) {
  const w = asString(whyNow);
  const a = asString(angle);
  if (!w && !a) return { ok: true, whyNow: "", angle: a };

  if (w && WHY_NOW_HYPE_RE.test(w) && !corpus.normalized.includes(w)) {
    return { ok: false, reason: "hype-without-ground", whyNow: "", angle: a };
  }

  const timeLike = WHY_NOW_TIME_RE.test(w) || /終了間近|開催|発表|アップデート/.test(a);
  if (timeLike && !storyHasTemporalGround(corpus)) {
    return { ok: false, reason: "no-temporal-ground", whyNow: "", angle: a };
  }

  // Bare hype angle without whyNow text
  if (!w && /注目|バズ|話題性/.test(a) && !storyHasTemporalGround(corpus)) {
    return { ok: false, reason: "hype-angle", whyNow: "", angle: "" };
  }

  return { ok: true, whyNow: w, angle: a };
}

function buildAutoRisks(validation, article, corpus) {
  const risks = [];
  const push = (r) => {
    if (!risks.includes(r)) risks.push(r);
  };

  for (const c of validation.conflicts) {
    if (c.type === "unconfirmed-price" || /価格|円/.test(c.fact || "")) {
      push("未確認の価格を書かない");
    }
    if (c.type === "date-conflict") {
      push("未確認の日付を書かない");
    }
  }
  if (validation.rejectedFields.includes("lead")) {
    push("未確認の日付を書かない");
    push("未確認の場所を書かない");
  }
  for (const fact of validation.rejectedKeyFacts) {
    if (/会場|場所/.test(fact)) push("未確認の場所を書かない");
    if (/会期|日|月/.test(fact)) push("未確認の日付を書かない");
    if (/価格|円|料金/.test(fact)) push("未確認の価格を書かない");
  }

  const posts = corpus.posts || [];
  const texts = posts.map((p) => asString(p.text)).join("\n");
  if (
    posts.some((p) => /[？?]$/.test(asString(p.text)) || /だっけ|ですか/.test(asString(p.text)))
  ) {
    push("質問投稿に回答を作らない");
  }
  push("因果関係を断定しない");
  push("将来予測をしない");

  if (
    /(美術館|博物館|会場|開催)/.test(corpus.raw) &&
    !/営業時間|開館時間|入場料|チケット/.test(texts)
  ) {
    push("営業時間・チケット情報は入力にないため書かない");
  }

  // Merge editorial risks
  for (const r of normalizeRisks(article?.risks)) push(r);

  return risks;
}

/**
 * Validate selected editorial article against Story. Returns edit context or null.
 */
function validateAndBuildEditContext(article, storyCtx) {
  if (!article || typeof article !== "object") return null;
  if (!hasEditorialContent(article)) return null;

  const validation = emptyValidation();
  const corpus = buildStoryCorpus(storyCtx || {});

  const { matched, unmatched } = matchEvidence(article.evidence, corpus.posts);
  validation.matchedEvidenceCount = matched.length;
  for (const ev of unmatched) {
    const label =
      normalizeUrl(ev.url) ||
      `${normalizeHandle(ev.authorHandle)}:${normalizeWhitespace(ev.text).slice(0, 40)}`;
    validation.warnings.push(`unmatched-evidence:${label}`);
  }

  const kf = validateKeyFacts(article.keyFacts, corpus);
  validation.rejectedKeyFacts = kf.rejected.slice();
  validation.conflicts.push(...kf.conflicts);

  const hl = validateHeadline(article.headline, corpus);
  let headline = "";
  if (hl.ok) {
    headline = hl.headline;
  } else {
    validation.rejectedFields.push("headline");
    validation.rejectedHeadline = asString(article.headline);
    if (hl.reason === "date-conflict" || hl.reason === "unconfirmed-price") {
      validation.conflicts.push({
        field: "headline",
        type: hl.reason,
        detail: hl.detail || "",
        value: asString(article.headline),
      });
    }
  }

  const ld = validateLead(article.lead, corpus);
  let lead = "";
  if (ld.ok) {
    lead = ld.lead;
    if (ld.partial) {
      validation.warnings.push("lead-partial-filter");
    }
  } else {
    validation.rejectedFields.push("lead");
  }

  const wn = validateWhyNow(article.whyNow, article.angle, corpus);
  let whyNow = "";
  let angle = asString(article.angle);
  if (wn.ok) {
    whyNow = wn.whyNow;
    angle = wn.angle;
  } else {
    validation.rejectedFields.push("whyNow");
    whyNow = "";
  }

  const risks = buildAutoRisks(validation, article, corpus);
  const evidence = matched.map((p) => ({
    url: asString(p.url) || null,
    authorName: asString(p.authorName) || null,
    authorHandle: asString(p.authorHandle) || null,
    postedAt: asString(p.postedAt) || null,
    text: asString(p.text) || "",
  }));

  const draft = {
    headline,
    lead,
    angle,
    whyNow,
    audience: asString(article.audience),
    keyFacts: kf.accepted,
    risks,
    evidence,
    storyId: asString(article.storyId) || null,
    knowledgeId: asString(article.knowledgeId) || null,
    riskFlags: buildRiskFlags(risks),
    usedEditorial: true,
    validation,
  };

  // If nothing usable remains, fall back entirely.
  const stillUseful =
    isUsableHeadline(draft.headline) ||
    isUsableLead(draft.lead) ||
    asString(draft.angle) ||
    asString(draft.whyNow) ||
    draft.keyFacts.length > 0 ||
    draft.risks.length > 0;
  if (!stillUseful) {
    return null;
  }

  // Stable sort validation arrays for determinism
  validation.rejectedKeyFacts.sort();
  validation.rejectedFields = [...new Set(validation.rejectedFields)].sort();
  validation.warnings = [...new Set(validation.warnings)].sort();
  validation.conflicts.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );

  return draft;
}

module.exports = {
  validateAndBuildEditContext,
  matchEvidence,
  buildStoryCorpus,
  validateKeyFacts,
  validateHeadline,
  validateLead,
  validateWhyNow,
  normalizeWhitespace,
  normalizeHandle,
  extractDateKeys,
  semanticFactKey,
  emptyValidation,
};
