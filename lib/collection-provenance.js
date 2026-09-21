/** Exact-byte collection receipts. No inference from clocks or other artifacts. */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash, randomUUID } = require("crypto");
const { writeJsonAtomicOrThrow } = require("./pipeline-io");

const provenancePath = artifact => `${path.resolve(artifact)}.provenance.json`;
const lockPath = artifact => `${path.resolve(artifact)}.provenance.lock`;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hashValid = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const idValid = value => typeof value === "string" && value.trim().length > 0;
function validCollectionTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function validateProvenance(value) {
  return Boolean(value && value.schemaVersion === 1 && idValid(value.generationId) &&
    validCollectionTimestamp(value.collectionCompletedAt) && hashValid(value.artifactSha256) &&
    (value.input === null || (value.input && idValid(value.input.generationId) && hashValid(value.input.artifactSha256))));
}
function readReceipt(file, readFileSync) {
  try { return { raw: String(readFileSync(file, "utf8")), reason: null }; }
  catch (error) { return { raw: null, reason: error.code === "ENOENT" ? "missing" : "unreadable" }; }
}
function readArtifactSnapshot(artifact, options = {}) {
  const read = options.readFileSync || fs.readFileSync;
  let snapshot;
  // Receipt tokens prevent ABA when successive artifacts have identical bytes.
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = readReceipt(provenancePath(artifact), read);
    const bytes = read(artifact);
    const after = readReceipt(provenancePath(artifact), read);
    const artifactSha256 = sha256(bytes);
    snapshot = { bytes, artifactSha256, provenance: null, reason: null };
    if (before.raw !== after.raw) { snapshot.reason = "changed-during-read"; continue; }
    if (before.raw === null) { snapshot.reason = before.reason; break; }
    let receipt;
    try { receipt = JSON.parse(before.raw); } catch (_) { snapshot.reason = "malformed"; break; }
    if (!validateProvenance(receipt)) { snapshot.reason = "malformed"; break; }
    if (receipt.artifactSha256 !== artifactSha256) { snapshot.reason = "hash-mismatch"; break; }
    snapshot.provenance = receipt;
    break;
  }
  return snapshot;
}
function parseSnapshot(snapshot, shape = "array") {
  const data = JSON.parse(snapshot.bytes.toString("utf8"));
  if (shape === "array" && !Array.isArray(data)) throw new Error("Expected posts array");
  if (shape === "editorial" && !Array.isArray(data) && !(data && Array.isArray(data.posts))) {
    throw new Error("Expected posts array or { posts: [] }");
  }
  return data;
}
function invalidateProvenance(artifact) {
  try { fs.unlinkSync(provenancePath(artifact)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

const heldLocks = new Set();
process.once("exit", () => {
  // Existing CLIs call process.exit on fatal I/O; finally does not run there.
  for (const release of heldLocks) { try { release(); } catch (_) { /* leave uncertain locks */ } }
});
function acquireWriterLock(artifact) {
  const dir = lockPath(artifact);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { fs.mkdirSync(dir); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw Object.assign(new Error("Artifact writer is locked; verify the owner is dead before manual recovery. Locks are never stolen by age."), { code: "PROVENANCE_LOCKED" });
  }
  const token = randomUUID();
  const ownerPath = path.join(dir, "owner.json");
  try { fs.writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, hostname: os.hostname() }), { flag: "wx" }); }
  catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  let released = false;
  function release() {
    if (released) return;
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token !== token) throw new Error("Artifact writer lock ownership changed");
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(dir);
    released = true;
    heldLocks.delete(release);
  }
  heldLocks.add(release);
  return release;
}

function createArtifactWriter(artifact, options = {}) {
  const outputPath = path.resolve(artifact);
  const releaseLock = options.dryRun ? () => {} : acquireWriterLock(outputPath);
  let invalidated = false;
  let wrote = false;
  let completed = false;
  let released = false;
  const writer = {
    writeJson(data) {
      if (options.dryRun || released || completed) throw new Error("Artifact writer is not writable");
      if (!invalidated) { invalidateProvenance(outputPath); invalidated = true; }
      (options.writeJson || writeJsonAtomicOrThrow)(outputPath, data);
      wrote = true;
    },
    complete(parentSnapshot = null) {
      if (released || completed) throw new Error("Artifact writer already completed or released");
      if (options.dryRun || !wrote) return null;
      const parent = parentSnapshot && parentSnapshot.provenance;
      if (!options.collection && !parent) { completed = true; return null; }
      if (parent && (!validateProvenance(parent) || parent.artifactSha256 !== sha256(parentSnapshot.bytes))) {
        throw new Error("Invalid parent provenance snapshot");
      }
      const artifactSha256 = sha256(fs.readFileSync(outputPath));
      // For Collect, sample ONLY after required work and exact persisted-byte read.
      const collectionCompletedAt = options.collection
        ? (options.now || (() => new Date().toISOString()))()
        : parent.collectionCompletedAt;
      if (!validCollectionTimestamp(collectionCompletedAt)) throw new Error("Invalid collection completion timestamp");
      const receipt = {
        schemaVersion: 1,
        generationId: randomUUID(),
        collectionCompletedAt,
        artifactSha256,
        input: options.collection ? null : {
          generationId: parent.generationId,
          artifactSha256: parent.artifactSha256,
        },
      };
      try { (options.writeReceipt || writeJsonAtomicOrThrow)(provenancePath(outputPath), receipt); }
      catch (error) { invalidateProvenance(outputPath); throw error; }
      completed = true;
      return receipt;
    },
    release() { if (!released) { releaseLock(); released = true; } },
  };
  return writer;
}

function withArtifactProvenance(options, work) {
  const writer = createArtifactWriter(options.outputPath, options);
  try {
    const snapshot = readArtifactSnapshot(options.inputPath);
    const data = parseSnapshot(snapshot, options.shape || "array");
    const result = work({ data, snapshot, writeJson: writer.writeJson });
    if (result && typeof result.then === "function") {
      return result.then(value => { writer.complete(snapshot); return value; }).finally(() => writer.release());
    }
    writer.complete(snapshot);
    writer.release();
    return result;
  } catch (error) { writer.release(); throw error; }
}

module.exports = {
  provenancePath, lockPath, sha256, validCollectionTimestamp, validateProvenance,
  readArtifactSnapshot, parseSnapshot, invalidateProvenance, acquireWriterLock,
  createArtifactWriter, withArtifactProvenance,
};
