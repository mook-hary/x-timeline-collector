/**
 * XP-003 — Publish Ledger.
 * Persistent publish-state records (not Publisher-owned memory).
 * Storage: .pipeline-work/publish/<provider>/<publishId>.json
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_DIR_REL = path.join(".pipeline-work", "publish");
const DEFAULT_PROVIDER = "x";
const DEFAULT_PUBLISHER_VERSION = "1";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

function resolveStoreRoot(rootDir) {
  return path.join(resolveRoot(rootDir), STORE_DIR_REL);
}

function resolveProviderDir(rootDir, provider) {
  return path.join(resolveStoreRoot(rootDir), normalizeProvider(provider));
}

function normalizeProvider(provider) {
  const value =
    provider != null && String(provider).trim()
      ? String(provider).trim()
      : DEFAULT_PROVIDER;
  if (!ID_RE.test(value)) {
    const err = new Error(`invalid provider: ${value}`);
    err.code = "publish-ledger-provider";
    throw err;
  }
  return value;
}

function validateId(id, fieldName = "id") {
  if (typeof id !== "string" || !id.trim()) {
    const err = new Error(`${fieldName} must be a non-empty string`);
    err.code = "publish-ledger-id";
    throw err;
  }
  const value = id.trim();
  if (value === "." || value === "..") {
    const err = new Error(`invalid ${fieldName}: ${value}`);
    err.code = "publish-ledger-id";
    throw err;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    const err = new Error(`${fieldName} must not contain path separators`);
    err.code = "publish-ledger-id";
    throw err;
  }
  if (!ID_RE.test(value)) {
    const err = new Error(
      `${fieldName} must be alphanumeric/hyphen/underscore (1–128 chars)`
    );
    err.code = "publish-ledger-id";
    throw err;
  }
  return value;
}

function generatePublishId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `pub-${stamp}-${rand}`;
}

/**
 * SHA-256 hex digest of post body (for duplicate detection, not storage of text).
 * @param {string} text
 */
function computeChecksum(text) {
  return crypto
    .createHash("sha256")
    .update(String(text == null ? "" : text), "utf8")
    .digest("hex");
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
      // ignore
    }
    throw error;
  }
}

function readJsonFile(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listJsonFiles(dir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort();
}

function optionalString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {string} [options.directory] absolute override for publish root
 * @param {string} [options.provider] default provider subdirectory
 * @param {object} [options.deps]
 */
function createPublishLedger(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const storeRoot =
    options.directory != null && String(options.directory).trim()
      ? path.resolve(String(options.directory).trim())
      : resolveStoreRoot(rootDir);
  const defaultProvider = normalizeProvider(options.provider);
  const deps = options.deps || {};

  function providerDir(provider) {
    return path.join(storeRoot, normalizeProvider(provider || defaultProvider));
  }

  function recordPath(provider, publishId) {
    return path.join(
      providerDir(provider),
      `${validateId(publishId, "publishId")}.json`
    );
  }

  function loadProvider(provider) {
    const dir = providerDir(provider);
    const files = listJsonFiles(dir, deps);
    const items = [];
    for (const name of files) {
      const id = name.replace(/\.json$/i, "");
      try {
        validateId(id, "publishId");
      } catch (_error) {
        continue;
      }
      try {
        const raw = readJsonFile(path.join(dir, name), deps);
        items.push({ ...raw, publishId: raw.publishId || id });
      } catch (_error) {
        // skip corrupt
      }
    }
    items.sort((a, b) => {
      const pa = String(a.publishedAt || "");
      const pb = String(b.publishedAt || "");
      if (pa !== pb) return pa < pb ? -1 : 1;
      return String(a.publishId).localeCompare(String(b.publishId));
    });
    return items;
  }

  function loadAll(providerFilter) {
    if (providerFilter != null && String(providerFilter).trim()) {
      return loadProvider(providerFilter);
    }
    const existsSync = deps.existsSync || fs.existsSync;
    const readdirSync = deps.readdirSync || fs.readdirSync;
    if (!existsSync(storeRoot)) return [];
    const providers = readdirSync(storeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
    const items = [];
    for (const provider of providers) {
      items.push(...loadProvider(provider));
    }
    items.sort((a, b) => {
      const pa = String(a.publishedAt || "");
      const pb = String(b.publishedAt || "");
      if (pa !== pb) return pa < pb ? -1 : 1;
      return String(a.publishId).localeCompare(String(b.publishId));
    });
    return items;
  }

  /**
   * Persist a published result. Dry-run / non-published → no write, returns null.
   * Does not mutate input. Does not block Publisher.
   * @param {object} result Publisher publishPost result (or compatible)
   * @param {object} [extra] optional templateId / formatterVersion overrides
   */
  function recordPublish(result, extra = {}) {
    if (!result || typeof result !== "object") {
      const err = new Error("result must be an object");
      err.code = "publish-ledger-result";
      throw err;
    }
    if (result.status !== "published") {
      return null;
    }

    const text = result.text != null ? String(result.text) : "";
    const provider = normalizeProvider(result.provider || defaultProvider);
    const publishId =
      result.publishId != null && String(result.publishId).trim()
        ? validateId(String(result.publishId), "publishId")
        : generatePublishId();

    const editorialId = optionalString(result.editorialId);
    const knowledgeId = optionalString(result.knowledgeId);
    const remoteId = optionalString(result.remoteId);
    const templateId = optionalString(
      extra.templateId != null
        ? extra.templateId
        : result.templateId != null
          ? result.templateId
          : result.metadata && result.metadata.templateId
    );
    const formatterVersion = optionalString(
      extra.formatterVersion != null
        ? extra.formatterVersion
        : result.formatterVersion != null
          ? result.formatterVersion
          : result.metadata && result.metadata.formatterVersion
    );
    const publisherVersion = optionalString(
      extra.publisherVersion != null
        ? extra.publisherVersion
        : result.publisherVersion != null
          ? result.publisherVersion
          : DEFAULT_PUBLISHER_VERSION
    );
    const publishedAt =
      result.publishedAt != null
        ? String(result.publishedAt)
        : new Date().toISOString();
    const checksum =
      result.checksum != null && String(result.checksum).trim()
        ? String(result.checksum).trim()
        : computeChecksum(text);

    if (!editorialId) {
      const err = new Error("editorialId is required to record publish");
      err.code = "publish-ledger-result";
      throw err;
    }
    if (!remoteId) {
      const err = new Error("remoteId is required to record publish");
      err.code = "publish-ledger-result";
      throw err;
    }

    const record = {
      publishId,
      provider,
      editorialId,
      knowledgeId,
      templateId,
      remoteId,
      checksum,
      status: "published",
      publishedAt,
      formatterVersion,
      publisherVersion,
    };

    const filePath = recordPath(provider, publishId);
    const existsSync = deps.existsSync || fs.existsSync;
    if (existsSync(filePath)) {
      const err = new Error(`publish record already exists: ${publishId}`);
      err.code = "publish-ledger-exists";
      throw err;
    }

    atomicWriteJson(filePath, record, deps);
    return { ...record };
  }

  function findByEditorialId(id, findOptions = {}) {
    const want = String(id || "").trim();
    if (!want) return null;
    const items = loadAll(findOptions.provider).filter(
      (r) => r.editorialId === want
    );
    if (items.length === 0) return null;
    return items[items.length - 1];
  }

  function findByKnowledgeId(id, findOptions = {}) {
    const want = String(id || "").trim();
    if (!want) return null;
    const items = loadAll(findOptions.provider).filter(
      (r) => r.knowledgeId === want
    );
    if (items.length === 0) return null;
    return items[items.length - 1];
  }

  function findByRemoteId(id, findOptions = {}) {
    const want = String(id || "").trim();
    if (!want) return null;
    const items = loadAll(findOptions.provider).filter(
      (r) => r.remoteId === want
    );
    if (items.length === 0) return null;
    return items[items.length - 1];
  }

  function findByChecksum(checksum, findOptions = {}) {
    const want = String(checksum || "").trim();
    if (!want) return null;
    const items = loadAll(findOptions.provider).filter(
      (r) => r.checksum === want
    );
    if (items.length === 0) return null;
    return items[items.length - 1];
  }

  /**
   * @param {{
   *   provider?: string,
   *   status?: string,
   *   knowledgeId?: string,
   *   editorialId?: string,
   *   checksum?: string,
   *   remoteId?: string,
   *   limit?: number,
   * }} [listOptions]
   */
  function list(listOptions = {}) {
    let items = loadAll(listOptions.provider);

    if (listOptions.status != null && String(listOptions.status).trim()) {
      const status = String(listOptions.status).trim();
      items = items.filter((r) => r.status === status);
    }
    if (
      listOptions.knowledgeId != null &&
      String(listOptions.knowledgeId).trim()
    ) {
      const knowledgeId = String(listOptions.knowledgeId).trim();
      items = items.filter((r) => r.knowledgeId === knowledgeId);
    }
    if (
      listOptions.editorialId != null &&
      String(listOptions.editorialId).trim()
    ) {
      const editorialId = String(listOptions.editorialId).trim();
      items = items.filter((r) => r.editorialId === editorialId);
    }
    if (listOptions.checksum != null && String(listOptions.checksum).trim()) {
      const checksum = String(listOptions.checksum).trim();
      items = items.filter((r) => r.checksum === checksum);
    }
    if (listOptions.remoteId != null && String(listOptions.remoteId).trim()) {
      const remoteId = String(listOptions.remoteId).trim();
      items = items.filter((r) => r.remoteId === remoteId);
    }

    if (listOptions.limit != null) {
      const limit = Number(listOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        const err = new Error("limit must be a non-negative integer");
        err.code = "publish-ledger-options";
        throw err;
      }
      items = items.slice(0, limit);
    }
    return items;
  }

  return {
    rootDir,
    storeRoot,
    storeDirRel: STORE_DIR_REL,
    defaultProvider,
    recordPublish,
    findByEditorialId,
    findByKnowledgeId,
    findByRemoteId,
    findByChecksum,
    list,
    computeChecksum,
  };
}

module.exports = {
  STORE_DIR_REL,
  DEFAULT_PROVIDER,
  DEFAULT_PUBLISHER_VERSION,
  createPublishLedger,
  computeChecksum,
  resolveStoreRoot,
  resolveRoot,
};
