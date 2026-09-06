/** Safe, internal diagnostics. Never serialize SDK errors or provider prose. */
const MESSAGES = Object.freeze({
  missing_api_key: 'API key is not configured.',
  auth_error: 'API authentication or permission was rejected.',
  model_error: 'Requested model is unavailable or unsupported.',
  request_error: 'API request or network connection failed.',
  rate_limit: 'API rate limit or quota was exceeded.',
  timeout: 'API request timed out.',
  invalid_response: 'Response was empty, unreadable, or not valid JSON.',
  schema_validation_error: 'Structured-output schema was rejected or output failed validation.',
  unknown_error: 'Evaluation failed for an unclassified reason.',
});
const SAFE_CODES = new Set([
  'missing_api_key', 'invalid_api_key', 'model_not_found', 'unsupported_model',
  'rate_limit_exceeded', 'insufficient_quota', 'invalid_json_schema',
  'invalid_request_error', 'authentication_error', 'permission_denied',
  'server_error', 'invalid_output', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);
const PHASES = ['before_request', 'during_request', 'after_response', 'schema_validation'];
function safeToken(value, pattern) {
  if (typeof value !== 'string' || value.length > 100 || !pattern.test(value)) return null;
  if (/sk-|bearer|secret|authorization/i.test(value)) return null;
  // Even a syntactically valid token must not echo the configured credential.
  if (process.env.OPENAI_API_KEY && value.includes(process.env.OPENAI_API_KEY)) return null;
  return value;
}
function failureDiagnostic(error, context = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const code = error?.code || error?.error?.code;
  const type = error?.type || error?.error?.type;
  const phase = PHASES.includes(context.phase) ? context.phase : 'before_request';
  // Inspect prose only to classify. Never include it in the returned diagnostic.
  const hint = [error?.name, code, type, error?.message, error?.param, error?.cause?.code].filter(v => typeof v === 'string').join(' ').slice(0, 8000);
  let category = 'unknown_error';
  if (code === 'missing_api_key') category = 'missing_api_key';
  else if (phase === 'schema_validation') category = 'schema_validation_error';
  else if (phase === 'after_response' || code === 'invalid_output') category = 'invalid_response';
  else if (status === 401 || status === 403 || /AuthenticationError|invalid_api_key/.test(hint)) category = 'auth_error';
  else if (status === 429 || /RateLimitError|rate_limit_exceeded|insufficient_quota/.test(hint)) category = 'rate_limit';
  else if (status === 408 || /timeout|timed out|ETIMEDOUT/i.test(hint)) category = 'timeout';
  else if (/model_not_found|unsupported_model|model.*(not found|does not exist|unsupported|not available)/i.test(hint)) category = 'model_error';
  else if (/invalid_json_schema|json_schema|response_format|text.format.schema/i.test(hint)) category = 'schema_validation_error';
  else if (status || /APIConnectionError|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(hint)) category = 'request_error';
  return {
    category, phase, httpStatus: status,
    apiCode: SAFE_CODES.has(code) ? code : null,
    apiType: SAFE_CODES.has(type) ? type : null,
    model: safeToken(context.model, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
    promptVersion: safeToken(context.promptVersion, /^[a-zA-Z0-9._-]+$/),
    schemaVersion: safeToken(context.schemaVersion, /^[a-zA-Z0-9._-]+$/),
    requestId: safeToken(context.requestId || error?.request_id, /^req_[a-zA-Z0-9_-]+$/),
    message: MESSAGES[category],
  };
}
function printFailureDiagnostics(diagnostics, log = console.log) {
  for (const diagnostic of diagnostics) log(`[visual-value:failure] ${JSON.stringify(diagnostic)}`);
}
module.exports = { failureDiagnostic, printFailureDiagnostics };
