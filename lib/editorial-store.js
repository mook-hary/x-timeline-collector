/**
 * EP-049 — Editorial Content Store.
 * EP-050 — Editorial Workflow (draft → … → archived).
 * Shared content records for news / aikido / future bots.
 * One JSON file per item under .pipeline-work/editorial/<id>.json
 * Not wired into Morning Pipeline (foundation only).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { findSimilarItems } = require("./editorial-similarity");
const {
  evaluateRules,
  getDefaultRules,
} = require("./editorial-rules");
const { rankItems, calculateRanking } = require("./editorial-ranking");

const STORE_DIR_REL = path.join(".pipeline-work", "editorial");
const ALLOWED_TYPES = new Set(["article", "post"]);
const DEFAULT_STATUS = "draft";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** @type {readonly string[]} */
const WORKFLOW_STATUSES = Object.freeze([
  "draft",
  "review",
  "approved",
  "scheduled",
  "published",
  "archived",
]);

const WORKFLOW_STATUS_SET = new Set(WORKFLOW_STATUSES);

/** Allowed next statuses keyed by current status. */
const ALLOWED_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["review"]),
  review: Object.freeze(["draft", "approved"]),
  approved: Object.freeze(["draft", "scheduled", "published"]),
  scheduled: Object.freeze(["approved", "published"]),
  published: Object.freeze(["archived"]),
  archived: Object.freeze(["draft"]),
});

/** Status → timestamp field set on transition into that status. */
const STATUS_TIMESTAMP_FIELD = Object.freeze({
  review: "reviewedAt",
  approved: "approvedAt",
  scheduled: "scheduledAt",
  published: "publishedAt",
  archived: "archivedAt",
});

const WORKFLOW_TIMESTAMP_FIELDS = Object.freeze([
  "reviewedAt",
  "approvedAt",
  "scheduledAt",
  "publishedAt",
  "archivedAt",
]);

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
    err.code = "editorial-id";
    throw err;
  }
  const value = id.trim();
  if (value === "." || value === "..") {
    const err = new Error(`invalid id: ${value}`);
    err.code = "editorial-id";
    throw err;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    const err = new Error(`id must not contain path separators: ${value}`);
    err.code = "editorial-id";
    throw err;
  }
  if (!ID_RE.test(value)) {
    const err = new Error(
      `id must be alphanumeric/hyphen/underscore (1–128 chars): ${value}`
    );
    err.code = "editorial-id";
    throw err;
  }
  return value;
}

function generateId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `ed-${stamp}-${rand}`;
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
    const err = new Error(`failed to write editorial item: ${error.message}`);
    err.code = "editorial-io";
    err.cause = error;
    throw err;
  }
}

function readJsonFile(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return JSON.parse(String(readFileSync(filePath, "utf8")));
  } catch (error) {
    const err = new Error(`failed to read editorial item: ${filePath}`);
    err.code = "editorial-io";
    err.cause = error;
    throw err;
  }
}

function normalizeTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) {
    const err = new Error("tags must be an array of strings");
    err.code = "editorial-validate";
    throw err;
  }
  return tags.map((t) => String(t));
}

function normalizeScore(score) {
  if (score == null) return 0;
  const n = Number(score);
  if (!Number.isFinite(n)) {
    const err = new Error("score must be a finite number");
    err.code = "editorial-validate";
    throw err;
  }
  return n;
}

function normalizeType(type) {
  const value = String(type || "").trim();
  if (!ALLOWED_TYPES.has(value)) {
    const err = new Error(`type must be "article" or "post" (got ${type})`);
    err.code = "editorial-validate";
    throw err;
  }
  return value;
}

function normalizeSource(source) {
  const value = String(source == null ? "" : source).trim();
  if (!value) {
    const err = new Error("source is required (e.g. news, aikido, animation)");
    err.code = "editorial-validate";
    throw err;
  }
  return value;
}

function normalizeStatus(status) {
  const value = String(status == null ? DEFAULT_STATUS : status).trim();
  if (!WORKFLOW_STATUS_SET.has(value)) {
    const err = new Error(
      `status must be one of: ${WORKFLOW_STATUSES.join(", ")} (got ${status})`
    );
    err.code = "editorial-status";
    throw err;
  }
  return value;
}

/**
 * Parse a datetime for workflow fields / listReadyToPublish.
 * @returns {string} ISO string
 */
function parseDateTime(value, fieldName = "datetime") {
  if (value == null || value === "") {
    const err = new Error(`${fieldName} is required`);
    err.code = "editorial-datetime";
    throw err;
  }
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value);
  } else {
    date = new Date(String(value));
  }
  if (Number.isNaN(date.getTime())) {
    const err = new Error(`invalid ${fieldName}: ${value}`);
    err.code = "editorial-datetime";
    throw err;
  }
  return date.toISOString();
}

function canTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function assertTransitionAllowed(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!canTransition(from, to)) {
    const err = new Error(
      `invalid status transition: ${from} → ${to}`
    );
    err.code = "editorial-transition";
    err.from = from;
    err.to = to;
    throw err;
  }
  return { from, to };
}

function pickWorkflowTimestamps(source) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const key of WORKFLOW_TIMESTAMP_FIELDS) {
    if (source[key] != null && source[key] !== "") {
      out[key] = String(source[key]);
    }
  }
  return out;
}

/**
 * Optional opaque metadata object (e.g. Aikido Editorial Bridge provenance).
 * @param {unknown} value
 * @returns {object|undefined}
 */
function normalizeMetadata(value) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    const err = new Error("metadata must be a plain object");
    err.code = "editorial-metadata";
    throw err;
  }
  return { ...value };
}

/**
 * Normalize / validate a content record (does not write).
 * Status changes belong to transition(); create always starts as draft.
 */
function normalizeItem(input, { isCreate, existing, now } = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const createdAt =
    isCreate === true
      ? now
      : existing && existing.createdAt
        ? existing.createdAt
        : raw.createdAt || now;

  let id;
  if (isCreate === true) {
    id =
      raw.id != null && String(raw.id).trim()
        ? validateId(raw.id)
        : generateId();
  } else {
    id = validateId(existing.id);
  }

  const base = isCreate === true ? {} : { ...existing };
  const merged = { ...base, ...raw, id };

  let status;
  if (isCreate === true) {
    if (raw.status != null && String(raw.status).trim() !== DEFAULT_STATUS) {
      const err = new Error(
        `new items must start as "${DEFAULT_STATUS}" (use transition() to change status)`
      );
      err.code = "editorial-status";
      throw err;
    }
    status = DEFAULT_STATUS;
  } else {
    status = normalizeStatus(existing.status || DEFAULT_STATUS);
  }

  const kept =
    isCreate === true
      ? pickWorkflowTimestamps(raw)
      : pickWorkflowTimestamps(existing);

  const metadata = normalizeMetadata(
    merged.metadata != null
      ? merged.metadata
      : existing && existing.metadata
  );

  const record = {
    id,
    source: normalizeSource(
      merged.source != null ? merged.source : existing && existing.source
    ),
    type: normalizeType(
      merged.type != null ? merged.type : existing && existing.type
    ),
    title: String(merged.title == null ? "" : merged.title),
    summary: String(merged.summary == null ? "" : merged.summary),
    body: String(merged.body == null ? "" : merged.body),
    tags: normalizeTags(
      merged.tags != null ? merged.tags : existing && existing.tags
    ),
    score: normalizeScore(
      merged.score != null ? merged.score : existing && existing.score
    ),
    status,
    ...kept,
    createdAt,
    updatedAt: now,
  };
  if (metadata !== undefined) {
    record.metadata = metadata;
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
 * Create an Editorial Store bound to a project root.
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {string} [options.directory] absolute/relative path to editorial JSON dir
 * @param {function} [options.now]
 * @param {object} [options.deps] fs overrides for tests
 */
function createEditorialStore(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const storeDir =
    options.directory != null && String(options.directory).trim()
      ? path.resolve(String(options.directory).trim())
      : resolveStoreDir(rootDir);
  const deps = options.deps || {};
  const nowFn = options.now;

  function create(item) {
    const stamp = nowIso(nowFn);
    const record = normalizeItem(item, { isCreate: true, now: stamp });
    const filePath = itemPath(storeDir, record.id);
    const existsSync = deps.existsSync || fs.existsSync;
    if (existsSync(filePath)) {
      const err = new Error(`editorial item already exists: ${record.id}`);
      err.code = "editorial-exists";
      throw err;
    }
    ensureStoreDir(storeDir, deps);
    atomicWriteJson(filePath, record, deps);
    return { ...record };
  }

  function find(id) {
    const safeId = validateId(id);
    const filePath = itemPath(storeDir, safeId);
    const existsSync = deps.existsSync || fs.existsSync;
    if (!existsSync(filePath)) return null;
    const raw = readJsonFile(filePath, deps);
    return { ...raw, id: safeId };
  }

  function update(id, patch) {
    const safeId = validateId(id);
    const existing = find(safeId);
    if (!existing) {
      const err = new Error(`editorial item not found: ${safeId}`);
      err.code = "editorial-not-found";
      throw err;
    }
    if (patch && patch.id != null && String(patch.id).trim() !== safeId) {
      const err = new Error("id cannot be changed via update");
      err.code = "editorial-validate";
      throw err;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "status")) {
      const err = new Error(
        "status cannot be changed via update(); use transition()"
      );
      err.code = "editorial-status";
      throw err;
    }
    const safePatch = { ...(patch || {}) };
    for (const key of WORKFLOW_TIMESTAMP_FIELDS) {
      delete safePatch[key];
    }
    const stamp = nowIso(nowFn);
    const record = normalizeItem(
      { ...safePatch, id: safeId },
      { isCreate: false, existing, now: stamp }
    );
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  /**
   * Transition workflow status. Timestamps are set for the target status.
   * @param {string} id
   * @param {string} nextStatus
   * @param {{ scheduledAt?: string|Date|number }} [transitionOptions]
   */
  function transition(id, nextStatus, transitionOptions = {}) {
    const safeId = validateId(id);
    const existing = find(safeId);
    if (!existing) {
      const err = new Error(`editorial item not found: ${safeId}`);
      err.code = "editorial-not-found";
      throw err;
    }
    const current = normalizeStatus(existing.status || DEFAULT_STATUS);
    const { to } = assertTransitionAllowed(current, nextStatus);
    const stamp = nowIso(nowFn);

    const record = {
      ...existing,
      id: safeId,
      status: to,
      updatedAt: stamp,
    };

    const tsField = STATUS_TIMESTAMP_FIELD[to];
    if (to === "scheduled") {
      if (
        transitionOptions == null ||
        transitionOptions.scheduledAt == null ||
        transitionOptions.scheduledAt === ""
      ) {
        const err = new Error(
          'options.scheduledAt is required when transitioning to "scheduled"'
        );
        err.code = "editorial-scheduled-at";
        throw err;
      }
      record.scheduledAt = parseDateTime(
        transitionOptions.scheduledAt,
        "scheduledAt"
      );
    } else if (tsField) {
      record[tsField] = stamp;
    }

    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  function list() {
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
      const filePath = path.join(storeDir, name);
      try {
        const raw = readJsonFile(filePath, deps);
        items.push({ ...raw, id });
      } catch (_error) {
        // skip corrupt files
      }
    }
    items.sort((a, b) => {
      const ua = String(a.updatedAt || "");
      const ub = String(b.updatedAt || "");
      if (ua !== ub) return ub < ua ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    return items;
  }

  function listByStatus(status) {
    const want = normalizeStatus(status);
    return list().filter((item) => item.status === want);
  }

  function listBySource(source) {
    const want = normalizeSource(source);
    return list().filter((item) => item.source === want);
  }

  /**
   * Scheduled items due for publish (scheduledAt <= now), ascending by scheduledAt.
   * @param {string|Date|number} [nowValue]
   */
  function listReadyToPublish(nowValue) {
    const nowIsoValue =
      nowValue == null ? nowIso(nowFn) : parseDateTime(nowValue, "now");
    const nowMs = Date.parse(nowIsoValue);
    const ready = list().filter((item) => {
      if (item.status !== "scheduled") return false;
      if (item.scheduledAt == null || item.scheduledAt === "") return false;
      const at = Date.parse(String(item.scheduledAt));
      if (Number.isNaN(at)) return false;
      return at <= nowMs;
    });
    ready.sort((a, b) => {
      const sa = String(a.scheduledAt || "");
      const sb = String(b.scheduledAt || "");
      if (sa !== sb) return sa < sb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    return ready;
  }

  /**
   * Find similar items already in the store.
   * @param {object} target
   * @param {object} [simOptions] passed to findSimilarItems
   */
  function findSimilar(target, simOptions = {}) {
    return findSimilarItems(target, list(), simOptions);
  }

  /**
   * Find items similar to an existing record (self excluded).
   * @param {string} id
   * @param {object} [simOptions]
   */
  function findSimilarById(id, simOptions = {}) {
    const safeId = validateId(id);
    const target = find(safeId);
    if (!target) {
      const err = new Error(`editorial item not found: ${safeId}`);
      err.code = "editorial-not-found";
      throw err;
    }
    return findSimilarItems(target, list(), {
      ...simOptions,
      excludeId: safeId,
    });
  }

  /**
   * Evaluate an in-memory item against editorial rules.
   * @param {object} item
   * @param {object} [options]
   * @param {object[]} [options.rules]
   * @param {object} [options.context]
   * @param {boolean} [options.includeSimilarity]
   * @param {object} [options.similarityOptions]
   */
  function evaluateItem(item, options = {}) {
    const rules =
      options.rules != null ? options.rules : getDefaultRules();
    const context = { ...(options.context || {}) };
    /** @type {{ item: object, similarity: number }[]|undefined} */
    let similarItems;

    if (options.includeSimilarity === true) {
      const simOpts = { ...(options.similarityOptions || {}) };
      if (item && item.id != null && simOpts.excludeId == null) {
        simOpts.excludeId = String(item.id);
      }
      // Low threshold so maxSimilarity reflects strongest neighbor.
      if (simOpts.threshold == null) simOpts.threshold = 0;
      if (simOpts.limit == null) simOpts.limit = 10;
      similarItems = findSimilarItems(item, list(), simOpts);
      const maxSimilarity =
        similarItems.length > 0
          ? similarItems.reduce(
              (max, row) => (row.similarity > max ? row.similarity : max),
              0
            )
          : 0;
      context.maxSimilarity = maxSimilarity;
    }

    const report = evaluateRules(item, rules, context);
    if (options.includeSimilarity === true) {
      return {
        ...report,
        similarItems: similarItems || [],
        context: { maxSimilarity: context.maxSimilarity },
      };
    }
    return report;
  }

  /**
   * Load item by id and evaluate.
   * @param {string} id
   * @param {object} [options]
   */
  function evaluate(id, options = {}) {
    const safeId = validateId(id);
    const item = find(safeId);
    if (!item) {
      const err = new Error(`editorial item not found: ${safeId}`);
      err.code = "editorial-not-found";
      throw err;
    }
    return evaluateItem(item, options);
  }

  function buildRankingContextForItem(item, options = {}) {
    const context = { ...(options.defaultContext || {}) };
    if (options.contextById && item && item.id != null) {
      Object.assign(context, options.contextById[String(item.id)] || {});
    }
    if (options.now != null && context.now == null) {
      context.now = options.now;
    }
    if (options.weights != null) {
      context.weights = options.weights;
    }

    if (options.includeEvaluation === true) {
      const evalReport = evaluateItem(item, {
        rules: options.rules,
        context: {
          ...(context.evaluationContext || {}),
          maxSimilarity: context.maxSimilarity,
          operation: context.operation,
        },
        includeSimilarity: options.includeSimilarity === true,
        similarityOptions: options.similarityOptions,
      });
      context.evaluation = evalReport;
      if (
        options.includeSimilarity === true &&
        evalReport.context &&
        evalReport.context.maxSimilarity != null
      ) {
        context.maxSimilarity = evalReport.context.maxSimilarity;
      }
    } else if (options.includeSimilarity === true) {
      const simOpts = { ...(options.similarityOptions || {}) };
      if (item && item.id != null && simOpts.excludeId == null) {
        simOpts.excludeId = String(item.id);
      }
      if (simOpts.threshold == null) simOpts.threshold = 0;
      if (simOpts.limit == null) simOpts.limit = 10;
      const similarItems = findSimilarItems(item, list(), simOpts);
      context.maxSimilarity =
        similarItems.length > 0
          ? similarItems.reduce(
              (max, row) => (row.similarity > max ? row.similarity : max),
              0
            )
          : 0;
    }

    return context;
  }

  /**
   * Rank all store items.
   * @param {object} [options]
   */
  function rank(options = {}) {
    const items = list();
    const contextById = {};
    for (const item of items) {
      if (!item || item.id == null) continue;
      contextById[String(item.id)] = buildRankingContextForItem(item, options);
    }
    return rankItems(items, {
      ...options,
      contextById: {
        ...(options.contextById || {}),
        ...contextById,
      },
      // Per-id context already includes evaluation/similarity; avoid double-merge issues
      defaultContext: options.defaultContext,
      weights: options.weights,
    });
  }

  /**
   * Rank specific ids (missing id → error). Result order is ranking order.
   * @param {string[]} ids
   * @param {object} [options]
   */
  function rankByIds(ids, options = {}) {
    if (!Array.isArray(ids)) {
      const err = new Error("ids must be an array");
      err.code = "editorial-ranking-options";
      throw err;
    }
    const items = [];
    for (const id of ids) {
      const safeId = validateId(id);
      const item = find(safeId);
      if (!item) {
        const err = new Error(`editorial item not found: ${safeId}`);
        err.code = "editorial-not-found";
        throw err;
      }
      items.push(item);
    }
    const contextById = {};
    for (const item of items) {
      contextById[String(item.id)] = buildRankingContextForItem(item, options);
    }
    return rankItems(items, {
      ...options,
      contextById: {
        ...(options.contextById || {}),
        ...contextById,
      },
      defaultContext: options.defaultContext,
      weights: options.weights,
    });
  }

  /**
   * Rank a single item by id.
   * @param {string} id
   * @param {object} [options]
   */
  function rankItem(id, options = {}) {
    const safeId = validateId(id);
    const item = find(safeId);
    if (!item) {
      const err = new Error(`editorial item not found: ${safeId}`);
      err.code = "editorial-not-found";
      throw err;
    }
    const context = buildRankingContextForItem(item, options);
    return calculateRanking(item, context);
  }

  return {
    rootDir,
    storeDir,
    storeDirRel: STORE_DIR_REL,
    create,
    update,
    find,
    list,
    listByStatus,
    listBySource,
    transition,
    listReadyToPublish,
    findSimilar,
    findSimilarById,
    evaluate,
    evaluateItem,
    rank,
    rankByIds,
    rankItem,
  };
}

module.exports = {
  STORE_DIR_REL,
  ALLOWED_TYPES,
  DEFAULT_STATUS,
  WORKFLOW_STATUSES,
  ALLOWED_TRANSITIONS,
  STATUS_TIMESTAMP_FIELD,
  WORKFLOW_TIMESTAMP_FIELDS,
  createEditorialStore,
  validateId,
  generateId,
  normalizeItem,
  normalizeMetadata,
  normalizeStatus,
  parseDateTime,
  canTransition,
  assertTransitionAllowed,
  resolveStoreDir,
  resolveRoot,
};
