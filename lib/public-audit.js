/**
 * EP-018 — Public-release safety checks (stdlib only).
 * Detects secrets / private paths / private trees. Never prints secret values.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PLACEHOLDER_API_KEY = "your_openai_api_key_here";

const FORBIDDEN_TRACKED_PREFIXES = [
  "output/",
  "runs/",
  "browser-data/",
  "knowledge-base/",
  ".pipeline-work/",
  "logs/",
];

const FORBIDDEN_TRACKED_EXACT = new Set([".env"]);

const RAW_TIMELINE_NAMES = new Set([
  "timeline.json",
  "timeline.csv",
  "timeline_analyzed.json",
  "timeline_ai.json",
  "timeline_enriched.json",
  "uncategorized.json",
  "uncategorized.txt",
  "ai_cache.json",
  "ai_progress.json",
  "enrich_cache.json",
  "enrich_progress.json",
]);

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".htm",
  ".css",
  ".yml",
  ".yaml",
  ".webmanifest",
  ".svg",
  ".env",
  ".example",
  ".gitignore",
  ".csv",
]);

// Construct patterns so this source file does not self-match live-looking values.
const SK_PROJ_RE = new RegExp(
  String.raw`sk-` + String.raw`proj-[A-Za-z0-9_-]{8,}`
);
const SK_LIVE_RE = new RegExp(
  String.raw`\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}`
);
const USERS_PATH_RE = /\/Users\/[A-Za-z0-9._-]+/;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const OPENAI_ASSIGN_RE = /OPENAI_API_KEY\s*=\s*([^\s#]+)/;

function isTextPath(filePath) {
  const base = path.basename(filePath);
  if (base === ".gitignore" || base === ".env" || base.endsWith(".example")) {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function listTrackedFiles(rootDir = process.cwd()) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: rootDir,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function redactSnippet(line, max = 120) {
  let s = String(line || "")
    .replace(SK_PROJ_RE, "sk-proj-[REDACTED]")
    .replace(SK_LIVE_RE, "sk-[REDACTED]")
    .replace(
      /(OPENAI_API_KEY\s*=\s*)(?!your_openai_api_key_here)[^\s"']+/gi,
      "$1[REDACTED]"
    )
    .replace(/(\/Users\/)[^/\s"']+/g, "$1[REDACTED]")
    .replace(
      /BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY_BLOCK]"
    );
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

function pushFinding(findings, finding) {
  findings.push({
    severity: finding.severity || "critical",
    rule: finding.rule,
    path: finding.path,
    line: finding.line || null,
    detail: finding.detail || "",
  });
}

function isSafeApiKeyValue(value) {
  const v = String(value || "").replace(/^["']|["']$/g, "");
  if (!v) return true;
  if (v === PLACEHOLDER_API_KEY) return true;
  if (v === "[REDACTED]" || v === "REDACTED") return true;
  if (/^your_/i.test(v)) return true;
  if (/^<.*>$/.test(v)) return true;
  if (/^\.+/.test(v)) return true;
  return false;
}

function looksLikeLiveSk(line) {
  if (!SK_LIVE_RE.test(line) && !SK_PROJ_RE.test(line)) return false;
  // Ignore documentation / test meta that only names the pattern family.
  if (/REDACTED|placeholder|example|your_|sk-\.\.\.|rule:|includes\(/i.test(line)) {
    // Still flag if a long live-looking token remains after removing redaction markers.
    const stripped = line
      .replace(/sk-proj-\[REDACTED\]/g, "")
      .replace(/sk-\[REDACTED\]/g, "");
    return SK_PROJ_RE.test(stripped) || SK_LIVE_RE.test(stripped);
  }
  return true;
}

function checkTrackedPathRules(trackedFiles, findings) {
  for (const file of trackedFiles) {
    const normalized = file.replace(/\\/g, "/");
    if (FORBIDDEN_TRACKED_EXACT.has(normalized)) {
      pushFinding(findings, {
        rule: "tracked-dotenv",
        path: normalized,
        detail: "`.env` must not be tracked",
      });
    }
    for (const prefix of FORBIDDEN_TRACKED_PREFIXES) {
      if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
        pushFinding(findings, {
          rule: "tracked-private-tree",
          path: normalized,
          detail: `private path prefix \`${prefix}\``,
        });
      }
    }
    if (/^runs-[^/]+\//.test(normalized)) {
      pushFinding(findings, {
        rule: "tracked-runs-variant",
        path: normalized,
        detail: "tracked runs-* workspace",
      });
    }
    const base = path.posix.basename(normalized);
    if (RAW_TIMELINE_NAMES.has(base) && !normalized.startsWith("test/")) {
      pushFinding(findings, {
        rule: "tracked-raw-timeline-name",
        path: normalized,
        detail: `raw timeline artifact name \`${base}\``,
      });
    }
  }
}

function scanLineSecrets(filePath, line, lineNo, findings) {
  if (looksLikeLiveSk(line)) {
    if (SK_PROJ_RE.test(line)) {
      pushFinding(findings, {
        rule: "openai-project-key",
        path: filePath,
        line: lineNo,
        detail: redactSnippet(line),
      });
    } else {
      pushFinding(findings, {
        rule: "openai-live-key",
        path: filePath,
        line: lineNo,
        detail: redactSnippet(line),
      });
    }
  }

  const envMatch = line.match(OPENAI_ASSIGN_RE);
  if (envMatch && !isSafeApiKeyValue(envMatch[1])) {
    pushFinding(findings, {
      rule: "openai-key-non-placeholder",
      path: filePath,
      line: lineNo,
      detail: "OPENAI_API_KEY=[REDACTED]",
    });
  }

  if (PRIVATE_KEY_RE.test(line)) {
    pushFinding(findings, {
      rule: "private-key-header",
      path: filePath,
      line: lineNo,
      detail: "private key header",
    });
  }

  if (USERS_PATH_RE.test(line)) {
    pushFinding(findings, {
      rule: "users-absolute-path",
      path: filePath,
      line: lineNo,
      detail: redactSnippet(line),
    });
  }
}

function scanSiteLine(filePath, line, lineNo, findings) {
  if (/\boutput\//.test(line) || /\bruns(?:-\w+)?\//.test(line)) {
    pushFinding(findings, {
      rule: "site-private-path-ref",
      path: filePath,
      line: lineNo,
      detail: redactSnippet(line),
    });
  }
}

function scanTextContent(filePath, content, findings, { siteMode = false } = {}) {
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    scanLineSecrets(filePath, line, lineNo, findings);
    if (siteMode) scanSiteLine(filePath, line, lineNo, findings);
  });

  if (siteMode) {
    for (const name of RAW_TIMELINE_NAMES) {
      if (content.includes(name)) {
        pushFinding(findings, {
          rule: "raw-timeline-filename-reference",
          path: filePath,
          detail: `mentions \`${name}\``,
        });
      }
    }
  }
}

function walkFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      files.push({ path: full, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      walkFiles(full, files);
    } else if (entry.isFile()) {
      files.push({ path: full, symlink: false });
    }
  }
  return files;
}

function shouldScanTrackedContent(rel) {
  // Skip self and tests for fixture strings; path rules still apply via git ls-files.
  if (rel === "lib/public-audit.js") return false;
  if (rel.startsWith("test/")) return false;
  return true;
}

function auditTrackedPublicTree(rootDir = process.cwd()) {
  const findings = [];
  const tracked = listTrackedFiles(rootDir);
  checkTrackedPathRules(tracked, findings);

  for (const rel of tracked) {
    if (!isTextPath(rel)) continue;
    if (!shouldScanTrackedContent(rel)) continue;
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) continue;
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (_err) {
      continue;
    }
    const siteMode = rel.replace(/\\/g, "/").startsWith("site/");
    // Non-site trees: secret/path scans only (docs may name timeline files).
    if (siteMode) {
      scanTextContent(rel, content, findings, { siteMode: true });
    } else {
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        scanLineSecrets(rel, line, idx + 1, findings);
      });
    }
  }

  return { findings, trackedCount: tracked.length };
}

function validateSiteDirectory(siteRoot, { requireManifest = true } = {}) {
  const findings = [];
  const root = path.resolve(siteRoot);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    pushFinding(findings, {
      rule: "site-missing",
      path: root,
      detail: "site directory missing",
    });
    return { findings, ok: false };
  }

  const indexPath = path.join(root, "index.html");
  if (!fs.existsSync(indexPath)) {
    pushFinding(findings, {
      rule: "site-index-missing",
      path: path.relative(process.cwd(), indexPath) || "site/index.html",
      detail: "site/index.html is required",
    });
  }

  if (requireManifest) {
    const manifestPath = path.join(root, "manifest.webmanifest");
    if (!fs.existsSync(manifestPath)) {
      pushFinding(findings, {
        rule: "site-manifest-missing",
        path:
          path.relative(process.cwd(), manifestPath) ||
          "site/manifest.webmanifest",
        detail: "site/manifest.webmanifest is required",
      });
    }
  }

  const walked = walkFiles(root);
  for (const item of walked) {
    const rel = path.relative(root, item.path).replace(/\\/g, "/");
    const display = path.join("site", rel).replace(/\\/g, "/");

    if (item.symlink) {
      let target = "";
      try {
        target = fs.readlinkSync(item.path);
      } catch (_err) {
        target = "";
      }
      const resolved = path.resolve(path.dirname(item.path), target);
      const outside = path.relative(root, resolved).startsWith("..");
      pushFinding(findings, {
        rule: outside ? "site-symlink-escape" : "site-symlink",
        path: display,
        detail: outside
          ? "symlink escapes site/"
          : "symlinks are not allowed in site/",
      });
      continue;
    }

    const base = path.basename(item.path);
    if (base === ".env" || base.startsWith(".env.")) {
      pushFinding(findings, {
        rule: "site-dotenv",
        path: display,
        detail: "env file inside site/",
      });
    }
    if (RAW_TIMELINE_NAMES.has(base)) {
      pushFinding(findings, {
        rule: "site-raw-timeline-file",
        path: display,
        detail: `raw timeline file \`${base}\``,
      });
    }

    if (!isTextPath(item.path)) continue;
    let content;
    try {
      content = fs.readFileSync(item.path, "utf8");
    } catch (_err) {
      continue;
    }
    scanTextContent(display, content, findings, { siteMode: true });
  }

  const critical = findings.filter((f) => f.severity === "critical");
  return { findings, ok: critical.length === 0 };
}

function formatFindings(findings) {
  return findings.map((f) => {
    const loc = f.line ? `${f.path}:${f.line}` : f.path;
    return `[${f.severity}] ${f.rule} @ ${loc}${f.detail ? ` — ${f.detail}` : ""}`;
  });
}

module.exports = {
  PLACEHOLDER_API_KEY,
  RAW_TIMELINE_NAMES,
  FORBIDDEN_TRACKED_PREFIXES,
  listTrackedFiles,
  auditTrackedPublicTree,
  validateSiteDirectory,
  formatFindings,
  redactSnippet,
  isTextPath,
};
