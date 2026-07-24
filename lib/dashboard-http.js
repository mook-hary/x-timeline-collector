/**
 * Shared HTTP helpers for local dashboards (ED-001 / EA-001).
 * Behavior-compatible with editorial-dashboard-server utilities.
 */
const path = require("path");

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
  let rel = decoded.split("?")[0].split("#")[0];
  if (!rel.startsWith("/")) rel = `/${rel}`;
  if (rel === "/") rel = "/index.html";
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

function sanitizeMessage(message) {
  return String(message == null ? "" : message)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization[:\s]+\S+/gi, "Authorization: [REDACTED]")
    .replace(/X_USER_ACCESS_TOKEN[=:\s]+\S+/gi, "X_USER_ACCESS_TOKEN=[REDACTED]")
    .replace(/\/Users\/[^\s]+/g, "[PATH]")
    .replace(/\/home\/[^\s]+/g, "[PATH]");
}

function isForbiddenStaticBase(filePath) {
  const base = path.basename(filePath);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "package.json" || base === "README.md") return true;
  if (filePath.includes(`${path.sep}.pipeline-work${path.sep}`)) return true;
  return false;
}

module.exports = {
  MIME,
  sendJson,
  readBody,
  resolveSafeStaticPath,
  sanitizeMessage,
  isForbiddenStaticBase,
};
