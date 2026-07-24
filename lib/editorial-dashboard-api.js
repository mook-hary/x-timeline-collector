/**
 * ED-001 — Editorial Dashboard API (library layer).
 * Reuses Editorial Store, X Formatter, X Publisher, Publish Ledger.
 */
const { createEditorialStore } = require("./editorial-store");
const { createXPostFormatter } = require("./x-post-formatter");
const { createXPublisher } = require("./x-publisher");
const { createXPublisherFromEnv } = require("./x-publisher-env");
const {
  createPublishLedger,
  computeChecksum,
} = require("./publish-ledger");
const { duplicateReason } = require("./aikido-publish-cli");

const ERROR_CODES = Object.freeze({
  EDITORIAL_NOT_FOUND: "EDITORIAL_NOT_FOUND",
  EDITORIAL_CONTENT_REQUIRED: "EDITORIAL_CONTENT_REQUIRED",
  EDITORIAL_SAVE_FAILED: "EDITORIAL_SAVE_FAILED",
  X_PREVIEW_FAILED: "X_PREVIEW_FAILED",
  X_ACCESS_TOKEN_MISSING: "X_ACCESS_TOKEN_MISSING",
  X_PUBLISH_FAILED: "X_PUBLISH_FAILED",
  ALREADY_PUBLISHED: "ALREADY_PUBLISHED",
  INVALID_REQUEST_BODY: "INVALID_REQUEST_BODY",
  CONFIRM_REQUIRED: "CONFIRM_REQUIRED",
});

function apiOk(data) {
  return { ok: true, data };
}

function apiErr(code, message, status = 400) {
  return {
    ok: false,
    status,
    error: {
      code: String(code),
      message: String(message),
    },
  };
}

function sanitizeMessage(message) {
  return String(message == null ? "" : message)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization[:\s]+\S+/gi, "Authorization: [REDACTED]")
    .replace(/X_USER_ACCESS_TOKEN[=:\s]+\S+/gi, "X_USER_ACCESS_TOKEN=[REDACTED]");
}

function categoryOf(item) {
  const meta = item && item.metadata && typeof item.metadata === "object"
    ? item.metadata
    : {};
  if (meta.knowledgeCategory) return String(meta.knowledgeCategory);
  if (Array.isArray(item.tags)) {
    const known = [
      "principle",
      "training",
      "technique",
      "mindset",
      "etiquette",
      "history",
      "teaching",
      "injury-prevention",
      "experience",
    ];
    for (const t of item.tags) {
      if (known.includes(String(t))) return String(t);
    }
  }
  return null;
}

function knowledgeIdOf(item) {
  const meta = item && item.metadata && typeof item.metadata === "object"
    ? item.metadata
    : {};
  return meta.knowledgeId != null ? String(meta.knowledgeId) : null;
}

/**
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {object} [options.editorialStore]
 * @param {object} [options.ledger]
 * @param {object} [options.formatter]
 * @param {object} [options.publisher] injected (tests / dry)
 * @param {function} [options.createPublisher] () => publisher for live publish
 * @param {function} [options.now]
 */
function createEditorialDashboardApi(options = {}) {
  const rootDir = options.rootDir;
  const editorialStore =
    options.editorialStore ||
    createEditorialStore({
      rootDir,
      now: options.now,
    });
  const ledger =
    options.ledger ||
    createPublishLedger({
      rootDir,
    });
  const formatter =
    options.formatter ||
    createXPostFormatter({
      now: options.now,
    });

  function resolvePublisher() {
    if (options.publisher) return options.publisher;
    if (typeof options.createPublisher === "function") {
      return options.createPublisher();
    }
    try {
      return createXPublisherFromEnv({
        clock: options.now,
      });
    } catch (error) {
      if (error && error.code === "X_ACCESS_TOKEN_MISSING") {
        const err = new Error("X_USER_ACCESS_TOKEN is required to publish");
        err.code = ERROR_CODES.X_ACCESS_TOKEN_MISSING;
        throw err;
      }
      throw error;
    }
  }

  function publishInfoFor(editorialId) {
    const record =
      typeof ledger.findByEditorialId === "function"
        ? ledger.findByEditorialId(editorialId)
        : null;
    if (!record) {
      return {
        publishStatus: "unpublished",
        published: false,
        remoteId: null,
        publishedAt: null,
        publishId: null,
      };
    }
    return {
      publishStatus: "published",
      published: true,
      remoteId: record.remoteId || null,
      publishedAt: record.publishedAt || null,
      publishId: record.publishId || null,
    };
  }

  function toListItem(item) {
    const pub = publishInfoFor(item.id);
    return {
      id: item.id,
      title: item.title || "",
      category: categoryOf(item),
      status: item.status,
      updatedAt: item.updatedAt,
      createdAt: item.createdAt,
      publishStatus: pub.publishStatus,
      published: pub.published,
      remoteId: pub.remoteId,
      publishedAt: pub.publishedAt,
    };
  }

  function toDetail(item) {
    const pub = publishInfoFor(item.id);
    return {
      id: item.id,
      knowledgeId: knowledgeIdOf(item),
      title: item.title || "",
      category: categoryOf(item),
      status: item.status,
      body: item.body == null ? "" : String(item.body),
      summary: item.summary || "",
      tags: Array.isArray(item.tags) ? item.tags : [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      metadata: item.metadata && typeof item.metadata === "object"
        ? item.metadata
        : {},
      publishStatus: pub.publishStatus,
      published: pub.published,
      remoteId: pub.remoteId,
      publishedAt: pub.publishedAt,
      publishId: pub.publishId,
    };
  }

  function listEditorials() {
    const items = editorialStore.list().map(toListItem);
    return apiOk({ editorials: items });
  }

  function getEditorial(id) {
    const item = editorialStore.find(id);
    if (!item) {
      return apiErr(
        ERROR_CODES.EDITORIAL_NOT_FOUND,
        "Editorial not found.",
        404
      );
    }
    return apiOk({ editorial: toDetail(item) });
  }

  function saveEditorial(id, bodyPayload) {
    if (!bodyPayload || typeof bodyPayload !== "object") {
      return apiErr(
        ERROR_CODES.INVALID_REQUEST_BODY,
        "Request body must be a JSON object."
      );
    }
    const body =
      bodyPayload.body != null ? String(bodyPayload.body) : "";
    if (!body.trim()) {
      return apiErr(
        ERROR_CODES.EDITORIAL_CONTENT_REQUIRED,
        "Editorial body is required."
      );
    }

    const existing = editorialStore.find(id);
    if (!existing) {
      return apiErr(
        ERROR_CODES.EDITORIAL_NOT_FOUND,
        "Editorial not found.",
        404
      );
    }

    // Ensure formatter can process the updated item before save.
    try {
      const trial = { ...existing, body };
      const preview = formatter.formatPost(trial);
      if (!preview || typeof preview.text !== "string") {
        return apiErr(
          ERROR_CODES.EDITORIAL_SAVE_FAILED,
          "X Formatter rejected the content."
        );
      }
    } catch (error) {
      return apiErr(
        ERROR_CODES.EDITORIAL_SAVE_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }

    try {
      const updated = editorialStore.update(id, { body });
      return apiOk({ editorial: toDetail(updated), message: "Saved." });
    } catch (error) {
      return apiErr(
        ERROR_CODES.EDITORIAL_SAVE_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }
  }

  function previewEditorial(id, bodyPayload = {}) {
    const item = editorialStore.find(id);
    if (!item) {
      return apiErr(
        ERROR_CODES.EDITORIAL_NOT_FOUND,
        "Editorial not found.",
        404
      );
    }
    try {
      const trial =
        bodyPayload &&
        typeof bodyPayload === "object" &&
        Object.prototype.hasOwnProperty.call(bodyPayload, "body")
          ? { ...item, body: String(bodyPayload.body == null ? "" : bodyPayload.body) }
          : item;
      const formatted = formatter.formatPost(trial);
      const maxLength = formatter.maxLength != null ? formatter.maxLength : 280;
      const estimatedLength = formatted.metadata.estimatedLength;
      const exceeds =
        estimatedLength > maxLength ||
        (Array.isArray(formatted.warnings) &&
          formatted.warnings.some((w) => /exceeds\s+maxLength/i.test(String(w))));
      return apiOk({
        preview: {
          text: formatted.text,
          characters: estimatedLength,
          estimatedLength,
          maxLength,
          exceedsLimit: exceeds,
          warnings: formatted.warnings || [],
          metadata: formatted.metadata,
        },
      });
    } catch (error) {
      return apiErr(
        ERROR_CODES.X_PREVIEW_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }
  }

  async function publishEditorial(id, bodyPayload) {
    if (!bodyPayload || typeof bodyPayload !== "object") {
      return apiErr(
        ERROR_CODES.INVALID_REQUEST_BODY,
        "Request body must be a JSON object."
      );
    }
    if (bodyPayload.confirm !== true) {
      return apiErr(
        ERROR_CODES.CONFIRM_REQUIRED,
        "Publish requires confirm: true."
      );
    }

    const item = editorialStore.find(id);
    if (!item) {
      return apiErr(
        ERROR_CODES.EDITORIAL_NOT_FOUND,
        "Editorial not found.",
        404
      );
    }

    let formatted;
    try {
      formatted = formatter.formatPost(item);
    } catch (error) {
      return apiErr(
        ERROR_CODES.X_PREVIEW_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }

    const checksum =
      typeof ledger.computeChecksum === "function"
        ? ledger.computeChecksum(formatted.text)
        : computeChecksum(formatted.text);
    const dup = duplicateReason(ledger, item.id, checksum);
    if (dup) {
      return apiErr(
        ERROR_CODES.ALREADY_PUBLISHED,
        "Already published.",
        409
      );
    }

    let publisher;
    try {
      publisher = resolvePublisher();
    } catch (error) {
      const code =
        error && error.code === ERROR_CODES.X_ACCESS_TOKEN_MISSING
          ? ERROR_CODES.X_ACCESS_TOKEN_MISSING
          : error && error.code === "X_ACCESS_TOKEN_MISSING"
            ? ERROR_CODES.X_ACCESS_TOKEN_MISSING
            : ERROR_CODES.X_PUBLISH_FAILED;
      return apiErr(
        code,
        sanitizeMessage(error && error.message ? error.message : error),
        code === ERROR_CODES.X_ACCESS_TOKEN_MISSING ? 503 : 500
      );
    }

    try {
      const result = await publisher.publishPost(formatted, {
        execute: true,
      });
      if (!result || result.status !== "published") {
        return apiErr(
          ERROR_CODES.X_PUBLISH_FAILED,
          "Publish did not complete."
        );
      }
      const recorded = ledger.recordPublish(result, {
        templateId:
          formatted.metadata && formatted.metadata.templateId
            ? formatted.metadata.templateId
            : null,
        formatterVersion:
          formatted.metadata && formatted.metadata.formatterVersion
            ? formatted.metadata.formatterVersion
            : null,
      });
      return apiOk({
        message: "Published successfully.",
        remoteId: result.remoteId,
        publishedAt: result.publishedAt,
        editorialId: result.editorialId,
        ledger: recorded,
      });
    } catch (error) {
      const code =
        error && error.code === "aikido-bridge-duplicate"
          ? ERROR_CODES.ALREADY_PUBLISHED
          : error && String(error.code || "").startsWith("X_")
            ? ERROR_CODES.X_PUBLISH_FAILED
            : ERROR_CODES.X_PUBLISH_FAILED;
      return apiErr(
        code === ERROR_CODES.ALREADY_PUBLISHED
          ? ERROR_CODES.ALREADY_PUBLISHED
          : ERROR_CODES.X_PUBLISH_FAILED,
        sanitizeMessage(error && error.message ? error.message : error),
        code === ERROR_CODES.ALREADY_PUBLISHED ? 409 : 500
      );
    }
  }

  function listPublishes(query = {}) {
    const items = ledger.list({
      provider: query.provider || "x",
      status: query.status,
      editorialId: query.editorialId,
      knowledgeId: query.knowledgeId,
      limit: query.limit,
    });
    // Newest first for dashboard.
    const sorted = items.slice().sort((a, b) => {
      const pa = String(a.publishedAt || "");
      const pb = String(b.publishedAt || "");
      if (pa !== pb) return pb < pa ? -1 : 1;
      return String(b.publishId || "").localeCompare(String(a.publishId || ""));
    });
    return apiOk({
      publishes: sorted.map((r) => ({
        publishId: r.publishId,
        editorialId: r.editorialId,
        knowledgeId: r.knowledgeId,
        status: r.status,
        remoteId: r.remoteId,
        publishedAt: r.publishedAt,
        checksum: r.checksum,
        provider: r.provider,
        error: null,
      })),
    });
  }

  return {
    ERROR_CODES,
    editorialStore,
    ledger,
    formatter,
    listEditorials,
    getEditorial,
    saveEditorial,
    previewEditorial,
    publishEditorial,
    listPublishes,
  };
}

module.exports = {
  ERROR_CODES,
  createEditorialDashboardApi,
  apiOk,
  apiErr,
  sanitizeMessage,
};
