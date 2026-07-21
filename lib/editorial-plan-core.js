const { validateBrief, extractBriefPayload } = require("./brief-core");

const DEFAULT_PURPOSE = "explain";
const DEFAULT_FORMAT = "article";
const DEFAULT_LANGUAGE = "ja";
const DEFAULT_TITLE = "(untitled plan)";
const DEFAULT_TONE_STYLE = "clear";
const DEFAULT_FORMALITY = "neutral";
const DEFAULT_KNOWLEDGE_LEVEL = "unspecified";
const DEFAULT_LENGTH_UNIT = "characters";
const DEFAULT_LENGTH_TARGET = 1200;

const KNOWLEDGE_LEVELS = new Set([
  "beginner",
  "intermediate",
  "advanced",
  "expert",
  "unspecified",
]);

const FORMALITY_VALUES = new Set(["casual", "neutral", "formal"]);

const LENGTH_UNITS = new Set(["characters", "words"]);

const RECOMMENDED_FORMATS = new Set([
  "article",
  "explainer",
  "news-summary",
  "research-note",
  "internal-memo",
  "social-post",
  "outline",
]);

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function isIso8601(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function rejectControlOrEmpty(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} は空でない文字列である必要があります。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${fieldName} に制御文字は使えません。`);
  }
  return value.trim();
}

function validatePlanId(id) {
  return rejectControlOrEmpty(id, "Plan id");
}

function generatePlanId(now) {
  const stamp = nowIso(now).replace(/[:.]/g, "-");
  return `plan-${stamp}`;
}

function normalizeStringList(values, fieldName) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    throw new Error(`${fieldName} は配列である必要があります。`);
  }
  const seen = new Set();
  const out = [];
  for (const item of values) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${fieldName} に空文字は使えません。`);
    }
    if (/[\u0000-\u001f\u007f]/.test(item)) {
      throw new Error(`${fieldName} に制御文字は使えません。`);
    }
    const trimmed = item.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildDefaultStructure() {
  return [
    { id: "introduction", label: "導入", required: true },
    { id: "body", label: "本文", required: true },
    { id: "conclusion", label: "まとめ", required: true },
  ];
}

function slugSectionId(label, index) {
  const base = String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base) return base;
  return `section-${index + 1}`;
}

function buildStructureFromSections(sectionLabels) {
  const labels = normalizeStringList(sectionLabels, "structure sections");
  if (labels.length === 0) return buildDefaultStructure();

  const seen = new Set();
  const structure = [];
  for (let i = 0; i < labels.length; i++) {
    let id = slugSectionId(labels[i], i);
    let suffix = 2;
    while (seen.has(id)) {
      id = `${slugSectionId(labels[i], i)}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    structure.push({
      id,
      label: labels[i],
      required: true,
    });
  }
  return structure;
}

function validateStructure(structure) {
  const errors = [];
  if (!Array.isArray(structure) || structure.length === 0) {
    return { ok: false, errors: ["structure は空でない配列である必要があります。"] };
  }
  const seen = new Set();
  for (let i = 0; i < structure.length; i++) {
    const item = structure[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`structure[${i}] はオブジェクトである必要があります。`);
      continue;
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      errors.push(`structure[${i}].id は空でない文字列である必要があります。`);
    } else if (seen.has(item.id.trim())) {
      errors.push(`structure id が重複しています: ${item.id}`);
    } else {
      seen.add(item.id.trim());
    }
    if (typeof item.label !== "string" || !item.label.trim()) {
      errors.push(`structure[${i}].label は空でない文字列である必要があります。`);
    }
    if (typeof item.required !== "boolean") {
      errors.push(`structure[${i}].required は boolean である必要があります。`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateLength(length) {
  const errors = [];
  if (!length || typeof length !== "object" || Array.isArray(length)) {
    return { ok: false, errors: ["length はオブジェクトである必要があります。"] };
  }
  if (!LENGTH_UNITS.has(length.unit)) {
    errors.push('length.unit は "characters" または "words" である必要があります。');
  }
  for (const key of ["target", "minimum", "maximum"]) {
    if (length[key] == null) continue;
    const n = length[key];
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`length.${key} は 1 以上の整数である必要があります。`);
    }
  }
  if (length.target == null) {
    errors.push("length.target は必須です。");
  }
  const min = length.minimum != null ? length.minimum : length.target;
  const max = length.maximum != null ? length.maximum : length.target;
  const target = length.target;
  if (
    Number.isInteger(min) &&
    Number.isInteger(target) &&
    Number.isInteger(max) &&
    !(min <= target && target <= max)
  ) {
    errors.push("length は minimum ≤ target ≤ maximum である必要があります。");
  }
  return { ok: errors.length === 0, errors };
}

function normalizeLength(options = {}) {
  const unit =
    typeof options.lengthUnit === "string" && options.lengthUnit.trim()
      ? options.lengthUnit.trim()
      : DEFAULT_LENGTH_UNIT;
  if (!LENGTH_UNITS.has(unit)) {
    throw new Error('length unit は "characters" または "words" である必要があります。');
  }

  const parsePositiveInt = (value, name) => {
    if (value == null || value === "") return null;
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} は 1 以上の整数である必要があります。`);
      }
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${name} は 1 以上の整数である必要があります。`);
      }
      return n;
    }
    throw new Error(`${name} は 1 以上の整数である必要があります。`);
  };

  const target =
    parsePositiveInt(options.length, "length target") ?? DEFAULT_LENGTH_TARGET;
  const minimum = parsePositiveInt(options.minLength, "min-length");
  const maximum = parsePositiveInt(options.maxLength, "max-length");

  const length = {
    unit,
    target,
    minimum: minimum != null ? minimum : target,
    maximum: maximum != null ? maximum : target,
  };
  const checked = validateLength(length);
  if (!checked.ok) {
    throw new Error(checked.errors.join("\n"));
  }
  return length;
}

function normalizeEditorialPlanOptions(rawOptions = {}, brief = null) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};

  const purpose =
    typeof options.purpose === "string" && options.purpose.trim()
      ? rejectControlOrEmpty(options.purpose, "purpose")
      : DEFAULT_PURPOSE;

  let title = null;
  if (typeof options.title === "string" && options.title.trim()) {
    title = rejectControlOrEmpty(options.title, "title");
  } else if (brief && typeof brief.title === "string" && brief.title.trim()) {
    title = brief.title.trim();
  } else {
    title = DEFAULT_TITLE;
  }

  const audienceDescription =
    typeof options.audience === "string" && options.audience.trim()
      ? rejectControlOrEmpty(options.audience, "audience")
      : "（未指定）";

  const knowledgeLevel =
    typeof options.knowledgeLevel === "string" && options.knowledgeLevel.trim()
      ? options.knowledgeLevel.trim()
      : DEFAULT_KNOWLEDGE_LEVEL;
  if (!KNOWLEDGE_LEVELS.has(knowledgeLevel)) {
    throw new Error(
      `knowledgeLevel が不正です: ${knowledgeLevel}\n許可値: ${[...KNOWLEDGE_LEVELS].join(", ")}`
    );
  }

  let format =
    typeof options.format === "string" && options.format.trim()
      ? rejectControlOrEmpty(options.format, "format")
      : DEFAULT_FORMAT;
  // Recommended values preferred; custom non-empty strings allowed.
  void RECOMMENDED_FORMATS;

  const style =
    typeof options.tone === "string" && options.tone.trim()
      ? rejectControlOrEmpty(options.tone, "tone")
      : DEFAULT_TONE_STYLE;
  const formality =
    typeof options.formality === "string" && options.formality.trim()
      ? options.formality.trim()
      : DEFAULT_FORMALITY;
  if (!FORMALITY_VALUES.has(formality)) {
    throw new Error(
      `formality が不正です: ${formality}\n許可値: ${[...FORMALITY_VALUES].join(", ")}`
    );
  }

  const language =
    typeof options.language === "string" && options.language.trim()
      ? rejectControlOrEmpty(options.language, "language")
      : DEFAULT_LANGUAGE;

  const length = normalizeLength(options);

  let structure;
  if (Array.isArray(options.structure) && options.structure.length > 0) {
    structure = options.structure.map((item) => ({
      id: rejectControlOrEmpty(item.id, "structure.id"),
      label: rejectControlOrEmpty(item.label, "structure.label"),
      required: item.required !== false,
    }));
    const checked = validateStructure(structure);
    if (!checked.ok) throw new Error(checked.errors.join("\n"));
  } else if (Array.isArray(options.sections) && options.sections.length > 0) {
    structure = buildStructureFromSections(options.sections);
  } else {
    structure = buildDefaultStructure();
  }

  return {
    id:
      typeof options.id === "string" && options.id.trim()
        ? validatePlanId(options.id)
        : null,
    title,
    purpose,
    audience: {
      description: audienceDescription,
      knowledgeLevel,
    },
    format,
    tone: { style, formality },
    language,
    length,
    structure,
    requiredPoints: normalizeStringList(options.requiredPoints || [], "requiredPoints"),
    excludedPoints: normalizeStringList(options.excludedPoints || [], "excludedPoints"),
    constraints: normalizeStringList(options.constraints || [], "constraints"),
  };
}

function buildBriefReference(brief) {
  if (brief == null) return null;
  const validated = validateBrief(brief);
  if (!validated.ok) {
    throw new Error(`Brief が不正です:\n${validated.errors.join("\n")}`);
  }
  const b = validated.brief;
  return {
    id: b.id,
    generatedAt: b.generatedAt,
    title: b.title,
    knowledgeIds: (b.knowledge || []).map((k) => k.id),
  };
}

/**
 * Create an Editorial Plan. Does not mutate brief. Does not read Knowledge Base.
 */
function createEditorialPlan(options = {}, brief = null, context = {}) {
  let briefObject = null;
  if (brief != null) {
    if (typeof brief === "string") {
      throw new Error("brief はオブジェクトである必要があります（文字列は不可）。");
    }
    // Accept already-validated brief or wrapper-shaped objects via extract
    try {
      briefObject = extractBriefPayload(brief);
    } catch (_error) {
      // If extract fails but looks like a validated brief already, use as-is path
      briefObject = brief;
    }
    const checked = validateBrief(briefObject);
    if (!checked.ok) {
      throw new Error(`Brief が不正です:\n${checked.errors.join("\n")}`);
    }
    briefObject = checked.brief;
  }

  const normalized = normalizeEditorialPlanOptions(options, briefObject);
  const id = normalized.id || generatePlanId(context.now);
  const briefReference = briefObject ? buildBriefReference(briefObject) : null;

  const plan = {
    id,
    title: normalized.title,
    purpose: normalized.purpose,
    audience: normalized.audience,
    format: normalized.format,
    tone: normalized.tone,
    language: normalized.language,
    length: normalized.length,
    structure: normalized.structure,
    requiredPoints: normalized.requiredPoints,
    excludedPoints: normalized.excludedPoints,
    constraints: normalized.constraints,
    briefReference,
    createdAt: nowIso(context.now),
  };

  const validated = validateEditorialPlan(plan);
  if (!validated.ok) {
    throw new Error(validated.errors.join("\n"));
  }
  return validated.plan;
}

function validateEditorialPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      ok: false,
      plan: null,
      errors: ["Editorial Plan はオブジェクトである必要があります。"],
    };
  }

  // Forbidden content markers (facts / article body)
  for (const forbidden of ["knowledge", "claims", "evidence", "body", "article", "content"]) {
    if (Object.prototype.hasOwnProperty.call(plan, forbidden)) {
      errors.push(`Plan に ${forbidden} を含めてはいけません（事実・本文は Brief / Writer 側）。`);
    }
  }

  try {
    validatePlanId(plan.id);
  } catch (error) {
    errors.push(error.message);
  }

  if (typeof plan.title !== "string" || !plan.title.trim()) {
    errors.push("title は空でない文字列である必要があります。");
  }
  if (typeof plan.purpose !== "string" || !plan.purpose.trim()) {
    errors.push("purpose は空でない文字列である必要があります。");
  }

  if (!plan.audience || typeof plan.audience !== "object" || Array.isArray(plan.audience)) {
    errors.push("audience はオブジェクトである必要があります。");
  } else {
    if (
      typeof plan.audience.description !== "string" ||
      !plan.audience.description.trim()
    ) {
      errors.push("audience.description は空でない文字列である必要があります。");
    }
    if (!KNOWLEDGE_LEVELS.has(plan.audience.knowledgeLevel)) {
      errors.push(
        `audience.knowledgeLevel が不正です: ${plan.audience.knowledgeLevel}`
      );
    }
  }

  if (typeof plan.format !== "string" || !plan.format.trim()) {
    errors.push("format は空でない文字列である必要があります。");
  } else if (/[\u0000-\u001f\u007f]/.test(plan.format)) {
    errors.push("format に制御文字は使えません。");
  }

  if (!plan.tone || typeof plan.tone !== "object" || Array.isArray(plan.tone)) {
    errors.push("tone はオブジェクトである必要があります。");
  } else {
    if (typeof plan.tone.style !== "string" || !plan.tone.style.trim()) {
      errors.push("tone.style は空でない文字列である必要があります。");
    }
    if (!FORMALITY_VALUES.has(plan.tone.formality)) {
      errors.push(`tone.formality が不正です: ${plan.tone.formality}`);
    }
  }

  if (typeof plan.language !== "string" || !plan.language.trim()) {
    errors.push("language は空でない文字列である必要があります。");
  } else if (/[\u0000-\u001f\u007f]/.test(plan.language)) {
    errors.push("language に制御文字は使えません。");
  }

  const lengthCheck = validateLength(plan.length);
  if (!lengthCheck.ok) errors.push(...lengthCheck.errors);

  const structureCheck = validateStructure(plan.structure);
  if (!structureCheck.ok) errors.push(...structureCheck.errors);

  for (const key of ["requiredPoints", "excludedPoints", "constraints"]) {
    try {
      normalizeStringList(plan[key], key);
    } catch (error) {
      errors.push(error.message);
    }
    if (Array.isArray(plan[key])) {
      const seen = new Set();
      for (const item of plan[key]) {
        if (seen.has(item)) {
          errors.push(`${key} に重複があります: ${item}`);
        }
        seen.add(item);
      }
    }
  }

  if (plan.briefReference != null) {
    const ref = plan.briefReference;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      errors.push("briefReference はオブジェクトである必要があります。");
    } else {
      if (typeof ref.id !== "string" || !ref.id.trim()) {
        errors.push("briefReference.id は空でない文字列である必要があります。");
      }
      if (!isIso8601(ref.generatedAt)) {
        errors.push("briefReference.generatedAt は ISO8601 である必要があります。");
      }
    }
  }

  if (!isIso8601(plan.createdAt)) {
    errors.push("createdAt は ISO8601 である必要があります。");
  }

  if (errors.length > 0) {
    return { ok: false, plan: null, errors };
  }

  return {
    ok: true,
    plan: JSON.parse(JSON.stringify(plan)),
    errors: [],
  };
}

module.exports = {
  DEFAULT_PURPOSE,
  DEFAULT_FORMAT,
  DEFAULT_LANGUAGE,
  DEFAULT_TITLE,
  DEFAULT_TONE_STYLE,
  DEFAULT_FORMALITY,
  DEFAULT_KNOWLEDGE_LEVEL,
  DEFAULT_LENGTH_UNIT,
  DEFAULT_LENGTH_TARGET,
  KNOWLEDGE_LEVELS,
  FORMALITY_VALUES,
  LENGTH_UNITS,
  RECOMMENDED_FORMATS,
  createEditorialPlan,
  validateEditorialPlan,
  normalizeEditorialPlanOptions,
  buildBriefReference,
  normalizeStringList,
  buildDefaultStructure,
  buildStructureFromSections,
  validateLength,
  validateStructure,
  validatePlanId,
  generatePlanId,
};
