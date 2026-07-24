/**
 * XP-002 — X Publisher.
 * Run: node test/x-publisher-test.js
 */
const assert = require("assert");
const {
  createXPublisher,
  validatePost,
  XPublishError,
  ERROR_CODES,
} = require("../lib/x-publisher");
const { createXApiClient } = require("../lib/x-api-client");
const { createXPublisherFromEnv } = require("../lib/x-publisher-env");

const NOW = "2026-07-25T00:00:00.000Z";
const TOKEN = "test-access-token-secret-value";

function formattedPost(partial = {}) {
  const text =
    partial.text !== undefined
      ? partial.text
      : "合気道では中心を保つ。力を抜いて動く。";
  const meta = {
    editorialId: "ed-1",
    knowledgeId: "know-1",
    templateId: "principle-short",
    estimatedLength: text.length,
    formattedAt: NOW,
    formatterVersion: "1",
    ...(partial.metadata || {}),
  };
  return {
    text,
    warnings: partial.warnings || [],
    metadata: meta,
  };
}

function createFakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async createPost(input) {
      calls.push(input);
      if (typeof handlers.createPost === "function") {
        return handlers.createPost(input);
      }
      return {
        remoteId: "1234567890",
        text: input.text,
        raw: { data: { id: "1234567890", text: input.text } },
      };
    },
  };
}

// --- validatePost ---
{
  const ok = validatePost(formattedPost());
  assert.strictEqual(ok.valid, true);

  assert.strictEqual(validatePost(null).code, ERROR_CODES.X_POST_INVALID);
  assert.strictEqual(
    validatePost(formattedPost({ text: "" })).code,
    ERROR_CODES.X_POST_INVALID
  );
  assert.strictEqual(
    validatePost(formattedPost({ text: "   " })).code,
    ERROR_CODES.X_POST_INVALID
  );
  assert.strictEqual(
    validatePost({ text: "hi", warnings: [] }).code,
    ERROR_CODES.X_POST_INVALID
  );
  assert.strictEqual(
    validatePost({
      text: "hi",
      warnings: [],
      metadata: { knowledgeId: "k" },
    }).code,
    ERROR_CODES.X_POST_INVALID
  );

  const long = "あ".repeat(281);
  assert.strictEqual(
    validatePost(
      formattedPost({
        text: long,
        metadata: { estimatedLength: long.length },
      })
    ).code,
    ERROR_CODES.X_POST_TOO_LONG
  );

  assert.strictEqual(
    validatePost(
      formattedPost({
        warnings: ["exceeds maxLength (280): estimatedLength=300"],
      })
    ).code,
    ERROR_CODES.X_POST_TOO_LONG
  );
  console.log("XP002 validate PASS");
}


async function main() {
// --- default dry-run: no client call ---
{
  let called = false;
  const client = {
    async createPost() {
      called = true;
      return { remoteId: "1", text: "x", raw: {} };
    },
  };
  const publisher = createXPublisher({ client, clock: () => NOW });
  const result = await publisher.publishPost(formattedPost());
  assert.strictEqual(result.status, "dry-run");
  assert.strictEqual(result.executed, false);
  assert.strictEqual(result.remoteId, null);
  assert.strictEqual(result.publishedAt, null);
  assert.strictEqual(result.editorialId, "ed-1");
  assert.strictEqual(result.knowledgeId, "know-1");
  assert.strictEqual(result.validation.valid, true);
  assert.strictEqual(called, false);
  console.log("XP002 dry-run PASS");
}

// --- execute=true publishes ---
{
  const client = createFakeClient();
  const publisher = createXPublisher({ client, clock: () => NOW });
  const post = formattedPost();
  const snapshot = JSON.stringify(post);
  const result = await publisher.publishPost(post, { execute: true });
  assert.strictEqual(JSON.stringify(post), snapshot);
  assert.strictEqual(result.status, "published");
  assert.strictEqual(result.executed, true);
  assert.strictEqual(result.remoteId, "1234567890");
  assert.strictEqual(result.publishedAt, NOW);
  assert.strictEqual(result.provider, "x");
  assert.strictEqual(result.response.remoteId, "1234567890");
  assert.strictEqual(client.calls.length, 1);
  assert.strictEqual(client.calls[0].madeWithAI, false);
  console.log("XP002 publish PASS");
}

// --- madeWithAI pass-through ---
{
  const client = createFakeClient();
  const publisher = createXPublisher({ client, clock: () => NOW });
  await publisher.publishPost(formattedPost(), {
    execute: true,
    madeWithAI: true,
  });
  assert.strictEqual(client.calls[0].madeWithAI, true);
  console.log("XP002 madeWithAI PASS");
}

// --- invalid response ---
{
  const client = createFakeClient({
    createPost: async () => ({ remoteId: "", text: "x", raw: {} }),
  });
  const publisher = createXPublisher({ client, clock: () => NOW });
  await assert.rejects(
    () => publisher.publishPost(formattedPost(), { execute: true }),
    (err) =>
      err instanceof XPublishError &&
      err.code === ERROR_CODES.X_API_INVALID_RESPONSE
  );
  console.log("XP002 invalid-response PASS");
}

// --- API error classification + no token leak ---
{
  async function expectCode(status, code, retryable) {
    const client = createFakeClient({
      createPost: async () => {
        const err = new Error(`HTTP ${status} Bearer ${TOKEN}`);
        err.status = status;
        throw err;
      },
    });
    const publisher = createXPublisher({ client, clock: () => NOW });
    try {
      await publisher.publishPost(formattedPost(), { execute: true });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof XPublishError);
      assert.strictEqual(err.code, code);
      assert.strictEqual(err.retryable, retryable);
      assert.ok(!String(err.message).includes(TOKEN));
      assert.ok(!String(err.stack || "").includes(TOKEN));
      const blob = JSON.stringify(err);
      assert.ok(!blob.includes(TOKEN));
      assert.ok(!blob.includes("Authorization"));
    }
  }
  await expectCode(401, ERROR_CODES.X_API_UNAUTHORIZED, false);
  await expectCode(403, ERROR_CODES.X_API_UNAUTHORIZED, false);
  await expectCode(429, ERROR_CODES.X_API_RATE_LIMITED, true);
  await expectCode(500, ERROR_CODES.X_API_REQUEST_FAILED, true);
  await expectCode(400, ERROR_CODES.X_API_REQUEST_FAILED, false);
  console.log("XP002 classify PASS");
}

// --- validation fails without client call ---
{
  let called = false;
  const client = {
    async createPost() {
      called = true;
    },
  };
  const publisher = createXPublisher({ client });
  await assert.rejects(
    () =>
      publisher.publishPost(formattedPost({ text: "" }), { execute: true }),
    (err) => err.code === ERROR_CODES.X_POST_INVALID
  );
  assert.strictEqual(called, false);
  console.log("XP002 validate-no-call PASS");
}

// --- publishPosts order / limit / continueOnError ---
{
  const client = createFakeClient({
    createPost: async (input) => {
      if (input.text === "fail") {
        const err = new Error("boom");
        err.status = 500;
        throw err;
      }
      return {
        remoteId: `id-${input.text}`,
        text: input.text,
        raw: {},
      };
    },
  });
  const publisher = createXPublisher({ client, clock: () => NOW });
  const posts = [
    formattedPost({
      text: "A",
      metadata: { editorialId: "a", estimatedLength: 1 },
    }),
    formattedPost({
      text: "B",
      metadata: { editorialId: "b", estimatedLength: 1 },
    }),
    formattedPost({
      text: "C",
      metadata: { editorialId: "c", estimatedLength: 1 },
    }),
  ];

  const dry = await publisher.publishPosts(posts);
  assert.strictEqual(dry.summary.dryRunCount, 3);
  assert.strictEqual(dry.summary.publishedCount, 0);
  assert.deepStrictEqual(
    dry.results.map((r) => r.editorialId),
    ["a", "b", "c"]
  );
  assert.strictEqual(client.calls.length, 0);

  const limited = await publisher.publishPosts(posts, {
    execute: true,
    limit: 2,
  });
  assert.strictEqual(limited.summary.totalCount, 2);
  assert.strictEqual(limited.summary.publishedCount, 2);
  assert.deepStrictEqual(
    limited.results.map((r) => r.editorialId),
    ["a", "b"]
  );

  const failBatch = [
    formattedPost({
      text: "ok1",
      metadata: { editorialId: "e1", estimatedLength: 3 },
    }),
    formattedPost({
      text: "fail",
      metadata: { editorialId: "e2", estimatedLength: 4 },
    }),
    formattedPost({
      text: "ok3",
      metadata: { editorialId: "e3", estimatedLength: 3 },
    }),
  ];

  const stop = await publisher.publishPosts(failBatch, {
    execute: true,
    continueOnError: false,
  });
  assert.strictEqual(stop.summary.errorCount, 1);
  assert.strictEqual(stop.summary.publishedCount, 1);
  assert.strictEqual(stop.results.length, 2);

  const cont = await publisher.publishPosts(failBatch, {
    execute: true,
    continueOnError: true,
  });
  assert.strictEqual(cont.summary.errorCount, 1);
  assert.strictEqual(cont.summary.publishedCount, 2);
  assert.strictEqual(cont.results.length, 3);
  console.log("XP002 batch PASS");
}

// --- duplicate editorialId in batch ---
{
  const client = createFakeClient();
  const publisher = createXPublisher({ client, clock: () => NOW });
  const posts = [
    formattedPost({
      text: "one",
      metadata: { editorialId: "dup", estimatedLength: 3 },
    }),
    formattedPost({
      text: "two",
      metadata: { editorialId: "dup", estimatedLength: 3 },
    }),
  ];
  const batch = await publisher.publishPosts(posts, { execute: true });
  assert.strictEqual(batch.summary.publishedCount, 1);
  assert.strictEqual(batch.summary.skippedCount, 1);
  assert.strictEqual(batch.results[1].status, "skipped");
  assert.strictEqual(
    batch.results[1].error.code,
    ERROR_CODES.X_BATCH_DUPLICATE_EDITORIAL_ID
  );
  assert.strictEqual(client.calls.length, 1);
  console.log("XP002 batch-dup PASS");
}

// --- Fake Fetcher x-api-client ---
{
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.ok(!JSON.stringify(init.body).includes(TOKEN));
    assert.ok(String(init.headers.Authorization).includes("Bearer "));
    const body = JSON.parse(init.body);
    assert.strictEqual(body.text, "hello");
    assert.strictEqual(body.made_with_ai, true);
    return {
      ok: true,
      status: 201,
      async text() {
        return JSON.stringify({
          data: { id: "999", text: "hello" },
        });
      },
    };
  };

  const client = createXApiClient({
    accessToken: TOKEN,
    fetcher,
    baseUrl: "https://api.example.test",
  });
  const out = await client.createPost({ text: "hello", madeWithAI: true });
  assert.strictEqual(out.remoteId, "999");
  assert.strictEqual(out.text, "hello");
  assert.strictEqual(calls[0].url, "https://api.example.test/2/tweets");
  assert.strictEqual(calls[0].init.method, "POST");

  // madeWithAI false → field omitted
  const calls2 = [];
  const client2 = createXApiClient({
    accessToken: TOKEN,
    fetcher: async (_url, init) => {
      calls2.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({ data: { id: "1", text: "t" } });
        },
      };
    },
  });
  await client2.createPost({ text: "t", madeWithAI: false });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(calls2[0], "made_with_ai"),
    false
  );
  console.log("XP002 api-client PASS");
}

// --- api client HTTP errors + timeout + token not in error ---
{
  const unauthorized = createXApiClient({
    accessToken: TOKEN,
    fetcher: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({
          title: "Unauthorized",
          detail: `bad token ${TOKEN}`,
        });
      },
    }),
  });
  try {
    await unauthorized.createPost({ text: "x" });
    assert.fail("expected throw");
  } catch (err) {
    assert.strictEqual(err.code, "X_API_UNAUTHORIZED");
    assert.strictEqual(err.status, 401);
    assert.ok(!String(err.message).includes(TOKEN));
    assert.ok(!JSON.stringify(err.apiError || {}).includes(TOKEN));
  }

  const rate = createXApiClient({
    accessToken: TOKEN,
    fetcher: async () => ({
      ok: false,
      status: 429,
      async text() {
        return JSON.stringify({ title: "Too Many Requests" });
      },
    }),
  });
  await assert.rejects(
    () => rate.createPost({ text: "x" }),
    (err) => err.code === "X_API_RATE_LIMITED" && err.retryable === true
  );

  const timed = createXApiClient({
    accessToken: TOKEN,
    timeoutMs: 20,
    fetcher: async (_url, init) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true, status: 200 }), 500);
        if (init && init.signal) {
          init.signal.addEventListener("abort", () => {
            clearTimeout(t);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      }),
  });
  await assert.rejects(
    () => timed.createPost({ text: "x" }),
    (err) =>
      err.code === "X_API_REQUEST_FAILED" &&
      /timed out/i.test(err.message) &&
      !String(err.message).includes(TOKEN)
  );
  console.log("XP002 api-errors PASS");
}

// --- env factory ---
{
  assert.throws(
    () => createXPublisherFromEnv({ env: {} }),
    (err) => err && err.code === "X_ACCESS_TOKEN_MISSING"
  );
  // Module load must not require token — factory only.
  const pub = createXPublisherFromEnv({
    env: { X_USER_ACCESS_TOKEN: TOKEN },
    client: createFakeClient(),
    clock: () => NOW,
  });
  const result = await pub.publishPost(formattedPost());
  assert.strictEqual(result.status, "dry-run");
  console.log("XP002 env PASS");
}


  console.log("x-publisher-test: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
