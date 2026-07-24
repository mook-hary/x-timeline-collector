/**
 * KP-001 — Aikido Knowledge Model.
 * Stores aikido knowledge (not prose drafts) under
 * .pipeline-work/knowledge/aikido/<id>.json
 * Independent from Editorial Store.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_DIR_REL = path.join(".pipeline-work", "knowledge", "aikido");
const DEFAULT_STATUS = "draft";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** @type {readonly string[]} */
const CATEGORIES = Object.freeze([
  "technique",
  "principle",
  "training",
  "mindset",
  "etiquette",
  "history",
  "teaching",
  "injury-prevention",
  "experience",
]);

const CATEGORY_SET = new Set(CATEGORIES);

/** Soft statuses for knowledge (no Workflow engine yet). */
const STATUSES = Object.freeze([
  "draft",
  "review",
  "published",
  "archived",
]);

const STATUS_SET = new Set(STATUSES);

function nowIso(nowFn) {
  if (typeof nowFn === "function") {
    const v = nowFn();
    return v instanceof Date ? v.toISOString() : String(v);
  }
  return new Date().toISOString();
}

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

function resolveStoreDir(rootDir) {
  return path.join(resolveRoot(rootDir), STORE_DIR_REL);
}

function validateId(id) {
  if (typeof id !== "string" || !id.trim()) {
    const err = new Error("id must be a non-empty string");
    err.code = "aikido-knowledge-id";
    throw err;
  }
  const value = id.trim();
  if (value === "." || value === "..") {
    const err = new Error(`invalid id: ${value}`);
    err.code = "aikido-knowledge-id";
    throw err;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    const err = new Error(`id must not contain path separators: ${value}`);
    err.code = "aikido-knowledge-id";
    throw err;
  }
  if (!ID_RE.test(value)) {
    const err = new Error(
      `id must be alphanumeric/hyphen/underscore (1–128 chars): ${value}`
    );
    err.code = "aikido-knowledge-id";
    throw err;
  }
  return value;
}

function generateId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `aikido-${stamp}-${rand}`;
}

function itemPath(storeDir, id) {
  return path.join(storeDir, `${validateId(id)}.json`);
}

function atomicWriteJson(filePath, data, deps = {}) {
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const renameSync = deps.renameSync || fs.renameSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;

  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (_cleanup) {
      // best-effort
    }
    const err = new Error(
      `failed to write aikido knowledge: ${error.message}`
    );
    err.code = "aikido-knowledge-io";
    err.cause = error;
    throw err;
  }
}

function readJsonFile(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return JSON.parse(String(readFileSync(filePath, "utf8")));
  } catch (error) {
    const err = new Error(`failed to read aikido knowledge: ${filePath}`);
    err.code = "aikido-knowledge-io";
    err.cause = error;
    throw err;
  }
}

function normalizeStringArray(value, fieldName) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    const err = new Error(`${fieldName} must be an array of strings`);
    err.code = "aikido-knowledge-validate";
    throw err;
  }
  return value.map((v) => String(v));
}

function normalizeCategory(category) {
  const value = String(category == null ? "" : category).trim();
  if (!CATEGORY_SET.has(value)) {
    const err = new Error(
      `category must be one of: ${CATEGORIES.join(", ")} (got ${category})`
    );
    err.code = "aikido-knowledge-category";
    throw err;
  }
  return value;
}

function normalizeDifficulty(difficulty) {
  if (difficulty == null) {
    const err = new Error("difficulty is required (integer 1–5)");
    err.code = "aikido-knowledge-difficulty";
    throw err;
  }
  if (typeof difficulty === "string" && difficulty.trim() !== "") {
    const asNum = Number(difficulty);
    if (!Number.isInteger(asNum)) {
      const err = new Error("difficulty must be an integer 1–5");
      err.code = "aikido-knowledge-difficulty";
      throw err;
    }
    return normalizeDifficulty(asNum);
  }
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    const err = new Error("difficulty must be an integer 1–5");
    err.code = "aikido-knowledge-difficulty";
    throw err;
  }
  return difficulty;
}

function normalizeStatus(status) {
  const value = String(status == null ? DEFAULT_STATUS : status).trim();
  if (!STATUS_SET.has(value)) {
    const err = new Error(
      `status must be one of: ${STATUSES.join(", ")} (got ${status})`
    );
    err.code = "aikido-knowledge-status";
    throw err;
  }
  return value;
}

function normalizeRelated(related) {
  const list = normalizeStringArray(related, "related");
  // Circular refs allowed; only validate id shape when non-empty.
  return list.map((id) => {
    const trimmed = String(id).trim();
    if (!trimmed) {
      const err = new Error("related ids must be non-empty strings");
      err.code = "aikido-knowledge-related";
      throw err;
    }
    return validateId(trimmed);
  });
}

/**
 * @param {object} input
 * @param {{ isCreate?: boolean, existing?: object, now?: string }} [opts]
 */
function normalizeKnowledge(input, opts = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const isCreate = opts.isCreate === true;
  const existing = opts.existing || null;
  const now = opts.now || new Date().toISOString();

  let id;
  if (isCreate) {
    id =
      raw.id != null && String(raw.id).trim()
        ? validateId(raw.id)
        : generateId();
  } else {
    id = validateId(existing.id);
  }

  const merged = isCreate ? { ...raw, id } : { ...existing, ...raw, id };

  const createdAt = isCreate
    ? now
    : (existing && existing.createdAt) || raw.createdAt || now;

  return {
    id,
    title: String(merged.title == null ? "" : merged.title),
    category: normalizeCategory(
      merged.category != null
        ? merged.category
        : existing && existing.category
    ),
    summary: String(merged.summary == null ? "" : merged.summary),
    content: String(merged.content == null ? "" : merged.content),
    tags: normalizeStringArray(
      merged.tags != null ? merged.tags : existing && existing.tags,
      "tags"
    ),
    difficulty: normalizeDifficulty(
      merged.difficulty != null
        ? merged.difficulty
        : existing && existing.difficulty
    ),
    sources: normalizeStringArray(
      merged.sources != null ? merged.sources : existing && existing.sources,
      "sources"
    ),
    related: normalizeRelated(
      merged.related != null ? merged.related : existing && existing.related
    ),
    status: normalizeStatus(
      merged.status != null ? merged.status : existing && existing.status
    ),
    createdAt,
    updatedAt: now,
  };
}

function ensureStoreDir(storeDir, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  mkdirSync(storeDir, { recursive: true });
}

function listItemFiles(storeDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort();
}

/**
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {string} [options.directory]
 * @param {function} [options.now]
 * @param {object} [options.deps]
 */
function createAikidoKnowledgeStore(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const storeDir =
    options.directory != null && String(options.directory).trim()
      ? path.resolve(String(options.directory).trim())
      : resolveStoreDir(rootDir);
  const deps = options.deps || {};
  const nowFn = options.now;

  function createKnowledge(entry) {
    const stamp = nowIso(nowFn);
    const record = normalizeKnowledge(entry, { isCreate: true, now: stamp });
    const filePath = itemPath(storeDir, record.id);
    const existsSync = deps.existsSync || fs.existsSync;
    if (existsSync(filePath)) {
      const err = new Error(`aikido knowledge already exists: ${record.id}`);
      err.code = "aikido-knowledge-exists";
      throw err;
    }
    ensureStoreDir(storeDir, deps);
    atomicWriteJson(filePath, record, deps);
    return { ...record };
  }

  function findKnowledge(id) {
    const safeId = validateId(id);
    const filePath = itemPath(storeDir, safeId);
    const existsSync = deps.existsSync || fs.existsSync;
    if (!existsSync(filePath)) return null;
    const raw = readJsonFile(filePath, deps);
    return { ...raw, id: safeId };
  }

  function updateKnowledge(id, patch) {
    const safeId = validateId(id);
    const existing = findKnowledge(safeId);
    if (!existing) {
      const err = new Error(`aikido knowledge not found: ${safeId}`);
      err.code = "aikido-knowledge-not-found";
      throw err;
    }
    if (patch && patch.id != null && String(patch.id).trim() !== safeId) {
      const err = new Error("id cannot be changed via updateKnowledge");
      err.code = "aikido-knowledge-validate";
      throw err;
    }
    const stamp = nowIso(nowFn);
    const record = normalizeKnowledge(
      { ...(patch || {}), id: safeId },
      { isCreate: false, existing, now: stamp }
    );
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  /**
   * @param {object} [listOptions]
   * @param {string} [listOptions.category]
   * @param {number} [listOptions.difficulty]
   * @param {string} [listOptions.tag]
   * @param {string} [listOptions.status]
   */
  function listKnowledge(listOptions = {}) {
    ensureStoreDir(storeDir, deps);
    const files = listItemFiles(storeDir, deps);
    const items = [];
    for (const name of files) {
      const id = name.replace(/\.json$/i, "");
      try {
        validateId(id);
      } catch (_error) {
        continue;
      }
      try {
        const raw = readJsonFile(path.join(storeDir, name), deps);
        items.push({ ...raw, id });
      } catch (_error) {
        // skip corrupt
      }
    }

    let filtered = items;
    if (listOptions.category != null && String(listOptions.category).trim()) {
      const category = normalizeCategory(listOptions.category);
      filtered = filtered.filter((item) => item.category === category);
    }
    if (listOptions.difficulty != null && listOptions.difficulty !== "") {
      const difficulty = normalizeDifficulty(listOptions.difficulty);
      filtered = filtered.filter((item) => item.difficulty === difficulty);
    }
    if (listOptions.tag != null && String(listOptions.tag).trim()) {
      const tag = String(listOptions.tag).trim();
      filtered = filtered.filter(
        (item) => Array.isArray(item.tags) && item.tags.includes(tag)
      );
    }
    if (listOptions.status != null && String(listOptions.status).trim()) {
      const status = normalizeStatus(listOptions.status);
      filtered = filtered.filter((item) => item.status === status);
    }

    filtered.sort((a, b) => {
      const ua = String(a.updatedAt || "");
      const ub = String(b.updatedAt || "");
      if (ua !== ub) return ub < ua ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    return filtered;
  }

  return {
    rootDir,
    storeDir,
    storeDirRel: STORE_DIR_REL,
    createKnowledge,
    updateKnowledge,
    findKnowledge,
    listKnowledge,
  };
}

module.exports = {
  STORE_DIR_REL,
  CATEGORIES,
  STATUSES,
  DEFAULT_STATUS,
  createAikidoKnowledgeStore,
  validateId,
  normalizeKnowledge,
  normalizeCategory,
  normalizeDifficulty,
  normalizeStatus,
  resolveStoreDir,
  resolveRoot,
};
