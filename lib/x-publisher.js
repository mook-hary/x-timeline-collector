/**
 * XP-002 — X Publisher.
 * Publishes XP-001 Formatted Posts via an injected X client.
 * Default is dry-run; real calls require { execute: true }.
 */
const DEFAULT_MAX_LENGTH = 280;

const ERROR_CODES = Object.freeze({
  X_POST_INVALID: "X_POST_INVALID",
  X_POST_TOO_LONG: "X_POST_TOO_LONG",
  X_API_UNAUTHORIZED: "X_API_UNAUTHORIZED",
  X_API_RATE_LIMITED: "X_API_RATE_LIMITED",
  X_API_REQUEST_FAILED: "X_API_REQUEST_FAILED",
  X_API_INVALID_RESPONSE: "X_API_INVALID_RESPONSE",
  X_PUBLISHER_NO_CLIENT: "X_PUBLISHER_NO_CLIENT",
  X_BATCH_DUPLICATE_EDITORIAL_ID: "X_BATCH_DUPLICATE_EDITORIAL_ID",
});

class XPublishError extends Error {
  /**
   * @param {{
   *   code: string,
   *   message: string,
   *   editorialId?: string|null,
   *   knowledgeId?: string|null,
   *   cause?: *,
   *   retryable?: boolean,
   *   details?: object,
   * }} opts
   */
  constructor(opts = {}) {
    const message =
      opts.message != null ? String(opts.message) : "X publish failed";
    super(message);
    this.name = "XPublishError";
    this.code = opts.code != null ? String(opts.code) : ERROR_CODES.X_API_REQUEST_FAILED;
    this.editorialId =
      opts.editorialId != null ? String(opts.editorialId) : null;
    this.knowledgeId =
      opts.knowledgeId != null ? String(opts.knowledgeId) : null;
    this.cause = opts.cause != null ? opts.cause : null;
    this.retryable = opts.retryable === true;
    this.details =
      opts.details && typeof opts.details === "object" ? { ...opts.details } : {};
  }
}

function resolveClock(clock) {
  if (typeof clock === "function") {
    const v = clock();
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  return new Date().toISOString();
}

function hasLengthWarning(warnings) {
  if (!Array.isArray(warnings)) return false;
  return warnings.some((w) => {
    const s = String(w == null ? "" : w);
    return /exceeds\s+maxLength/i.test(s) || /too\s+long/i.test(s);
  });
}

/**
 * Classify a thrown client/HTTP error into XPublishError fields.
 * Never includes tokens or Authorization headers.
 * @param {*} error
 * @param {{ editorialId?: *, knowledgeId?: * }} [ctx]
 */
function classifyClientError(error, ctx = {}) {
  if (error instanceof XPublishError) return error;

  const status =
    (error && (error.status ?? error.statusCode ?? error.httpStatus)) != null
      ? Number(error.status ?? error.statusCode ?? error.httpStatus)
      : null;

  let code = ERROR_CODES.X_API_REQUEST_FAILED;
  let retryable = false;
  if (status === 401 || status === 403) {
    code = ERROR_CODES.X_API_UNAUTHORIZED;
  } else if (status === 429) {
    code = ERROR_CODES.X_API_RATE_LIMITED;
    retryable = true;
  } else if (status != null && status >= 500) {
    code = ERROR_CODES.X_API_REQUEST_FAILED;
    retryable = true;
  } else if (
    error &&
    error.code &&
    String(error.code).startsWith("X_API_")
  ) {
    code = String(error.code);
    retryable = error.retryable === true;
  }

  const rawMessage =
    error && error.message != null ? String(error.message) : "X API request failed";
  // Strip common secret patterns from message text.
  const message = rawMessage
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization[:\s]+\S+/gi, "Authorization: [REDACTED]");

  return new XPublishError({
    code,
    message,
    editorialId: ctx.editorialId,
    knowledgeId: ctx.knowledgeId,
    cause: error,
    retryable,
    details: status != null ? { status } : {},
  });
}

/**
 * Validate XP-001 formatted post. Does not mutate input.
 * @param {object} post
 * @param {{ maxLength?: number }} [options]
 * @returns {{ valid: boolean, code?: string, message?: string, details?: object, warnings: string[] }}
 */
function validatePost(post, options = {}) {
  const maxLength =
    options.maxLength == null ? DEFAULT_MAX_LENGTH : Number(options.maxLength);
  const warnings = [];

  if (!post || typeof post !== "object" || Array.isArray(post)) {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_INVALID,
      message: "post must be an object",
      details: {},
      warnings,
    };
  }

  if (typeof post.text !== "string") {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_INVALID,
      message: "text must be a string",
      details: {},
      warnings,
    };
  }

  if (post.text.length === 0 || !post.text.trim()) {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_INVALID,
      message: "text must not be empty",
      details: {},
      warnings,
    };
  }

  if (!post.metadata || typeof post.metadata !== "object") {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_INVALID,
      message: "metadata is required",
      details: {},
      warnings,
    };
  }

  const editorialId = post.metadata.editorialId;
  if (editorialId == null || String(editorialId).trim() === "") {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_INVALID,
      message: "metadata.editorialId is required",
      details: {},
      warnings,
    };
  }

  if (!Number.isFinite(maxLength) || maxLength < 0) {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_INVALID,
      message: "maxLength must be a non-negative number",
      details: { maxLength },
      warnings,
    };
  }

  const estimatedLength =
    post.metadata.estimatedLength != null
      ? Number(post.metadata.estimatedLength)
      : post.text.length;

  if (post.text.length > maxLength || estimatedLength > maxLength) {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_TOO_LONG,
      message: `text exceeds maxLength (${maxLength})`,
      details: {
        maxLength,
        textLength: post.text.length,
        estimatedLength,
      },
      warnings,
    };
  }

  if (hasLengthWarning(post.warnings)) {
    return {
      valid: false,
      code: ERROR_CODES.X_POST_TOO_LONG,
      message: "formatter reported a length warning",
      details: {
        maxLength,
        formatterWarnings: Array.isArray(post.warnings)
          ? post.warnings.slice()
          : [],
      },
      warnings: Array.isArray(post.warnings) ? post.warnings.slice() : [],
    };
  }

  return {
    valid: true,
    warnings,
    details: {
      maxLength,
      textLength: post.text.length,
      estimatedLength,
    },
  };
}

/**
 * Validate client success payload.
 * @param {*} response
 */
function assertValidClientResponse(response, ctx = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new XPublishError({
      code: ERROR_CODES.X_API_INVALID_RESPONSE,
      message: "client response must be an object",
      editorialId: ctx.editorialId,
      knowledgeId: ctx.knowledgeId,
    });
  }
  if (typeof response.remoteId !== "string" || !response.remoteId.trim()) {
    throw new XPublishError({
      code: ERROR_CODES.X_API_INVALID_RESPONSE,
      message: "client response.remoteId must be a non-empty string",
      editorialId: ctx.editorialId,
      knowledgeId: ctx.knowledgeId,
    });
  }
  if (typeof response.text !== "string") {
    throw new XPublishError({
      code: ERROR_CODES.X_API_INVALID_RESPONSE,
      message: "client response.text must be a string",
      editorialId: ctx.editorialId,
      knowledgeId: ctx.knowledgeId,
    });
  }
  return response;
}

/**
 * @param {object} options
 * @param {{ createPost: Function }} [options.client]
 * @param {function} [options.clock]
 * @param {number} [options.maxLength]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 */
function createXPublisher(options = {}) {
  const client = options.client || null;
  const clock = options.clock;
  const defaultMaxLength =
    options.maxLength == null ? DEFAULT_MAX_LENGTH : Number(options.maxLength);
  const logger = options.logger || null;

  function log(level, message, meta) {
    if (!logger || typeof logger[level] !== "function") return;
    // Never pass secrets; only safe meta keys.
    const safe = meta && typeof meta === "object"
      ? {
          editorialId: meta.editorialId,
          knowledgeId: meta.knowledgeId,
          code: meta.code,
          status: meta.status,
        }
      : undefined;
    logger[level](message, safe);
  }

  function runValidate(post, callOptions = {}) {
    return validatePost(post, {
      maxLength:
        callOptions.maxLength == null
          ? defaultMaxLength
          : callOptions.maxLength,
    });
  }

  /**
   * @param {object} post XP-001 formatted post
   * @param {{
   *   execute?: boolean,
   *   madeWithAI?: boolean,
   *   maxLength?: number,
   * }} [callOptions]
   */
  async function publishPost(post, callOptions = {}) {
    const execute = callOptions.execute === true;
    const madeWithAI = callOptions.madeWithAI === true;
    const validation = runValidate(post, callOptions);
    const editorialId =
      post && post.metadata && post.metadata.editorialId != null
        ? String(post.metadata.editorialId)
        : null;
    const knowledgeId =
      post && post.metadata && post.metadata.knowledgeId != null
        ? String(post.metadata.knowledgeId)
        : null;
    const estimatedLength =
      post && post.metadata && post.metadata.estimatedLength != null
        ? Number(post.metadata.estimatedLength)
        : post && typeof post.text === "string"
          ? post.text.length
          : 0;
    const text = post && typeof post.text === "string" ? post.text : "";

    if (!validation.valid) {
      throw new XPublishError({
        code: validation.code || ERROR_CODES.X_POST_INVALID,
        message: validation.message || "post validation failed",
        editorialId,
        knowledgeId,
        details: validation.details || {},
      });
    }

    if (!execute) {
      log("info", "x publish dry-run", { editorialId, knowledgeId });
      return {
        status: "dry-run",
        executed: false,
        editorialId,
        knowledgeId,
        text,
        estimatedLength,
        validation: {
          valid: true,
          warnings: validation.warnings || [],
        },
        publishedAt: null,
        remoteId: null,
      };
    }

    if (!client || typeof client.createPost !== "function") {
      throw new XPublishError({
        code: ERROR_CODES.X_PUBLISHER_NO_CLIENT,
        message: "client is required when execute: true",
        editorialId,
        knowledgeId,
      });
    }

    let response;
    try {
      response = await client.createPost({ text, madeWithAI });
    } catch (error) {
      const classified = classifyClientError(error, {
        editorialId,
        knowledgeId,
      });
      log("error", "x publish failed", {
        editorialId,
        knowledgeId,
        code: classified.code,
        status: classified.details && classified.details.status,
      });
      throw classified;
    }

    try {
      assertValidClientResponse(response, { editorialId, knowledgeId });
    } catch (error) {
      throw classifyClientError(error, { editorialId, knowledgeId });
    }

    const publishedAt = resolveClock(clock);
    log("info", "x publish ok", { editorialId, knowledgeId });
    return {
      status: "published",
      executed: true,
      editorialId,
      knowledgeId,
      text,
      estimatedLength,
      publishedAt,
      remoteId: response.remoteId,
      provider: "x",
      response: {
        remoteId: response.remoteId,
        text: response.text,
      },
    };
  }

  /**
   * @param {object[]} posts
   * @param {{
   *   execute?: boolean,
   *   limit?: number,
   *   continueOnError?: boolean,
   *   madeWithAI?: boolean,
   *   maxLength?: number,
   * }} [callOptions]
   */
  async function publishPosts(posts, callOptions = {}) {
    const execute = callOptions.execute === true;
    const continueOnError = callOptions.continueOnError === true;
    const madeWithAI = callOptions.madeWithAI === true;

    let list = Array.isArray(posts) ? posts.slice() : [];
    if (callOptions.limit != null) {
      const limit = Number(callOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        throw new XPublishError({
          code: ERROR_CODES.X_POST_INVALID,
          message: "limit must be a non-negative integer",
          details: { limit: callOptions.limit },
        });
      }
      list = list.slice(0, limit);
    }

    const results = [];
    let dryRunCount = 0;
    let publishedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const seenEditorialIds = new Set();

    for (let i = 0; i < list.length; i++) {
      const post = list[i];
      const editorialId =
        post && post.metadata && post.metadata.editorialId != null
          ? String(post.metadata.editorialId)
          : null;

      if (editorialId && seenEditorialIds.has(editorialId)) {
        skippedCount += 1;
        results.push({
          index: i,
          status: "skipped",
          executed: false,
          editorialId,
          knowledgeId:
            post && post.metadata && post.metadata.knowledgeId != null
              ? String(post.metadata.knowledgeId)
              : null,
          error: {
            code: ERROR_CODES.X_BATCH_DUPLICATE_EDITORIAL_ID,
            message: `duplicate editorialId in batch: ${editorialId}`,
          },
        });
        continue;
      }
      if (editorialId) seenEditorialIds.add(editorialId);

      try {
        const result = await publishPost(post, {
          execute,
          madeWithAI,
          maxLength: callOptions.maxLength,
        });
        results.push({ index: i, ...result });
        if (result.status === "dry-run") dryRunCount += 1;
        if (result.status === "published") publishedCount += 1;
      } catch (error) {
        errorCount += 1;
        const classified =
          error instanceof XPublishError
            ? error
            : classifyClientError(error, {
                editorialId,
                knowledgeId:
                  post && post.metadata && post.metadata.knowledgeId != null
                    ? String(post.metadata.knowledgeId)
                    : null,
              });
        results.push({
          index: i,
          status: "error",
          executed: false,
          editorialId: classified.editorialId,
          knowledgeId: classified.knowledgeId,
          error: {
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable === true,
          },
        });
        if (!continueOnError) break;
      }
    }

    return {
      results,
      summary: {
        totalCount: list.length,
        dryRunCount,
        publishedCount,
        errorCount,
        skippedCount,
      },
    };
  }

  return {
    client,
    maxLength: defaultMaxLength,
    validatePost: runValidate,
    publishPost,
    publishPosts,
  };
}

module.exports = {
  DEFAULT_MAX_LENGTH,
  ERROR_CODES,
  XPublishError,
  createXPublisher,
  validatePost,
  classifyClientError,
  assertValidClientResponse,
};
