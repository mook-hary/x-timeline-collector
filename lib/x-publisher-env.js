/**
 * XP-002 — Build X Publisher from environment.
 * Does not load secrets at module import time.
 */
const { createXApiClient } = require("./x-api-client");
const { createXPublisher } = require("./x-publisher");

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv|object} [options.env]
 * @param {typeof fetch} [options.fetcher]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @param {function} [options.clock]
 * @param {number} [options.maxLength]
 * @param {object} [options.logger]
 * @param {object} [options.client] override client (tests)
 */
function createXPublisherFromEnv(options = {}) {
  const env = options.env || process.env;
  const accessToken =
    env && env.X_USER_ACCESS_TOKEN != null
      ? String(env.X_USER_ACCESS_TOKEN).trim()
      : "";

  if (!accessToken) {
    const err = new Error(
      "X_USER_ACCESS_TOKEN is required to create an X publisher from env"
    );
    err.code = "X_ACCESS_TOKEN_MISSING";
    throw err;
  }

  const client =
    options.client ||
    createXApiClient({
      accessToken,
      fetcher: options.fetcher,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      logger: options.logger,
    });

  return createXPublisher({
    client,
    clock: options.clock,
    maxLength: options.maxLength,
    logger: options.logger,
  });
}

module.exports = {
  createXPublisherFromEnv,
};
