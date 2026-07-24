/**
 * XP-003 — Publish Ledger.
 * Run: node test/publish-ledger-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  createPublishLedger,
  computeChecksum,
  STORE_DIR_REL,
  DEFAULT_PUBLISHER_VERSION,
} = require("../lib/publish-ledger");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T01:00:00.000Z";
const TEXT = "合気道では中心を保つ。";

function publishedResult(partial = {}) {
  return {
    status: "published",
    executed: true,
    editorialId: "ed-1",
    knowledgeId: "know-1",
    text: TEXT,
    estimatedLength: TEXT.length,
    publishedAt: NOW,
    remoteId: "1234567890",
    provider: "x",
    templateId: "principle-short",
    formatterVersion: "1",
    publisherVersion: "1",
    response: { remoteId: "1234567890", text: TEXT },
    ...partial,
  };
}

// --- checksum ---
{
  const a = computeChecksum(TEXT);
  const b = computeChecksum(TEXT);
  const c = computeChecksum(`${TEXT}!`);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(a.length, 64);
  console.log("XP003 checksum PASS");
}

// --- record published / dry-run skip ---
{
  const root = tmpDir("pub-ledger-");
  const ledger = createPublishLedger({ rootDir: root });

  const dry = ledger.recordPublish({
    status: "dry-run",
    executed: false,
    editorialId: "ed-1",
    text: TEXT,
  });
  assert.strictEqual(dry, null);
  assert.strictEqual(ledger.list().length, 0);

  const recorded = ledger.recordPublish(publishedResult());
  assert.ok(recorded.publishId);
  assert.strictEqual(recorded.provider, "x");
  assert.strictEqual(recorded.editorialId, "ed-1");
  assert.strictEqual(recorded.knowledgeId, "know-1");
  assert.strictEqual(recorded.templateId, "principle-short");
  assert.strictEqual(recorded.remoteId, "1234567890");
  assert.strictEqual(recorded.checksum, computeChecksum(TEXT));
  assert.strictEqual(recorded.status, "published");
  assert.strictEqual(recorded.publishedAt, NOW);
  assert.strictEqual(recorded.formatterVersion, "1");
  assert.strictEqual(recorded.publisherVersion, DEFAULT_PUBLISHER_VERSION);

  const filePath = path.join(
    root,
    STORE_DIR_REL,
    "x",
    `${recorded.publishId}.json`
  );
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.strictEqual(onDisk.checksum, recorded.checksum);
  assert.ok(!("text" in onDisk));
  console.log("XP003 record PASS");
}

// --- find + duplicate search ---
{
  const root = tmpDir("pub-ledger-find-");
  const ledger = createPublishLedger({ rootDir: root });
  const r1 = ledger.recordPublish(publishedResult());
  ledger.recordPublish(
    publishedResult({
      editorialId: "ed-2",
      knowledgeId: "know-2",
      remoteId: "999",
      text: "別本文",
      publishedAt: "2026-07-25T01:00:01.000Z",
    })
  );

  assert.strictEqual(ledger.findByEditorialId("ed-1").publishId, r1.publishId);
  assert.strictEqual(ledger.findByKnowledgeId("know-1").publishId, r1.publishId);
  assert.strictEqual(ledger.findByRemoteId("1234567890").publishId, r1.publishId);
  assert.strictEqual(
    ledger.findByChecksum(computeChecksum(TEXT)).publishId,
    r1.publishId
  );
  assert.strictEqual(ledger.findByEditorialId("missing"), null);
  assert.strictEqual(ledger.findByChecksum(computeChecksum("nope")), null);

  // same checksum → findable for duplicate check (ledger does not block)
  const again = ledger.recordPublish(
    publishedResult({
      editorialId: "ed-3",
      remoteId: "111",
      publishedAt: "2026-07-25T01:00:02.000Z",
    })
  );
  assert.strictEqual(again.checksum, r1.checksum);
  assert.strictEqual(
    ledger.list({ checksum: r1.checksum }).length,
    2
  );
  console.log("XP003 find PASS");
}

// --- list filters ---
{
  const root = tmpDir("pub-ledger-list-");
  const ledger = createPublishLedger({ rootDir: root });
  ledger.recordPublish(
    publishedResult({
      editorialId: "e-a",
      knowledgeId: "k-a",
      remoteId: "1",
      publishedAt: "2026-07-25T01:00:00.000Z",
    })
  );
  ledger.recordPublish(
    publishedResult({
      editorialId: "e-b",
      knowledgeId: "k-b",
      remoteId: "2",
      text: "other",
      publishedAt: "2026-07-25T01:00:01.000Z",
    })
  );

  assert.strictEqual(ledger.list().length, 2);
  assert.strictEqual(ledger.list({ provider: "x" }).length, 2);
  assert.strictEqual(ledger.list({ status: "published" }).length, 2);
  assert.strictEqual(ledger.list({ knowledgeId: "k-a" }).length, 1);
  assert.strictEqual(ledger.list({ editorialId: "e-b" }).length, 1);
  assert.strictEqual(ledger.list({ limit: 1 }).length, 1);
  assert.strictEqual(ledger.list({ limit: 1 })[0].editorialId, "e-a");
  console.log("XP003 list PASS");
}

// --- CLI + JSON ---
{
  const root = tmpDir("pub-ledger-cli-");
  const ledger = createPublishLedger({ rootDir: root });
  ledger.recordPublish(
    publishedResult({
      editorialId: "cli-ed",
      knowledgeId: "cli-know",
      remoteId: "cli-remote",
    })
  );

  const script = path.join(
    __dirname,
    "..",
    "scripts",
    "aikido-publish-list.js"
  );
  const human = spawnSync(
    process.execPath,
    [script, `--rootDir=${root}`, "--provider=x", "--status=published"],
    { encoding: "utf8" }
  );
  assert.strictEqual(human.status, 0, human.stderr);
  assert.ok(human.stdout.includes("Publish Ledger"));
  assert.ok(human.stdout.includes("cli-ed"));

  const json = spawnSync(
    process.execPath,
    [
      script,
      `--rootDir=${root}`,
      "--json",
      "--knowledgeId=cli-know",
      "--editorialId=cli-ed",
    ],
    { encoding: "utf8" }
  );
  assert.strictEqual(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].remoteId, "cli-remote");
  assert.ok(parsed[0].checksum);
  console.log("XP003 cli PASS");
}

console.log("publish-ledger-test: all PASS");
