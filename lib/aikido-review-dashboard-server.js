/**
 * EA-001 — Candidate Review Dashboard HTTP server (127.0.0.1:4175).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  createAikidoReviewDashboardApi,
} = require("./aikido-review-dashboard-api");
const {
  MIME,
  sendJson,
  readBody,
  resolveSafeStaticPath,
  isForbiddenStaticBase,
} = require("./dashboard-http");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4175;

function createAikidoReviewDashboardServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port != null ? Number(options.port) : DEFAULT_PORT;
  const rootDir = options.rootDir || process.cwd();
  const staticDir =
    options.staticDir || path.join(rootDir, "review-dashboard");
  const api =
    options.api ||
    createAikidoReviewDashboardApi({
      rootDir,
      ...(options.apiOptions || {}),
    });

  async function handleApi(req, res, pathname) {
    try {
      if (req.method === "GET" && pathname === "/api/candidates") {
        const url = new URL(req.url, `http://${host}`);
        const result = api.listCandidates({
          status: url.searchParams.get("status") || undefined,
        });
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      const one = pathname.match(/^\/api\/candidates\/([^/]+)$/);
      if (one) {
        const id = decodeURIComponent(one[1]);
        if (req.method === "GET") {
          const result = api.getCandidate(id);
          return sendJson(res, result.ok ? 200 : result.status || 400, result);
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          const result = api.saveCandidate(id, body);
          return sendJson(res, result.ok ? 200 : result.status || 400, result);
        }
      }

      const preview = pathname.match(
        /^\/api\/candidates\/([^/]+)\/knowledge-preview$/
      );
      if (preview && req.method === "POST") {
        const id = decodeURIComponent(preview[1]);
        await readBody(req).catch(() => ({}));
        const result = api.knowledgePreview(id);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      const approve = pathname.match(/^\/api\/candidates\/([^/]+)\/approve$/);
      if (approve && req.method === "POST") {
        const id = decodeURIComponent(approve[1]);
        const body = await readBody(req);
        const result = api.approveCandidate(id, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      const reject = pathname.match(/^\/api\/candidates\/([^/]+)\/reject$/);
      if (reject && req.method === "POST") {
        const id = decodeURIComponent(reject[1]);
        const body = await readBody(req);
        const result = api.rejectCandidate(id, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }

      if (req.method === "GET" && pathname === "/api/reviews") {
        const url = new URL(req.url, `http://${host}`);
        const result = api.listReviews({
          candidateId: url.searchParams.get("candidateId") || undefined,
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
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
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
        resolve({ host, port, url: `http://${host}:${port}`, server, api });
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
  createAikidoReviewDashboardServer,
};
