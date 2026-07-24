/**
 * EA-004 — Launcher Dashboard HTTP server (127.0.0.1:4173).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  createLauncherDashboardApi,
} = require("./launcher-dashboard-api");
const {
  MIME,
  sendJson,
  readBody,
  resolveSafeStaticPath,
  isForbiddenStaticBase,
} = require("./dashboard-http");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;

/**
 * @param {object} [options]
 */
function createLauncherDashboardServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port != null ? Number(options.port) : DEFAULT_PORT;
  const rootDir = options.rootDir || process.cwd();
  const staticDir =
    options.staticDir || path.join(rootDir, "launcher");
  const api =
    options.api ||
    createLauncherDashboardApi({
      rootDir,
      ...(options.apiOptions || {}),
    });

  async function handleApi(req, res, pathname) {
    try {
      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "launcher" });
      }

      if (req.method === "GET" && pathname === "/api/health") {
        const result = await api.getSystemHealth();
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/home") {
        const result = api.getHome();
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/stats") {
        const result = api.getStats();
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/activity") {
        const url = new URL(req.url, `http://${host}`);
        const result = api.getActivity(
          url.searchParams.get("limit") || 20
        );
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/pipeline/morning/status") {
        const result = api.getMorningStatus();
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "POST" && pathname === "/api/pipeline/morning/run") {
        const body = await readBody(req).catch(() => ({}));
        const result = await api.runMorningPipeline(body);
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
      pathname = new URL(req.url || "/", `http://${host}`).pathname;
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
  createLauncherDashboardServer,
};
