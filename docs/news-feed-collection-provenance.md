# News feed collection provenance

`schemaVersion: 1` adds an always-present `collectionCompletedAt` field: a UTC
ISO timestamp when verified, otherwise `null`. `generatedAt` remains export time.

The timestamp certifies successful collection of the scope from which the exact
Daily Enriched input was derived. It is sampled at the end of Collect after all
required persistence/work. It does not certify recent post publication, successful
AI judgments, complete enrichment, successful Morning, or public deployment.

## Local receipts

Each artifact P has P.provenance.json with schemaVersion, generationId,
collectionCompletedAt, artifactSha256, and input (null for Scope; otherwise the
immediate parent's generationId and artifactSha256). SHA-256 covers exact bytes.
Every committed output has a new generationId, even for identical empty arrays.
No receipt metadata other than the verified timestamp enters the public feed.

Each writer holds P.provenance.lock, captures the actual input bytes and matching
receipt, and invalidates the previous output receipt before its first write.
Only successful final completion writes a receipt atomically. Intermediate AI
writes are unbound. Unverified inputs may still be processed, but never mint a
receipt. No fallback to latest Scope, item timestamps, mtime or export time exists.
Actual Morning fallback inputs carry their own provenance without changing order.

Reader reads receipt/data/receipt and validates identical receipt generations and
exact-byte hashes; races are retried once. It parses the same captured bytes.
Missing, malformed, unreadable or mismatched receipts give public null and a short
local diagnostic; valid historical content remains exportable. In-memory posts
have no implicit file provenance. Invalid artifact JSON still fails normally.

Zero-item successful runs propagate receipts through empty arrays. Re-exporting
old Enriched, including [], preserves its original collection timestamp. A newer
Collect cannot rebind old Enriched. If a failed writer has already invalidated the
old receipt, re-export yields null instead of fabricating freshness.

Locks are never stolen by age. On a busy/uncertain lock, the second writer fails.
Normal returns, exceptions and process.exit release owned locks. After an abrupt
termination, inspect the local owner.json PID/hostname and establish that the owner
is dead and no writer is active before manually removing that lock directory.
Do not remove a live or uncertain lock. No automatic recovery is provided.

Atomic rename supports process-crash safety on a local filesystem, not power-loss
fsync durability. This is a trusted-writer contract, not tamper-proof attestation.
Manual edits/copies without a matching receipt invalidate provenance; formatting
changes also invalidate the exact-byte hash.

## Timeline Digest

Require a successful current-run fetch and ordinary schema/count validation.
Accept collection freshness only for a timezone-qualified collectionCompletedAt
within 36 hours, permitting at most five minutes of future skew. Validate
export-time generatedAt independently. Null means unverified, including empty
feeds. Recheck age before promotion if processing is lengthy.
