/**
 * KP-006 — Knowledge Seed CLI helpers.
 * Maps CLI args onto existing Knowledge Store schema (no new format).
 */
const {
  createAikidoKnowledgeStore,
  normalizeKnowledge,
  normalizeDifficulty,
} = require("./aikido-knowledge");

const ERROR_CODES = Object.freeze({
  KNOWLEDGE_TITLE_REQUIRED: "KNOWLEDGE_TITLE_REQUIRED",
  KNOWLEDGE_CATEGORY_REQUIRED: "KNOWLEDGE_CATEGORY_REQUIRED",
  KNOWLEDGE_BODY_REQUIRED: "KNOWLEDGE_BODY_REQUIRED",
});

/** CLI-only aliases → schema difficulty 1–5. */
const DIFFICULTY_ALIASES = Object.freeze({
  beginner: 1,
  easy: 1,
  intermediate: 3,
  normal: 3,
  medium: 3,
  advanced: 5,
  hard: 5,
});

/**
 * @param {string[]} argv
 */
function parseKnowledgeAddArgs(argv = []) {
  const out = {
    title: undefined,
    category: undefined,
    body: undefined,
    summary: undefined,
    difficulty: undefined,
    tags: undefined,
    sourceId: undefined,
    json: false,
    dryRun: false,
    rootDir: undefined,
    id: undefined,
  };

  for (const raw of argv) {
    if (!raw || !raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    let key;
    let value;
    if (eq === -1) {
      key = raw.slice(2);
      value = true;
    } else {
      key = raw.slice(2, eq);
      value = raw.slice(eq + 1);
    }

    switch (key) {
      case "title":
        out.title = String(value).trim();
        break;
      case "category":
        out.category = String(value).trim();
        break;
      case "body":
        out.body = String(value);
        break;
      case "summary":
        out.summary = String(value);
        break;
      case "difficulty":
        out.difficulty = String(value).trim();
        break;
      case "tags":
        out.tags = String(value);
        break;
      case "source-id":
      case "sourceId":
        out.sourceId = String(value).trim();
        break;
      case "id":
        out.id = String(value).trim();
        break;
      case "json":
        out.json = value === true || value === "true" || value === "1";
        break;
      case "dry-run":
      case "dryRun":
        out.dryRun = value === true || value === "true" || value === "1";
        break;
      case "rootDir":
        out.rootDir = String(value).trim();
        break;
      default:
        break;
    }
  }

  return out;
}

/**
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseTags(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Resolve CLI difficulty (alias or 1–5) to schema integer.
 * Default when omitted: 1.
 * @param {string|number|undefined} raw
 */
function resolveDifficulty(raw) {
  if (raw == null || raw === "") return 1;
  if (typeof raw === "string") {
    const key = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DIFFICULTY_ALIASES, key)) {
      return DIFFICULTY_ALIASES[key];
    }
  }
  return normalizeDifficulty(raw);
}

/**
 * Build Knowledge create input from CLI args (existing schema fields only).
 * @param {ReturnType<typeof parseKnowledgeAddArgs>} args
 */
function buildKnowledgeInput(args) {
  if (!args.title || !String(args.title).trim()) {
    const err = new Error("title is required (--title=...)");
    err.code = ERROR_CODES.KNOWLEDGE_TITLE_REQUIRED;
    throw err;
  }
  if (!args.category || !String(args.category).trim()) {
    const err = new Error("category is required (--category=...)");
    err.code = ERROR_CODES.KNOWLEDGE_CATEGORY_REQUIRED;
    throw err;
  }
  if (args.body == null || !String(args.body).trim()) {
    const err = new Error("body is required (--body=...)");
    err.code = ERROR_CODES.KNOWLEDGE_BODY_REQUIRED;
    throw err;
  }

  const input = {
    title: String(args.title).trim(),
    category: String(args.category).trim(),
    summary:
      args.summary != null ? String(args.summary) : "",
    content: String(args.body),
    tags: parseTags(args.tags),
    difficulty: resolveDifficulty(args.difficulty),
    sources: args.sourceId ? [String(args.sourceId).trim()] : [],
    related: [],
  };
  if (args.id) input.id = args.id;
  return input;
}

/**
 * @param {{
 *   argv?: string[],
 *   rootDir?: string,
 *   knowledgeStore?: object,
 *   now?: function,
 *   stdout?: { write: Function },
 *   stderr?: { write: Function },
 * }} options
 */
function runKnowledgeAdd(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const args = parseKnowledgeAddArgs(options.argv || []);
  const rootDir = options.rootDir || args.rootDir;

  let input;
  try {
    input = buildKnowledgeInput(args);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const code = error && error.code ? error.code : "aikido-knowledge-add";
    if (args.json) {
      stdout.write(
        `${JSON.stringify({ ok: false, code, error: message }, null, 2)}\n`
      );
    } else {
      stderr.write(`${code}: ${message}\n`);
    }
    return { exitCode: 1, code, error: message };
  }

  const store =
    options.knowledgeStore ||
    createAikidoKnowledgeStore({
      rootDir: rootDir || undefined,
      now: options.now,
    });

  let knowledge;
  try {
    knowledge = normalizeKnowledge(input, {
      isCreate: true,
      now:
        typeof options.now === "function"
          ? options.now()
          : options.now != null
            ? String(options.now)
            : undefined,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const code = error && error.code ? error.code : "aikido-knowledge-validate";
    if (args.json) {
      stdout.write(
        `${JSON.stringify({ ok: false, code, error: message }, null, 2)}\n`
      );
    } else {
      stderr.write(`${code}: ${message}\n`);
    }
    return { exitCode: 1, code, error: message };
  }

  if (args.dryRun) {
    if (args.json) {
      stdout.write(
        `${JSON.stringify({ ok: true, dryRun: true, knowledge }, null, 2)}\n`
      );
    } else {
      stdout.write("DRY RUN\n");
      stdout.write("No files were written.\n\n");
      stdout.write(`${JSON.stringify(knowledge, null, 2)}\n`);
    }
    return { exitCode: 0, dryRun: true, knowledge, written: false };
  }

  let created;
  try {
    created = store.createKnowledge(input);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const code = error && error.code ? error.code : "aikido-knowledge-io";
    if (args.json) {
      stdout.write(
        `${JSON.stringify({ ok: false, code, error: message }, null, 2)}\n`
      );
    } else {
      stderr.write(`${code}: ${message}\n`);
    }
    return { exitCode: 1, code, error: message };
  }

  if (args.json) {
    stdout.write(
      `${JSON.stringify({ ok: true, knowledge: created }, null, 2)}\n`
    );
  } else {
    stdout.write("Knowledge created.\n\n");
    stdout.write(`ID: ${created.id}\n`);
    stdout.write(`Title: ${created.title}\n`);
    stdout.write(`Category: ${created.category}\n`);
  }

  return { exitCode: 0, dryRun: false, knowledge: created, written: true };
}

module.exports = {
  ERROR_CODES,
  DIFFICULTY_ALIASES,
  parseKnowledgeAddArgs,
  parseTags,
  resolveDifficulty,
  buildKnowledgeInput,
  runKnowledgeAdd,
};
