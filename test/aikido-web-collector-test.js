/**
 * KC-001 — Aikido Web Source Collector.
 * Run: node test/aikido-web-collector-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createAikidoWebCollector,
  assertSafeUrl,
  isPrivateOrLoopbackHost,
  parseHtmlDocument,
  extractMainText,
  inferSourceType,
  decodeHtmlEntities,
  normalizeWhitespace,
} = require("../lib/aikido-web-collector");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T21:00:00.000Z";

const SAMPLE_HTML = `<!doctype html>
<html lang="ja">
<head>
  <title>合気道の中心 &amp; 呼吸</title>
  <link rel="canonical" href="https://example.com/aikido/center/" />
  <meta name="description" content="中心を保つ稽古の要点" />
  <meta name="author" content="山田太郎" />
  <meta property="og:site_name" content="Example Dojo" />
  <meta property="article:published_time" content="2026-01-15" />
</head>
<body>
  <header>ナビ</header>
  <nav>メニュー</nav>
  <main>
    <article>
      <h1>合気道の中心</h1>
      <p>合気道では中心を保つことが大切である。相手とぶつからず、力を抜いて動く。稽古の基本は呼吸と姿勢にあり、焦らず丁寧に繰り返すことが上達につながる。</p>
      <p>稽古では呼吸を整え、余分な力を入れない。受け身も安全に行い、相手との間合いを意識しながら中心から動く感覚を養う。</p>
      <script>alert(1)</script>
      <style>.x{color:red}</style>
    </article>
  </main>
  <footer>フッター</footer>
</body>
</html>`;

function createFakeFetcher(handler) {
  return {
    name: "fake",
    async fetch(url, options = {}) {
      return handler(url, options);
    },
  };
}

async function main() {
  // --- URL safety ---
  {
    assertSafeUrl("https://example.com/a");
    assert.throws(() => assertSafeUrl("file:///etc/passwd"), /scheme/);
    assert.throws(() => assertSafeUrl("javascript:alert(1)"), /scheme/);
    assert.throws(() => assertSafeUrl("http://localhost/a"), /hostname|private/);
    assert.throws(() => assertSafeUrl("http://127.0.0.1/a"), /private/);
    assert.throws(() => assertSafeUrl("http://192.168.1.1/a"), /private/);
    assert.throws(() => assertSafeUrl("http://10.0.0.5/a"), /private/);
    assert.throws(
      () => assertSafeUrl("https://user:pass@example.com/"),
      /credentials/
    );
    assert.ok(isPrivateOrLoopbackHost("172.16.0.1"));
    console.log("KC001 url-safety PASS");
  }

  // --- HTML parse ---
  {
    const parsed = parseHtmlDocument(
      SAMPLE_HTML,
      "https://example.com/aikido/x"
    );
    assert.strictEqual(parsed.title, "合気道の中心 & 呼吸");
    assert.ok(parsed.canonicalUrl.includes("example.com/aikido/center"));
    assert.strictEqual(parsed.author, "山田太郎");
    assert.strictEqual(parsed.publisher, "Example Dojo");
    assert.strictEqual(parsed.publishedAt, "2026-01-15");
    assert.strictEqual(parsed.language, "ja");
    assert.ok(parsed.rawText.includes("中心を保つ"));
    assert.ok(!parsed.rawText.includes("alert"));
    assert.ok(!parsed.rawText.includes("ナビ"));
    assert.strictEqual(decodeHtmlEntities("&amp;"), "&");
    assert.strictEqual(normalizeWhitespace("a \n\n\n b"), "a\n\nb");

    const bodyOnly = extractMainText(
      `<html><body><p>${"あ".repeat(50)}</p></body></html>`
    );
    assert.ok(bodyOnly.includes("あ"));

    assert.strictEqual(
      inferSourceType({
        url: "https://dojo.example.com",
        title: "道場案内",
        options: {},
      }),
      "dojo-site"
    );
    assert.strictEqual(
      inferSourceType({
        url: "https://x.com",
        title: "a",
        options: { sourceType: "interview" },
      }),
      "interview"
    );
    console.log("KC001 html-parse PASS");
  }

  // --- preview / collect ---
  {
    const intake = createAikidoSourceIntake({
      rootDir: tmpDir("aikido-web-"),
      now: () => NOW,
    });
    const fetcher = createFakeFetcher(async (url) => ({
      url,
      finalUrl: url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: SAMPLE_HTML,
      fetchedAt: NOW,
    }));
    const collector = createAikidoWebCollector({
      fetcher,
      sourceIntake: intake,
      now: () => NOW,
    });

    const preview = await collector.previewUrl(
      "https://example.com/aikido/page",
      { now: NOW }
    );
    assert.strictEqual(preview.errors.length, 0);
    assert.ok(preview.source.title);
    assert.strictEqual(intake.listSources().length, 0);

    const collected = await collector.collectUrl(
      "https://example.com/aikido/page?utm_source=x",
      { now: NOW, tags: ["web"] }
    );
    assert.strictEqual(collected.created, true);
    assert.strictEqual(collected.source.status, "collected");
    assert.strictEqual(collected.source.metadata.collector, "aikido-web");
    assert.ok(collected.source.tags.includes("web"));
    assert.strictEqual(intake.listSources().length, 1);

    let dupErr = null;
    try {
      await collector.collectUrl("https://example.com/aikido/page/", {
        now: NOW,
      });
    } catch (error) {
      dupErr = error;
    }
    assert.ok(dupErr);
    assert.strictEqual(dupErr.code, "aikido-source-duplicate-url");

    const allowed = await collector.collectUrl(
      "https://example.com/aikido/page/#frag",
      { now: NOW, allowDuplicateUrl: true }
    );
    assert.strictEqual(allowed.created, true);
    console.log("KC001 preview-collect PASS");
  }

  // --- errors ---
  {
    const intake = createAikidoSourceIntake({
      rootDir: tmpDir("aikido-web-err-"),
      now: () => NOW,
    });

    const httpErr = createAikidoWebCollector({
      sourceIntake: intake,
      fetcher: createFakeFetcher(async (url) => ({
        url,
        status: 404,
        headers: { "content-type": "text/html" },
        body: "<html><title>x</title><body>not found page content here enough text</body></html>",
        fetchedAt: NOW,
      })),
    });
    await assert.rejects(
      () => httpErr.collectUrl("https://example.com/missing"),
      /HTTP 404/
    );

    const typeErr = createAikidoWebCollector({
      sourceIntake: intake,
      fetcher: createFakeFetcher(async (url) => ({
        url,
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF",
        fetchedAt: NOW,
      })),
    });
    await assert.rejects(
      () => typeErr.collectUrl("https://example.com/a.pdf"),
      /content-type/
    );

    const shortErr = createAikidoWebCollector({
      sourceIntake: intake,
      fetcher: createFakeFetcher(async (url) => ({
        url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><title>短</title><body><article>短い</article></body></html>",
        fetchedAt: NOW,
      })),
    });
    await assert.rejects(
      () =>
        shortErr.collectUrl("https://example.com/short", {
          minTextLength: 100,
        }),
      /minTextLength/
    );

    const noIntake = createAikidoWebCollector({
      fetcher: createFakeFetcher(async (url) => ({
        url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: SAMPLE_HTML,
        fetchedAt: NOW,
      })),
    });
    await assert.rejects(
      () => noIntake.collectUrl("https://example.com/x"),
      /sourceIntake/
    );
    console.log("KC001 errors PASS");
  }

  // --- batch ---
  {
    const intake = createAikidoSourceIntake({
      rootDir: tmpDir("aikido-web-batch-"),
      now: () => NOW,
    });
    const fetcher = createFakeFetcher(async (url) => {
      if (url.includes("bad")) {
        return {
          url,
          status: 500,
          headers: { "content-type": "text/html" },
          body: "<html><title>err</title><body></body></html>",
          fetchedAt: NOW,
        };
      }
      return {
        url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: SAMPLE_HTML.replace(
          "合気道の中心 &amp; 呼吸",
          `ページ ${url.slice(-1)} &amp; 本文`
        ),
        fetchedAt: NOW,
      };
    });
    const collector = createAikidoWebCollector({
      fetcher,
      sourceIntake: intake,
    });
    const batch = await collector.collectUrls(
      [
        "https://example.com/a1",
        "https://example.com/bad",
        "https://example.com/a2",
      ],
      { now: NOW, continueOnError: true }
    );
    assert.deepStrictEqual(
      batch.results.map((r) => r.url),
      [
        "https://example.com/a1",
        "https://example.com/bad",
        "https://example.com/a2",
      ]
    );
    assert.strictEqual(batch.summary.createdCount, 2);
    assert.strictEqual(batch.summary.errorCount, 1);
    assert.strictEqual(
      intake.findSource(batch.results[0].source.id).status,
      "collected"
    );
    assert.ok(
      !fs.existsSync(path.join(intake.rootDir, ".pipeline-work", "knowledge"))
    );
    console.log("KC001 batch PASS");
  }

  console.log("aikido-web-collector-test: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
