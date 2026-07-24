/**
 * ED-001 — Editorial Dashboard.
 * Run: node test/editorial-dashboard-test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  createEditorialDashboardApi,
  ERROR_CODES,
} = require("../lib/editorial-dashboard-api");
const {
  createEditorialDashboardServer,
  DEFAULT_HOST,
  resolveSafeStaticPath,
} = require("../lib/editorial-dashboard-server");
const { createEditorialStore } = require("../lib/editorial-store");
const { createPublishLedger, computeChecksum } = require("../lib/publish-ledger");
const { createXPostFormatter } = require("../lib/x-post-formatter");
const { createXPublisher } = require("../lib/x-publisher");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T04:00:00.000Z";

function httpRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_error) {
            json = null;
          }
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function seed(root) {
  const editorial = createEditorialStore({
    rootDir: root,
    now: () => NOW,
  });
  const item = editorial.create({
    id: "ed-dash-1",
    source: "aikido",
    type: "post",
    title: "中心の話",
    body: "合気道では中心を保つ。\n力を抜いて動く。",
    tags: ["center", "principle"],
    metadata: {
      knowledgeId: "know-1",
      templateId: "principle-short",
      knowledgeCategory: "principle",
    },
  });
  return { editorial, item };
}

async function main() {
  // --- path traversal helper ---
  {
    const root = tmpDir("ed-dash-static-");
    const staticDir = path.join(root, "dashboard");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), "<html></html>\n");
    assert.ok(resolveSafeStaticPath(staticDir, "/index.html"));
    assert.strictEqual(resolveSafeStaticPath(staticDir, "/../../.env"), null);
    assert.strictEqual(
      resolveSafeStaticPath(staticDir, "/%2e%2e/%2e%2e/.env"),
      null
    );
    console.log("ED001 path-safety PASS");
  }

  // --- API unit ---
  {
    const root = tmpDir("ed-dash-api-");
    const { editorial, item } = seed(root);
    const ledger = createPublishLedger({ rootDir: root });
    let clientCalls = 0;
    const publisher = createXPublisher({
      client: {
        async createPost({ text }) {
          clientCalls += 1;
          return { remoteId: "999888", text, raw: {} };
        },
      },
      clock: () => NOW,
    });
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      ledger,
      formatter: createXPostFormatter({ now: NOW }),
      publisher,
    });

    const list = api.listEditorials();
    assert.strictEqual(list.ok, true);
    assert.strictEqual(list.data.editorials.length, 1);
    assert.strictEqual(list.data.editorials[0].id, item.id);
    assert.strictEqual(list.data.editorials[0].publishStatus, "unpublished");

    const missing = api.getEditorial("nope");
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error.code, ERROR_CODES.EDITORIAL_NOT_FOUND);
    assert.strictEqual(missing.status, 404);

    const emptySave = api.saveEditorial(item.id, { body: "   " });
    assert.strictEqual(emptySave.ok, false);
    assert.strictEqual(
      emptySave.error.code,
      ERROR_CODES.EDITORIAL_CONTENT_REQUIRED
    );

    const saved = api.saveEditorial(item.id, {
      body: "編集後の本文です。中心を保つ。",
    });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.data.editorial.body.includes("編集後"), true);

    const preview = api.previewEditorial(item.id);
    assert.strictEqual(preview.ok, true);
    assert.ok(preview.data.preview.text.includes("編集後"));
    assert.strictEqual(typeof preview.data.preview.characters, "number");
    assert.strictEqual(clientCalls, 0);
    assert.strictEqual(ledger.list().length, 0);

    const noConfirm = await api.publishEditorial(item.id, {});
    assert.strictEqual(noConfirm.ok, false);
    assert.strictEqual(noConfirm.error.code, "CONFIRM_REQUIRED");
    assert.strictEqual(clientCalls, 0);

    const published = await api.publishEditorial(item.id, { confirm: true });
    assert.strictEqual(published.ok, true);
    assert.strictEqual(published.data.remoteId, "999888");
    assert.strictEqual(clientCalls, 1);
    assert.strictEqual(ledger.list().length, 1);

    const again = await api.publishEditorial(item.id, { confirm: true });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.error.code, ERROR_CODES.ALREADY_PUBLISHED);
    assert.strictEqual(clientCalls, 1);

    const detail = api.getEditorial(item.id);
    assert.strictEqual(detail.data.editorial.published, true);
    assert.strictEqual(detail.data.editorial.remoteId, "999888");

    const hist = api.listPublishes({ editorialId: item.id });
    assert.strictEqual(hist.data.publishes.length, 1);
    assert.ok(!JSON.stringify(hist).includes("Bearer"));
    assert.ok(!JSON.stringify(published).includes("token"));
    console.log("ED001 api PASS");
  }

  // --- HTTP server ---
  {
    const root = tmpDir("ed-dash-http-");
    const { editorial, item } = seed(root);
    const ledger = createPublishLedger({ rootDir: root });
    const staticDir = path.join(root, "dashboard");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(
      path.join(staticDir, "index.html"),
      "<!doctype html><title>dash</title>\n"
    );
    fs.writeFileSync(path.join(root, ".env"), "X_USER_ACCESS_TOKEN=secret-token\n");

    let calls = 0;
    const dash = createEditorialDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir,
      apiOptions: {
        editorialStore: editorial,
        ledger,
        formatter: createXPostFormatter({ now: NOW }),
        publisher: createXPublisher({
          client: {
            async createPost({ text }) {
              calls += 1;
              return { remoteId: "111", text, raw: {} };
            },
          },
          clock: () => NOW,
        }),
      },
    });

    // port 0 → ephemeral; recreate with listen
    const server = dash.server;
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    const addr = server.address();
    assert.strictEqual(addr.address, "127.0.0.1");
    const port = addr.port;

    const home = await httpRequest(port, "GET", "/");
    assert.strictEqual(home.status, 200);
    assert.ok(home.text.includes("dash"));

    const list = await httpRequest(port, "GET", "/api/editorials");
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.ok, true);
    assert.strictEqual(list.json.data.editorials[0].id, item.id);

    const one = await httpRequest(
      port,
      "GET",
      `/api/editorials/${item.id}`
    );
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.data.editorial.body.includes("合気道"), true);

    const missing = await httpRequest(port, "GET", "/api/editorials/missing-x");
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.ok, false);

    const put = await httpRequest(port, "PUT", `/api/editorials/${item.id}`, {
      body: "HTTP経由で保存した本文。",
    });
    assert.strictEqual(put.status, 200);
    assert.ok(put.json.data.editorial.body.includes("HTTP経由"));

    const badPut = await httpRequest(port, "PUT", `/api/editorials/${item.id}`, {
      body: "",
    });
    assert.strictEqual(badPut.status, 400);
    assert.strictEqual(
      badPut.json.error.code,
      ERROR_CODES.EDITORIAL_CONTENT_REQUIRED
    );

    const prev = await httpRequest(
      port,
      "POST",
      `/api/editorials/${item.id}/preview`,
      {}
    );
    assert.strictEqual(prev.status, 200);
    assert.strictEqual(calls, 0);
    assert.strictEqual(ledger.list().length, 0);

    const pub = await httpRequest(
      port,
      "POST",
      `/api/editorials/${item.id}/publish`,
      { confirm: true }
    );
    assert.strictEqual(pub.status, 200);
    assert.strictEqual(pub.json.data.remoteId, "111");
    assert.strictEqual(calls, 1);
    assert.strictEqual(ledger.list().length, 1);
    assert.ok(!JSON.stringify(pub.json).toLowerCase().includes("secret"));

    const dup = await httpRequest(
      port,
      "POST",
      `/api/editorials/${item.id}/publish`,
      { confirm: true }
    );
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.json.error.code, ERROR_CODES.ALREADY_PUBLISHED);

    const envLeak = await httpRequest(port, "GET", "/../.env");
    assert.ok(envLeak.status === 403 || envLeak.status === 404);
    assert.ok(!String(envLeak.text).includes("secret-token"));

    const trav = await httpRequest(port, "GET", "/../../.env");
    assert.strictEqual(trav.status, 403);

    const trav2 = await httpRequest(port, "GET", "/%2e%2e/%2e%2e/.env");
    assert.strictEqual(trav2.status, 403);

    // Publish failure surfaces safe error
    const root2 = tmpDir("ed-dash-fail-");
    const seeded = seed(root2);
    const dashFail = createEditorialDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root2,
      staticDir,
      apiOptions: {
        editorialStore: seeded.editorial,
        ledger: createPublishLedger({ rootDir: root2 }),
        formatter: createXPostFormatter({ now: NOW }),
        publisher: createXPublisher({
          client: {
            async createPost() {
              const err = new Error("boom Bearer secret-token");
              err.status = 500;
              throw err;
            },
          },
          clock: () => NOW,
        }),
      },
    });
    await new Promise((resolve, reject) => {
      dashFail.server.listen(0, "127.0.0.1", (err) =>
        err ? reject(err) : resolve()
      );
    });
    const portFail = dashFail.server.address().port;
    const fail = await httpRequest(
      portFail,
      "POST",
      `/api/editorials/${seeded.item.id}/publish`,
      { confirm: true }
    );
    assert.strictEqual(fail.status, 500);
    assert.strictEqual(fail.json.error.code, ERROR_CODES.X_PUBLISH_FAILED);
    assert.ok(!String(fail.json.error.message).includes("secret-token"));
    assert.ok(String(fail.json.error.message).includes("[REDACTED]") || !String(fail.json.error.message).includes("Bearer secret"));

    await new Promise((r) => dashFail.server.close(() => r()));
    await new Promise((r) => server.close(() => r()));
    console.log("ED001 http PASS");
  }

  // --- checksum helper still consistent ---
  {
    assert.strictEqual(
      computeChecksum("abc").length,
      64
    );
    console.log("ED001 misc PASS");
  }

  console.log("editorial-dashboard-test: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
