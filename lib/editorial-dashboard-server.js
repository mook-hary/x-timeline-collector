/**
 * ED-001 — Editorial Dashboard HTTP server.
 * Binds 127.0.0.1 only. Serves dashboard/ static files + JSON API.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createEditorialDashboardApi } = require("./editorial-dashboard-api");
const {
  MIME,
  sendJson,
  readBody,
  resolveSafeStaticPath,
  isForbiddenStaticBase,
} = require("./dashboard-http");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4174;

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
    options.staticDir || path.join(rootDir, "dashboard");
  const api =
    options.api ||
    createEditorialDashboardApi({
      rootDir,
      ...(options.apiOptions || {}),
    });

  async function handleApi(req, res, pathname) {
    try {
      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "editorial" });
      }

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

      const aiDraftsMatch = pathname.match(
        /^\/api\/editorials\/([^/]+)\/ai-drafts$/
      );
      if (aiDraftsMatch && req.method === "POST") {
        const id = decodeURIComponent(aiDraftsMatch[1]);
        const body = await readBody(req).catch(() => ({}));
        const result = await api.generateAiDrafts(id, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      const applyAiMatch = pathname.match(
        /^\/api\/editorials\/([^/]+)\/apply-ai-draft$/
      );
      if (applyAiMatch && req.method === "POST") {
        const id = decodeURIComponent(applyAiMatch[1]);
        const body = await readBody(req);
        const result = api.applyAiDraft(id, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "POST" && pathname === "/api/pipeline/morning/run") {
        const body = await readBody(req).catch(() => ({}));
        const result = await api.runMorningPipeline(body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/pipeline/morning/status") {
        const result = api.getMorningPipelineStatus();
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/pipeline/morning/history") {
        const url = new URL(req.url, `http://${host}`);
        const result = api.getMorningPipelineHistory({
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

    if (isForbiddenStaticBase(filePath)) {
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

    if (pathname === "/health" || pathname.startsWith("/api/")) {
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
