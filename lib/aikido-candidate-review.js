/**
 * KP-005 — Aikido Knowledge Candidate Review.
 * Persists Extractor candidates for human review; only approved → Knowledge.
 * Does not auto-approve, auto-convert, or mutate Source status.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  CATEGORIES,
  normalizeCategory,
  normalizeDifficulty,
} = require("./aikido-knowledge");

const STORE_DIR_REL = path.join(".pipeline-work", "reviews", "aikido");
const DEFAULT_STATUS = "pending";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CATEGORY_SET = new Set(CATEGORIES);

/** @type {readonly string[]} */
const STATUSES = Object.freeze([
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "converted",
  "archived",
]);

const STATUS_SET = new Set(STATUSES);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["reviewing", "approved", "rejected"]),
  reviewing: Object.freeze(["approved", "rejected"]),
  approved: Object.freeze(["converted"]),
  rejected: Object.freeze(["archived"]),
  converted: Object.freeze(["archived"]),
  archived: Object.freeze([]),
});

const PROTECTED_FIELDS = Object.freeze([
  "id",
  "candidateId",
  "sourceId",
  "status",
  "knowledgeId",
  "createdAt",
  "reviewedAt",
  "approvedAt",
  "rejectedAt",
  "convertedAt",
]);

function nowIso(nowFn, override) {
  if (override != null) {
    const v = typeof override === "function" ? override() : override;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number") return new Date(v).toISOString();
    return String(v);
  }
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
    err.code = "aikido-review-id";
    throw err;
  }
  const value = id.trim();
  if (value === "." || value === "..") {
    const err = new Error(`invalid id: ${value}`);
    err.code = "aikido-review-id";
    throw err;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    const err = new Error(`id must not contain path separators: ${value}`);
    err.code = "aikido-review-id";
    throw err;
  }
  if (!ID_RE.test(value)) {
    const err = new Error(
      `id must be alphanumeric/hyphen/underscore (1–128 chars): ${value}`
    );
    err.code = "aikido-review-id";
    throw err;
  }
  return value;
}

function generateReviewId(candidateId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(candidateId), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `rev-${hash}`;
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
    const err = new Error(`failed to write aikido review: ${error.message}`);
    err.code = "aikido-review-io";
    err.cause = error;
    throw err;
  }
}

function readJsonFile(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return JSON.parse(String(readFileSync(filePath, "utf8")));
  } catch (error) {
    const err = new Error(`failed to read aikido review: ${filePath}`);
    err.code = "aikido-review-io";
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
    const err = new Error(`${fieldName} must be an array`);
    err.code = "aikido-review-validate";
    throw err;
  }
  return value.map((v) => String(v));
}

function normalizeStatus(status) {
  const value = String(status == null ? DEFAULT_STATUS : status).trim();
  if (!STATUS_SET.has(value)) {
    const err = new Error(
      `status must be one of: ${STATUSES.join(", ")} (got ${status})`
    );
    err.code = "aikido-review-status";
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
    const err = new Error(`invalid review status transition: ${from} → ${to}`);
    err.code = "aikido-review-transition";
    err.from = from;
    err.to = to;
    throw err;
  }
  return { from, to };
}

function normalizeSourceReferences(refs) {
  if (refs == null) return [];
  if (!Array.isArray(refs)) {
    const err = new Error("sourceReferences must be an array");
    err.code = "aikido-review-validate";
    throw err;
  }
  return refs.map((ref) => {
    if (!ref || typeof ref !== "object") {
      const err = new Error("sourceReferences entries must be objects");
      err.code = "aikido-review-validate";
      throw err;
    }
    return {
      sourceId: ref.sourceId == null ? "" : String(ref.sourceId),
      quote: ref.quote == null ? "" : String(ref.quote),
      location: ref.location == null ? "" : String(ref.location),
    };
  });
}

function normalizeConfidence(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    const err = new Error("confidence must be a number between 0 and 1");
    err.code = "aikido-review-validate";
    throw err;
  }
  return n;
}

function normalizeMetadata(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    const err = new Error("metadata must be an object");
    err.code = "aikido-review-validate";
    throw err;
  }
  return { ...value };
}

/**
 * Build review record from candidate-like input.
 */
function buildReviewRecord(input, stamp, existingId) {
  const raw = input && typeof input === "object" ? input : {};
  const candidateId = String(raw.candidateId || "").trim();
  const sourceId = String(raw.sourceId || "").trim();
  if (!candidateId) {
    const err = new Error("candidateId is required");
    err.code = "aikido-review-validate";
    throw err;
  }
  if (!sourceId) {
    const err = new Error("sourceId is required");
    err.code = "aikido-review-validate";
    throw err;
  }

  const title = String(raw.title == null ? "" : raw.title).trim();
  if (!title) {
    const err = new Error("title is required");
    err.code = "aikido-review-validate";
    throw err;
  }

  const category = normalizeCategory(raw.category);
  const summary = String(raw.summary == null ? "" : raw.summary);
  const content = String(raw.content == null ? "" : raw.content);
  if (isBlank(summary) && isBlank(content)) {
    const err = new Error("summary or content is required");
    err.code = "aikido-review-validate";
    throw err;
  }

  const id =
    existingId ||
    (raw.id != null && String(raw.id).trim()
      ? validateId(raw.id)
      : generateReviewId(candidateId));

  return {
    id,
    candidateId,
    sourceId,
    title,
    category,
    summary,
    content,
    tags: normalizeStringArray(raw.tags, "tags"),
    difficulty: normalizeDifficulty(
      raw.difficulty != null ? raw.difficulty : 1
    ),
    sourceReferences: normalizeSourceReferences(raw.sourceReferences),
    confidence: normalizeConfidence(raw.confidence),
    warnings: normalizeStringArray(raw.warnings, "warnings"),
    status: DEFAULT_STATUS,
    reviewerNotes: String(raw.reviewerNotes == null ? "" : raw.reviewerNotes),
    rejectionReason: String(
      raw.rejectionReason == null ? "" : raw.rejectionReason
    ),
    knowledgeId: null,
    candidateMetadata: normalizeMetadata(
      raw.candidateMetadata != null
        ? raw.candidateMetadata
        : raw.metadata || {}
    ),
    metadata: normalizeMetadata(raw.reviewMetadata || {}),
    createdAt: stamp,
    updatedAt: stamp,
    reviewedAt: null,
    approvedAt: null,
    rejectedAt: null,
    convertedAt: null,
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
 * @param {object} [options.knowledgeStore]
 * @param {object} [options.deps]
 */
function createAikidoCandidateReview(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const storeDir =
    options.directory != null && String(options.directory).trim()
      ? path.resolve(String(options.directory).trim())
      : resolveStoreDir(rootDir);
  const deps = options.deps || {};
  const nowFn = options.now;
  const knowledgeStore = options.knowledgeStore || null;

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
        // skip
      }
    }
    items.sort((a, b) => {
      const ca = String(a.createdAt || "");
      const cb = String(b.createdAt || "");
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    return items;
  }

  function findByCandidateId(candidateId) {
    const want = String(candidateId || "").trim();
    if (!want) return null;
    return loadAll().find((r) => r.candidateId === want) || null;
  }

  function createReview(input) {
    const stamp = nowIso(nowFn, input && input.now);
    const raw = input && typeof input === "object" ? { ...input } : {};
    const allowDuplicateCandidate = !!raw.allowDuplicateCandidate;
    delete raw.allowDuplicateCandidate;
    delete raw.now;

    // Accept extractor candidate shape: metadata → candidateMetadata
    if (raw.metadata && !raw.candidateMetadata) {
      raw.candidateMetadata = raw.metadata;
    }

    if (!allowDuplicateCandidate && raw.candidateId) {
      const dup = findByCandidateId(raw.candidateId);
      if (dup) {
        const err = new Error(
          `duplicate candidateId already reviewed: ${raw.candidateId}`
        );
        err.code = "aikido-review-duplicate-candidate";
        err.existingId = dup.id;
        throw err;
      }
    }

    // When allowing duplicates, avoid colliding deterministic ids.
    if (allowDuplicateCandidate && !raw.id && raw.candidateId) {
      const hash = crypto
        .createHash("sha256")
        .update(`${raw.candidateId}:${stamp}`, "utf8")
        .digest("hex")
        .slice(0, 16);
      raw.id = `rev-${hash}`;
    }

    const record = buildReviewRecord(raw, stamp);
    const existsSync = deps.existsSync || fs.existsSync;
    const filePath = itemPath(storeDir, record.id);
    if (existsSync(filePath)) {
      const err = new Error(`aikido review already exists: ${record.id}`);
      err.code = "aikido-review-exists";
      throw err;
    }

    ensureStoreDir(storeDir, deps);
    atomicWriteJson(filePath, record, deps);
    return { ...record };
  }

  function createReviews(extractionResult, callOptions = {}) {
    const result =
      extractionResult && typeof extractionResult === "object"
        ? extractionResult
        : {};
    const sourceId = result.sourceId != null ? String(result.sourceId) : "";
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const reviews = [];
    const errors = [];
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const review = createReview({
          ...candidate,
          sourceId: candidate.sourceId || sourceId,
          candidateMetadata: candidate.metadata,
          allowDuplicateCandidate: callOptions.allowDuplicateCandidate,
          now: callOptions.now,
        });
        reviews.push(review);
        createdCount += 1;
      } catch (error) {
        if (error && error.code === "aikido-review-duplicate-candidate") {
          skippedCount += 1;
          errors.push({
            index: i,
            message: error.message,
            code: error.code,
            skipped: true,
          });
        } else {
          errorCount += 1;
          errors.push({
            index: i,
            message: error && error.message ? error.message : String(error),
            code: error && error.code ? error.code : "aikido-review-error",
          });
        }
      }
    }

    return {
      reviews,
      errors,
      summary: {
        candidateCount: candidates.length,
        createdCount,
        skippedCount,
        errorCount,
      },
    };
  }

  function findReview(id) {
    const safeId = validateId(id);
    const filePath = itemPath(storeDir, safeId);
    const existsSync = deps.existsSync || fs.existsSync;
    if (!existsSync(filePath)) return null;
    const raw = readJsonFile(filePath, deps);
    return { ...raw, id: safeId };
  }

  function listReviews(listOptions = {}) {
    let items = loadAll();

    if (listOptions.status != null && String(listOptions.status).trim()) {
      const status = normalizeStatus(listOptions.status);
      items = items.filter((r) => r.status === status);
    }
    if (listOptions.category != null && String(listOptions.category).trim()) {
      const category = normalizeCategory(listOptions.category);
      items = items.filter((r) => r.category === category);
    }
    if (listOptions.difficulty != null && listOptions.difficulty !== "") {
      const difficulty = normalizeDifficulty(listOptions.difficulty);
      items = items.filter((r) => r.difficulty === difficulty);
    }
    if (listOptions.tag != null && String(listOptions.tag).trim()) {
      const tag = String(listOptions.tag).trim();
      items = items.filter(
        (r) => Array.isArray(r.tags) && r.tags.includes(tag)
      );
    }
    if (listOptions.sourceId != null && String(listOptions.sourceId).trim()) {
      const sourceId = String(listOptions.sourceId).trim();
      items = items.filter((r) => r.sourceId === sourceId);
    }
    if (
      listOptions.candidateId != null &&
      String(listOptions.candidateId).trim()
    ) {
      const candidateId = String(listOptions.candidateId).trim();
      items = items.filter((r) => r.candidateId === candidateId);
    }
    if (listOptions.minConfidence != null && listOptions.minConfidence !== "") {
      const min = Number(listOptions.minConfidence);
      items = items.filter(
        (r) => r.confidence != null && Number(r.confidence) >= min
      );
    }
    if (listOptions.hasWarnings === true) {
      items = items.filter(
        (r) => Array.isArray(r.warnings) && r.warnings.length > 0
      );
    } else if (listOptions.hasWarnings === false) {
      items = items.filter(
        (r) => !Array.isArray(r.warnings) || r.warnings.length === 0
      );
    }
    if (listOptions.converted === true) {
      items = items.filter((r) => r.status === "converted");
    } else if (listOptions.converted === false) {
      items = items.filter((r) => r.status !== "converted");
    }

    if (listOptions.limit != null) {
      const limit = Number(listOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        const err = new Error("limit must be a non-negative integer");
        err.code = "aikido-review-options";
        throw err;
      }
      items = items.slice(0, limit);
    }
    return items;
  }

  function updateReview(id, patch, callOptions = {}) {
    const safeId = validateId(id);
    const existing = findReview(safeId);
    if (!existing) {
      const err = new Error(`aikido review not found: ${safeId}`);
      err.code = "aikido-review-not-found";
      throw err;
    }
    if (existing.status === "converted") {
      const err = new Error("converted reviews cannot be updated");
      err.code = "aikido-review-locked";
      throw err;
    }

    const raw = patch && typeof patch === "object" ? { ...patch } : {};
    for (const field of PROTECTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw, field)) {
        const err = new Error(
          `${field} cannot be changed via updateReview(); use transition helpers`
        );
        err.code = "aikido-review-protected";
        throw err;
      }
    }

    const stamp = nowIso(nowFn, callOptions.now || raw.now);
    delete raw.now;

    const next = {
      ...existing,
      title:
        raw.title != null ? String(raw.title).trim() : existing.title,
      category:
        raw.category != null
          ? normalizeCategory(raw.category)
          : existing.category,
      summary: raw.summary != null ? String(raw.summary) : existing.summary,
      content: raw.content != null ? String(raw.content) : existing.content,
      tags:
        raw.tags != null
          ? normalizeStringArray(raw.tags, "tags")
          : existing.tags,
      difficulty:
        raw.difficulty != null
          ? normalizeDifficulty(raw.difficulty)
          : existing.difficulty,
      sourceReferences:
        raw.sourceReferences != null
          ? normalizeSourceReferences(raw.sourceReferences)
          : existing.sourceReferences,
      reviewerNotes:
        raw.reviewerNotes != null
          ? String(raw.reviewerNotes)
          : existing.reviewerNotes,
      metadata:
        raw.metadata != null
          ? normalizeMetadata(raw.metadata)
          : existing.metadata,
      updatedAt: stamp,
    };

    if (isBlank(next.title)) {
      const err = new Error("title is required");
      err.code = "aikido-review-validate";
      throw err;
    }
    if (isBlank(next.summary) && isBlank(next.content)) {
      const err = new Error("summary or content is required");
      err.code = "aikido-review-validate";
      throw err;
    }

    atomicWriteJson(itemPath(storeDir, safeId), next, deps);
    return { ...next };
  }

  function transitionReview(id, nextStatus, callOptions = {}) {
    const safeId = validateId(id);
    const existing = findReview(safeId);
    if (!existing) {
      const err = new Error(`aikido review not found: ${safeId}`);
      err.code = "aikido-review-not-found";
      throw err;
    }
    const { to } = assertTransition(existing.status, nextStatus);
    const stamp = nowIso(nowFn, callOptions.now);
    const record = {
      ...existing,
      status: to,
      updatedAt: stamp,
    };
    if (callOptions.reviewerNotes != null) {
      record.reviewerNotes = String(callOptions.reviewerNotes);
    }
    if (to === "approved" || to === "rejected" || to === "reviewing") {
      if (!record.reviewedAt) record.reviewedAt = stamp;
    }
    if (to === "approved") record.approvedAt = stamp;
    if (to === "rejected") {
      if (isBlank(callOptions.rejectionReason)) {
        const err = new Error("rejectionReason is required");
        err.code = "aikido-review-reject";
        throw err;
      }
      record.rejectionReason = String(callOptions.rejectionReason);
      record.rejectedAt = stamp;
    }
    if (to === "converted") {
      // converted should go through createKnowledgeFromReview
      const err = new Error(
        'use createKnowledgeFromReview() to transition to "converted"'
      );
      err.code = "aikido-review-transition";
      throw err;
    }
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  function approveReview(id, callOptions = {}) {
    const safeId = validateId(id);
    const existing = findReview(safeId);
    if (!existing) {
      const err = new Error(`aikido review not found: ${safeId}`);
      err.code = "aikido-review-not-found";
      throw err;
    }
    assertTransition(existing.status, "approved");
    const stamp = nowIso(nowFn, callOptions.now);
    const record = {
      ...existing,
      status: "approved",
      reviewedAt: existing.reviewedAt || stamp,
      approvedAt: stamp,
      updatedAt: stamp,
      reviewerNotes:
        callOptions.reviewerNotes != null
          ? String(callOptions.reviewerNotes)
          : existing.reviewerNotes,
    };
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  function rejectReview(id, callOptions = {}) {
    if (isBlank(callOptions.rejectionReason)) {
      const err = new Error("rejectionReason is required");
      err.code = "aikido-review-reject";
      throw err;
    }
    const safeId = validateId(id);
    const existing = findReview(safeId);
    if (!existing) {
      const err = new Error(`aikido review not found: ${safeId}`);
      err.code = "aikido-review-not-found";
      throw err;
    }
    assertTransition(existing.status, "rejected");
    const stamp = nowIso(nowFn, callOptions.now);
    const record = {
      ...existing,
      status: "rejected",
      reviewedAt: existing.reviewedAt || stamp,
      rejectedAt: stamp,
      updatedAt: stamp,
      rejectionReason: String(callOptions.rejectionReason),
      reviewerNotes:
        callOptions.reviewerNotes != null
          ? String(callOptions.reviewerNotes)
          : existing.reviewerNotes,
    };
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return { ...record };
  }

  function createKnowledgeFromReview(id, callOptions = {}) {
    if (!knowledgeStore || typeof knowledgeStore.createKnowledge !== "function") {
      const err = new Error(
        "knowledgeStore with createKnowledge() is required for conversion"
      );
      err.code = "aikido-review-knowledge-store";
      throw err;
    }

    const safeId = validateId(id);
    const existing = findReview(safeId);
    if (!existing) {
      const err = new Error(`aikido review not found: ${safeId}`);
      err.code = "aikido-review-not-found";
      throw err;
    }
    if (existing.status !== "approved") {
      const err = new Error(
        `only approved reviews can be converted (got ${existing.status})`
      );
      err.code = "aikido-review-not-approved";
      throw err;
    }
    if (existing.knowledgeId) {
      const err = new Error(
        `review already converted to knowledge: ${existing.knowledgeId}`
      );
      err.code = "aikido-review-already-converted";
      throw err;
    }

    assertTransition(existing.status, "converted");

    let knowledge;
    try {
      knowledge = knowledgeStore.createKnowledge({
        title: existing.title,
        category: existing.category,
        summary: existing.summary,
        content: existing.content,
        tags: existing.tags,
        difficulty: existing.difficulty,
        sources: [existing.sourceId],
        related: [],
        status: "draft",
        ...(callOptions.knowledgeId ? { id: callOptions.knowledgeId } : {}),
      });
    } catch (error) {
      // Atomicity: do not mutate review on failure.
      throw error;
    }

    const stamp = nowIso(nowFn, callOptions.now);
    const record = {
      ...existing,
      status: "converted",
      knowledgeId: knowledge.id,
      convertedAt: stamp,
      updatedAt: stamp,
    };
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return {
      review: { ...record },
      knowledge: { ...knowledge },
    };
  }

  /**
   * Approve + create Knowledge in one flow.
   * Creates Knowledge first; on failure the review is left unchanged.
   */
  function approveAndCreateKnowledge(id, callOptions = {}) {
    if (!knowledgeStore || typeof knowledgeStore.createKnowledge !== "function") {
      const err = new Error(
        "knowledgeStore with createKnowledge() is required for conversion"
      );
      err.code = "aikido-review-knowledge-store";
      throw err;
    }

    const safeId = validateId(id);
    const existing = findReview(safeId);
    if (!existing) {
      const err = new Error(`aikido review not found: ${safeId}`);
      err.code = "aikido-review-not-found";
      throw err;
    }
    if (existing.knowledgeId || existing.status === "converted") {
      const err = new Error(
        `review already converted to knowledge: ${existing.knowledgeId || ""}`
      );
      err.code = "aikido-review-already-converted";
      err.knowledgeId = existing.knowledgeId || null;
      throw err;
    }
    if (existing.status === "rejected" || existing.status === "archived") {
      const err = new Error(
        `cannot approve review in status ${existing.status}`
      );
      err.code = "aikido-review-transition";
      throw err;
    }
    if (
      existing.status !== "pending" &&
      existing.status !== "reviewing" &&
      existing.status !== "approved"
    ) {
      const err = new Error(
        `cannot approve review in status ${existing.status}`
      );
      err.code = "aikido-review-transition";
      throw err;
    }

    let knowledge;
    try {
      knowledge = knowledgeStore.createKnowledge({
        title: existing.title,
        category: existing.category,
        summary: existing.summary,
        content: existing.content,
        tags: existing.tags,
        difficulty: existing.difficulty,
        sources: [existing.sourceId],
        related: [],
        status: "draft",
        ...(callOptions.knowledgeId ? { id: callOptions.knowledgeId } : {}),
      });
    } catch (error) {
      // Review untouched.
      throw error;
    }

    const stamp = nowIso(nowFn, callOptions.now);
    const record = {
      ...existing,
      status: "converted",
      knowledgeId: knowledge.id,
      reviewedAt: existing.reviewedAt || stamp,
      approvedAt: existing.approvedAt || stamp,
      convertedAt: stamp,
      updatedAt: stamp,
      reviewerNotes:
        callOptions.reviewerNotes != null
          ? String(callOptions.reviewerNotes)
          : existing.reviewerNotes,
    };
    atomicWriteJson(itemPath(storeDir, safeId), record, deps);
    return {
      review: { ...record },
      knowledge: { ...knowledge },
    };
  }

  return {
    rootDir,
    storeDir,
    storeDirRel: STORE_DIR_REL,
    createReview,
    createReviews,
    findReview,
    listReviews,
    updateReview,
    transitionReview,
    approveReview,
    rejectReview,
    createKnowledgeFromReview,
    approveAndCreateKnowledge,
  };
}

module.exports = {
  STORE_DIR_REL,
  STATUSES,
  DEFAULT_STATUS,
  ALLOWED_TRANSITIONS,
  PROTECTED_FIELDS,
  createAikidoCandidateReview,
  assertTransition,
  validateId,
  generateReviewId,
  resolveStoreDir,
  resolveRoot,
};
