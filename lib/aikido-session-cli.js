/**
 * KS-001 — Knowledge Session CLI helpers.
 * List / detail for Source, Review, Knowledge (read-only).
 */
const { createAikidoSourceIntake } = require("./aikido-source-intake");
const { createAikidoCandidateReview } = require("./aikido-candidate-review");
const { createAikidoKnowledgeStore } = require("./aikido-knowledge");

const KINDS = ["source", "review", "knowledge"];

/**
 * Parse argv flags: --key=value, --flag, --flag=true/false
 * @param {string[]} argv
 */
function parseArgs(argv = []) {
  const out = {
    json: false,
    hasWarnings: undefined,
    id: undefined,
    status: undefined,
    type: undefined,
    category: undefined,
    difficulty: undefined,
    tag: undefined,
    limit: undefined,
    rootDir: undefined,
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
      case "json":
        out.json = value === true || value === "true" || value === "1";
        break;
      case "hasWarnings":
        if (value === true) out.hasWarnings = true;
        else if (value === "false" || value === "0") out.hasWarnings = false;
        else out.hasWarnings = true;
        break;
      case "id":
        out.id = String(value).trim();
        break;
      case "status":
        out.status = String(value).trim();
        break;
      case "type":
        out.type = String(value).trim();
        break;
      case "category":
        out.category = String(value).trim();
        break;
      case "difficulty":
        out.difficulty = String(value).trim();
        break;
      case "tag":
        out.tag = String(value).trim();
        break;
      case "limit":
        out.limit = String(value).trim();
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

function applyLimit(items, limitRaw) {
  if (limitRaw == null || limitRaw === "") return items;
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 0) {
    const err = new Error("limit must be a non-negative integer");
    err.code = "aikido-session-options";
    throw err;
  }
  return items.slice(0, limit);
}

function pad(str, width) {
  const s = str == null ? "" : String(str);
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function formatTable(columns, rows) {
  const widths = columns.map((col, i) => {
    let w = col.header.length;
    for (const row of rows) {
      const cell = row[i] == null ? "" : String(row[i]);
      if (cell.length > w) w = Math.min(cell.length, col.max || 48);
    }
    return Math.max(w, col.header.length);
  });

  const lines = [];
  lines.push(columns.map((col, i) => pad(col.header, widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    lines.push(
      columns
        .map((col, i) => {
          const cell = row[i] == null ? "" : String(row[i]);
          const clipped =
            col.max && cell.length > col.max
              ? `${cell.slice(0, col.max - 1)}…`
              : cell;
          return pad(clipped, widths[i]);
        })
        .join("  ")
    );
  }
  if (rows.length === 0) {
    lines.push("(none)");
  }
  return lines.join("\n") + "\n";
}

function formatDetail(record) {
  const lines = [];
  const keys = Object.keys(record || {});
  for (const key of keys) {
    const value = record[key];
    if (value != null && typeof value === "object") {
      lines.push(`${key}:`);
      const json = JSON.stringify(value, null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      lines.push(json);
    } else {
      lines.push(`${key}: ${value == null ? "" : String(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function createStores(rootDir) {
  const opts = rootDir ? { rootDir } : {};
  return {
    source: createAikidoSourceIntake(opts),
    review: createAikidoCandidateReview(opts),
    knowledge: createAikidoKnowledgeStore(opts),
  };
}

function listForKind(kind, stores, args) {
  if (kind === "source") {
    let items = stores.source.listSources({
      status: args.status,
      sourceType: args.type,
      tag: args.tag,
    });
    items = applyLimit(items, args.limit);
    return items;
  }
  if (kind === "review") {
    const listOptions = {
      status: args.status,
      category: args.category,
      difficulty: args.difficulty,
      tag: args.tag,
    };
    if (args.hasWarnings !== undefined) {
      listOptions.hasWarnings = args.hasWarnings;
    }
    // Prefer store limit when set; still apply CLI limit for consistency.
    if (args.limit != null && args.limit !== "") {
      listOptions.limit = Number(args.limit);
    }
    return stores.review.listReviews(listOptions);
  }
  if (kind === "knowledge") {
    let items = stores.knowledge.listKnowledge({
      status: args.status,
      category: args.category,
      difficulty: args.difficulty,
      tag: args.tag,
    });
    items = applyLimit(items, args.limit);
    return items;
  }
  const err = new Error(`unknown kind: ${kind}`);
  err.code = "aikido-session-kind";
  throw err;
}

function findForKind(kind, stores, id) {
  if (kind === "source") return stores.source.findSource(id);
  if (kind === "review") return stores.review.findReview(id);
  if (kind === "knowledge") return stores.knowledge.findKnowledge(id);
  return null;
}

function notFoundLabel(kind) {
  if (kind === "source") return "source";
  if (kind === "review") return "review";
  return "knowledge";
}

function tableForKind(kind, items) {
  if (kind === "source") {
    return formatTable(
      [
        { header: "ID", max: 36 },
        { header: "Title", max: 40 },
        { header: "Source Type", max: 16 },
        { header: "Status", max: 12 },
        { header: "CreatedAt", max: 24 },
      ],
      items.map((s) => [
        s.id,
        s.title,
        s.sourceType,
        s.status,
        s.createdAt,
      ])
    );
  }
  if (kind === "review") {
    return formatTable(
      [
        { header: "ID", max: 36 },
        { header: "Title", max: 40 },
        { header: "Status", max: 12 },
        { header: "Confidence", max: 10 },
        { header: "Category", max: 18 },
      ],
      items.map((r) => [
        r.id,
        r.title,
        r.status,
        r.confidence,
        r.category,
      ])
    );
  }
  return formatTable(
    [
      { header: "ID", max: 36 },
      { header: "Title", max: 40 },
      { header: "Category", max: 18 },
      { header: "Difficulty", max: 10 },
      { header: "Tags", max: 32 },
    ],
    items.map((k) => [
      k.id,
      k.title,
      k.category,
      k.difficulty,
      Array.isArray(k.tags) ? k.tags.join(",") : "",
    ])
  );
}

/**
 * @param {{
 *   kind: 'source'|'review'|'knowledge',
 *   argv?: string[],
 *   rootDir?: string,
 *   stdout?: { write(s: string): void },
 *   stderr?: { write(s: string): void },
 * }} options
 * @returns {{ exitCode: number, output?: string, error?: string }}
 */
function runSessionCli(options = {}) {
  const kind = options.kind;
  if (!KINDS.includes(kind)) {
    const msg = `unknown kind: ${kind} (expected ${KINDS.join("|")})`;
    const stderr = options.stderr || process.stderr;
    stderr.write(`${msg}\n`);
    return { exitCode: 1, error: msg };
  }

  const args = parseArgs(options.argv || []);
  const rootDir = options.rootDir || args.rootDir || undefined;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  try {
    const stores = createStores(rootDir);

    if (args.id) {
      const record = findForKind(kind, stores, args.id);
      if (!record) {
        const msg = `${notFoundLabel(kind)} not found: ${args.id}`;
        stderr.write(`${msg}\n`);
        return { exitCode: 1, error: msg };
      }
      const text = args.json
        ? `${JSON.stringify(record, null, 2)}\n`
        : formatDetail(record);
      stdout.write(text);
      return { exitCode: 0, output: text };
    }

    const items = listForKind(kind, stores, args);
    const text = args.json
      ? `${JSON.stringify(items, null, 2)}\n`
      : tableForKind(kind, items);
    stdout.write(text);
    return { exitCode: 0, output: text };
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    stderr.write(`${msg}\n`);
    return { exitCode: 1, error: msg };
  }
}

module.exports = {
  KINDS,
  parseArgs,
  applyLimit,
  formatTable,
  formatDetail,
  runSessionCli,
  listForKind,
  findForKind,
};
