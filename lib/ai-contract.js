const crypto = require("crypto");

/**
 * Shared helpers for AI cache / progress execution contracts.
 * URL remains post Identity; reuse requires matching input fingerprint + execution contract.
 */

function normalizeHandle(authorHandle) {
  return String(authorHandle ?? "").trim();
}

function normalizeText(text) {
  let value = String(text ?? "").trim();
  value = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  value = value.replace(/[ \t]+/g, " ");
  value = value.replace(/\n{3,}/g, "\n\n");
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`
  );
  return `{${parts.join(",")}}`;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hashStable(value) {
  return sha256Hex(stableStringify(value));
}

function hasExecutionContractFields(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.inputFingerprint === "string" &&
      entry.inputFingerprint &&
      typeof entry.model === "string" &&
      entry.model &&
      typeof entry.promptVersion === "string" &&
      entry.promptVersion &&
      typeof entry.schemaVersion === "string" &&
      entry.schemaVersion
  );
}

function matchesExecutionContract(entry, contract) {
  if (!hasExecutionContractFields(entry) || !contract) return false;
  return (
    entry.inputFingerprint === contract.inputFingerprint &&
    entry.model === contract.model &&
    entry.promptVersion === contract.promptVersion &&
    entry.schemaVersion === contract.schemaVersion
  );
}

function buildCacheKey(contract) {
  return hashStable({
    model: contract.model,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    inputFingerprint: contract.inputFingerprint,
  });
}

/**
 * @param {object} entry
 * @param {{ promptVersion: string, schemaVersion: string }} currentVersions
 * @returns {"valid"|"legacy"|"mismatch"}
 */
function classifyCacheEntryKind(entry, currentVersions) {
  if (!hasExecutionContractFields(entry)) return "legacy";
  if (
    entry.promptVersion !== currentVersions.promptVersion ||
    entry.schemaVersion !== currentVersions.schemaVersion
  ) {
    return "mismatch";
  }
  return "valid";
}

module.exports = {
  normalizeHandle,
  normalizeText,
  stableStringify,
  sha256Hex,
  hashStable,
  hasExecutionContractFields,
  matchesExecutionContract,
  buildCacheKey,
  classifyCacheEntryKind,
};
