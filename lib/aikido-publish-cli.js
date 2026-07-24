/**
 * XP-004 — Aikido X Publish CLI core.
 * Default dry-run; execute only when --confirm (and not --dry-run).
 */
const { createXPostFormatter } = require("./x-post-formatter");
const { computeChecksum } = require("./publish-ledger");

/**
 * @param {string[]} argv
 */
function parsePublishArgs(argv = []) {
  const out = {
    id: undefined,
    category: undefined,
    dryRun: false,
    confirm: false,
    json: false,
    limit: undefined,
    continueOnError: false,
    madeWithAI: false,
    force: false,
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
      case "id":
        out.id = String(value).trim();
        break;
      case "category":
        out.category = String(value).trim();
        break;
      case "dry-run":
      case "dryRun":
        out.dryRun = value === true || value === "true" || value === "1";
        break;
      case "confirm":
        out.confirm = value === true || value === "true" || value === "1";
        break;
      case "json":
        out.json = value === true || value === "true" || value === "1";
        break;
      case "limit":
        out.limit = String(value).trim();
        break;
      case "continueOnError":
        out.continueOnError =
          value === true || value === "true" || value === "1";
        break;
      case "madeWithAI":
        out.madeWithAI = value === true || value === "true" || value === "1";
        break;
      case "force":
        out.force = value === true || value === "true" || value === "1";
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
 * Select editorial items by id or knowledge category.
 * @param {{
 *   editorialStore: { find: Function, list: Function },
 *   knowledgeStore?: { listKnowledge: Function },
 *   id?: string,
 *   category?: string,
 *   limit?: string|number,
 * }} opts
 */
function selectEditorialItems(opts) {
  const { editorialStore, knowledgeStore, id, category } = opts;
  if (!editorialStore) {
    const err = new Error("editorialStore is required");
    err.code = "aikido-publish-deps";
    throw err;
  }

  let items = [];
  if (id) {
    const item = editorialStore.find(id);
    if (!item) {
      const err = new Error(`editorial item not found: ${id}`);
      err.code = "aikido-publish-not-found";
      throw err;
    }
    items = [item];
  } else if (category) {
    const knowledgeIds = new Set();
    if (knowledgeStore && typeof knowledgeStore.listKnowledge === "function") {
      for (const k of knowledgeStore.listKnowledge({ category })) {
        if (k && k.id) knowledgeIds.add(String(k.id));
      }
    }
    items = editorialStore.list().filter((item) => {
      if (!item) return false;
      const meta = item.metadata && typeof item.metadata === "object"
        ? item.metadata
        : {};
      if (meta.knowledgeCategory === category) return true;
      if (meta.knowledgeId && knowledgeIds.has(String(meta.knowledgeId))) {
        return true;
      }
      return false;
    });
  } else {
    const err = new Error(
      "Usage: --id=<editorial-id> or --category=<category>"
    );
    err.code = "aikido-publish-usage";
    throw err;
  }

  if (opts.limit != null && opts.limit !== "") {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      const err = new Error("limit must be a non-negative integer");
      err.code = "aikido-publish-options";
      throw err;
    }
    items = items.slice(0, limit);
  }

  return items;
}

function duplicateReason(ledger, editorialId, checksum) {
  if (!ledger) return null;
  if (
    editorialId &&
    typeof ledger.findByEditorialId === "function" &&
    ledger.findByEditorialId(editorialId)
  ) {
    return {
      code: "DUPLICATE_EDITORIAL_ID",
      message: `already published for editorialId=${editorialId}`,
    };
  }
  if (
    checksum &&
    typeof ledger.findByChecksum === "function" &&
    ledger.findByChecksum(checksum)
  ) {
    return {
      code: "DUPLICATE_CHECKSUM",
      message: `already published for checksum=${checksum.slice(0, 12)}…`,
    };
  }
  return null;
}

/**
 * @param {{
 *   argv?: string[],
 *   editorialStore: object,
 *   knowledgeStore?: object,
 *   formatter?: object,
 *   publisher: { publishPost: Function },
 *   ledger: {
 *     recordPublish: Function,
 *     findByEditorialId?: Function,
 *     findByChecksum?: Function,
 *     computeChecksum?: Function,
 *   },
 *   stdout?: { write: Function },
 *   stderr?: { write: Function },
 * }} options
 */
async function runAikidoPublish(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const args = parsePublishArgs(options.argv || []);

  // Safety: --dry-run wins over --confirm
  const execute = args.confirm === true && args.dryRun !== true;

  const summary = {
    totalCount: 0,
    publishedCount: 0,
    skippedCount: 0,
    dryRunCount: 0,
    errorCount: 0,
  };
  const results = [];

  let items;
  try {
    items = selectEditorialItems({
      editorialStore: options.editorialStore,
      knowledgeStore: options.knowledgeStore,
      id: args.id,
      category: args.category,
      limit: args.limit,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    stderr.write(`${message}\n`);
    return {
      exitCode: error && error.code === "aikido-publish-usage" ? 2 : 1,
      execute,
      results,
      summary,
      error: message,
    };
  }

  summary.totalCount = items.length;
  const formatter =
    options.formatter || createXPostFormatter({ includeHashtags: false });
  const publisher = options.publisher;
  const ledger = options.ledger;

  if (!publisher || typeof publisher.publishPost !== "function") {
    const message = "publisher is required";
    stderr.write(`${message}\n`);
    return { exitCode: 1, execute, results, summary, error: message };
  }
  if (!ledger || typeof ledger.recordPublish !== "function") {
    const message = "ledger is required";
    stderr.write(`${message}\n`);
    return { exitCode: 1, execute, results, summary, error: message };
  }

  const checksumOf =
    typeof ledger.computeChecksum === "function"
      ? ledger.computeChecksum.bind(ledger)
      : computeChecksum;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const editorialId = item.id != null ? String(item.id) : null;

    try {
      const formatted = formatter.formatPost(item);
      const checksum = checksumOf(formatted.text);

      if (!args.force) {
        const dup = duplicateReason(ledger, editorialId, checksum);
        if (dup) {
          summary.skippedCount += 1;
          results.push({
            index: i,
            status: "skipped",
            editorialId,
            knowledgeId:
              formatted.metadata && formatted.metadata.knowledgeId
                ? formatted.metadata.knowledgeId
                : null,
            text: formatted.text,
            checksum,
            error: dup,
          });
          continue;
        }
      }

      const publishResult = await publisher.publishPost(formatted, {
        execute,
        madeWithAI: args.madeWithAI,
      });

      let ledgerRecord = null;
      if (publishResult && publishResult.status === "published") {
        ledgerRecord = ledger.recordPublish(publishResult, {
          templateId:
            formatted.metadata && formatted.metadata.templateId
              ? formatted.metadata.templateId
              : null,
          formatterVersion:
            formatted.metadata && formatted.metadata.formatterVersion
              ? formatted.metadata.formatterVersion
              : null,
        });
        summary.publishedCount += 1;
      } else if (publishResult && publishResult.status === "dry-run") {
        summary.dryRunCount += 1;
      }

      results.push({
        index: i,
        status: publishResult.status,
        editorialId,
        knowledgeId: publishResult.knowledgeId,
        text: publishResult.text,
        remoteId: publishResult.remoteId || null,
        publishedAt: publishResult.publishedAt || null,
        checksum,
        ledgerId: ledgerRecord && ledgerRecord.publishId
          ? ledgerRecord.publishId
          : null,
        warnings: formatted.warnings || [],
      });
    } catch (error) {
      summary.errorCount += 1;
      const code = error && error.code ? error.code : "aikido-publish-error";
      const message =
        error && error.message ? error.message : String(error);
      results.push({
        index: i,
        status: "error",
        editorialId,
        knowledgeId:
          item.metadata && item.metadata.knowledgeId
            ? item.metadata.knowledgeId
            : null,
        error: { code, message },
      });
      if (!args.continueOnError) break;
    }
  }

  const payload = {
    execute,
    confirm: args.confirm,
    dryRun: !execute,
    results,
    summary: {
      total: summary.totalCount,
      published: summary.publishedCount,
      skipped: summary.skippedCount,
      dryRun: summary.dryRunCount,
      errors: summary.errorCount,
    },
  };

  if (args.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    stdout.write("Aikido X Publish\n\n");
    stdout.write(execute ? "Mode: CONFIRM (execute)\n" : "Mode: dry-run\n");
    stdout.write("\n");
    for (const row of results) {
      if (row.status === "skipped") {
        stdout.write(
          `SKIP  ${row.editorialId}: ${row.error && row.error.message}\n`
        );
      } else if (row.status === "error") {
        stdout.write(
          `ERR   ${row.editorialId}: ${row.error && row.error.message}\n`
        );
      } else if (row.status === "published") {
        stdout.write(
          `OK    ${row.editorialId} -> remoteId=${row.remoteId}\n`
        );
        if (row.text) stdout.write(`${row.text}\n\n`);
      } else if (row.status === "dry-run") {
        stdout.write(`DRY   ${row.editorialId}\n`);
        if (row.text) stdout.write(`${row.text}\n\n`);
      }
    }
    stdout.write("Summary\n");
    stdout.write(`Total: ${payload.summary.total}\n`);
    stdout.write(`Published: ${payload.summary.published}\n`);
    stdout.write(`Skipped: ${payload.summary.skipped}\n`);
    stdout.write(`Dry-run: ${payload.summary.dryRun}\n`);
    stdout.write(`Errors: ${payload.summary.errors}\n`);
  }

  return {
    exitCode: summary.errorCount > 0 ? 1 : 0,
    execute,
    ...payload,
  };
}

module.exports = {
  parsePublishArgs,
  selectEditorialItems,
  duplicateReason,
  runAikidoPublish,
};
