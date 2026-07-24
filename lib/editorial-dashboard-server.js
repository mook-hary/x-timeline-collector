/**
 * ED-001 — Editorial Dashboard HTTP server.
 * Binds 127.0.0.1 only. Serves dashboard/ static files + JSON API.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createEditorialDashboardApi } = require("./editorial-dashboard-api");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4174;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error("Request body too large");
        err.code = "INVALID_REQUEST_BODY";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        const err = new Error("Invalid JSON body");
        err.code = "INVALID_REQUEST_BODY";
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Resolve a safe path under staticRoot. Reject traversal.
 * @returns {string|null}
 */
function resolveSafeStaticPath(staticRoot, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || "/"));
  } catch (_error) {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // Normalize and strip query/hash already handled by caller.
  let rel = decoded.split("?")[0].split("#")[0];
  if (!rel.startsWith("/")) rel = `/${rel}`;
  if (rel === "/") rel = "/index.html";

  // Reject obvious traversal before join.
  if (rel.includes("..") || rel.includes("\\")) return null;

  const candidate = path.normalize(path.join(staticRoot, rel));
  const rootResolved = path.resolve(staticRoot);
  if (
    candidate !== rootResolved &&
    !candidate.startsWith(rootResolved + path.sep)
  ) {
    return null;
  }
  return candidate;
}

/**
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.rootDir]
 * @param {string} [options.staticDir]
 * @param {object} [options.api]
 * @param {object} [options.apiOptions] passed to createEditorialDashboardApi
 */
function createEditorialDashboardServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port != null ? Number(options.port) : DEFAULT_PORT;
  const rootDir = options.rootDir || process.cwd();
  const staticDir =
    options.staticDir ||
    path.join(rootDir, "dashboard");
  const api =
    options.api ||
    createEditorialDashboardApi({
      rootDir,
      ...(options.apiOptions || {}),
    });

  async function handleApi(req, res, pathname) {
    try {
      if (req.method === "GET" && pathname === "/api/editorials") {
        const result = api.listEditorials();
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      const oneMatch = pathname.match(/^\/api\/editorials\/([^/]+)$/);
      if (oneMatch) {
        const id = decodeURIComponent(oneMatch[1]);
        if (req.method === "GET") {
          const result = api.getEditorial(id);
          return sendJson(res, result.ok ? 200 : result.status || 400, result);
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          const result = api.saveEditorial(id, body);
          return sendJson(res, result.ok ? 200 : result.status || 400, result);
        }
      }

      const previewMatch = pathname.match(
        /^\/api\/editorials\/([^/]+)\/preview$/
      );
      if (previewMatch && req.method === "POST") {
        const id = decodeURIComponent(previewMatch[1]);
        const body = await readBody(req).catch(() => ({}));
        const result = api.previewEditorial(id, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      const publishMatch = pathname.match(
        /^\/api\/editorials\/([^/]+)\/publish$/
      );
      if (publishMatch && req.method === "POST") {
        const id = decodeURIComponent(publishMatch[1]);
        const body = await readBody(req);
        const result = await api.publishEditorial(id, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/publishes") {
        const url = new URL(req.url, `http://${host}`);
        const result = api.listPublishes({
          editorialId: url.searchParams.get("editorialId") || undefined,
          knowledgeId: url.searchParams.get("knowledgeId") || undefined,
          status: url.searchParams.get("status") || undefined,
          provider: url.searchParams.get("provider") || undefined,
          limit: url.searchParams.get("limit") || undefined,
        });
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      return sendJson(res, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "API route not found." },
      });
    } catch (error) {
      const code =
        error && error.code === "INVALID_REQUEST_BODY"
          ? "INVALID_REQUEST_BODY"
          : "INTERNAL_ERROR";
      return sendJson(res, code === "INVALID_REQUEST_BODY" ? 400 : 500, {
        ok: false,
        error: {
          code,
          message:
            code === "INVALID_REQUEST_BODY"
              ? "Invalid request body."
              : "Internal server error.",
        },
      });
    }
  }

  function handleStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    const filePath = resolveSafeStaticPath(staticDir, pathname);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    // Never serve env or pipeline stores via static.
    const base = path.basename(filePath);
    if (
      base === ".env" ||
      base.startsWith(".env.") ||
      filePath.includes(`${path.sep}.pipeline-work${path.sep}`)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    let pathname = "/";
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      pathname = url.pathname;
    } catch (_error) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }

    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname);
      return;
    }
    handleStatic(req, res, pathname);
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve({
          host,
          port,
          url: `http://${host}:${port}`,
          server,
          api,
        });
      });
    });
  }

  function close() {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    host,
    port,
    staticDir,
    server,
    api,
    listen,
    close,
    resolveSafeStaticPath: (p) => resolveSafeStaticPath(staticDir, p),
  };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  createEditorialDashboardServer,
  resolveSafeStaticPath,
};
