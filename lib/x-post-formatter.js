/**
 * XP-001 — X Post Formatter.
 * Convert Editorial items to X post payloads without rewriting copy.
 * Does not post to X / OAuth / schedule.
 */
const FORMATTER_VERSION = "1";
const DEFAULT_MAX_LENGTH = 280;

function nowIso(nowFn) {
  if (typeof nowFn === "function") {
    const v = nowFn();
    return v instanceof Date ? v.toISOString() : String(v);
  }
  if (nowFn != null) {
    if (nowFn instanceof Date) return nowFn.toISOString();
    return String(nowFn);
  }
  return new Date().toISOString();
}

/**
 * Light structural normalize only (line endings). Does not rewrite wording.
 * @param {string} text
 */
function normalizeLineEndings(text) {
  return String(text == null ? "" : text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * @param {string} tag
 * @returns {string|null} hashtag without leading #
 */
function sanitizeHashtagToken(tag) {
  let value = String(tag == null ? "" : tag).trim();
  if (!value) return null;
  if (value.startsWith("#")) value = value.slice(1).trim();
  // Keep letters, numbers, underscore, CJK; drop spaces and punctuation.
  value = value.replace(/[^\w\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]/gu, "");
  if (!value) return null;
  return value;
}

/**
 * Collect hashtag tokens from editorial tags + metadata.hashtags.
 * @param {object} item
 * @returns {string[]}
 */
function collectHashtagTokens(item) {
  const out = [];
  const seen = new Set();
  function push(raw) {
    const token = sanitizeHashtagToken(raw);
    if (!token) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  }

  if (item && Array.isArray(item.tags)) {
    for (const tag of item.tags) push(tag);
  }
  const meta = item && item.metadata && typeof item.metadata === "object"
    ? item.metadata
    : {};
  if (Array.isArray(meta.hashtags)) {
    for (const tag of meta.hashtags) push(tag);
  }
  if (Array.isArray(meta.tags)) {
    for (const tag of meta.tags) push(tag);
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {number} [options.maxLength]
 * @param {boolean} [options.includeHashtags]
 * @param {function|string|Date|number} [options.now]
 */
function createXPostFormatter(options = {}) {
  const defaultMaxLength =
    options.maxLength == null ? DEFAULT_MAX_LENGTH : Number(options.maxLength);
  const defaultIncludeHashtags = options.includeHashtags === true;
  const nowFn = options.now;

  /**
   * @param {object} editorialItem
   * @param {{
   *   maxLength?: number,
   *   includeHashtags?: boolean,
   *   now?: *,
   * }} [callOptions]
   */
  function formatPost(editorialItem, callOptions = {}) {
    if (!editorialItem || typeof editorialItem !== "object") {
      const err = new Error("editorialItem must be an object");
      err.code = "x-post-formatter-item";
      throw err;
    }

    const maxLength =
      callOptions.maxLength == null
        ? defaultMaxLength
        : Number(callOptions.maxLength);
    if (!Number.isFinite(maxLength) || maxLength < 0) {
      const err = new Error("maxLength must be a non-negative number");
      err.code = "x-post-formatter-max-length";
      throw err;
    }

    const includeHashtags =
      callOptions.includeHashtags == null
        ? defaultIncludeHashtags
        : callOptions.includeHashtags === true;

    const formattedAt = nowIso(
      callOptions.now != null ? callOptions.now : nowFn
    );

    // Body is the post text; do not summarize / rewrite.
    let text = normalizeLineEndings(
      editorialItem.body == null ? "" : String(editorialItem.body)
    );
    // Trim only outer edges (formatting), keep internal wording intact.
    text = text.replace(/^\n+/, "").replace(/\n+$/, "");

    if (includeHashtags) {
      const tokens = collectHashtagTokens(editorialItem);
      if (tokens.length > 0) {
        const hashLine = tokens.map((t) => `#${t}`).join(" ");
        text = text ? `${text}\n\n${hashLine}` : hashLine;
      }
    }

    const estimatedLength = text.length;
    const warnings = [];
    if (estimatedLength > maxLength) {
      warnings.push(
        `exceeds maxLength (${maxLength}): estimatedLength=${estimatedLength}`
      );
    }

    const meta =
      editorialItem.metadata && typeof editorialItem.metadata === "object"
        ? editorialItem.metadata
        : {};

    return {
      text,
      warnings,
      metadata: {
        editorialId:
          editorialItem.id != null ? String(editorialItem.id) : null,
        knowledgeId:
          meta.knowledgeId != null ? String(meta.knowledgeId) : null,
        templateId:
          meta.templateId != null ? String(meta.templateId) : null,
        estimatedLength,
        formattedAt,
        formatterVersion: FORMATTER_VERSION,
      },
    };
  }

  /**
   * @param {object[]} items
   * @param {{
   *   limit?: number,
   *   maxLength?: number,
   *   includeHashtags?: boolean,
   *   now?: *,
   * }} [callOptions]
   */
  function formatPosts(items, callOptions = {}) {
    let list = Array.isArray(items) ? items.slice() : [];
    if (callOptions.limit != null) {
      const limit = Number(callOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        const err = new Error("limit must be a non-negative integer");
        err.code = "x-post-formatter-options";
        throw err;
      }
      list = list.slice(0, limit);
    }
    // Preserve input order.
    return list.map((item) => formatPost(item, callOptions));
  }

  return {
    formatterVersion: FORMATTER_VERSION,
    maxLength: defaultMaxLength,
    includeHashtags: defaultIncludeHashtags,
    formatPost,
    formatPosts,
  };
}

module.exports = {
  FORMATTER_VERSION,
  DEFAULT_MAX_LENGTH,
  createXPostFormatter,
  normalizeLineEndings,
  sanitizeHashtagToken,
  collectHashtagTokens,
};
