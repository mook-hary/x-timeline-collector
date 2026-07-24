/**
 * EA-002 — Editorial Dashboard AI Draft API.
 * Run: node test/editorial-dashboard-ai-draft-test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  createEditorialDashboardApi,
  ERROR_CODES,
  sanitizeMessage,
} = require("../lib/editorial-dashboard-api");
const {
  createEditorialDashboardServer,
} = require("../lib/editorial-dashboard-server");
const { createEditorialStore } = require("../lib/editorial-store");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createPublishLedger } = require("../lib/publish-ledger");
const { createXPostFormatter } = require("../lib/x-post-formatter");
const { createXPublisher } = require("../lib/x-publisher");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T05:00:00.000Z";
const SECRET = "sk-live-openai-should-never-leak-abcdef";

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

function seed(root, { withKnowledge = true } = {}) {
  const knowledge = createAikidoKnowledgeStore({
    rootDir: root,
    now: () => NOW,
  });
  const editorial = createEditorialStore({
    rootDir: root,
    now: () => NOW,
  });
  let knowledgeId = null;
  if (withKnowledge) {
    const k = knowledge.createKnowledge({
      id: "aikido-draft-know-1",
      title: "呼吸力とは力を抜くことではない",
      category: "principle",
      summary: "力を抜くだけでは呼吸力にならない。",
      content:
        "合気道で言う呼吸力は、力を抜くことそのものではない。中心を保ち、相手とつながったまま動く感覚を指す。",
      tags: ["breath", "principle"],
      difficulty: 2,
      sources: ["稽古メモ"],
    });
    knowledgeId = k.id;
  }
  const item = editorial.create({
    id: "ed-ai-draft-1",
    source: "aikido",
    type: "post",
    title: "呼吸力",
    body: "元のEditorial本文です。",
    tags: ["principle"],
    metadata: {
      knowledgeId: knowledgeId || "missing-knowledge",
      knowledgeCategory: "principle",
      templateId: "principle-short",
    },
  });
  return { knowledge, editorial, item, knowledgeId };
}

function makeFakeAi(extraSuggestions) {
  const calls = [];
  const base = [
    {
      label: "簡潔",
      intent: "基本原則を短く伝える",
      body: "呼吸力は力を抜くことではない。中心を保ち相手とつながる。",
    },
    {
      label: "解説",
      intent: "誤解を避けながら説明する",
      body: "合気道の呼吸力は、力を抜くだけでは足りない。中心を保ったまま相手とつながって動く感覚だ。",
    },
    {
      label: "問いかけ",
      intent: "読者の振り返りを促す",
      body: "稽古で「力を抜く」だけになっていませんか。中心とつながりを保てていますか。",
    },
  ];
  return {
    calls,
    async completeJson(args) {
      calls.push(args);
      const suggestions = extraSuggestions || base;
      return { suggestions };
    },
  };
}

async function main() {
  // sanitize redacts api keys
  {
    const msg = sanitizeMessage(`failed key=${SECRET} OPENAI_API_KEY=${SECRET}`);
    assert.ok(!msg.includes(SECRET));
    assert.ok(msg.includes("[REDACTED"));
    console.log("EA002 sanitize PASS");
  }

  // generate does not mutate editorial / ledger / publisher
  {
    const root = tmpDir("ea002-gen-");
    const { editorial, item, knowledge } = seed(root);
    const ledger = createPublishLedger({ rootDir: root });
    let publishCalls = 0;
    const publisher = createXPublisher({
      client: {
        async createPost() {
          publishCalls += 1;
          return { remoteId: "x", text: "t", raw: {} };
        },
      },
      clock: () => NOW,
    });
    const ai = makeFakeAi();
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger,
      formatter: createXPostFormatter({ now: NOW }),
      publisher,
      aiClient: ai,
    });

    const beforeBody = editorial.find(item.id).body;
    const beforeLedger = ledger.list({}).length;
    const gen = await api.generateAiDrafts(item.id, { count: 3 });
    assert.strictEqual(gen.ok, true);
    assert.strictEqual(gen.data.suggestions.length, 3);
    assert.strictEqual(ai.calls.length, 1);
    assert.strictEqual(editorial.find(item.id).body, beforeBody);
    assert.strictEqual(ledger.list({}).length, beforeLedger);
    assert.strictEqual(publishCalls, 0);

    const inputBlob = JSON.stringify(ai.calls[0]);
    assert.ok(inputBlob.includes("呼吸力"));
    assert.ok(!inputBlob.includes(SECRET));
    console.log("EA002 generate no-mutate PASS");
  }

  // over-limit suggestion stays in response as invalid
  {
    const root = tmpDir("ea002-limit-");
    const { editorial, item, knowledge } = seed(root);
    const longBody = "あ".repeat(400);
    const ai = makeFakeAi([
      {
        label: "簡潔",
        intent: "短い",
        body: "短い案です。",
      },
      {
        label: "解説",
        intent: "長い",
        body: longBody,
      },
      {
        label: "問いかけ",
        intent: "問い",
        body: "振り返れますか。",
      },
    ]);
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      aiClient: ai,
      publisher: createXPublisher({
        client: { async createPost() { return { remoteId: "1", text: "t", raw: {} }; } },
        clock: () => NOW,
      }),
    });
    const gen = await api.generateAiDrafts(item.id, { count: 3 });
    assert.strictEqual(gen.ok, true);
    const longOne = gen.data.suggestions.find((s) => s.label === "解説");
    assert.ok(longOne);
    assert.strictEqual(longOne.invalid, true);
    assert.strictEqual(longOne.withinLimit, false);

    const applyBad = api.applyAiDraft(item.id, {
      suggestionBody: longBody,
      confirm: true,
    });
    assert.strictEqual(applyBad.ok, false);
    assert.strictEqual(applyBad.error.code, ERROR_CODES.AI_DRAFT_LIMIT_EXCEEDED);
    assert.strictEqual(editorial.find(item.id).body, "元のEditorial本文です。");
    console.log("EA002 over-limit apply blocked PASS");
  }

  // confirm required + apply saves body, no publish
  {
    const root = tmpDir("ea002-apply-");
    const { editorial, item, knowledge } = seed(root);
    const ledger = createPublishLedger({ rootDir: root });
    let publishCalls = 0;
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger,
      formatter: createXPostFormatter({ now: NOW }),
      aiClient: makeFakeAi(),
      publisher: createXPublisher({
        client: {
          async createPost() {
            publishCalls += 1;
            return { remoteId: "1", text: "t", raw: {} };
          },
        },
        clock: () => NOW,
      }),
    });

    const noConfirm = api.applyAiDraft(item.id, {
      suggestionBody: "新しい本文です。",
    });
    assert.strictEqual(noConfirm.ok, false);
    assert.strictEqual(
      noConfirm.error.code,
      ERROR_CODES.AI_DRAFT_APPLY_CONFIRMATION_REQUIRED
    );
    assert.strictEqual(editorial.find(item.id).body, "元のEditorial本文です。");

    const noBody = api.applyAiDraft(item.id, { confirm: true, suggestionBody: "  " });
    assert.strictEqual(noBody.ok, false);
    assert.strictEqual(noBody.error.code, ERROR_CODES.AI_DRAFT_BODY_REQUIRED);

    const applied = api.applyAiDraft(item.id, {
      suggestionBody: "新しいAI本文を適用します。",
      confirm: true,
    });
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.data.message, "AI draft applied and saved.");
    assert.strictEqual(
      editorial.find(item.id).body,
      "新しいAI本文を適用します。"
    );
    assert.strictEqual(ledger.list({}).length, 0);
    assert.strictEqual(publishCalls, 0);
    console.log("EA002 apply confirm PASS");
  }

  // missing editorial / knowledge
  {
    const root = tmpDir("ea002-miss-");
    const { editorial, knowledge } = seed(root);
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      aiClient: makeFakeAi(),
    });
    const missingEd = await api.generateAiDrafts("nope", { count: 3 });
    assert.strictEqual(missingEd.ok, false);
    assert.strictEqual(missingEd.error.code, ERROR_CODES.EDITORIAL_NOT_FOUND);

    const orphan = editorial.create({
      id: "ed-orphan",
      source: "aikido",
      type: "post",
      title: "orphan",
      body: "本文",
      metadata: { knowledgeId: "does-not-exist" },
    });
    const missingK = await api.generateAiDrafts(orphan.id, { count: 3 });
    assert.strictEqual(missingK.ok, false);
    assert.strictEqual(missingK.error.code, ERROR_CODES.KNOWLEDGE_NOT_FOUND);
    console.log("EA002 missing refs PASS");
  }

  // AI config missing — dashboard still starts, safe error
  {
    const root = tmpDir("ea002-noconfig-");
    const { editorial, item, knowledge } = seed(root);
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      // no aiClient
    });
    const list = api.listEditorials();
    assert.strictEqual(list.ok, true);

    const gen = await api.generateAiDrafts(item.id, { count: 3 });
    assert.strictEqual(gen.ok, false);
    assert.strictEqual(gen.error.code, ERROR_CODES.AI_CONFIG_MISSING);
    assert.match(gen.error.message, /not configured/i);
    assert.ok(!JSON.stringify(gen).includes(SECRET));
    assert.strictEqual(editorial.find(item.id).body, "元のEditorial本文です。");

    if (prev != null) process.env.OPENAI_API_KEY = prev;
    console.log("EA002 ai missing PASS");
  }

  // HTTP routes + dashboard boots without AI
  {
    const root = tmpDir("ea002-http-");
    const staticDir = path.join(root, "dashboard");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "..", "dashboard", "index.html"),
      path.join(staticDir, "index.html")
    );
    const { editorial, item, knowledge } = seed(root);
    const ai = makeFakeAi();
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      aiClient: ai,
      publisher: createXPublisher({
        client: { async createPost() { return { remoteId: "1", text: "t", raw: {} }; } },
        clock: () => NOW,
      }),
    });
    const server = createEditorialDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir,
      api,
    });
    const { port } = await new Promise((resolve, reject) => {
      server.server.listen(0, "127.0.0.1", () => {
        resolve({ port: server.server.address().port });
      });
      server.server.once("error", reject);
    });

    const genRes = await httpRequest(port, "POST", `/api/editorials/${item.id}/ai-drafts`, {
      count: 3,
    });
    assert.strictEqual(genRes.status, 200);
    assert.strictEqual(genRes.json.ok, true);
    assert.strictEqual(genRes.json.data.suggestions.length, 3);
    assert.ok(!genRes.text.includes(SECRET));

    const applyRes = await httpRequest(
      port,
      "POST",
      `/api/editorials/${item.id}/apply-ai-draft`,
      { suggestionBody: "HTTP経由で適用。", confirm: true }
    );
    assert.strictEqual(applyRes.status, 200);
    assert.strictEqual(applyRes.json.ok, true);
    assert.strictEqual(editorial.find(item.id).body, "HTTP経由で適用。");

    const html = await httpRequest(port, "GET", "/");
    assert.strictEqual(html.status, 200);
    assert.ok(html.text.includes("AI Draft Assistant"));

    await new Promise((resolve) => server.server.close(resolve));
    console.log("EA002 http routes PASS");
  }

  // invalid AI response
  {
    const root = tmpDir("ea002-badjson-");
    const { editorial, item, knowledge } = seed(root);
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: editorial,
      knowledgeStore: knowledge,
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      aiClient: {
        async completeJson() {
          return { suggestions: [] };
        },
      },
    });
    const gen = await api.generateAiDrafts(item.id, { count: 3 });
    assert.strictEqual(gen.ok, false);
    assert.strictEqual(gen.error.code, ERROR_CODES.AI_RESPONSE_EMPTY);
    assert.strictEqual(editorial.find(item.id).body, "元のEditorial本文です。");
    console.log("EA002 invalid AI response PASS");
  }

  console.log("editorial-dashboard-ai-draft-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
