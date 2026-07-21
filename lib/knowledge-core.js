const path = require("path");
const { readJsonObjectRequired } = require("./pipeline-io");

const STATUS_FILE = path.join(__dirname, "..", "config", "knowledge-status.json");
const KNOWLEDGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Load status list + transitions.
 * Compatible with Task 025 string[] and Task 026 { id, transitionsTo }[].
 */
function loadKnowledgeStatusConfig() {
  const data = readJsonObjectRequired(STATUS_FILE, "Knowledge status 設定");
  if (!Array.isArray(data.statuses) || data.statuses.length === 0) {
    throw new Error("config/knowledge-status.json の statuses は空でない配列である必要があります。");
  }

  const statuses = [];
  const transitions = {};
  const seen = new Set();

  for (let i = 0; i < data.statuses.length; i++) {
    const entry = data.statuses[i];
    let id;
    let transitionsTo = [];

    if (typeof entry === "string") {
      id = entry.trim();
      transitionsTo = [];
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error(`config/knowledge-status.json の statuses[${i}].id が不正です。`);
      }
      id = entry.id.trim();
      if (entry.transitionsTo == null) {
        transitionsTo = [];
      } else if (!Array.isArray(entry.transitionsTo)) {
        throw new Error(
          `config/knowledge-status.json の statuses[${i}].transitionsTo は配列である必要があります。`
        );
      } else {
        transitionsTo = entry.transitionsTo.map((item, j) => {
          if (typeof item !== "string" || !item.trim()) {
            throw new Error(
              `config/knowledge-status.json の statuses[${i}].transitionsTo[${j}] が不正です。`
            );
          }
          return item.trim();
        });
      }
    } else {
      throw new Error(
        `config/knowledge-status.json の statuses[${i}] は文字列またはオブジェクトである必要があります。`
      );
    }

    if (!id) {
      throw new Error("config/knowledge-status.json の status id は空にできません。");
    }
    if (seen.has(id)) {
      throw new Error(`config/knowledge-status.json の status が重複しています: ${id}`);
    }
    seen.add(id);
    statuses.push(id);
    transitions[id] = transitionsTo;
  }

  for (const [from, targets] of Object.entries(transitions)) {
    for (const to of targets) {
      if (!seen.has(to)) {
        throw new Error(
          `config/knowledge-status.json の遷移先が不正です: ${from} → ${to}`
        );
      }
    }
  }

  const defaultStatus =
    typeof data.default === "string" && data.default.trim()
      ? data.default.trim()
      : statuses[0];
  if (!seen.has(defaultStatus)) {
    throw new Error(
      `config/knowledge-status.json の default (${defaultStatus}) が statuses に含まれていません。`
    );
  }

  return {
    defaultStatus,
    statuses,
    transitions,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function asRefArray(value, fieldName, errors) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} は配列である必要があります。`);
    return [];
  }
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") {
      if (!item.trim()) {
        errors.push(`${fieldName}[${i}] は空でない文字列参照である必要があります。`);
        continue;
      }
      out.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      // Compatibility: object refs normalize to identity strings.
      const identity =
        (typeof item.id === "string" && item.id.trim()) ||
        (typeof item.conceptKey === "string" && item.conceptKey.trim()) ||
        (typeof item.url === "string" && item.url.trim()) ||
        "";
      if (!identity) {
        errors.push(
          `${fieldName}[${i}] は id / conceptKey / url のいずれかを持つ参照である必要があります。`
        );
        continue;
      }
      out.push(identity);
      continue;
    }
    errors.push(`${fieldName}[${i}] は文字列または参照オブジェクトである必要があります。`);
  }
  return out;
}

function normalizeEvidence(raw, errors) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    errors.push("evidence はオブジェクトである必要があります。");
  }
  return {
    stories: asRefArray(source.stories, "evidence.stories", errors),
    concepts: asRefArray(source.concepts, "evidence.concepts", errors),
    posts: asRefArray(source.posts, "evidence.posts", errors),
  };
}

function dedupePreserveOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function evidenceCount(evidence) {
  return (
    (evidence.stories?.length || 0) +
    (evidence.concepts?.length || 0) +
    (evidence.posts?.length || 0)
  );
}

/**
 * Clone Knowledge with fresh nested arrays (no shared mutable refs).
 */
function cloneKnowledge(knowledge) {
  return {
    id: knowledge.id,
    title: knowledge.title,
    summary: knowledge.summary,
    status: knowledge.status,
    stories: [...(knowledge.stories || [])],
    concepts: [...(knowledge.concepts || [])],
    posts: [...(knowledge.posts || [])],
    createdAt: knowledge.createdAt,
    updatedAt: knowledge.updatedAt,
    confidence: knowledge.confidence,
    evidence: {
      stories: [...(knowledge.evidence?.stories || [])],
      concepts: [...(knowledge.evidence?.concepts || [])],
      posts: [...(knowledge.evidence?.posts || [])],
    },
    notes: knowledge.notes,
    version: knowledge.version,
  };
}

/**
 * Sync top-level stories/concepts/posts as aliases of evidence (SoT = evidence).
 */
function withSyncedAliases(knowledge) {
  const evidence = {
    stories: dedupePreserveOrder([...(knowledge.evidence?.stories || [])]),
    concepts: dedupePreserveOrder([...(knowledge.evidence?.concepts || [])]),
    posts: dedupePreserveOrder([...(knowledge.evidence?.posts || [])]),
  };
  return {
    ...knowledge,
    evidence,
    stories: [...evidence.stories],
    concepts: [...evidence.concepts],
    posts: [...evidence.posts],
  };
}

/**
 * Create a Knowledge Object draft (pure). Does not persist.
 */
function createKnowledge(input = {}, options = {}) {
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const timestamp = options.now || nowIso();
  const errors = [];

  const evidence = normalizeEvidence(input.evidence, errors);
  const stories = dedupePreserveOrder([
    ...asRefArray(input.stories, "stories", errors),
    ...evidence.stories,
  ]);
  const concepts = dedupePreserveOrder([
    ...asRefArray(input.concepts, "concepts", errors),
    ...evidence.concepts,
  ]);
  const posts = dedupePreserveOrder([
    ...asRefArray(input.posts, "posts", errors),
    ...evidence.posts,
  ]);

  const syncedEvidence = {
    stories: [...stories],
    concepts: [...concepts],
    posts: [...posts],
  };

  let confidence = 0;
  if (input.confidence != null) {
    confidence = Number(input.confidence);
  }

  const knowledge = {
    id: input.id == null ? "" : String(input.id).trim(),
    title: input.title == null ? "" : String(input.title).trim(),
    summary: input.summary == null ? "" : String(input.summary),
    status:
      input.status == null || input.status === ""
        ? statusConfig.defaultStatus
        : String(input.status).trim(),
    stories: [...syncedEvidence.stories],
    concepts: [...syncedEvidence.concepts],
    posts: [...syncedEvidence.posts],
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp,
    confidence,
    evidence: syncedEvidence,
    notes: input.notes == null ? "" : String(input.notes),
    version: input.version == null ? 1 : Number(input.version),
  };

  if (errors.length > 0) {
    const err = new Error(errors.join("\n"));
    err.validation = { ok: false, knowledge: null, errors };
    throw err;
  }

  const validated = validateKnowledge(knowledge, { statusConfig });
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }

  return cloneKnowledge(validated.knowledge);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Validate a Knowledge Object.
 * Source of Truth for refs: evidence.*; top-level arrays are aliases and must match when both present.
 */
function validateKnowledge(raw, options = {}) {
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const errors = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, knowledge: null, errors: ["Knowledge はオブジェクトである必要があります。"] };
  }

  if (typeof raw.id !== "string" || !raw.id.trim()) {
    errors.push("id は空でない文字列である必要があります。");
  } else if (!KNOWLEDGE_ID_RE.test(raw.id.trim())) {
    errors.push(
      `id が不正です: ${raw.id}\n英数字・ハイフン・アンダースコアのみ（先頭は英数字）を使ってください。`
    );
  }

  if (typeof raw.title !== "string" || !raw.title.trim()) {
    errors.push("title は空でない文字列である必要があります。");
  }

  if (typeof raw.summary !== "string") {
    errors.push("summary は文字列である必要があります（空文字可）。");
  }

  if (typeof raw.status !== "string" || !statusConfig.statuses.includes(raw.status)) {
    errors.push(
      `status が不正です: ${raw.status}\n許可値: ${statusConfig.statuses.join(", ")}`
    );
  }

  const hasEvidenceObject =
    raw.evidence != null && typeof raw.evidence === "object" && !Array.isArray(raw.evidence);
  const evidence = normalizeEvidence(raw.evidence, errors);
  const stories = asRefArray(raw.stories, "stories", errors);
  const concepts = asRefArray(raw.concepts, "concepts", errors);
  const posts = asRefArray(raw.posts, "posts", errors);

  const hasTopStories = Array.isArray(raw.stories);
  const hasTopConcepts = Array.isArray(raw.concepts);
  const hasTopPosts = Array.isArray(raw.posts);
  const hasEvStories = hasEvidenceObject && Array.isArray(raw.evidence.stories);
  const hasEvConcepts = hasEvidenceObject && Array.isArray(raw.evidence.concepts);
  const hasEvPosts = hasEvidenceObject && Array.isArray(raw.evidence.posts);

  if (hasTopStories && hasEvStories && !arraysEqual(dedupePreserveOrder(stories), dedupePreserveOrder(evidence.stories))) {
    errors.push("stories と evidence.stories が一致しません（evidence が正本です）。");
  }
  if (hasTopConcepts && hasEvConcepts && !arraysEqual(dedupePreserveOrder(concepts), dedupePreserveOrder(evidence.concepts))) {
    errors.push("concepts と evidence.concepts が一致しません（evidence が正本です）。");
  }
  if (hasTopPosts && hasEvPosts && !arraysEqual(dedupePreserveOrder(posts), dedupePreserveOrder(evidence.posts))) {
    errors.push("posts と evidence.posts が一致しません（evidence が正本です）。");
  }

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    errors.push("confidence は 0〜100 の数値である必要があります。");
  }

  if (typeof raw.notes !== "string") {
    errors.push("notes は文字列である必要があります（空文字可）。");
  }

  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    errors.push("version は 1 以上の整数である必要があります。");
  }

  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    errors.push("createdAt は有効な ISO8601 文字列である必要があります。");
  }

  if (typeof raw.updatedAt !== "string" || Number.isNaN(Date.parse(raw.updatedAt))) {
    errors.push("updatedAt は有効な ISO8601 文字列である必要があります。");
  }

  if (
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string" &&
    !Number.isNaN(Date.parse(raw.createdAt)) &&
    !Number.isNaN(Date.parse(raw.updatedAt)) &&
    Date.parse(raw.createdAt) > Date.parse(raw.updatedAt)
  ) {
    errors.push("createdAt は updatedAt より後であってはなりません。");
  }

  if (errors.length > 0) {
    return { ok: false, knowledge: null, errors };
  }

  const finalEvidence = {
    stories: hasEvStories ? dedupePreserveOrder(evidence.stories) : dedupePreserveOrder(stories),
    concepts: hasEvConcepts ? dedupePreserveOrder(evidence.concepts) : dedupePreserveOrder(concepts),
    posts: hasEvPosts ? dedupePreserveOrder(evidence.posts) : dedupePreserveOrder(posts),
  };

  const synced = withSyncedAliases({
    id: raw.id.trim(),
    title: raw.title.trim(),
    summary: raw.summary,
    status: raw.status,
    stories: finalEvidence.stories,
    concepts: finalEvidence.concepts,
    posts: finalEvidence.posts,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    confidence,
    evidence: finalEvidence,
    notes: raw.notes,
    version,
  });

  return { ok: true, knowledge: synced, errors: [] };
}

/**
 * Accept pure Knowledge Object or Workflow wrapper `{ knowledge, operation }`.
 */
function extractKnowledgePayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("入力はオブジェクトである必要があります。");
  }

  const hasWrapperKnowledge =
    Object.prototype.hasOwnProperty.call(data, "knowledge") &&
    data.knowledge &&
    typeof data.knowledge === "object" &&
    !Array.isArray(data.knowledge);

  if (hasWrapperKnowledge) {
    return data.knowledge;
  }

  if (typeof data.id === "string" && typeof data.title === "string") {
    return data;
  }

  throw new Error(
    "Knowledge Object、または { knowledge, operation } 形式を指定してください。"
  );
}

function parseKnowledgeInput(text, options = {}) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (error) {
    throw new Error(`Knowledge JSON の解析に失敗しました: ${error.message}`);
  }
  const payload = extractKnowledgePayload(data);
  const validated = validateKnowledge(payload, options);
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }
  return cloneKnowledge(validated.knowledge);
}

function deserializeKnowledge(text, options = {}) {
  return parseKnowledgeInput(text, options);
}

function serializeKnowledge(knowledge, options = {}) {
  const validated = validateKnowledge(knowledge, options);
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }
  const space = options.pretty === false ? 0 : 2;
  return `${JSON.stringify(validated.knowledge, null, space)}\n`;
}

module.exports = {
  STATUS_FILE,
  KNOWLEDGE_ID_RE,
  loadKnowledgeStatusConfig,
  createKnowledge,
  validateKnowledge,
  serializeKnowledge,
  deserializeKnowledge,
  parseKnowledgeInput,
  extractKnowledgePayload,
  cloneKnowledge,
  withSyncedAliases,
  evidenceCount,
  nowIso,
};
