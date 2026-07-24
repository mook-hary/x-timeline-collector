/**
 * Thin injectable AI JSON client for Aikido assistants.
 * Reuses OpenAI Responses API + OPENAI_API_KEY / OPENAI_MODEL (same as analyze_ai).
 */
const OpenAI = require("openai");

const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_TIMEOUT_MS = 60000;

function extractOutputText(response) {
  if (
    response &&
    typeof response.output_text === "string" &&
    response.output_text
  ) {
    return response.output_text;
  }
  if (!response || !Array.isArray(response.output)) {
    const err = new Error("AI response contained no text");
    err.code = "AI_RESPONSE_EMPTY";
    throw err;
  }
  const chunks = [];
  for (const item of response.output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content && content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  const text = chunks.join("").trim();
  if (!text) {
    const err = new Error("AI response was empty");
    err.code = "AI_RESPONSE_EMPTY";
    throw err;
  }
  return text;
}

/**
 * Strip optional markdown fences; keep existing analyze_ai JSON.parse path spirit.
 * @param {string} text
 */
function parseJsonLoose(text) {
  let raw = String(text || "").trim();
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) raw = fence[1].trim();
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error("AI response was not valid JSON");
    err.code = "AI_RESPONSE_INVALID";
    err.cause = error;
    throw err;
  }
}

function mapProviderError(error) {
  const status =
    error && (error.status || error.statusCode || (error.error && error.error.status));
  const message = error && error.message ? String(error.message) : "AI request failed";
  const lower = message.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    /api[_ ]?key|unauthorized|authentication/i.test(message)
  ) {
    const err = new Error("AI service authentication failed");
    err.code = "AI_CONFIG_MISSING";
    return err;
  }
  if (
    status === 429 ||
    status >= 500 ||
    /rate limit|insufficient|quota|credit|overloaded|timeout/i.test(lower)
  ) {
    const err = new Error(
      "AI service is temporarily unavailable or has insufficient credits."
    );
    err.code = "AI_DRAFT_GENERATION_FAILED";
    err.retryable = true;
    return err;
  }
  const err = new Error("AI draft generation failed");
  err.code = "AI_DRAFT_GENERATION_FAILED";
  err.cause = error;
  return err;
}

/**
 * @param {object} [options]
 * @param {string} [options.apiKey]
 * @param {string} [options.model]
 * @param {object} [options.openai] OpenAI SDK instance
 * @param {function} [options.completeJson] fully custom injectable
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.allowRetry]
 */
function createAikidoAiClient(options = {}) {
  if (typeof options.completeJson === "function") {
    return {
      configured: true,
      model: options.model || DEFAULT_MODEL,
      completeJson: options.completeJson,
    };
  }

  const apiKey =
    options.apiKey != null
      ? String(options.apiKey).trim()
      : process.env.OPENAI_API_KEY
        ? String(process.env.OPENAI_API_KEY).trim()
        : "";
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is required for AI Draft Assistant");
    err.code = "AI_CONFIG_MISSING";
    throw err;
  }

  const model =
    options.model != null && String(options.model).trim()
      ? String(options.model).trim()
      : process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const timeoutMs =
    options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  const allowRetry = options.allowRetry !== false;
  const openai =
    options.openai ||
    new OpenAI({
      apiKey,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
    });

  async function once(payload) {
    const response = await openai.responses.create(payload);
    const text = extractOutputText(response);
    return parseJsonLoose(text);
  }

  /**
   * @param {{
   *   instructions: string,
   *   input: string|object,
   *   schema: object,
   *   schemaName?: string,
   * }} args
   */
  async function completeJson(args = {}) {
    const instructions = String(args.instructions || "");
    const input =
      typeof args.input === "string"
        ? args.input
        : JSON.stringify(args.input || {}, null, 2);
    const schema = args.schema;
    const schemaName = args.schemaName || "aikido_response";
    if (!schema || typeof schema !== "object") {
      const err = new Error("JSON schema is required");
      err.code = "AI_RESPONSE_INVALID";
      throw err;
    }

    const payload = {
      model,
      instructions,
      input,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    };

    try {
      return await once(payload);
    } catch (error) {
      if (error && error.code && String(error.code).startsWith("AI_")) {
        throw error;
      }
      const mapped = mapProviderError(error);
      if (allowRetry && mapped.retryable === true) {
        try {
          return await once(payload);
        } catch (error2) {
          if (error2 && error2.code && String(error2.code).startsWith("AI_")) {
            throw error2;
          }
          throw mapProviderError(error2);
        }
      }
      throw mapped;
    }
  }

  return {
    configured: true,
    model,
    completeJson,
  };
}

/**
 * @param {object} [options]
 * @returns {{ configured: boolean, client?: object, error?: Error }}
 */
function tryCreateAikidoAiClientFromEnv(options = {}) {
  try {
    const client = createAikidoAiClient(options);
    return { configured: true, client };
  } catch (error) {
    return {
      configured: false,
      error:
        error && error.code === "AI_CONFIG_MISSING"
          ? error
          : Object.assign(new Error("AI Draft Assistant is not configured."), {
              code: "AI_CONFIG_MISSING",
              cause: error,
            }),
    };
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  createAikidoAiClient,
  tryCreateAikidoAiClientFromEnv,
  extractOutputText,
  parseJsonLoose,
  mapProviderError,
};
