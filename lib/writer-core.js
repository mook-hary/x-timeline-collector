const { validateBrief, extractBriefPayload } = require("./brief-core");
const { validateEditorialPlan } = require("./editorial-plan-core");
const {
  normalizeStoryContext,
  hasRichStoryContent,
  renderStoryArticle,
  resolveContentTitle,
  looksLikeSlashLabel,
} = require("./writer-content");
const {
  resolveEditContext,
  resolveEditorialHeadline,
} = require("./writer-editorial");

const DEFAULT_ARTICLE_TITLE = "(untitled article)";
const UNUSABLE_NOTE = "この項目は根拠不足のため本文へ採用しませんでした。";

function isIntroSection(section) {
  const id = String(section.id || "").toLowerCase();
  const label = String(section.label || "");
  return (
    id === "introduction" ||
    id === "intro" ||
    label === "導入" ||
    label === "はじめに"
  );
}

function isConclusionSection(section) {
  const id = String(section.id || "").toLowerCase();
  const label = String(section.label || "");
  return (
    id === "conclusion" ||
    id === "summary" ||
    label === "まとめ" ||
    label === "結論"
  );
}

function isGenericPlanTitle(title) {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) return true;
  if (/^Daily\s+\d{4}-\d{2}-\d{2}$/i.test(t)) return true;
  if (
    /^(制作・クリエイティブ技術|アニメ・漫画|ゲーム・ゲーム開発|注目の話題|その他)$/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Title priority (EP-001 / EP-002):
 * 1. Concrete Plan.title (not Daily/category/slash) — preserves AR H1 sync
 *    — except when it equals a Story-rejected Editorial headline
 * 2. Validated Editorial Brief headline
 * 3. Story-derived title
 * 4. Plan.title / Brief.title fallbacks
 */
function resolveArticleTitle(plan, brief, storiesInput) {
  const planTitle =
    plan && typeof plan.title === "string" ? plan.title.trim() : "";

  if (storiesInput != null) {
    const storyCtx = normalizeStoryContext(storiesInput, brief);
    const edit = resolveEditContext(brief, storyCtx, plan);
    const rejectedHeadline =
      edit && edit.validation && typeof edit.validation.rejectedHeadline === "string"
        ? edit.validation.rejectedHeadline.trim()
        : "";

    const planIsRejectedEditorial =
      rejectedHeadline && planTitle === rejectedHeadline;

    if (
      planTitle &&
      !isGenericPlanTitle(planTitle) &&
      !looksLikeSlashLabel(planTitle) &&
      !planIsRejectedEditorial
    ) {
      return planTitle;
    }

    const editorialHeadline = resolveEditorialHeadline(edit);
    if (editorialHeadline) return editorialHeadline;

    const contentTitle = resolveContentTitle(storiesInput, brief, plan);
    if (contentTitle) return contentTitle;
    if (planTitle && !planIsRejectedEditorial) return planTitle;
  }

  if (planTitle) return planTitle;
  if (brief && typeof brief.title === "string" && brief.title.trim()) {
    // Skip Brief title when it equals a rejected editorial headline.
    if (storiesInput != null) {
      const storyCtx = normalizeStoryContext(storiesInput, brief);
      const edit = resolveEditContext(brief, storyCtx, plan);
      const rejectedHeadline =
        edit &&
        edit.validation &&
        typeof edit.validation.rejectedHeadline === "string"
          ? edit.validation.rejectedHeadline.trim()
          : "";
      if (rejectedHeadline && brief.title.trim() === rejectedHeadline) {
        const contentTitle = resolveContentTitle(storiesInput, brief, plan);
        if (contentTitle) return contentTitle;
      }
    }
    return brief.title.trim();
  }
  return DEFAULT_ARTICLE_TITLE;
}

function knowledgeTitleForClaim(brief, knowledgeId) {
  const list = Array.isArray(brief.knowledge) ? brief.knowledge : [];
  const found = list.find((k) => k.id === knowledgeId);
  if (found && typeof found.title === "string" && found.title.trim()) {
    return found.title.trim();
  }
  return knowledgeId;
}

/**
 * Validate Brief + Plan for Writer. Does not generate Markdown.
 */
function validateWriterInput(briefInput, planInput) {
  const errors = [];

  let brief = null;
  try {
    const payload =
      briefInput &&
      typeof briefInput === "object" &&
      !Array.isArray(briefInput) &&
      Array.isArray(briefInput.knowledge)
        ? briefInput
        : extractBriefPayload(briefInput);
    const briefResult = validateBrief(payload);
    if (!briefResult.ok) {
      errors.push(...briefResult.errors.map((e) => `Brief: ${e}`));
    } else {
      brief = briefResult.brief;
    }
  } catch (error) {
    errors.push(`Brief: ${error.message}`);
  }

  let plan = null;
  const planResult = validateEditorialPlan(planInput);
  if (!planResult.ok) {
    errors.push(...planResult.errors.map((e) => `Plan: ${e}`));
  } else {
    plan = planResult.plan;
  }

  if (brief && plan && plan.briefReference) {
    const ref = plan.briefReference;
    if (ref.id !== brief.id) {
      errors.push(
        `briefReference.id (${ref.id}) が Brief.id (${brief.id}) と一致しません。`
      );
    }
    if (ref.generatedAt !== brief.generatedAt) {
      errors.push(
        `briefReference.generatedAt が Brief.generatedAt と一致しません。`
      );
    }
  }

  if (plan && (!Array.isArray(plan.structure) || plan.structure.length === 0)) {
    errors.push("Plan.structure は空でない配列である必要があります。");
  }

  if (errors.length > 0) {
    return { ok: false, brief: null, plan: null, errors };
  }

  return { ok: true, brief, plan, errors: [] };
}

function renderIntroduction(plan, brief, title) {
  const audience =
    plan.audience && typeof plan.audience.description === "string"
      ? plan.audience.description
      : "（未指定）";
  const purpose =
    typeof plan.purpose === "string" && plan.purpose.trim()
      ? plan.purpose.trim()
      : "explain";
  const topic = title;

  return [
    `本記事では「${topic}」について解説します。`,
    "",
    `対象読者は${audience}です。`,
    "",
    `目的は${purpose}です。`,
  ].join("\n");
}

function renderConclusion(plan) {
  const points = Array.isArray(plan.requiredPoints) ? plan.requiredPoints : [];
  const lines = ["以上が本記事の要点です。"];
  if (points.length > 0) {
    lines.push("");
    lines.push("必須観点:");
    for (const point of points) {
      lines.push(`- ${point}`);
    }
  }
  return lines.join("\n");
}

function renderClaimBlock(brief, claim) {
  const heading = knowledgeTitleForClaim(brief, claim.knowledgeId);
  const lines = [`## ${heading}`, ""];

  if (claim.usable) {
    lines.push(typeof claim.text === "string" ? claim.text : "");
  } else {
    lines.push(`> ${UNUSABLE_NOTE}`);
  }

  return lines.join("\n");
}

function renderClaims(brief) {
  const claims = Array.isArray(brief.claims) ? brief.claims : [];
  if (claims.length === 0) {
    return "";
  }
  return claims.map((claim) => renderClaimBlock(brief, claim)).join("\n\n");
}

function renderGapSection(brief) {
  const gaps = Array.isArray(brief.gaps) ? brief.gaps : [];
  if (gaps.length === 0) return null;

  const lines = ["## 注意事項", ""];
  for (const gap of gaps) {
    const message =
      gap && typeof gap.message === "string"
        ? gap.message
        : String(gap?.type || "");
    lines.push(`- ${message}`);
  }
  return lines.join("\n");
}

function renderMetadataComments(brief, plan) {
  const blocks = [];

  const planConstraints = Array.isArray(plan.constraints) ? plan.constraints : [];
  const briefConstraints = Array.isArray(brief.constraints)
    ? brief.constraints
    : [];
  const allConstraints = [];
  const seen = new Set();
  for (const item of [...planConstraints, ...briefConstraints]) {
    if (typeof item !== "string" || !item.trim()) continue;
    const value = item.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    allConstraints.push(value);
  }

  const constraintLines = ["<!--", "Constraints"];
  if (allConstraints.length === 0) {
    constraintLines.push("(none)");
  } else {
    for (const c of allConstraints) {
      constraintLines.push(`- ${c}`);
    }
  }
  constraintLines.push("-->");
  blocks.push(constraintLines.join("\n"));

  const stats = brief.statistics || {};
  const statLines = [
    "<!--",
    "Statistics",
    `Knowledge: ${stats.knowledgeCount ?? 0}`,
    `Claim: ${stats.claimCount ?? 0}`,
    `UsableClaim: ${stats.usableClaimCount ?? 0}`,
    `UnusableClaim: ${stats.unusableClaimCount ?? 0}`,
    `Evidence: ${stats.evidenceCount ?? 0}`,
    `StoryEvidence: ${stats.storyEvidenceCount ?? 0}`,
    `ConceptEvidence: ${stats.conceptEvidenceCount ?? 0}`,
    `PostEvidence: ${stats.postEvidenceCount ?? 0}`,
    `Gap: ${stats.gapCount ?? 0}`,
    `LowConfidence: ${stats.lowConfidenceCount ?? 0}`,
    `NonPublished: ${stats.nonPublishedCount ?? 0}`,
    `MinimumConfidence: ${stats.minimumConfidence}`,
    `MaximumConfidence: ${stats.maximumConfidence}`,
    `AverageConfidence: ${stats.averageConfidence}`,
    "-->",
  ];
  blocks.push(statLines.join("\n"));

  const snapshots = Array.isArray(brief.sourceSnapshot)
    ? brief.sourceSnapshot
    : [];
  const snapLines = ["<!--", "Source Snapshot"];
  if (snapshots.length === 0) {
    snapLines.push("(none)");
  } else {
    for (const snap of snapshots) {
      snapLines.push(`${snap.id}`);
      snapLines.push(`v${snap.version}`);
      snapLines.push(`status:${snap.status}`);
      snapLines.push(`updatedAt:${snap.updatedAt}`);
      snapLines.push("---");
    }
    if (snapLines[snapLines.length - 1] === "---") {
      snapLines.pop();
    }
  }
  snapLines.push("-->");
  blocks.push(snapLines.join("\n"));

  return blocks.join("\n\n");
}

function renderSection(section, role, brief, plan, title, claimsRendered) {
  const heading = `## ${section.label}`;
  if (role === "intro") {
    return `${heading}\n\n${renderIntroduction(plan, brief, title)}`;
  }
  if (role === "conclusion") {
    return `${heading}\n\n${renderConclusion(plan)}`;
  }
  if (claimsRendered.done) {
    return heading;
  }
  claimsRendered.done = true;
  const claimsMarkdown = renderClaims(brief);
  return claimsMarkdown ? `${heading}\n\n${claimsMarkdown}` : heading;
}

function renderLegacyMarkdown(brief, plan, title) {
  const structure = plan.structure;
  const parts = [`# ${title}`, ""];

  const claimsRendered = { done: false };
  let hasIntroSection = false;
  let hasConclusionSection = false;
  let hasBodySection = false;

  for (const section of structure) {
    if (isIntroSection(section)) {
      hasIntroSection = true;
    } else if (isConclusionSection(section)) {
      hasConclusionSection = true;
    } else {
      hasBodySection = true;
    }
  }

  if (!hasIntroSection) {
    parts.push(renderIntroduction(plan, brief, title));
    parts.push("");
  }

  for (const section of structure) {
    if (isIntroSection(section)) {
      parts.push(
        renderSection(section, "intro", brief, plan, title, claimsRendered)
      );
      parts.push("");
    } else if (isConclusionSection(section)) {
      if (!claimsRendered.done && !hasBodySection) {
        const claimsMarkdown = renderClaims(brief);
        if (claimsMarkdown) {
          parts.push(claimsMarkdown);
          parts.push("");
        }
        claimsRendered.done = true;
      }
      parts.push(
        renderSection(section, "conclusion", brief, plan, title, claimsRendered)
      );
      parts.push("");
    } else {
      parts.push(
        renderSection(section, "body", brief, plan, title, claimsRendered)
      );
      parts.push("");
    }
  }

  if (!claimsRendered.done) {
    const claimsMarkdown = renderClaims(brief);
    if (claimsMarkdown) {
      parts.push(claimsMarkdown);
      parts.push("");
    }
    claimsRendered.done = true;
  }

  if (!hasConclusionSection) {
    parts.push("## まとめ");
    parts.push("");
    parts.push(renderConclusion(plan));
    parts.push("");
  }

  const gaps = renderGapSection(brief);
  if (gaps) {
    parts.push(gaps);
    parts.push("");
  }

  parts.push(renderMetadataComments(brief, plan));
  parts.push("");

  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function renderStoryMarkdown(brief, plan, storiesInput) {
  const ctx = normalizeStoryContext(storiesInput, brief);
  if (!ctx || !hasRichStoryContent(ctx)) {
    return null;
  }

  const rendered = renderStoryArticle(ctx, plan, brief);
  if (!rendered) return null;

  // Prefer Plan.title when concrete (Pipeline syncs story title into Plan).
  const title = resolveArticleTitle(plan, brief, storiesInput);

  const parts = [`# ${title}`, "", rendered.bodyMarkdown, ""];

  const gaps = renderGapSection(brief);
  if (gaps) {
    parts.push(gaps);
    parts.push("");
  }

  parts.push(renderMetadataComments(brief, plan));
  parts.push("");

  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/**
 * Deterministic Markdown renderer. No AI.
 * @param {object} briefInput
 * @param {object} planInput
 * @param {object} [options]
 * @param {object|object[]|null} [options.stories] - optional stories.js JSON
 */
function renderMarkdown(briefInput, planInput, options = {}) {
  const validated = validateWriterInput(briefInput, planInput);
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }

  const { brief, plan } = validated;
  const storiesInput =
    options && Object.prototype.hasOwnProperty.call(options, "stories")
      ? options.stories
      : null;

  if (storiesInput != null) {
    const storyMd = renderStoryMarkdown(brief, plan, storiesInput);
    if (storyMd) return storyMd;
  }

  const title = resolveArticleTitle(plan, brief, null);
  return renderLegacyMarkdown(brief, plan, title);
}

module.exports = {
  DEFAULT_ARTICLE_TITLE,
  UNUSABLE_NOTE,
  validateWriterInput,
  renderMarkdown,
  renderIntroduction,
  renderClaims,
  renderGapSection,
  renderMetadataComments,
  renderSection,
  resolveArticleTitle,
  resolveContentTitle,
  resolveEditContext,
  isIntroSection,
  isConclusionSection,
  isGenericPlanTitle,
};
