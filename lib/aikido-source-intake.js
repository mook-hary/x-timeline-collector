/**
 * KP-003 — Aikido Source Intake.
 * Stores raw aikido source materials (not yet knowledge) under
 * .pipeline-work/sources/aikido/<id>.json
 * No network I/O. Independent from Knowledge / Editorial.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const STORE_DIR_REL = path.join(".pipeline-work", "sources", "aikido");
const DEFAULT_STATUS = "collected";
const DEFAULT_LANGUAGE = "ja";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** @type {readonly string[]} */
const SOURCE_TYPES = Object.freeze([
  "official-site",
  "article",
  "book",
  "paper",
  "video",
  "podcast",
  "dojo-site",
  "interview",
  "training-note",
  "personal-experience",
  "other",
]);

const SOURCE_TYPE_SET = new Set(SOURCE_TYPES);

/** @type {readonly string[]} */
const STATUSES = Object.freeze([
  "collected",
  "reviewing",
  "processed",
  "rejected",
  "archived",
]);

const STATUS_SET = new Set(STATUSES);

const ALLOWED_TRANSITIONS = Object.freeze({
  collected: Object.freeze(["reviewing", "rejected"]),
  reviewing: Object.freeze(["processed", "rejected"]),
  processed: Object.freeze(["archived"]),
  rejected: Object.freeze(["archived"]),
  archived: Object.freeze([]),
});

const TRACKING_QUERY_KEYS = new Set(["fbclid", "gclid"]);

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
    err.code = "aikido-source-id";
    throw err;
  }
  const value = id.trim();
  if (value === "." || value === "..") {
    const err = new Error(`invalid id: ${value}`);
    err.code = "aikido-source-id";
    throw err;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    const err = new Error(`id must not contain path separators: ${value}`);
    err.code = "aikido-source-id";
    throw err;
  }
  if (!ID_RE.test(value)) {
    const err = new Error(
      `id must be alphanumeric/hyphen/underscore (1–128 chars): ${value}`
    );
    err.code = "aikido-source-id";
    throw err;
  }
  return value;
}

function generateId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `src-${stamp}-${rand}`;
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
    const err = new Error(`failed to write aikido source: ${error.message}`);
    err.code = "aikido-source-io";
    err.cause = error;
    throw err;
  }
}

function readJsonFile(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return JSON.parse(String(readFileSync(filePath, "utf8")));
  } catch (error) {
    const err = new Error(`failed to read aikido source: ${filePath}`);
    err.code = "aikido-source-io";
    err.cause = error;
    throw err;
  }
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function normalizeStringArray(value, fieldName) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    const err = new Error(`${fieldName} must be an array of strings`);
    err.code = "aikido-source-validate";
    throw err;
  }
  return value.map((v) => String(v));
}

function normalizeSourceType(sourceType) {
  const value = String(sourceType == null ? "" : sourceType).trim();
  if (!SOURCE_TYPE_SET.has(value)) {
    const err = new Error(
      `sourceType must be one of: ${SOURCE_TYPES.join(", ")} (got ${sourceType})`
    );
    err.code = "aikido-source-type";
    throw err;
  }
  return value;
}

function normalizeStatus(status) {
  const value = String(status == null ? DEFAULT_STATUS : status).trim();
  if (!STATUS_SET.has(value)) {
    const err = new Error(
      `status must be one of: ${STATUSES.join(", ")} (got ${status})`
    );
    err.code = "aikido-source-status";
    throw err;
  }
  return value;
}

function assertTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (from === to) return { from, to };
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const err = new Error(`invalid status transition: ${from} → ${to}`);
    err.code = "aikido-source-transition";
    err.from = from;
    err.to = to;
    throw err;
  }
  return { from, to };
}

/**
 * Normalize URL for duplicate detection.
 * - trim
 * - drop fragment
 * - drop trailing slash (except root path)
 * - drop utm_*, fbclid, gclid
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  if (isBlank(url)) return "";
  let raw = String(url).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    // Relative / non-URL strings: still apply light normalization.
    raw = raw.replace(/#.*$/, "");
    raw = raw.replace(/\/+$/, "");
    return raw.toLowerCase();
  }

  parsed.hash = "";
  const params = parsed.searchParams;
  const keys = [...params.keys()];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_QUERY_KEYS.has(lower)) {
      params.delete(key);
    }
  }
  // Rebuild search to stable order
  const entries = [...params.entries()].sort((a, b) => {
    if (a[0] === b[0]) return String(a[1]).localeCompare(String(b[1]));
    return a[0].localeCompare(b[0]);
  });
  parsed.search = "";
  for (const [k, v] of entries) {
    parsed.searchParams.append(k, v);
  }

  let pathname = parsed.pathname || "/";
  if (pathname.length > 1) {
    pathname = pathname.replace(/\/+$/, "");
  }
  parsed.pathname = pathname || "/";

  // Hostname lower-case; keep protocol as-is from URL parser
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

function normalizeOptionalUrl(url) {
  if (isBlank(url)) return "";
  const trimmed = String(url).trim();
  // Keep original stored URL (trimmed); normalized form used for dedupe.
  return trimmed;
}

function normalizeRelatedKnowledgeIds(ids) {
  const list = normalizeStringArray(ids, "relatedKnowledgeIds");
  return list.map((id) => {
    const trimmed = String(id).trim();
    if (!trimmed) {
      const err = new Error("relatedKnowledgeIds must be non-empty strings");
      err.code = "aikido-source-related";
      throw err;
    }
    return trimmed;
  });
}

function normalizeMetadata(metadata) {
  if (metadata == null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    const err = new Error("metadata must be an object");
    err.code = "aikido-source-validate";
    throw err;
  }
  return { ...metadata };
}

function assertEvidencePresent(record) {
  if (
    isBlank(record.url) &&
    isBlank(record.rawText) &&
    isBlank(record.notes)
  ) {
    const err = new Error(
      "at least one of url, rawText, or notes is required"
    );
    err.code = "aikido-source-evidence";
    throw err;
  }
}

/**
 * @param {object} input
 * @param {{ isCreate?: boolean, existing?: object, now?: string }} [opts]
 */
function normalizeSource(input, opts = {}) {
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

  let status;
  if (isCreate) {
    if (raw.status != null && String(raw.status).trim() !== DEFAULT_STATUS) {
      const err = new Error(
        `new sources must start as "${DEFAULT_STATUS}"`
      );
      err.code = "aikido-source-status";
      throw err;
    }
    status = DEFAULT_STATUS;
  } else if (raw.status != null) {
    assertTransition(existing.status, raw.status);
    status = normalizeStatus(raw.status);
  } else {
    status = normalizeStatus(existing.status);
  }

  const record = {
    id,
    sourceType: normalizeSourceType(
      merged.sourceType != null
        ? merged.sourceType
        : existing && existing.sourceType
    ),
    title: String(merged.title == null ? "" : merged.title).trim(),
    url: normalizeOptionalUrl(
      merged.url != null ? merged.url : existing && existing.url
    ),
    author: String(
      merged.author != null
        ? merged.author
        : (existing && existing.author) || ""
    ),
    publisher: String(
      merged.publisher != null
        ? merged.publisher
        : (existing && existing.publisher) || ""
    ),
    publishedAt: String(
      merged.publishedAt != null
        ? merged.publishedAt
        : (existing && existing.publishedAt) || ""
    ),
    accessedAt: String(
      merged.accessedAt != null
        ? merged.accessedAt
        : (existing && existing.accessedAt) || ""
    ),
    language: String(
      merged.language != null
        ? merged.language
        : (existing && existing.language) || DEFAULT_LANGUAGE
    ).trim() || DEFAULT_LANGUAGE,
    rawText: String(
      merged.rawText != null
        ? merged.rawText
        : (existing && existing.rawText) || ""
    ),
    summary: String(
      merged.summary != null
        ? merged.summary
        : (existing && existing.summary) || ""
    ),
    notes: String(
      merged.notes != null ? merged.notes : (existing && existing.notes) || ""
    ),
    tags: normalizeStringArray(
      merged.tags != null ? merged.tags : existing && existing.tags,
      "tags"
    ),
    status,
    relatedKnowledgeIds: normalizeRelatedKnowledgeIds(
      merged.relatedKnowledgeIds != null
        ? merged.relatedKnowledgeIds
        : existing && existing.relatedKnowledgeIds
    ),
    metadata: normalizeMetadata(
      merged.metadata != null
        ? merged.metadata
        : existing && existing.metadata
    ),
    createdAt,
    updatedAt: now,
  };

  if (isBlank(record.title)) {
    const err = new Error("title is required");
    err.code = "aikido-source-validate";
    throw err;
  }
  assertEvidencePresent(record);
  if (record.url) {
    // Validate URL can be normalized when present
    normalizeUrl(record.url);
  }
  return record;
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
function createAikidoSourceIntake(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const storeDir =
    options.directory != null && String(options.directory).trim()
      ? path.resolve(String(options.directory).trim())
      : resolveStoreDir(rootDir);
  const deps = options.deps || {};
  const nowFn = options.now;

  function loadAll() {
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
    // Stable order: createdAt ascending (intake / registration order), then id.
    items.sort((a, b) => {
      const ca = String(a.createdAt || "");
      const cb = String(b.createdAt || "");
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    return items;
  }

  function findDuplicateByNormalizedUrl(normalized, excludeId) {
    if (!normalized) return null;
    for (const item of loadAll()) {
      if (excludeId && item.id === excludeId) continue;
      if (!item.url) continue;
      if (normalizeUrl(item.url) === normalized) return item;
    }
    return null;
  }

  function createSource(input) {
    const stamp = nowIso(nowFn);
    const rawInput = input && typeof input === "object" ? { ...input } : {};
    const allowDuplicateUrl = !!rawInput.allowDuplicateUrl;
    delete rawInput.allowDuplicateUrl;

    const record = normalizeSource(rawInput, { isCreate: true, now: stamp });
    const filePath = itemPath(storeDir, record.id);
    const existsSync = deps.existsSync || fs.existsSync;
    if (existsSync(filePath)) {
      const err = new Error(`aikido source already exists: ${record.id}`);
      err.code = "aikido-source-exists";
      throw err;
    }

    if (record.url && !allowDuplicateUrl) {
      const dup = findDuplicateByNormalizedUrl(normalizeUrl(record.url), null);
      if (dup) {
        const err = new Error(
          `duplicate source URL (normalized matches ${dup.id})`
        );
        err.code = "aikido-source-duplicate-url";
        err.existingId = dup.id;
        throw err;
      }
    }

    ensureStoreDir(storeDir, deps);
    atomicWriteJson(filePath, record, deps);
    return { ...record };
  }

  function findSource(id) {
    const safeId = validateId(id);
    const filePath = itemPath(storeDir, safeId);
    const existsSync = deps.existsSync || fs.existsSync;
    if (!existsSync(filePath)) return null;
    const raw = readJsonFile(filePath, deps);
    return { ...raw, id: safeId };
  }

  function updateSource(id, patch) {
    const safeId = validateId(id);
    const existing = findSource(safeId);
    if (!existing) {
      const err = new Error(`aikido source not found: ${safeId}`);
      err.code = "aikido-source-not-found";
      throw err;
    }
    if (patch && patch.id != null && String(patch.id).trim() !== safeId) {
      const err = new Error("id cannot be changed via updateSource");
      err.code = "aikido-source-validate";
      throw err;
    }

    const allowDuplicateUrl = !!(patch && patch.allowDuplicateUrl);
    const safePatch = { ...(patch || {}) };
    delete safePatch.allowDuplicateUrl;

    const stamp = nowIso(nowFn);
    const record = normalizeSource(safePatch, {
      isCreate: false,
      existing,
      now: stamp,
    });

    if (record.url && !allowDuplicateUrl) {
      const dup = findDuplicateByNormalizedUrl(
        normalizeUrl(record.url),
        safeId
      );
      if (dup) {
        const err = new Error(
          `duplicate source URL (normalized matches ${dup.id})`
        );
        err.code = "aikido-source-duplicate-url";
        err.existingId = dup.id;
        throw err;
      }
    }

    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  /**
   * @param {object} [listOptions]
   */
  function listSources(listOptions = {}) {
    let items = loadAll();

    if (listOptions.sourceType != null && String(listOptions.sourceType).trim()) {
      const sourceType = normalizeSourceType(listOptions.sourceType);
      items = items.filter((s) => s.sourceType === sourceType);
    }
    if (listOptions.status != null && String(listOptions.status).trim()) {
      const status = normalizeStatus(listOptions.status);
      items = items.filter((s) => s.status === status);
    }
    if (listOptions.tag != null && String(listOptions.tag).trim()) {
      const tag = String(listOptions.tag).trim();
      items = items.filter(
        (s) => Array.isArray(s.tags) && s.tags.includes(tag)
      );
    }
    if (listOptions.language != null && String(listOptions.language).trim()) {
      const language = String(listOptions.language).trim();
      items = items.filter((s) => s.language === language);
    }
    if (listOptions.author != null && String(listOptions.author).trim()) {
      const author = String(listOptions.author).trim();
      items = items.filter((s) => s.author === author);
    }
    if (
      listOptions.publisher != null &&
      String(listOptions.publisher).trim()
    ) {
      const publisher = String(listOptions.publisher).trim();
      items = items.filter((s) => s.publisher === publisher);
    }
    if (listOptions.hasUrl === true) {
      items = items.filter((s) => !isBlank(s.url));
    } else if (listOptions.hasUrl === false) {
      items = items.filter((s) => isBlank(s.url));
    }
    if (listOptions.hasRawText === true) {
      items = items.filter((s) => !isBlank(s.rawText));
    } else if (listOptions.hasRawText === false) {
      items = items.filter((s) => isBlank(s.rawText));
    }

    return items;
  }

  /**
   * Mark source as processed and attach related knowledge ids.
   * Does not create Knowledge records.
   */
  function markProcessed(id, markOptions = {}) {
    const safeId = validateId(id);
    const existing = findSource(safeId);
    if (!existing) {
      const err = new Error(`aikido source not found: ${safeId}`);
      err.code = "aikido-source-not-found";
      throw err;
    }

    const knowledgeIds = normalizeRelatedKnowledgeIds(
      markOptions.knowledgeIds != null
        ? markOptions.knowledgeIds
        : existing.relatedKnowledgeIds
    );

    // Allow collected → reviewing → processed, or reviewing → processed.
    // If still collected, move via reviewing then processed in one call.
    let status = existing.status;
    if (status === "collected") {
      assertTransition(status, "reviewing");
      status = "reviewing";
    }
    assertTransition(status, "processed");

    const stamp = nowIso(nowFn);
    const record = {
      ...existing,
      id: safeId,
      status: "processed",
      relatedKnowledgeIds: knowledgeIds,
      updatedAt: stamp,
    };
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  return {
    rootDir,
    storeDir,
    storeDirRel: STORE_DIR_REL,
    createSource,
    updateSource,
    findSource,
    listSources,
    markProcessed,
  };
}

module.exports = {
  STORE_DIR_REL,
  SOURCE_TYPES,
  STATUSES,
  DEFAULT_STATUS,
  DEFAULT_LANGUAGE,
  ALLOWED_TRANSITIONS,
  createAikidoSourceIntake,
  normalizeUrl,
  normalizeSource,
  normalizeSourceType,
  normalizeStatus,
  assertTransition,
  validateId,
  resolveStoreDir,
  resolveRoot,
};
