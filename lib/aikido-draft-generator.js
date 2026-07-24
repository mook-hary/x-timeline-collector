/**
 * KP-002 — Aikido Draft Generator.
 * Deterministic templates → Editorial-compatible drafts (no AI, no auto-save).
 */
const DEFAULT_MAX_LENGTH = 280;

/**
 * @returns {object[]}
 */
function getDefaultAikidoTemplates() {
  return [
    {
      id: "principle-short",
      categories: [
        "principle",
        "mindset",
        "teaching",
        "etiquette",
        "history",
      ],
      build(knowledge, context) {
        const title = pickText(knowledge.title) || "合気道の原則";
        const summary =
          pickText(knowledge.summary) ||
          pickText(knowledge.content) ||
          title;
        const lines = [];
        lines.push(`【原則】${title}`);
        pushIf(lines, pickText(knowledge.summary));
        pushIf(lines, pickText(knowledge.content));
        return {
          title,
          summary: clipSummary(summary),
          body: lines.join("\n"),
          tags: mergeTags(knowledge, ["principle"]),
        };
      },
    },
    {
      id: "training-tip",
      categories: ["training"],
      build(knowledge, context) {
        const title = pickText(knowledge.title) || "稽古のヒント";
        const summary =
          pickText(knowledge.summary) ||
          pickText(knowledge.content) ||
          title;
        const lines = [];
        lines.push(`【稽古】${title}`);
        pushIf(lines, pickText(knowledge.summary));
        pushIf(lines, pickText(knowledge.content));
        if (knowledge.difficulty != null) {
          lines.push(`難易度: ${knowledge.difficulty}/5`);
        }
        return {
          title,
          summary: clipSummary(summary),
          body: lines.join("\n"),
          tags: mergeTags(knowledge, ["training"]),
        };
      },
    },
    {
      id: "experience-note",
      categories: ["experience"],
      build(knowledge, context) {
        const title = pickText(knowledge.title) || "稽古メモ";
        const summary =
          pickText(knowledge.summary) ||
          pickText(knowledge.content) ||
          title;
        const lines = [];
        lines.push(`【体験】${title}`);
        pushIf(lines, pickText(knowledge.summary));
        pushIf(lines, pickText(knowledge.content));
        return {
          title,
          summary: clipSummary(summary),
          body: lines.join("\n"),
          tags: mergeTags(knowledge, ["experience"]),
        };
      },
    },
    {
      id: "technique-point",
      categories: ["technique"],
      build(knowledge, context) {
        const title = pickText(knowledge.title) || "技のポイント";
        const summary =
          pickText(knowledge.summary) ||
          pickText(knowledge.content) ||
          title;
        const lines = [];
        lines.push(`【技】${title}`);
        pushIf(lines, pickText(knowledge.summary));
        pushIf(lines, pickText(knowledge.content));
        if (knowledge.difficulty != null) {
          lines.push(`難易度: ${knowledge.difficulty}/5`);
        }
        return {
          title,
          summary: clipSummary(summary),
          body: lines.join("\n"),
          tags: mergeTags(knowledge, ["technique"]),
        };
      },
    },
    {
      id: "injury-prevention",
      categories: ["injury-prevention"],
      build(knowledge, context) {
        const title = pickText(knowledge.title) || "安全のための注意";
        const summary =
          pickText(knowledge.summary) ||
          pickText(knowledge.content) ||
          title;
        const lines = [];
        lines.push(`【安全】${title}`);
        pushIf(lines, pickText(knowledge.summary));
        pushIf(lines, pickText(knowledge.content));
        return {
          title,
          summary: clipSummary(summary),
          body: lines.join("\n"),
          tags: mergeTags(knowledge, ["injury-prevention", "safety"]),
        };
      },
    },
  ];
}

function pickText(value) {
  if (value == null) return "";
  const s = String(value).trim();
  return s;
}

function pushIf(lines, text) {
  if (text) lines.push(text);
}

function clipSummary(text, max = 80) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return truncateJapanese(s, max);
}

function mergeTags(knowledge, extras) {
  const tags = [];
  const seen = new Set();
  const add = (t) => {
    const v = String(t == null ? "" : t).trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    tags.push(v);
  };
  if (Array.isArray(knowledge && knowledge.tags)) {
    for (const t of knowledge.tags) add(t);
  }
  for (const t of extras || []) add(t);
  if (knowledge && knowledge.category) add(knowledge.category);
  return tags;
}

/**
 * Prefer sentence boundaries; keep within maxLength including ellipsis.
 * @param {string} text
 * @param {number} maxLength
 */
function truncateJapanese(text, maxLength) {
  const value = String(text || "");
  const max = Number(maxLength);
  if (!Number.isFinite(max) || max < 0) {
    const err = new Error("maxLength must be a non-negative number");
    err.code = "aikido-draft-max-length";
    throw err;
  }
  if (value.length <= max) return value;
  if (max === 0) return "";

  const ellipsis = "…";
  if (max <= ellipsis.length) {
    return ellipsis.slice(0, max);
  }

  const budget = max - ellipsis.length;
  const head = value.slice(0, budget);
  const delimiters = ["。", "！", "？", "\n", ".", "!", "?"];
  let cut = -1;
  for (const d of delimiters) {
    const i = head.lastIndexOf(d);
    if (i > cut) cut = i;
  }
  const minKeep = Math.max(1, Math.floor(budget * 0.35));
  if (cut >= minKeep) {
    const ended = head.slice(0, cut + 1);
    // Clean sentence end: no ellipsis needed if still truncated from original
    if (ended.length <= max) return ended;
  }

  let trimmed = head.replace(/\s+$/u, "");
  if (!trimmed) {
    return (value.slice(0, budget) + ellipsis).slice(0, max);
  }
  let out = trimmed + ellipsis;
  if (out.length > max) {
    out = trimmed.slice(0, max - ellipsis.length) + ellipsis;
  }
  return out.slice(0, max);
}

function resolveNow(options = {}) {
  if (options.now != null) {
    const v =
      typeof options.now === "function" ? options.now() : options.now;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number") return new Date(v).toISOString();
    return String(v);
  }
  return new Date().toISOString();
}

function indexTemplates(templates) {
  const byId = new Map();
  for (const t of templates) {
    if (!t || !t.id || typeof t.build !== "function") {
      const err = new Error("invalid template definition");
      err.code = "aikido-draft-template";
      throw err;
    }
    if (byId.has(t.id)) {
      const err = new Error(`duplicate template id: ${t.id}`);
      err.code = "aikido-draft-template";
      throw err;
    }
    byId.set(t.id, t);
  }
  return byId;
}

/**
 * Deterministic template selection for a knowledge category.
 * @param {object} knowledge
 * @param {object[]} templates
 * @param {string} [templateId]
 */
function selectTemplate(knowledge, templates, templateId) {
  const byId = indexTemplates(templates);
  const category = knowledge && knowledge.category;

  if (templateId != null && String(templateId).trim()) {
    const id = String(templateId).trim();
    const template = byId.get(id);
    if (!template) {
      const err = new Error(`unknown templateId: ${id}`);
      err.code = "aikido-draft-template";
      throw err;
    }
    const cats = Array.isArray(template.categories) ? template.categories : [];
    if (!cats.includes(category)) {
      const err = new Error(
        `template "${id}" does not support category "${category}"`
      );
      err.code = "aikido-draft-template-category";
      throw err;
    }
    return template;
  }

  const compatible = templates
    .filter(
      (t) =>
        Array.isArray(t.categories) && t.categories.includes(category)
    )
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (compatible.length === 0) {
    const err = new Error(
      `no template available for category "${category}"`
    );
    err.code = "aikido-draft-template-category";
    throw err;
  }
  return compatible[0];
}

/**
 * @param {object} knowledge
 * @param {object} [options]
 */
function generateDraft(knowledge, options = {}) {
  if (!knowledge || typeof knowledge !== "object") {
    const err = new Error("knowledge must be an object");
    err.code = "aikido-draft-knowledge";
    throw err;
  }

  const templates =
    options.templates != null
      ? options.templates
      : getDefaultAikidoTemplates();
  const template = selectTemplate(
    knowledge,
    templates,
    options.templateId
  );
  const maxLength =
    options.maxLength == null ? DEFAULT_MAX_LENGTH : Number(options.maxLength);
  if (!Number.isFinite(maxLength) || maxLength < 0) {
    const err = new Error("maxLength must be a non-negative number");
    err.code = "aikido-draft-max-length";
    throw err;
  }

  const generatedAt = resolveNow(options);
  const built = template.build(knowledge, { generatedAt, options }) || {};
  const title = String(built.title == null ? "" : built.title);
  const summary = String(built.summary == null ? "" : built.summary);
  let body = String(built.body == null ? "" : built.body);
  body = truncateJapanese(body, maxLength);

  const tags = Array.isArray(built.tags)
    ? built.tags.map((t) => String(t))
    : mergeTags(knowledge, []);

  return {
    source: "aikido",
    type: "post",
    title,
    summary,
    body,
    tags,
    score: 0,
    status: "draft",
    metadata: {
      knowledgeId: knowledge.id != null ? String(knowledge.id) : null,
      knowledgeCategory:
        knowledge.category != null ? String(knowledge.category) : null,
      difficulty:
        knowledge.difficulty != null ? Number(knowledge.difficulty) : null,
      templateId: template.id,
      generatedAt,
    },
  };
}

/**
 * @param {object[]} knowledgeItems
 * @param {object} [options]
 */
function generateDrafts(knowledgeItems, options = {}) {
  const list = Array.isArray(knowledgeItems) ? knowledgeItems : [];
  let filtered = list.slice();

  if (options.category != null && String(options.category).trim()) {
    const category = String(options.category).trim();
    filtered = filtered.filter((k) => k && k.category === category);
  }
  if (options.difficulty != null && options.difficulty !== "") {
    const difficulty = Number(options.difficulty);
    filtered = filtered.filter((k) => k && k.difficulty === difficulty);
  }
  if (options.tag != null && String(options.tag).trim()) {
    const tag = String(options.tag).trim();
    filtered = filtered.filter(
      (k) => k && Array.isArray(k.tags) && k.tags.includes(tag)
    );
  }
  if (options.status != null && String(options.status).trim()) {
    const status = String(options.status).trim();
    filtered = filtered.filter((k) => k && k.status === status);
  }

  // Preserve input order (do not re-sort).
  const drafts = filtered.map((knowledge) =>
    generateDraft(knowledge, options)
  );

  if (options.limit == null) return drafts;
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 0) {
    const err = new Error("limit must be a non-negative integer");
    err.code = "aikido-draft-options";
    throw err;
  }
  return drafts.slice(0, limit);
}

module.exports = {
  DEFAULT_MAX_LENGTH,
  getDefaultAikidoTemplates,
  selectTemplate,
  truncateJapanese,
  generateDraft,
  generateDrafts,
};
