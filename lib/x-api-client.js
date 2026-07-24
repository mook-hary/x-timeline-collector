/**
 * XP-002 — X API Client (POST /2/tweets).
 * Access token is injected; never logged or attached to thrown Errors.
 */
const DEFAULT_BASE_URL = "https://api.x.com";
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @param {object} options
 * @param {string} options.accessToken User access token (Bearer)
 * @param {typeof fetch} [options.fetcher]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 */
function createXApiClient(options = {}) {
  const accessToken =
    options.accessToken != null ? String(options.accessToken).trim() : "";
  if (!accessToken) {
    const err = new Error("accessToken is required");
    err.code = "X_ACCESS_TOKEN_MISSING";
    throw err;
  }

  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
  const timeoutMs =
    options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const err = new Error("timeoutMs must be a positive number");
    err.code = "X_API_INVALID_OPTIONS";
    throw err;
  }

  const fetcher =
    typeof options.fetcher === "function"
      ? options.fetcher
      : typeof fetch === "function"
        ? fetch.bind(globalThis)
        : null;
  if (!fetcher) {
    const err = new Error("fetcher is required (inject fetch)");
    err.code = "X_API_NO_FETCHER";
    throw err;
  }

  const logger = options.logger || null;

  function safeLog(level, message, meta) {
    if (!logger || typeof logger[level] !== "function") return;
    logger[level](message, meta && typeof meta === "object" ? { ...meta } : undefined);
  }

  function redact(value) {
    if (value == null) return value;
    let s = String(value);
    if (accessToken && s.includes(accessToken)) {
      s = s.split(accessToken).join("[REDACTED]");
    }
    s = s.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    return s;
  }

  /**
   * @param {{ text: string, madeWithAI?: boolean }} input
   * @returns {Promise<{ remoteId: string, text: string, raw: object }>}
   */
  async function createPost(input = {}) {
    const text = input.text;
    if (typeof text !== "string") {
      const err = new Error("text must be a string");
      err.code = "X_POST_INVALID";
      throw err;
    }

    const body = { text };
    if (input.madeWithAI === true) {
      body.made_with_ai = true;
    }

    const url = `${baseUrl}/2/tweets`;
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId = null;
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      const aborted =
        error &&
        (error.name === "AbortError" ||
          /aborted|timeout/i.test(String(error.message || "")));
      const err = new Error(
        aborted ? "X API request timed out" : redact(error && error.message)
      );
      err.code = "X_API_REQUEST_FAILED";
      err.retryable = true;
      err.cause = error;
      // Do not attach request headers or token.
      safeLog("error", "x api network error", {
        code: err.code,
        timedOut: aborted,
      });
      throw err;
    }
    if (timeoutId) clearTimeout(timeoutId);

    const status = response && response.status != null ? Number(response.status) : 0;
    let json = null;
    let rawText = "";
    try {
      if (response && typeof response.text === "function") {
        rawText = await response.text();
        json = rawText ? JSON.parse(rawText) : null;
      } else if (response && typeof response.json === "function") {
        json = await response.json();
      }
    } catch (_parseError) {
      json = null;
    }

    if (!response || !response.ok) {
      const err = new Error(
        redact(
          (json && (json.detail || json.title || json.message)) ||
            `X API HTTP ${status}`
        )
      );
      err.status = status;
      err.statusCode = status;
      if (status === 401 || status === 403) {
        err.code = "X_API_UNAUTHORIZED";
        err.retryable = false;
      } else if (status === 429) {
        err.code = "X_API_RATE_LIMITED";
        err.retryable = true;
      } else if (status >= 500) {
        err.code = "X_API_REQUEST_FAILED";
        err.retryable = true;
      } else {
        err.code = "X_API_REQUEST_FAILED";
        err.retryable = false;
      }
      // Attach sanitized API error payload only (no headers).
      if (json && typeof json === "object") {
        err.apiError = {
          title: json.title != null ? String(json.title) : undefined,
          detail: json.detail != null ? redact(json.detail) : undefined,
          type: json.type != null ? String(json.type) : undefined,
        };
      }
      safeLog("error", "x api http error", {
        status,
        code: err.code,
      });
      throw err;
    }

    const data = json && json.data && typeof json.data === "object" ? json.data : null;
    const remoteId = data && data.id != null ? String(data.id) : "";
    const responseText =
      data && data.text != null ? String(data.text) : String(text);

    if (!remoteId) {
      const err = new Error("X API response missing data.id");
      err.code = "X_API_INVALID_RESPONSE";
      err.status = status;
      throw err;
    }

    safeLog("info", "x api createPost ok", { status });
    return {
      remoteId,
      text: responseText,
      raw: json && typeof json === "object" ? json : { data: { id: remoteId, text: responseText } },
    };
  }

  return {
    baseUrl,
    timeoutMs,
    createPost,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  createXApiClient,
};
