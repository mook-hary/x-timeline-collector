/**
 * EP-052 — Editorial Rules Engine.
 * Returns error / warning / info findings only (no workflow mutation).
 */
const { normalizeText } = require("./editorial-similarity");

const ALLOWED_SEVERITIES = Object.freeze(["error", "warning", "info"]);
const SEVERITY_SET = new Set(ALLOWED_SEVERITIES);

/**
 * @param {object} definition
 */
function createRule(definition) {
  if (!definition || typeof definition !== "object") {
    const err = new Error("rule definition must be an object");
    err.code = "editorial-rule";
    throw err;
  }
  const id = String(definition.id || "").trim();
  if (!id) {
    const err = new Error("rule id is required");
    err.code = "editorial-rule";
    throw err;
  }
  const description = String(definition.description || "").trim();
  if (!description) {
    const err = new Error(`rule description is required (${id})`);
    err.code = "editorial-rule";
    throw err;
  }
  const severity = String(definition.severity || "").trim();
  if (!SEVERITY_SET.has(severity)) {
    const err = new Error(
      `rule severity must be one of: ${ALLOWED_SEVERITIES.join(", ")} (got ${definition.severity})`
    );
    err.code = "editorial-rule-severity";
    throw err;
  }
  if (typeof definition.check !== "function") {
    const err = new Error(`rule check must be a function (${id})`);
    err.code = "editorial-rule";
    throw err;
  }

  return {
    id,
    description,
    severity,
    enabled: definition.enabled !== false,
    sources: normalizeStringList(definition.sources, "sources"),
    types: normalizeStringList(definition.types, "types"),
    check: definition.check,
  };
}

function normalizeStringList(value, fieldName) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    const err = new Error(`rule ${fieldName} must be an array when provided`);
    err.code = "editorial-rule";
    throw err;
  }
  return value.map((v) => String(v));
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function contentLength(item) {
  const summary = normalizeText(item && item.summary);
  const body = normalizeText(item && item.body);
  return [summary, body].filter(Boolean).join(" ").length;
}

function shouldSkipRule(rule, item) {
  if (rule.enabled === false) {
    return { skip: true, message: "Rule is disabled" };
  }
  if (Array.isArray(rule.sources) && rule.sources.length > 0) {
    if (!rule.sources.includes(item && item.source)) {
      return {
        skip: true,
        message: `Source "${item && item.source}" not in rule sources`,
      };
    }
  }
  if (Array.isArray(rule.types) && rule.types.length > 0) {
    if (!rule.types.includes(item && item.type)) {
      return {
        skip: true,
        message: `Type "${item && item.type}" not in rule types`,
      };
    }
  }
  return { skip: false };
}

/**
 * @returns {{ ruleId, severity, status, message, details }}
 */
function evaluateRule(rule, item, context = {}) {
  const validated =
    rule && rule.id && typeof rule.check === "function"
      ? rule
      : createRule(rule);

  const skip = shouldSkipRule(validated, item);
  if (skip.skip) {
    return {
      ruleId: validated.id,
      severity: validated.severity,
      status: "skipped",
      message: skip.message,
      details: {},
    };
  }

  try {
    const outcome = validated.check(item, context || {}) || {};
    if (outcome.__skip === true) {
      return {
        ruleId: validated.id,
        severity: validated.severity,
        status: "skipped",
        message: outcome.message || "Skipped",
        details:
          outcome.details && typeof outcome.details === "object"
            ? outcome.details
            : {},
      };
    }
    const passed = outcome.passed !== false;
    return {
      ruleId: validated.id,
      severity: validated.severity,
      status: passed ? "passed" : "failed",
      message:
        outcome.message == null
          ? passed
            ? null
            : validated.description
          : outcome.message,
      details:
        outcome.details && typeof outcome.details === "object"
          ? outcome.details
          : {},
    };
  } catch (error) {
    const safe =
      error && error.message
        ? String(error.message).slice(0, 200)
        : "rule check failed";
    return {
      ruleId: validated.id,
      severity: validated.severity,
      status: "failed",
      message: `Rule error: ${safe}`,
      details: { thrown: true },
    };
  }
}

/**
 * @returns {{ passed, counts, results }}
 */
function evaluateRules(item, rules, context = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const seen = new Set();
  const normalized = [];
  for (const raw of list) {
    const rule = createRule(raw);
    if (seen.has(rule.id)) {
      const err = new Error(`duplicate rule id: ${rule.id}`);
      err.code = "editorial-rule-duplicate";
      throw err;
    }
    seen.add(rule.id);
    normalized.push(rule);
  }

  const results = normalized.map((rule) =>
    evaluateRule(rule, item, context || {})
  );

  const counts = { error: 0, warning: 0, info: 0, skipped: 0 };
  for (const result of results) {
    if (result.status === "skipped") {
      counts.skipped += 1;
      continue;
    }
    if (result.status === "failed") {
      if (result.severity === "error") counts.error += 1;
      else if (result.severity === "warning") counts.warning += 1;
      else if (result.severity === "info") counts.info += 1;
    }
  }

  return {
    passed: counts.error === 0,
    counts,
    results,
  };
}

/**
 * Built-in publish-prep rules.
 */
function getDefaultRules() {
  return [
    createRule({
      id: "title-required",
      description: "Title is required",
      severity: "error",
      check(item) {
        if (isBlank(item && item.title)) {
          return { passed: false, message: "Title is required", details: {} };
        }
        return { passed: true, message: null, details: {} };
      },
    }),
    createRule({
      id: "body-or-summary-required",
      description: "Summary or body is required",
      severity: "error",
      check(item) {
        if (isBlank(item && item.summary) && isBlank(item && item.body)) {
          return {
            passed: false,
            message: "Summary or body is required",
            details: {},
          };
        }
        return { passed: true, message: null, details: {} };
      },
    }),
    createRule({
      id: "short-content",
      description: "Content is shorter than 100 normalized characters",
      severity: "warning",
      check(item) {
        const length = contentLength(item);
        if (length < 100) {
          return {
            passed: false,
            message: `Content length ${length} is under 100 characters`,
            details: { length },
          };
        }
        return { passed: true, message: null, details: { length } };
      },
    }),
    createRule({
      id: "tags-recommended",
      description: "Tags are recommended",
      severity: "warning",
      check(item) {
        const tags = Array.isArray(item && item.tags) ? item.tags : [];
        const usable = tags.filter((t) => !isBlank(t));
        if (usable.length === 0) {
          return {
            passed: false,
            message: "Tags are recommended",
            details: { tagCount: 0 },
          };
        }
        return {
          passed: true,
          message: null,
          details: { tagCount: usable.length },
        };
      },
    }),
    createRule({
      id: "high-similarity",
      description: "High similarity to existing content",
      severity: "warning",
      check(_item, context) {
        if (
          !context ||
          context.maxSimilarity == null ||
          context.maxSimilarity === ""
        ) {
          return {
            __skip: true,
            message: "maxSimilarity not provided",
            details: {},
          };
        }
        const max = Number(context.maxSimilarity);
        if (!Number.isFinite(max)) {
          return {
            passed: false,
            message: "maxSimilarity is not a finite number",
            details: { maxSimilarity: context.maxSimilarity },
          };
        }
        if (max >= 0.85) {
          return {
            passed: false,
            message: `maxSimilarity ${max} is >= 0.85`,
            details: { maxSimilarity: max },
          };
        }
        return {
          passed: true,
          message: null,
          details: { maxSimilarity: max },
        };
      },
    }),
    createRule({
      id: "publishable-status",
      description: "Publish requires approved or scheduled status",
      severity: "error",
      check(item, context) {
        if (!context || context.operation !== "publish") {
          return {
            __skip: true,
            message: 'Skipped unless context.operation === "publish"',
            details: {},
          };
        }
        const status = item && item.status;
        if (status === "approved" || status === "scheduled") {
          return { passed: true, message: null, details: { status } };
        }
        return {
          passed: false,
          message: `status "${status}" is not publishable (need approved or scheduled)`,
          details: { status },
        };
      },
    }),
  ];
}

module.exports = {
  ALLOWED_SEVERITIES,
  createRule,
  evaluateRule,
  evaluateRules,
  getDefaultRules,
  contentLength,
  isBlank,
};
