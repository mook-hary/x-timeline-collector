const { extractBriefPayload } = require("./brief-core");
const { validateWriterInput, UNUSABLE_NOTE } = require("./writer-core");

const DEFAULT_CONFIDENCE_THRESHOLD = 50;
const GAPS_SECTION_LABEL = "注意事項";

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function isIso8601(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function validateReportId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Report id は空でない文字列である必要があります。");
  }
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Report id に制御文字は使えません。");
  }
  return id.trim();
}

function generateReportId(now) {
  return `report-${nowIso(now).replace(/[:.]/g, "-")}`;
}

function stripHtmlComments(markdown) {
  return String(markdown || "").replace(/<!--[\s\S]*?-->/g, "");
}

function extractVisibleMarkdown(markdown) {
  return stripHtmlComments(markdown);
}

function extractMarkdownTitle(markdown) {
  const visible = extractVisibleMarkdown(markdown);
  const match = /^#\s+(.+?)\s*$/m.exec(visible);
  return match ? match[1].trim() : null;
}

function extractMarkdownSections(markdown) {
  const visible = extractVisibleMarkdown(markdown);
  const sections = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let match;
  while ((match = re.exec(visible)) !== null) {
    sections.push(match[1].trim());
  }
  return sections;
}

/**
 * Length contract:
 * - strip HTML comments
 * - remove newlines
 * - keep other Markdown characters
 * - characters: Unicode code points (Array.from)
 * - words: whitespace-split non-empty tokens
 */
function countArticleLength(markdown, unit = "characters") {
  const visible = extractVisibleMarkdown(markdown);
  const flat = visible.replace(/[\r\n]+/g, "");
  if (unit === "words") {
    return flat
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean).length;
  }
  return Array.from(flat).length;
}

function analyzeMarkdown(markdown, plan) {
  const title = extractMarkdownTitle(markdown);
  const sections = extractMarkdownSections(markdown);
  const plannedLabels = Array.isArray(plan?.structure)
    ? plan.structure.map((s) => s.label)
    : [];
  const plannedPresent = sections.filter((label) =>
    plannedLabels.includes(label)
  );
  const additional = sections.filter(
    (label) => !plannedLabels.includes(label)
  );

  const unit = plan?.length?.unit || "characters";
  const actualLength = countArticleLength(markdown, unit);
  const minimum = plan?.length?.minimum ?? null;
  const maximum = plan?.length?.maximum ?? null;
  const target = plan?.length?.target ?? null;

  let withinTargetRange = null;
  if (minimum != null && maximum != null) {
    withinTargetRange = actualLength >= minimum && actualLength <= maximum;
  }

  return {
    markdownTitle: title,
    sections,
    sectionCount: {
      total: sections.length,
      planned: plannedPresent.length,
      plannedExpected: plannedLabels.length,
      additional: additional.length,
      hasGapsSection: sections.includes(GAPS_SECTION_LABEL),
    },
    actualLength,
    lengthUnit: unit,
    minimumLength: minimum,
    maximumLength: maximum,
    targetLength: target,
    withinTargetRange,
    hasConstraintsMeta: /<!--\s*\nConstraints/.test(markdown),
    hasStatisticsMeta: /<!--\s*\nStatistics/.test(markdown),
    hasSnapshotMeta: /<!--\s*\nSource Snapshot/.test(markdown),
    visibleText: extractVisibleMarkdown(markdown),
    hasUnusableNote: extractVisibleMarkdown(markdown).includes(UNUSABLE_NOTE),
  };
}

/**
 * Exact substring match of claim.text in visible markdown.
 * Duplicate identical texts: presence of text marks each such claim rendered
 * (Knowledge-ID-specific spans are not tracked).
 */
function analyzeClaims(brief, visibleMarkdown) {
  const claims = Array.isArray(brief.claims) ? brief.claims : [];
  const items = [];
  let usable = 0;
  let unusable = 0;

  for (const claim of claims) {
    const text = typeof claim.text === "string" ? claim.text : "";
    const isUsable = claim.usable === true;
    if (isUsable) usable += 1;
    else unusable += 1;

    const textPresent = text.length > 0 && visibleMarkdown.includes(text);

    items.push({
      knowledgeId: claim.knowledgeId,
      text,
      confidence: claim.confidence,
      evidenceCount: claim.evidenceCount,
      usable: isUsable,
      rendered: isUsable ? textPresent : false,
      reason: claim.reason || null,
      unusableBodyPresent: !isUsable && textPresent,
    });
  }

  return {
    total: claims.length,
    usable,
    unusable,
    rendered: items.filter((c) => c.usable && c.rendered).length,
    omitted: items.filter((c) => c.usable && !c.rendered).length,
    items,
  };
}

function buildEvidenceSummary(brief) {
  const evidence = brief.evidence || { stories: [], concepts: [], posts: [] };
  const stories = Array.isArray(evidence.stories) ? [...evidence.stories] : [];
  const concepts = Array.isArray(evidence.concepts)
    ? [...evidence.concepts]
    : [];
  const posts = Array.isArray(evidence.posts) ? [...evidence.posts] : [];
  return {
    total: stories.length + concepts.length + posts.length,
    stories: { count: stories.length, refs: stories },
    concepts: { count: concepts.length, refs: concepts },
    posts: { count: posts.length, refs: posts },
  };
}

function buildConfidenceSummary(brief, threshold) {
  const list = Array.isArray(brief.knowledge) ? brief.knowledge : [];
  const values = list
    .map((k) => k.confidence)
    .filter((c) => typeof c === "number" && Number.isFinite(c));
  const belowThreshold = list
    .filter(
      (k) => typeof k.confidence === "number" && k.confidence < threshold
    )
    .map((k) => ({ knowledgeId: k.id, confidence: k.confidence }));

  let average = null;
  if (values.length > 0) {
    const sum = values.reduce((a, b) => a + b, 0);
    average = Math.round((sum / values.length) * 100) / 100;
  }

  return {
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null,
    average,
    threshold,
    belowThreshold,
  };
}

function markdownIncludesSnapshotId(markdown, id) {
  if (!markdown || !id) return false;
  const block = /<!--\s*\nSource Snapshot([\s\S]*?)-->/.exec(markdown);
  if (!block) return false;
  return block[1].split("\n").some((line) => line.trim() === id);
}

function buildChecks({
  writerValidation,
  brief,
  plan,
  md,
  claims,
  confidence,
  markdown,
}) {
  const checks = [];
  const push = (type, status, severity, message, details = null) => {
    checks.push({ type, status, severity, message, details });
  };

  if (writerValidation.ok) {
    push("brief-valid", "pass", "info", "Brief は valid です。");
    push("plan-valid", "pass", "info", "Plan は valid です。");
    push("writer-input-valid", "pass", "info", "Writer 入力は valid です。");
  } else {
    push("writer-input-valid", "error", "error", "Writer 入力が不正です。", {
      errors: writerValidation.errors,
    });
  }

  if (plan.briefReference) {
    const match =
      plan.briefReference.id === brief.id &&
      plan.briefReference.generatedAt === brief.generatedAt;
    push(
      "brief-reference-match",
      match ? "pass" : "error",
      match ? "info" : "error",
      match
        ? "briefReference が Brief と一致します。"
        : "briefReference が Brief と一致しません。"
    );
  } else {
    push(
      "brief-reference-match",
      "warning",
      "warning",
      "Plan に briefReference がありません。"
    );
  }

  const expectedTitle =
    typeof plan.title === "string" && plan.title.trim()
      ? plan.title.trim()
      : null;
  const titleMatch =
    expectedTitle != null &&
    md.markdownTitle != null &&
    expectedTitle === md.markdownTitle;
  push(
    "markdown-title-match",
    titleMatch ? "pass" : "error",
    titleMatch ? "info" : "error",
    titleMatch
      ? "Markdown H1 が Plan.title と一致します。"
      : "Markdown H1 が Plan.title と一致しません。",
    { planTitle: expectedTitle, markdownTitle: md.markdownTitle }
  );

  const structureOk =
    md.sectionCount.plannedExpected === 0 || md.sectionCount.planned > 0;
  push(
    "structure-present",
    structureOk ? "pass" : "warning",
    structureOk ? "info" : "warning",
    structureOk
      ? "Plan.structure 由来の見出しが検出されました。"
      : "Plan.structure 由来の見出しが見つかりません。"
  );

  const usableItems = claims.items.filter((c) => c.usable);
  if (usableItems.length === 0) {
    push("usable-claims-rendered", "error", "error", "usable claim が 0 件です。");
  } else {
    const allRendered = usableItems.every((c) => c.rendered);
    push(
      "usable-claims-rendered",
      allRendered ? "pass" : "error",
      allRendered ? "info" : "error",
      allRendered
        ? "usable claim がすべて Markdown に完全一致で存在します。"
        : "usable claim の一部が Markdown にありません。",
      {
        missing: usableItems
          .filter((c) => !c.rendered)
          .map((c) => c.knowledgeId),
      }
    );
  }

  const badUnusable = claims.items.filter((c) => c.unusableBodyPresent);
  push(
    "unusable-claims-not-rendered",
    badUnusable.length === 0 ? "pass" : "error",
    badUnusable.length === 0 ? "info" : "error",
    badUnusable.length === 0
      ? "unusable claim 本文は Markdown に含まれていません。"
      : "unusable claim 本文が Markdown に含まれています。",
    { knowledgeIds: badUnusable.map((c) => c.knowledgeId) }
  );

  const gaps = Array.isArray(brief.gaps) ? brief.gaps : [];
  if (gaps.length > 0) {
    push(
      "gaps-section-present",
      md.sectionCount.hasGapsSection ? "pass" : "warning",
      md.sectionCount.hasGapsSection ? "info" : "warning",
      md.sectionCount.hasGapsSection
        ? "注意事項セクションがあります。"
        : "Brief.gaps があるのに注意事項セクションがありません。"
    );
  } else {
    push("gaps-section-present", "pass", "info", "Brief.gaps は空です。");
  }

  push(
    "constraints-metadata-present",
    md.hasConstraintsMeta ? "pass" : "warning",
    md.hasConstraintsMeta ? "info" : "warning",
    md.hasConstraintsMeta
      ? "Constraints HTML コメントがあります。"
      : "Constraints HTML コメントがありません。"
  );
  push(
    "statistics-metadata-present",
    md.hasStatisticsMeta ? "pass" : "warning",
    md.hasStatisticsMeta ? "info" : "warning",
    md.hasStatisticsMeta
      ? "Statistics HTML コメントがあります。"
      : "Statistics HTML コメントがありません。"
  );
  push(
    "source-snapshot-metadata-present",
    md.hasSnapshotMeta ? "pass" : "warning",
    md.hasSnapshotMeta ? "info" : "warning",
    md.hasSnapshotMeta
      ? "Source Snapshot HTML コメントがあります。"
      : "Source Snapshot HTML コメントがありません。"
  );

  if (md.withinTargetRange === true) {
    push("target-length", "pass", "info", "記事長が Plan.length の範囲内です。", {
      actualLength: md.actualLength,
    });
  } else if (md.withinTargetRange === false) {
    push(
      "target-length",
      "warning",
      "warning",
      "記事長が Plan.length の範囲外です。",
      {
        actualLength: md.actualLength,
        minimum: md.minimumLength,
        maximum: md.maximumLength,
      }
    );
  } else {
    push(
      "target-length",
      "pass",
      "info",
      "length 範囲判定はスキップ（min/max 未設定）。",
      { actualLength: md.actualLength, target: md.targetLength }
    );
  }

  if (confidence.belowThreshold.length > 0) {
    push(
      "low-confidence",
      "warning",
      "warning",
      `confidence が閾値 ${confidence.threshold} 未満の Knowledge があります。`,
      { items: confidence.belowThreshold }
    );
  }

  const nonPublished = (brief.knowledge || []).filter(
    (k) => k.status !== "published"
  );
  if (nonPublished.length > 0) {
    push(
      "non-published-knowledge",
      "warning",
      "warning",
      "published 以外の Knowledge を含みます。",
      { ids: nonPublished.map((k) => k.id) }
    );
  }

  const snapshots = Array.isArray(brief.sourceSnapshot)
    ? brief.sourceSnapshot
    : [];
  if (snapshots.length > 0) {
    const missing = snapshots.filter(
      (s) => !markdownIncludesSnapshotId(markdown, s.id)
    );
    push(
      "source-snapshot-ids",
      missing.length === 0 ? "pass" : "warning",
      missing.length === 0 ? "info" : "warning",
      missing.length === 0
        ? "Source Snapshot コメントに Knowledge id が含まれます。"
        : "Source Snapshot コメントに欠けた Knowledge id があります。",
      { missing: missing.map((s) => s.id) }
    );
  }

  // Core treats inputs as immutable; CLI may additionally compare mtimes.
  push(
    "input-files-read-only",
    "pass",
    "info",
    "入力は読み取り専用として扱い、Report 生成では変更しません。"
  );

  return checks;
}

function computeReadyForAiRewrite({
  checks,
  claims,
  writerValidation,
  brief,
  plan,
}) {
  const errorCount = checks.filter((c) => c.status === "error").length;
  const usableItems = claims.items.filter((c) => c.usable);
  const allUsableRendered =
    usableItems.length > 0 && usableItems.every((c) => c.rendered);
  const refOk =
    !plan.briefReference ||
    (plan.briefReference.id === brief.id &&
      plan.briefReference.generatedAt === brief.generatedAt);
  const allPublished = (brief.knowledge || []).every(
    (k) => k.status === "published"
  );

  const ready =
    errorCount === 0 &&
    writerValidation.ok === true &&
    usableItems.length >= 1 &&
    allUsableRendered &&
    refOk &&
    allPublished;

  const reasons = [];
  if (errorCount > 0) reasons.push("error check があります。");
  if (!writerValidation.ok) reasons.push("Writer 入力が invalid です。");
  if (usableItems.length < 1) reasons.push("usable claim がありません。");
  if (usableItems.length >= 1 && !allUsableRendered) {
    reasons.push("usable claim がすべて rendered ではありません。");
  }
  if (!refOk) reasons.push("briefReference が一致しません。");
  if (!allPublished) {
    reasons.push(
      "published 以外の Knowledge を含むため readyForAiRewrite=false です。"
    );
  }
  if (ready) reasons.push("機械的条件を満たしています。");

  return { ready, reasons };
}

function buildReviewSummary(checks, claims, writerValidation, brief, plan) {
  const errorCount = checks.filter((c) => c.status === "error").length;
  const warningCount = checks.filter((c) => c.status === "warning").length;
  const passCount = checks.filter((c) => c.status === "pass").length;

  let status = "pass";
  if (errorCount > 0) status = "fail";
  else if (warningCount > 0) status = "warning";

  const { ready, reasons } = computeReadyForAiRewrite({
    checks,
    claims,
    writerValidation,
    brief,
    plan,
  });

  return {
    status,
    errorCount,
    warningCount,
    passCount,
    readyForAiRewrite: ready,
    reasons,
  };
}

function calculateArticleReportStatistics({
  brief,
  plan,
  claims,
  evidence,
  md,
  checks,
  reviewSummary,
}) {
  const briefConstraints = Array.isArray(brief.constraints)
    ? brief.constraints
    : [];
  const planConstraints = Array.isArray(plan.constraints)
    ? plan.constraints
    : [];

  return {
    knowledgeCount: Array.isArray(brief.knowledge) ? brief.knowledge.length : 0,
    totalClaimCount: claims.total,
    usableClaimCount: claims.usable,
    unusableClaimCount: claims.unusable,
    renderedClaimCount: claims.items.filter((c) => c.usable && c.rendered)
      .length,
    omittedClaimCount: claims.items.filter((c) => c.usable && !c.rendered)
      .length,
    evidenceCount: evidence.total,
    gapCount: Array.isArray(brief.gaps) ? brief.gaps.length : 0,
    constraintCount: briefConstraints.length + planConstraints.length,
    plannedSectionCount: Array.isArray(plan.structure)
      ? plan.structure.length
      : 0,
    renderedSectionCount: md.sectionCount.total,
    articleLength: md.actualLength,
    checkCount: checks.length,
    errorCount: reviewSummary.errorCount,
    warningCount: reviewSummary.warningCount,
    passCount: reviewSummary.passCount,
  };
}

function buildArticleReport(
  briefInput,
  planInput,
  markdown,
  options = {},
  context = {}
) {
  if (typeof markdown !== "string") {
    throw new Error("Markdown は文字列である必要があります。");
  }

  let briefPayload;
  try {
    briefPayload =
      briefInput &&
      typeof briefInput === "object" &&
      Array.isArray(briefInput.knowledge)
        ? briefInput
        : extractBriefPayload(briefInput);
  } catch (error) {
    throw new Error(`Brief: ${error.message}`);
  }

  const writerValidation = validateWriterInput(briefPayload, planInput);
  if (!writerValidation.ok) {
    const err = new Error(writerValidation.errors.join("\n"));
    err.validation = writerValidation;
    throw err;
  }

  const { brief, plan } = writerValidation;
  const threshold =
    options.confidenceThreshold != null
      ? Number(options.confidenceThreshold)
      : DEFAULT_CONFIDENCE_THRESHOLD;

  const md = analyzeMarkdown(markdown, plan);
  const claims = analyzeClaims(brief, md.visibleText);
  const evidence = buildEvidenceSummary(brief);
  const confidence = buildConfidenceSummary(brief, threshold);
  const checks = buildChecks({
    writerValidation,
    brief,
    plan,
    md,
    claims,
    confidence,
    markdown,
  });
  const reviewSummary = buildReviewSummary(
    checks,
    claims,
    writerValidation,
    brief,
    plan
  );

  const knowledgeList = (brief.knowledge || []).map((k) => {
    const snap = (brief.sourceSnapshot || []).find((s) => s.id === k.id);
    return {
      id: k.id,
      title: k.title,
      status: k.status,
      version: k.version,
      confidence: k.confidence,
      updatedAt: k.updatedAt,
      evidenceCount:
        snap && typeof snap.evidenceCount === "number"
          ? snap.evidenceCount
          : null,
    };
  });

  const sourceSnapshot = (brief.sourceSnapshot || []).map((s) => ({
    id: s.id,
    version: s.version,
    status: s.status,
    updatedAt: s.updatedAt,
  }));

  const statistics = calculateArticleReportStatistics({
    brief,
    plan,
    claims,
    evidence,
    md,
    checks,
    reviewSummary,
  });

  const id =
    options.id != null
      ? validateReportId(options.id)
      : generateReportId(context.now);

  const report = {
    id,
    generatedAt: nowIso(context.now),
    article: {
      title: plan.title,
      format: plan.format,
      language: plan.language,
      targetLength: md.targetLength,
      minimumLength: md.minimumLength,
      maximumLength: md.maximumLength,
      actualLength: md.actualLength,
      lengthUnit: md.lengthUnit,
      withinTargetRange: md.withinTargetRange,
      sectionCount: md.sectionCount,
    },
    sources: {
      brief: {
        id: brief.id,
        title: brief.title,
        generatedAt: brief.generatedAt,
        purpose: brief.purpose,
      },
      plan: {
        id: plan.id,
        title: plan.title,
        createdAt: plan.createdAt,
        purpose: plan.purpose,
        audience: plan.audience,
        format: plan.format,
        tone: plan.tone,
        language: plan.language,
      },
      knowledge: knowledgeList,
    },
    claims: {
      total: claims.total,
      usable: claims.usable,
      unusable: claims.unusable,
      rendered: claims.rendered,
      omitted: claims.omitted,
      items: claims.items.map((item) => ({
        knowledgeId: item.knowledgeId,
        text: item.text,
        confidence: item.confidence,
        evidenceCount: item.evidenceCount,
        usable: item.usable,
        rendered: item.usable ? item.rendered : false,
        reason: item.reason,
      })),
    },
    evidence,
    confidence,
    gaps: Array.isArray(brief.gaps)
      ? JSON.parse(JSON.stringify(brief.gaps))
      : [],
    constraints: {
      brief: Array.isArray(brief.constraints) ? [...brief.constraints] : [],
      plan: Array.isArray(plan.constraints) ? [...plan.constraints] : [],
    },
    sourceSnapshot,
    checks,
    reviewSummary,
    statistics,
  };

  const validated = validateArticleReport(report);
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }
  return validated.report;
}

function validateArticleReport(report) {
  const errors = [];

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      ok: false,
      report: null,
      errors: ["Article Report はオブジェクトである必要があります。"],
    };
  }

  for (const forbidden of ["markdown", "briefBody", "planBody", "articleBody"]) {
    if (Object.prototype.hasOwnProperty.call(report, forbidden)) {
      errors.push(`Report に ${forbidden} を含めてはいけません。`);
    }
  }

  try {
    validateReportId(report.id);
  } catch (error) {
    errors.push(error.message);
  }

  if (!isIso8601(report.generatedAt)) {
    errors.push("generatedAt は ISO8601 である必要があります。");
  }

  if (!report.article || typeof report.article !== "object") {
    errors.push("article はオブジェクトである必要があります。");
  }
  if (!report.sources || typeof report.sources !== "object") {
    errors.push("sources はオブジェクトである必要があります。");
  }

  if (!report.claims || typeof report.claims !== "object") {
    errors.push("claims はオブジェクトである必要があります。");
  } else if (!Array.isArray(report.claims.items)) {
    errors.push("claims.items は配列である必要があります。");
  } else {
    if (report.claims.total !== report.claims.items.length) {
      errors.push("claims.total が items 件数と一致しません。");
    }
    const usable = report.claims.items.filter((c) => c.usable).length;
    const unusable = report.claims.items.filter((c) => !c.usable).length;
    if (report.claims.usable !== usable) {
      errors.push("claims.usable が不整合です。");
    }
    if (report.claims.unusable !== unusable) {
      errors.push("claims.unusable が不整合です。");
    }
  }

  if (!report.evidence || typeof report.evidence !== "object") {
    errors.push("evidence はオブジェクトである必要があります。");
  } else {
    const e = report.evidence;
    const sum =
      (e.stories?.count || 0) +
      (e.concepts?.count || 0) +
      (e.posts?.count || 0);
    if (e.total !== sum) {
      errors.push("evidence.total が種別件数の合計と一致しません。");
    }
  }

  if (!report.confidence || typeof report.confidence !== "object") {
    errors.push("confidence はオブジェクトである必要があります。");
  } else {
    for (const key of ["minimum", "maximum", "average"]) {
      const v = report.confidence[key];
      if (v != null && (typeof v !== "number" || v < 0 || v > 100)) {
        errors.push(`confidence.${key} が不正です。`);
      }
    }
  }

  if (!Array.isArray(report.gaps)) {
    errors.push("gaps は配列である必要があります。");
  }
  if (!report.constraints || typeof report.constraints !== "object") {
    errors.push("constraints はオブジェクトである必要があります。");
  }

  if (!Array.isArray(report.sourceSnapshot)) {
    errors.push("sourceSnapshot は配列である必要があります。");
  } else {
    const seen = new Set();
    for (const snap of report.sourceSnapshot) {
      if (seen.has(snap.id)) {
        errors.push(`sourceSnapshot id が重複しています: ${snap.id}`);
      }
      seen.add(snap.id);
    }
    if (report.sources && Array.isArray(report.sources.knowledge)) {
      for (const k of report.sources.knowledge) {
        if (!seen.has(k.id)) {
          errors.push(`sourceSnapshot が欠けています: ${k.id}`);
        }
      }
    }
  }

  if (!Array.isArray(report.checks)) {
    errors.push("checks は配列である必要があります。");
  }

  if (!report.reviewSummary || typeof report.reviewSummary !== "object") {
    errors.push("reviewSummary はオブジェクトである必要があります。");
  } else if (Array.isArray(report.checks)) {
    const ec = report.checks.filter((c) => c.status === "error").length;
    const wc = report.checks.filter((c) => c.status === "warning").length;
    const pc = report.checks.filter((c) => c.status === "pass").length;
    if (report.reviewSummary.errorCount !== ec) {
      errors.push("reviewSummary.errorCount が不整合です。");
    }
    if (report.reviewSummary.warningCount !== wc) {
      errors.push("reviewSummary.warningCount が不整合です。");
    }
    if (report.reviewSummary.passCount !== pc) {
      errors.push("reviewSummary.passCount が不整合です。");
    }
    const expectedStatus = ec > 0 ? "fail" : wc > 0 ? "warning" : "pass";
    if (report.reviewSummary.status !== expectedStatus) {
      errors.push("reviewSummary.status が不整合です。");
    }
    if (
      report.reviewSummary.errorCount > 0 &&
      report.reviewSummary.readyForAiRewrite === true
    ) {
      errors.push(
        "readyForAiRewrite が機械的規則と一致しません（error があるのに true）。"
      );
    }
    if (
      report.claims &&
      report.claims.usable < 1 &&
      report.reviewSummary.readyForAiRewrite === true
    ) {
      errors.push(
        "readyForAiRewrite が機械的規則と一致しません（usable claim なし）。"
      );
    }
  }

  if (!report.statistics || typeof report.statistics !== "object") {
    errors.push("statistics はオブジェクトである必要があります。");
  } else if (Array.isArray(report.checks) && report.reviewSummary) {
    if (report.statistics.checkCount !== report.checks.length) {
      errors.push("statistics.checkCount が不整合です。");
    }
    if (report.statistics.errorCount !== report.reviewSummary.errorCount) {
      errors.push("statistics.errorCount が不整合です。");
    }
  }

  if (errors.length > 0) {
    return { ok: false, report: null, errors };
  }

  return {
    ok: true,
    report: JSON.parse(JSON.stringify(report)),
    errors: [],
  };
}

module.exports = {
  DEFAULT_CONFIDENCE_THRESHOLD,
  GAPS_SECTION_LABEL,
  buildArticleReport,
  validateArticleReport,
  analyzeMarkdown,
  analyzeClaims,
  buildChecks,
  buildReviewSummary,
  calculateArticleReportStatistics,
  countArticleLength,
  extractVisibleMarkdown,
  extractMarkdownTitle,
  extractMarkdownSections,
  stripHtmlComments,
  validateReportId,
  generateReportId,
  computeReadyForAiRewrite,
};
