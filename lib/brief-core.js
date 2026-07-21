const { evidenceCount, cloneKnowledge } = require("./knowledge-core");
const {
  buildEditorialFromStories,
  validateEditorial,
  GENERIC_CATEGORY_RE,
} = require("./brief-editorial");

const BRIEF_STATUS = "draft";
const DEFAULT_PURPOSE = "research-note";
const DEFAULT_CONFIDENCE_THRESHOLD = 50;
const DEFAULT_TITLE = "(untitled brief)";

const DEFAULT_CONSTRAINTS = [
  "Knowledge summary にない事実を追加しない。",
  "Evidence 参照を根拠として扱う（本文未確認の断定を避ける）。",
  "Evidence 本文を取得・確認していない場合は断定しない。",
  "Knowledge の status と confidence を尊重する。",
  "不明点を推測で埋めない。",
  "sourceSnapshot の version / updatedAt を明示できるようにする。",
];

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

const STATUS_RANK = {
  published: 0,
  review: 1,
  draft: 2,
  archived: 3,
};

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function isIso8601(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function validateBriefId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Brief id は空でない文字列である必要があります。");
  }
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Brief id に制御文字は使えません。");
  }
  return id.trim();
}

function generateBriefId(now) {
  const stamp = nowIso(now).replace(/[:.]/g, "-");
  return `brief-${stamp}`;
}

function resolveBriefTitle(knowledgeList, titleOption, editorialHeadline) {
  if (typeof titleOption === "string" && titleOption.trim()) {
    return titleOption.trim();
  }
  if (typeof editorialHeadline === "string" && editorialHeadline.trim()) {
    const headline = editorialHeadline.trim();
    if (!GENERIC_CATEGORY_RE.test(headline)) {
      return headline;
    }
  }
  if (!Array.isArray(knowledgeList) || knowledgeList.length === 0) {
    return DEFAULT_TITLE;
  }
  if (knowledgeList.length === 1) {
    return String(knowledgeList[0].title || DEFAULT_TITLE);
  }
  const primary = String(knowledgeList[0].title || DEFAULT_TITLE);
  return `${primary} (+${knowledgeList.length - 1})`;
}

function cloneEvidence(evidence) {
  return {
    stories: [...(evidence?.stories || [])],
    concepts: [...(evidence?.concepts || [])],
    posts: [...(evidence?.posts || [])],
  };
}

/**
 * Knowledge summary → one claim per Knowledge (no paraphrasing / splitting).
 */
function buildClaim(knowledge) {
  const summary =
    typeof knowledge.summary === "string" ? knowledge.summary : "";
  const count = evidenceCount(knowledge.evidence || {});
  const hasSummary = summary.trim().length > 0;
  const usable = hasSummary && count > 0;
  const reasons = [];
  if (!hasSummary) reasons.push("empty-summary");
  if (count === 0) reasons.push("no-evidence");
  if (knowledge.status && knowledge.status !== "published") {
    reasons.push(`status:${knowledge.status}`);
  }

  return {
    knowledgeId: knowledge.id,
    text: summary,
    confidence: knowledge.confidence,
    evidenceCount: count,
    usable,
    reason: reasons.length > 0 ? reasons.join(",") : null,
  };
}

/**
 * Merge Evidence refs across Knowledge list. First-seen order; type-local dedupe.
 * Returns { evidence, evidenceProvenance }.
 */
function mergeEvidence(knowledgeList) {
  const evidence = { stories: [], concepts: [], posts: [] };
  const evidenceProvenance = {
    stories: {},
    concepts: {},
    posts: {},
  };

  const kinds = ["stories", "concepts", "posts"];
  for (const knowledge of knowledgeList) {
    const ev = knowledge.evidence || { stories: [], concepts: [], posts: [] };
    for (const kind of kinds) {
      const refs = Array.isArray(ev[kind]) ? ev[kind] : [];
      for (const ref of refs) {
        if (typeof ref !== "string" || !ref) continue;
        if (!Object.prototype.hasOwnProperty.call(evidenceProvenance[kind], ref)) {
          evidence[kind].push(ref);
          evidenceProvenance[kind][ref] = [];
        }
        const owners = evidenceProvenance[kind][ref];
        if (!owners.includes(knowledge.id)) {
          owners.push(knowledge.id);
        }
      }
    }
  }

  return { evidence, evidenceProvenance };
}

function detectBriefGaps(knowledgeList, options = {}) {
  const threshold =
    options.confidenceThreshold != null
      ? Number(options.confidenceThreshold)
      : DEFAULT_CONFIDENCE_THRESHOLD;
  const gaps = [];

  if (!Array.isArray(knowledgeList) || knowledgeList.length === 0) {
    gaps.push({
      type: "no-knowledge",
      severity: "error",
      knowledgeId: null,
      message: "Knowledge が 0 件です。",
    });
    return gaps;
  }

  const statuses = new Set(knowledgeList.map((k) => k.status));
  if (statuses.size > 1) {
    gaps.push({
      type: "mixed-status",
      severity: "warning",
      knowledgeId: null,
      message: `複数 Knowledge の status が混在しています: ${[...statuses].sort().join(", ")}`,
    });
  }

  let anyEvidenceType = false;
  for (const knowledge of knowledgeList) {
    const ev = knowledge.evidence || { stories: [], concepts: [], posts: [] };
    const count = evidenceCount(ev);
    if (count > 0) anyEvidenceType = true;

    if (typeof knowledge.summary !== "string" || !knowledge.summary.trim()) {
      gaps.push({
        type: "empty-summary",
        severity: "warning",
        knowledgeId: knowledge.id,
        message: `summary が空です: ${knowledge.id}`,
      });
    }

    if (count === 0) {
      gaps.push({
        type: "no-evidence",
        severity: "warning",
        knowledgeId: knowledge.id,
        message: `Evidence が 0 件です: ${knowledge.id}`,
      });
    }

    if (
      typeof knowledge.confidence === "number" &&
      knowledge.confidence < threshold
    ) {
      gaps.push({
        type: "low-confidence",
        severity: "warning",
        knowledgeId: knowledge.id,
        message: `confidence が閾値 ${threshold} 未満です: ${knowledge.id} (${knowledge.confidence})`,
      });
    }

    if (knowledge.status && knowledge.status !== "published") {
      gaps.push({
        type: "non-published",
        severity: knowledge.status === "archived" ? "warning" : "info",
        knowledgeId: knowledge.id,
        message: `published 以外の Knowledge を含みます: ${knowledge.id} (${knowledge.status})`,
      });
    }

    if (knowledge.status === "archived") {
      gaps.push({
        type: "archived",
        severity: "warning",
        knowledgeId: knowledge.id,
        message: `archived Knowledge を含みます: ${knowledge.id}`,
      });
    }
  }

  if (!anyEvidenceType) {
    gaps.push({
      type: "no-evidence-type",
      severity: "warning",
      knowledgeId: null,
      message: "いずれの Knowledge にも Evidence がありません。",
    });
  }

  const knowledgeOrder = new Map(
    knowledgeList.map((k, index) => [k.id, index])
  );

  gaps.sort((a, b) => {
    const sevA = SEVERITY_ORDER[a.severity] ?? 99;
    const sevB = SEVERITY_ORDER[b.severity] ?? 99;
    if (sevA !== sevB) return sevA - sevB;
    const idxA =
      a.knowledgeId == null ? -1 : knowledgeOrder.get(a.knowledgeId) ?? 9999;
    const idxB =
      b.knowledgeId == null ? -1 : knowledgeOrder.get(b.knowledgeId) ?? 9999;
    if (idxA !== idxB) return idxA - idxB;
    return String(a.type).localeCompare(String(b.type));
  });

  return gaps;
}

function calculateBriefStatistics(knowledgeList, claims, evidence, gaps) {
  const list = Array.isArray(knowledgeList) ? knowledgeList : [];
  const claimList = Array.isArray(claims) ? claims : [];
  const gapList = Array.isArray(gaps) ? gaps : [];
  const ev = evidence || { stories: [], concepts: [], posts: [] };

  const confidences = list
    .map((k) => k.confidence)
    .filter((c) => typeof c === "number" && Number.isFinite(c));

  const usableClaimCount = claimList.filter((c) => c.usable).length;
  const lowConfidenceCount = gapList.filter((g) => g.type === "low-confidence")
    .length;
  const nonPublishedCount = list.filter(
    (k) => k.status && k.status !== "published"
  ).length;

  let averageConfidence = null;
  if (confidences.length > 0) {
    const sum = confidences.reduce((a, b) => a + b, 0);
    averageConfidence = Math.round((sum / confidences.length) * 100) / 100;
  }

  return {
    knowledgeCount: list.length,
    claimCount: claimList.length,
    usableClaimCount,
    unusableClaimCount: claimList.length - usableClaimCount,
    evidenceCount: evidenceCount(ev),
    storyEvidenceCount: (ev.stories || []).length,
    conceptEvidenceCount: (ev.concepts || []).length,
    postEvidenceCount: (ev.posts || []).length,
    gapCount: gapList.length,
    lowConfidenceCount,
    nonPublishedCount,
    minimumConfidence: confidences.length > 0 ? Math.min(...confidences) : null,
    maximumConfidence: confidences.length > 0 ? Math.max(...confidences) : null,
    averageConfidence,
  };
}

function toBriefKnowledge(knowledge) {
  return {
    id: knowledge.id,
    title: knowledge.title,
    summary: typeof knowledge.summary === "string" ? knowledge.summary : "",
    status: knowledge.status,
    version: knowledge.version,
    confidence: knowledge.confidence,
    notes: typeof knowledge.notes === "string" ? knowledge.notes : "",
    updatedAt: knowledge.updatedAt,
  };
}

function toSourceSnapshot(knowledge) {
  return {
    id: knowledge.id,
    version: knowledge.version,
    status: knowledge.status,
    updatedAt: knowledge.updatedAt,
    title: knowledge.title,
    confidence: knowledge.confidence,
    evidenceCount: evidenceCount(knowledge.evidence || {}),
  };
}

function sortKnowledgeForStatusSearch(list) {
  return [...list].sort((a, b) => {
    const rankA = STATUS_RANK[a.status] ?? 50;
    const rankB = STATUS_RANK[b.status] ?? 50;
    if (rankA !== rankB) return rankA - rankB;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const aTime = Date.parse(a.updatedAt);
    const bTime = Date.parse(b.updatedAt);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return bTime - aTime;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Build a Knowledge Brief from already-loaded Knowledge objects.
 * Does not mutate inputs. Does not read/write Knowledge Base.
 *
 * Optional options.stories (stories.js --json) adds editorial instruction block.
 *
 * @param {object[]} knowledgeList - validated Knowledge objects
 * @param {object} options
 * @param {object} [context]
 */
function buildKnowledgeBrief(knowledgeList, options = {}, context = {}) {
  const input = Array.isArray(knowledgeList)
    ? knowledgeList.map((k) => cloneKnowledge(k))
    : [];

  const preserveOrder = options.preserveOrder === true;
  const ordered = preserveOrder ? input : sortKnowledgeForStatusSearch(input);

  const id =
    options.id != null
      ? validateBriefId(options.id)
      : generateBriefId(context.now);

  const hasStoriesInput = Object.prototype.hasOwnProperty.call(
    options,
    "stories"
  );
  const editorial = hasStoriesInput
    ? buildEditorialFromStories(options.stories, ordered)
    : null;
  const primaryHeadline =
    editorial && editorial.articles.length > 0
      ? editorial.articles[0].headline
      : null;
  const title = resolveBriefTitle(ordered, options.title, primaryHeadline);
  const purpose =
    typeof options.purpose === "string" && options.purpose.trim()
      ? options.purpose.trim()
      : DEFAULT_PURPOSE;

  const claims = ordered.map((k) => buildClaim(k));
  const { evidence, evidenceProvenance } = mergeEvidence(ordered);
  const gaps = detectBriefGaps(ordered, {
    confidenceThreshold: options.confidenceThreshold,
  });

  const extraConstraints = Array.isArray(options.constraints)
    ? options.constraints.filter((c) => typeof c === "string" && c.trim())
    : [];
  const editorialRiskConstraints = [];
  if (editorial) {
    for (const article of editorial.articles) {
      for (const risk of article.risks || []) {
        if (typeof risk === "string" && risk.trim()) {
          editorialRiskConstraints.push(`編集注意: ${risk.trim()}`);
        }
      }
    }
  }
  const constraints = [
    ...DEFAULT_CONSTRAINTS,
    ...extraConstraints.map((c) => c.trim()),
    ...editorialRiskConstraints,
  ];

  const knowledge = ordered.map((k) => toBriefKnowledge(k));
  const sourceSnapshot = ordered.map((k) => toSourceSnapshot(k));
  const statistics = calculateBriefStatistics(
    ordered,
    claims,
    evidence,
    gaps
  );

  const brief = {
    id,
    title,
    purpose,
    status: BRIEF_STATUS,
    generatedAt: nowIso(context.now),
    knowledge,
    claims,
    evidence,
    evidenceProvenance,
    gaps,
    constraints,
    sourceSnapshot,
    statistics,
  };
  if (editorial) {
    brief.editorial = editorial;
  }

  const validated = validateBrief(brief);
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }

  return validated.brief;
}

function validateBrief(brief) {
  const errors = [];

  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    return { ok: false, brief: null, errors: ["Brief はオブジェクトである必要があります。"] };
  }

  try {
    validateBriefId(brief.id);
  } catch (error) {
    errors.push(error.message);
  }

  if (typeof brief.title !== "string" || !brief.title.trim()) {
    errors.push("title は空でない文字列である必要があります。");
  }
  if (typeof brief.purpose !== "string" || !brief.purpose.trim()) {
    errors.push("purpose は空でない文字列である必要があります。");
  }
  if (brief.status !== BRIEF_STATUS) {
    errors.push(`status は "${BRIEF_STATUS}" である必要があります。`);
  }
  if (!isIso8601(brief.generatedAt)) {
    errors.push("generatedAt は ISO8601 である必要があります。");
  }

  if (!Array.isArray(brief.knowledge)) {
    errors.push("knowledge は配列である必要があります。");
  }
  if (!Array.isArray(brief.claims)) {
    errors.push("claims は配列である必要があります。");
  }
  if (!Array.isArray(brief.gaps)) {
    errors.push("gaps は配列である必要があります。");
  }
  if (!Array.isArray(brief.constraints)) {
    errors.push("constraints は配列である必要があります。");
  }
  if (!Array.isArray(brief.sourceSnapshot)) {
    errors.push("sourceSnapshot は配列である必要があります。");
  }
  if (!brief.statistics || typeof brief.statistics !== "object") {
    errors.push("statistics はオブジェクトである必要があります。");
  }

  const knowledgeIds = new Set();
  if (Array.isArray(brief.knowledge)) {
    for (const item of brief.knowledge) {
      if (!item || typeof item !== "object") {
        errors.push("knowledge 項目が不正です。");
        continue;
      }
      if (typeof item.id !== "string" || !item.id) {
        errors.push("knowledge.id が不正です。");
        continue;
      }
      if (knowledgeIds.has(item.id)) {
        errors.push(`knowledge id が重複しています: ${item.id}`);
      }
      knowledgeIds.add(item.id);
      if (
        !Number.isInteger(item.version) ||
        item.version < 1
      ) {
        errors.push(`knowledge.version が不正です: ${item.id}`);
      }
      if (
        typeof item.confidence !== "number" ||
        !Number.isInteger(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 100
      ) {
        errors.push(`knowledge.confidence が不正です: ${item.id}`);
      }
    }
  }

  const snapshotIds = new Set();
  if (Array.isArray(brief.sourceSnapshot)) {
    for (const snap of brief.sourceSnapshot) {
      if (!snap || typeof snap !== "object") {
        errors.push("sourceSnapshot 項目が不正です。");
        continue;
      }
      if (typeof snap.id !== "string" || !snap.id) {
        errors.push("sourceSnapshot.id が不正です。");
        continue;
      }
      if (snapshotIds.has(snap.id)) {
        errors.push(`sourceSnapshot id が重複しています: ${snap.id}`);
      }
      snapshotIds.add(snap.id);
      if (!knowledgeIds.has(snap.id)) {
        errors.push(`sourceSnapshot に対応する knowledge がありません: ${snap.id}`);
      }
      if (!Number.isInteger(snap.version) || snap.version < 1) {
        errors.push(`sourceSnapshot.version が不正です: ${snap.id}`);
      }
      if (!isIso8601(snap.updatedAt)) {
        errors.push(`sourceSnapshot.updatedAt が不正です: ${snap.id}`);
      }
    }
    for (const id of knowledgeIds) {
      if (!snapshotIds.has(id)) {
        errors.push(`sourceSnapshot が欠けています: ${id}`);
      }
    }
  }

  if (Array.isArray(brief.claims)) {
    for (const claim of brief.claims) {
      if (!claim || typeof claim !== "object") {
        errors.push("claim 項目が不正です。");
        continue;
      }
      if (!knowledgeIds.has(claim.knowledgeId)) {
        errors.push(`claim.knowledgeId が存在しません: ${claim.knowledgeId}`);
      }
      if (typeof claim.text !== "string") {
        errors.push(`claim.text は文字列である必要があります: ${claim.knowledgeId}`);
      }
      if (typeof claim.usable !== "boolean") {
        errors.push(`claim.usable は boolean である必要があります: ${claim.knowledgeId}`);
      }
    }
  }

  const evidence = brief.evidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !Array.isArray(evidence.stories) ||
    !Array.isArray(evidence.concepts) ||
    !Array.isArray(evidence.posts)
  ) {
    errors.push("evidence は { stories, concepts, posts } 配列である必要があります。");
  } else {
    for (const kind of ["stories", "concepts", "posts"]) {
      const seen = new Set();
      for (const ref of evidence[kind]) {
        if (typeof ref !== "string" || !ref) {
          errors.push(`evidence.${kind} に不正な参照があります。`);
          continue;
        }
        if (seen.has(ref)) {
          errors.push(`evidence.${kind} に重複があります: ${ref}`);
        }
        seen.add(ref);
      }
    }
  }

  const provenance = brief.evidenceProvenance;
  if (provenance != null) {
    if (typeof provenance !== "object" || Array.isArray(provenance)) {
      errors.push("evidenceProvenance はオブジェクトである必要があります。");
    } else if (evidence && typeof evidence === "object") {
      for (const kind of ["stories", "concepts", "posts"]) {
        const map = provenance[kind];
        if (!map || typeof map !== "object" || Array.isArray(map)) {
          errors.push(`evidenceProvenance.${kind} が不正です。`);
          continue;
        }
        const refs = evidence[kind] || [];
        for (const ref of refs) {
          if (!Object.prototype.hasOwnProperty.call(map, ref)) {
            errors.push(`evidenceProvenance.${kind} に欠けています: ${ref}`);
            continue;
          }
          const owners = map[ref];
          if (!Array.isArray(owners) || owners.length === 0) {
            errors.push(`evidenceProvenance.${kind}[${ref}] が空です。`);
            continue;
          }
          for (const kid of owners) {
            if (!knowledgeIds.has(kid)) {
              errors.push(
                `evidenceProvenance.${kind}[${ref}] の knowledgeId が不正です: ${kid}`
              );
            }
          }
        }
        for (const ref of Object.keys(map)) {
          if (!refs.includes(ref)) {
            errors.push(
              `evidenceProvenance.${kind} に余剰があります: ${ref}`
            );
          }
        }
      }
    }
  }

  if (brief.statistics && typeof brief.statistics === "object") {
    const s = brief.statistics;
    if (typeof s.knowledgeCount !== "number" || s.knowledgeCount < 0) {
      errors.push("statistics.knowledgeCount が不正です。");
    }
    if (
      Array.isArray(brief.knowledge) &&
      s.knowledgeCount !== brief.knowledge.length
    ) {
      errors.push("statistics.knowledgeCount が knowledge 件数と一致しません。");
    }
    if (
      Array.isArray(brief.claims) &&
      typeof s.claimCount === "number" &&
      s.claimCount !== brief.claims.length
    ) {
      errors.push("statistics.claimCount が claims 件数と一致しません。");
    }
    if (
      Array.isArray(brief.gaps) &&
      typeof s.gapCount === "number" &&
      s.gapCount !== brief.gaps.length
    ) {
      errors.push("statistics.gapCount が gaps 件数と一致しません。");
    }
  }

  if (Array.isArray(brief.constraints)) {
    for (const c of brief.constraints) {
      if (typeof c !== "string" || !c.trim()) {
        errors.push("constraints の各要素は空でない文字列である必要があります。");
        break;
      }
    }
  }

  // Optional Editorial Brief v2 block (additive; absent on legacy briefs).
  if (Object.prototype.hasOwnProperty.call(brief, "editorial")) {
    validateEditorial(brief.editorial, errors);
  }

  if (errors.length > 0) {
    return { ok: false, brief: null, errors };
  }

  return {
    ok: true,
    brief: JSON.parse(JSON.stringify(brief)),
    errors: [],
  };
}

/**
 * Filter / resolve which Knowledge statuses are allowed for Brief selection.
 */
function resolveAllowedStatuses(options = {}) {
  const allow = new Set(["published"]);
  const extra = options.allowStatus;
  if (Array.isArray(extra)) {
    for (const s of extra) {
      if (typeof s === "string" && s.trim()) allow.add(s.trim());
    }
  }
  return allow;
}

/**
 * Deduplicate ID list preserving first-seen order.
 */
function dedupeIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) continue;
    const value = id.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Extract a Brief object from pure Brief JSON or CLI wrapper `{ brief, operation }`.
 * Does not repair ambiguous JSON.
 */
function extractBriefPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Brief はオブジェクトである必要があります。");
  }

  const looksLikeBrief = (obj) =>
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    typeof obj.id === "string" &&
    typeof obj.generatedAt === "string" &&
    Array.isArray(obj.knowledge);

  if (looksLikeBrief(data) && !Object.prototype.hasOwnProperty.call(data, "operation")) {
    return data;
  }

  if (
    Object.prototype.hasOwnProperty.call(data, "brief") &&
    looksLikeBrief(data.brief)
  ) {
    return data.brief;
  }

  if (looksLikeBrief(data)) {
    return data;
  }

  throw new Error(
    "Brief Object、または { brief, operation } 形式を指定してください。"
  );
}

module.exports = {
  BRIEF_STATUS,
  DEFAULT_PURPOSE,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_CONSTRAINTS,
  DEFAULT_TITLE,
  buildKnowledgeBrief,
  buildClaim,
  mergeEvidence,
  detectBriefGaps,
  calculateBriefStatistics,
  validateBrief,
  validateBriefId,
  generateBriefId,
  resolveBriefTitle,
  resolveAllowedStatuses,
  dedupeIds,
  sortKnowledgeForStatusSearch,
  cloneEvidence,
  extractBriefPayload,
};
