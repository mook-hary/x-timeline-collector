/**
 * EP-040 — Reader launch helpers.
 * Run: node test/reader-launch-test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  DEFAULT_PORT,
  LISTEN_HOST,
  READER_HTML_REL,
  resolvePort,
  readerUrl,
  readerDir,
  readerHtmlPath,
  isPortInUse,
  ensureReaderHtml,
  startReaderServer,
  generateReader,
  getLanIPv4,
  formatServeUrls,
  formatServeUrlLines,
} = require("../lib/reader-launch");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function httpGet(urlPath, port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      })
      .on("error", reject);
  });
}

// --- path / port helpers ---
{
  assert.strictEqual(DEFAULT_PORT, 8765);
  assert.strictEqual(LISTEN_HOST, "0.0.0.0");
  assert.strictEqual(readerUrl(8765), "http://localhost:8765");
  assert.strictEqual(resolvePort({}), 8765);
  assert.strictEqual(resolvePort({ READER_PORT: "9001" }), 9001);
  assert.strictEqual(resolvePort({ READER_PORT: "nope" }), 8765);
  const root = "/tmp/project";
  assert.ok(readerHtmlPath(root).endsWith(READER_HTML_REL));
  console.log("EP040 helpers PASS");
}

// --- EP-043 LAN helpers ---
{
  const ip = getLanIPv4(() => ({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.1.23", family: "IPv4", internal: false }],
    utun0: [{ address: "10.0.0.1", family: "IPv4", internal: false }],
  }));
  assert.strictEqual(ip, "192.168.1.23");

  const urls = formatServeUrls(8765, "192.168.1.23");
  assert.strictEqual(urls.local, "http://localhost:8765");
  assert.strictEqual(urls.network, "http://192.168.1.23:8765");

  const lines = formatServeUrlLines(8765, "192.168.1.23");
  assert.ok(lines[0].includes("Local:"));
  assert.ok(lines[0].includes("http://localhost:8765"));
  assert.ok(lines[1].includes("Network:"));
  assert.ok(lines[1].includes("http://192.168.1.23:8765"));

  const none = formatServeUrlLines(8765, null);
  assert.ok(none[1].includes("unavailable"));
  console.log("EP043 lan-urls PASS");
}

// --- ensureReaderHtml errors ---
{
  const root = tmpDir("reader-launch-missing-");
  assert.throws(() => ensureReaderHtml(root), /Generate first: npm run reader/);
  fs.mkdirSync(readerDir(root), { recursive: true });
  assert.throws(() => ensureReaderHtml(root), /Reader HTML missing/);
  fs.writeFileSync(readerHtmlPath(root), "<html>ok</html>", "utf8");
  assert.strictEqual(ensureReaderHtml(root), readerHtmlPath(root));
  console.log("EP040 ensure PASS");
}

(async () => {
  const root = tmpDir("reader-launch-serve-");
  const dir = readerDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<html><body>reader</body></html>",
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "style.css"), "body{color:red}", "utf8");

  const port = 18000 + Math.floor(Math.random() * 1000);
  assert.strictEqual(await isPortInUse(port), false);
  const server = await startReaderServer(dir, port);
  assert.strictEqual(await isPortInUse(port), true);

  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  assert.strictEqual(addr.port, port);
  // 0.0.0.0 (or :: if dual-stack maps) — must not be loopback-only.
  const boundHost = String(addr.address);
  assert.ok(
    boundHost === "0.0.0.0" ||
      boundHost === "::" ||
      boundHost === "::ffff:0.0.0.0",
    `expected LAN bind, got ${boundHost}`
  );

  const index = await httpGet("/", port);
  assert.strictEqual(index.status, 200);
  assert.ok(index.body.includes("reader"));
  assert.ok(String(index.headers["content-type"] || "").includes("text/html"));

  const css = await httpGet("/style.css", port);
  assert.strictEqual(css.status, 200);
  assert.ok(css.body.includes("color:red"));

  const missing = await httpGet("/nope.html", port);
  assert.strictEqual(missing.status, 404);

  const traversal = await httpGet("/../package.json", port);
  assert.ok(traversal.status === 403 || traversal.status === 404);

  await new Promise((resolve) => server.close(resolve));
  console.log("EP040 server PASS");

  {
    const calls = [];
    const result = generateReader(root, {
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { status: 0 };
      },
      stdio: "pipe",
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].args[0].endsWith(path.join("scripts", "morning.js")));
    assert.deepStrictEqual(calls[0].args.slice(1), ["--from-enriched"]);
    console.log("EP040 generate PASS");
  }

  {
    const port2 = 19000 + Math.floor(Math.random() * 1000);
    const s1 = await startReaderServer(dir, port2);
    let errCode = null;
    try {
      await startReaderServer(dir, port2);
    } catch (error) {
      errCode = error.code;
    }
    assert.strictEqual(errCode, "EADDRINUSE");
    await new Promise((resolve) => s1.close(resolve));
    console.log("EP040 no-double-listen PASS");
  }

  console.log("reader-launch-test: all PASS");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
