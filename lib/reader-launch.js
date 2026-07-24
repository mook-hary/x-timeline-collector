/**
 * EP-040 — Shared helpers for Reader generate / serve / open.
 * No new dependencies. Project-root relative paths.
 */
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_PORT = 8765;
const READER_DIR_REL = path.join("output", "digest-reader");
const READER_HTML_REL = path.join(READER_DIR_REL, "index.html");
const ENRICHED_REL = path.join("output", "timeline_enriched.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

function readerDir(rootDir) {
  return path.join(resolveRoot(rootDir), READER_DIR_REL);
}

function readerHtmlPath(rootDir) {
  return path.join(resolveRoot(rootDir), READER_HTML_REL);
}

function readerUrl(port = DEFAULT_PORT) {
  return `http://localhost:${Number(port) || DEFAULT_PORT}`;
}

function resolvePort(env = process.env) {
  const raw = env.READER_PORT;
  if (raw == null || String(raw).trim() === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT;
  return Math.floor(n);
}

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (err) => {
      resolve(err && err.code === "EADDRINUSE");
    });
    tester.once("listening", () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, host);
  });
}

function ensureReaderHtml(rootDir) {
  const htmlPath = readerHtmlPath(rootDir);
  const dir = readerDir(rootDir);
  if (!fs.existsSync(dir)) {
    const err = new Error(
      `Reader output directory missing: ${READER_DIR_REL}\n` +
        `Generate first: npm run reader`
    );
    err.code = "reader-dir-missing";
    throw err;
  }
  if (!fs.existsSync(htmlPath)) {
    const err = new Error(
      `Reader HTML missing: ${READER_HTML_REL}\n` +
        `Generate first: npm run reader`
    );
    err.code = "reader-html-missing";
    throw err;
  }
  return htmlPath;
}

/**
 * Minimal static file server for output/digest-reader.
 * @param {string} dir absolute path
 * @param {number} port
 * @returns {Promise<import('http').Server>}
 */
function startReaderServer(dir, port) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end("Method Not Allowed");
        return;
      }
      const host = req.headers.host || `localhost:${port}`;
      const u = new URL(req.url || "/", `http://${host}`);
      let pathname = decodeURIComponent(u.pathname);
      if (pathname === "/") pathname = "/index.html";
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(root, safe);
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.stat(filePath, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
        const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
      });
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Run morning --from-enriched (Reader rebuild only).
 * @returns {{ status: number, error?: Error }}
 */
function generateReader(rootDir, deps = {}) {
  const root = resolveRoot(rootDir);
  const spawn = deps.spawn || spawnSync;
  const morningScript = path.join(root, "scripts", "morning.js");
  const result = spawn(process.execPath, [morningScript, "--from-enriched"], {
    cwd: root,
    encoding: "utf8",
    env: deps.env || process.env,
    stdio: deps.stdio || "inherit",
  });
  if (result.error) {
    return { status: 1, error: result.error, result };
  }
  return {
    status: result.status == null ? 1 : result.status,
    result,
  };
}

function openBrowser(url, deps = {}) {
  const openFn =
    deps.openFn ||
    ((target) =>
      spawnSync("open", [target], {
        encoding: "utf8",
      }));
  return openFn(url);
}

function attachShutdown(server, log = console.error) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      process.exit(0);
    });
    // Force exit if close hangs.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => {
    log("\nStopping Reader server...");
    stop();
  });
  process.on("SIGTERM", stop);
  return stop;
}

module.exports = {
  DEFAULT_PORT,
  READER_DIR_REL,
  READER_HTML_REL,
  ENRICHED_REL,
  resolveRoot,
  readerDir,
  readerHtmlPath,
  readerUrl,
  resolvePort,
  isPortInUse,
  ensureReaderHtml,
  startReaderServer,
  generateReader,
  openBrowser,
  attachShutdown,
};
