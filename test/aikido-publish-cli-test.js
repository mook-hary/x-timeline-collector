/**
 * XP-004 — Aikido X Publish CLI.
 * Run: node test/aikido-publish-cli-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  parsePublishArgs,
  runAikidoPublish,
} = require("../lib/aikido-publish-cli");
const { createEditorialStore } = require("../lib/editorial-store");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createPublishLedger, computeChecksum } = require("../lib/publish-ledger");
const { createXPostFormatter } = require("../lib/x-post-formatter");
const { createXPublisher } = require("../lib/x-publisher");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T02:00:00.000Z";

function createFakePublisher(handlers = {}) {
  const calls = [];
  return {
    calls,
    async publishPost(post, opts = {}) {
      calls.push({ post, opts });
      if (typeof handlers.publishPost === "function") {
        return handlers.publishPost(post, opts);
      }
      if (opts.execute === true) {
        return {
          status: "published",
          executed: true,
          editorialId: post.metadata.editorialId,
          knowledgeId: post.metadata.knowledgeId,
          text: post.text,
          estimatedLength: post.text.length,
          publishedAt: NOW,
          remoteId: `remote-${post.metadata.editorialId}`,
          provider: "x",
          response: {
            remoteId: `remote-${post.metadata.editorialId}`,
            text: post.text,
          },
          templateId: post.metadata.templateId,
          formatterVersion: post.metadata.formatterVersion,
        };
      }
      return {
        status: "dry-run",
        executed: false,
        editorialId: post.metadata.editorialId,
        knowledgeId: post.metadata.knowledgeId,
        text: post.text,
        estimatedLength: post.text.length,
        validation: { valid: true, warnings: [] },
        publishedAt: null,
        remoteId: null,
      };
    },
  };
}

function createFakeLedger() {
  const records = [];
  return {
    records,
    computeChecksum,
    findByEditorialId(id) {
      const want = String(id || "");
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].editorialId === want) return records[i];
      }
      return null;
    },
    findByChecksum(checksum) {
      const want = String(checksum || "");
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].checksum === want) return records[i];
      }
      return null;
    },
    recordPublish(result, extra = {}) {
      if (!result || result.status !== "published") return null;
      const record = {
        publishId: `pub-${records.length + 1}`,
        provider: "x",
        editorialId: result.editorialId,
        knowledgeId: result.knowledgeId,
        templateId: extra.templateId || null,
        remoteId: result.remoteId,
        checksum: computeChecksum(result.text),
        status: "published",
        publishedAt: result.publishedAt,
        formatterVersion: extra.formatterVersion || null,
        publisherVersion: "1",
      };
      records.push(record);
      return record;
    },
  };
}

async function seed(root) {
  const editorial = createEditorialStore({
    rootDir: root,
    now: () => NOW,
  });
  const knowledge = createAikidoKnowledgeStore({
    rootDir: root,
    now: () => NOW,
  });
  knowledge.createKnowledge({
    id: "k-principle",
    title: "中心",
    category: "principle",
    summary: "中心を保つ",
    content: "力が抜けた状態で軸を意識する。",
    tags: ["center"],
    difficulty: 2,
    sources: ["道場"],
  });
  knowledge.createKnowledge({
    id: "k-training",
    title: "受け身",
    category: "training",
    summary: "受け身",
    content: "安全に受ける。",
    tags: ["ukemi"],
    difficulty: 1,
    sources: ["道場"],
  });

  const ed1 = editorial.create({
    id: "ed-principle-1",
    source: "aikido",
    type: "post",
    title: "中心",
    body: "合気道では中心を保つ。",
    tags: ["center"],
    metadata: {
      knowledgeId: "k-principle",
      templateId: "principle-short",
      knowledgeCategory: "principle",
      formatterVersion: "1",
    },
  });
  const ed2 = editorial.create({
    id: "ed-training-1",
    source: "aikido",
    type: "post",
    title: "受け身",
    body: "受け身は安全に。",
    tags: ["ukemi"],
    metadata: {
      knowledgeId: "k-training",
      templateId: "training-tip",
      knowledgeCategory: "training",
      formatterVersion: "1",
    },
  });
  return { editorial, knowledge, ed1, ed2 };
}

// --- parseArgs ---
{
  const a = parsePublishArgs([
    "--id=ed-1",
    "--confirm",
    "--dry-run",
    "--json",
    "--limit=2",
    "--continueOnError",
    "--madeWithAI",
    "--force",
    "--category=principle",
  ]);
  assert.strictEqual(a.id, "ed-1");
  assert.strictEqual(a.confirm, true);
  assert.strictEqual(a.dryRun, true);
  assert.strictEqual(a.json, true);
  assert.strictEqual(a.limit, "2");
  assert.strictEqual(a.continueOnError, true);
  assert.strictEqual(a.madeWithAI, true);
  assert.strictEqual(a.force, true);
  assert.strictEqual(a.category, "principle");
  console.log("XP004 parse PASS");
}

async function main() {
  // --- dry-run default (no confirm) ---
  {
    const root = tmpDir("aikido-pub-dry-");
    const { editorial, knowledge, ed1 } = await seed(root);
    const publisher = createFakePublisher();
    const ledger = createFakeLedger();
    let out = "";
    const result = await runAikidoPublish({
      argv: [`--id=${ed1.id}`],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      formatter: createXPostFormatter({ now: NOW }),
      publisher,
      ledger,
      stdout: { write(s) { out += s; } },
      stderr: { write() {} },
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.execute, false);
    assert.strictEqual(result.summary.dryRun, 1);
    assert.strictEqual(result.summary.published, 0);
    assert.strictEqual(publisher.calls.length, 1);
    assert.strictEqual(publisher.calls[0].opts.execute, false);
    assert.strictEqual(ledger.records.length, 0);
    assert.ok(out.includes("dry-run") || out.includes("DRY"));
    console.log("XP004 dry-run PASS");
  }

  // --- confirm publishes + ledger ---
  {
    const root = tmpDir("aikido-pub-confirm-");
    const { editorial, knowledge, ed1 } = await seed(root);
    const publisher = createFakePublisher();
    const ledger = createFakeLedger();
    const result = await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--confirm", "--json"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      formatter: createXPostFormatter({ now: NOW }),
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(result.execute, true);
    assert.strictEqual(result.summary.published, 1);
    assert.strictEqual(result.summary.dryRun, 0);
    assert.strictEqual(publisher.calls[0].opts.execute, true);
    assert.strictEqual(ledger.records.length, 1);
    assert.strictEqual(ledger.records[0].editorialId, ed1.id);
    assert.strictEqual(ledger.records[0].remoteId, `remote-${ed1.id}`);
    assert.ok(ledger.records[0].checksum);
    console.log("XP004 confirm-ledger PASS");
  }

  // --- dry-run wins over confirm ---
  {
    const root = tmpDir("aikido-pub-both-");
    const { editorial, knowledge, ed1 } = await seed(root);
    const publisher = createFakePublisher();
    const ledger = createFakeLedger();
    const result = await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--confirm", "--dry-run"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(result.execute, false);
    assert.strictEqual(result.summary.dryRun, 1);
    assert.strictEqual(ledger.records.length, 0);
    console.log("XP004 dry-wins PASS");
  }

  // --- duplicate skip + force ---
  {
    const root = tmpDir("aikido-pub-dup-");
    const { editorial, knowledge, ed1 } = await seed(root);
    const publisher = createFakePublisher();
    const ledger = createFakeLedger();

    await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--confirm"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(ledger.records.length, 1);

    const skipped = await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--confirm", "--json"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(skipped.summary.skipped, 1);
    assert.strictEqual(skipped.summary.published, 0);
    assert.strictEqual(ledger.records.length, 1);

    const forced = await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--confirm", "--force"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(forced.summary.published, 1);
    assert.strictEqual(ledger.records.length, 2);
    console.log("XP004 duplicate-force PASS");
  }

  // --- category + limit + continueOnError ---
  {
    const root = tmpDir("aikido-pub-batch-");
    const { editorial, knowledge } = await seed(root);
    // add another principle item
    editorial.create({
      id: "ed-principle-2",
      source: "aikido",
      type: "post",
      title: "軸",
      body: "軸を意識する。",
      metadata: {
        knowledgeId: "k-principle",
        templateId: "principle-short",
        knowledgeCategory: "principle",
      },
    });

    const publisher = createFakePublisher({
      publishPost: async (post, opts) => {
        if (post.metadata.editorialId === "ed-principle-2" && opts.execute) {
          const err = new Error("boom");
          err.code = "X_API_REQUEST_FAILED";
          throw err;
        }
        return createFakePublisher().publishPost(post, opts);
      },
    });
    const ledger = createFakeLedger();

    const limited = await runAikidoPublish({
      argv: ["--category=principle", "--limit=1", "--json"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher: createFakePublisher(),
      ledger: createFakeLedger(),
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(limited.summary.total, 1);
    assert.strictEqual(limited.summary.dryRun, 1);

    const stop = await runAikidoPublish({
      argv: ["--category=principle", "--confirm"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    // order: list() is updatedAt desc — either item may fail first
    assert.ok(stop.summary.errors >= 1);
    assert.strictEqual(stop.exitCode, 1);

    const cont = await runAikidoPublish({
      argv: [
        "--category=principle",
        "--confirm",
        "--force",
        "--continueOnError",
      ],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger: createFakeLedger(),
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(cont.summary.total, 2);
    assert.strictEqual(cont.summary.errors, 1);
    assert.strictEqual(cont.summary.published, 1);
    console.log("XP004 batch PASS");
  }

  // --- real ledger integration + script dry-run ---
  {
    const root = tmpDir("aikido-pub-int-");
    const { editorial, knowledge, ed1 } = await seed(root);
    const ledger = createPublishLedger({ rootDir: root });
    const clientCalls = [];
    const publisher = createXPublisher({
      client: {
        async createPost(input) {
          clientCalls.push(input);
          return {
            remoteId: "999",
            text: input.text,
            raw: {},
          };
        },
      },
      clock: () => NOW,
    });

    const dry = await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--json"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(dry.summary.dryRun, 1);
    assert.strictEqual(clientCalls.length, 0);
    assert.strictEqual(ledger.list().length, 0);

    const pub = await runAikidoPublish({
      argv: [`--id=${ed1.id}`, "--confirm", "--json"],
      editorialStore: editorial,
      knowledgeStore: knowledge,
      publisher,
      ledger,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.strictEqual(pub.summary.published, 1);
    assert.strictEqual(clientCalls.length, 1);
    assert.strictEqual(ledger.list().length, 1);

    const script = path.join(__dirname, "..", "scripts", "aikido-publish.js");
    const cli = spawnSync(
      process.execPath,
      [script, `--rootDir=${root}`, `--id=${ed1.id}`, "--json"],
      { encoding: "utf8", env: { ...process.env, X_USER_ACCESS_TOKEN: "" } }
    );
    assert.strictEqual(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    // duplicate → skipped on second dry-run? dry-run still checks duplicate
    assert.strictEqual(parsed.summary.skipped, 1);
    console.log("XP004 integration-cli PASS");
  }

  console.log("aikido-publish-cli-test: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
