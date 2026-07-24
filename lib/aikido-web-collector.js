/**
 * KC-001 — Aikido Web Source Collector.
 * Fetches explicit public HTML URLs into Source Intake.
 * No site-wide crawl, no JS rendering, no X/Twitter.
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { normalizeUrl } = require("./aikido-source-intake");

const COLLECTOR_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MIN_TEXT_LENGTH = 100;
const DEFAULT_USER_AGENT =
  "x-timeline-collector-aikido-web/1 (+https://github.com/; research; respectful)";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

/**
 * Validate URL is safe for fetching (http/https, no private targets).
 * @param {string} urlString
 * @returns {URL}
 */
function assertSafeUrl(urlString) {
  if (urlString == null || !String(urlString).trim()) {
    const err = new Error("url is required");
    err.code = "aikido-web-url";
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(String(urlString).trim());
  } catch (_error) {
    const err = new Error(`invalid URL: ${urlString}`);
    err.code = "aikido-web-url";
    throw err;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    const err = new Error(`unsupported URL scheme: ${parsed.protocol}`);
    err.code = "aikido-web-url-scheme";
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error("URL must not contain credentials");
    err.code = "aikido-web-url-credentials";
    throw err;
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    const err = new Error(`blocked hostname: ${host}`);
    err.code = "aikido-web-url-host";
    throw err;
  }
  if (isPrivateOrLoopbackHost(host)) {
    const err = new Error(`private/loopback host is not allowed: ${host}`);
    err.code = "aikido-web-url-private";
    throw err;
  }
  return parsed;
}

function isPrivateOrLoopbackHost(hostname) {
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  // IPv4
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function resolveNow(options = {}) {
  if (options.now != null) {
    const v = typeof options.now === "function" ? options.now() : options.now;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number") return new Date(v).toISOString();
    return String(v);
  }
  return new Date().toISOString();
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeElements(html, tagName) {
  const re = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
    "gi"
  );
  return String(html || "").replace(re, " ");
}

function extractMetaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta\\b[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["'][^>]*>`,
      "i"
    );
    const re2 = new RegExp(
      `<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["'][^>]*>`,
      "i"
    );
    const m = html.match(re) || html.match(re2);
    if (m && m[1] && m[1].trim()) return decodeHtmlEntities(m[1].trim());
  }
  return "";
}

function extractAttr(html, tagRe, attr) {
  const m = String(html || "").match(tagRe);
  if (!m) return "";
  const tag = m[0];
  const attrRe = new RegExp(`${attr}=["']([^"']+)["']`, "i");
  const a = tag.match(attrRe);
  return a ? decodeHtmlEntities(a[1].trim()) : "";
}

function extractTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return normalizeWhitespace(decodeHtmlEntities(stripTags(m[1])));
}

function extractLang(html) {
  const m = String(html || "").match(/<html\b[^>]*\blang=["']([^"']+)["']/i);
  if (m && m[1]) return m[1].trim().toLowerCase().slice(0, 16);
  const meta = extractMetaContent(html, ["language", "og:locale"]);
  return meta ? meta.toLowerCase().slice(0, 16) : "";
}

function extractBlock(html, selectorTag) {
  // selectorTag: article | main | body or attribute role=main
  if (selectorTag === '[role="main"]') {
    const re =
      /<([a-z0-9]+)([^>]*\brole=["']main["'][^>]*)>([\s\S]*?)<\/\1>/i;
    const m = String(html || "").match(re);
    return m ? m[0] : "";
  }
  const re = new RegExp(
    `<${selectorTag}\\b[^>]*>([\\s\\S]*?)<\\/${selectorTag}>`,
    "i"
  );
  const m = String(html || "").match(re);
  return m ? m[0] : "";
}

function cleanHtmlForText(html) {
  let out = String(html || "");
  for (const tag of [
    "script",
    "style",
    "noscript",
    "nav",
    "footer",
    "header",
    "form",
    "iframe",
  ]) {
    out = removeElements(out, tag);
  }
  // remove remaining void/script-like
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  return out;
}

function extractMainText(html) {
  const cleaned = cleanHtmlForText(html);
  const candidates = [
    extractBlock(cleaned, "article"),
    extractBlock(cleaned, "main"),
    extractBlock(cleaned, '[role="main"]'),
    extractBlock(cleaned, "body"),
    cleaned,
  ];
  for (const block of candidates) {
    if (!block) continue;
    const text = normalizeWhitespace(decodeHtmlEntities(stripTags(block)));
    if (text) return text;
  }
  return "";
}

/**
 * Parse HTML into source fields (pure, deterministic).
 */
function parseHtmlDocument(html, baseUrl, options = {}) {
  const warnings = [];
  const title = extractTitle(html);
  const canonical =
    extractAttr(
      html,
      /<link\b[^>]*rel=["']canonical["'][^>]*>/i,
      "href"
    ) ||
    extractMetaContent(html, ["og:url"]);
  let canonicalUrl = "";
  if (canonical) {
    try {
      canonicalUrl = new URL(canonical, baseUrl).toString();
    } catch (_error) {
      warnings.push(`invalid canonical URL: ${canonical}`);
    }
  }

  const author =
    extractMetaContent(html, [
      "author",
      "article:author",
      "og:article:author",
    ]) || "";
  const publisher =
    extractMetaContent(html, [
      "og:site_name",
      "application-name",
      "publisher",
    ]) || "";
  const publishedAt =
    extractMetaContent(html, [
      "article:published_time",
      "og:published_time",
      "publishdate",
      "date",
      "DC.date",
    ]) || "";
  const description =
    extractMetaContent(html, ["description", "og:description"]) || "";
  let language = extractLang(html);
  if (!language) language = "ja";

  const rawText = extractMainText(html);
  const summary = description;

  return {
    title,
    author,
    publisher,
    publishedAt,
    language,
    rawText,
    summary,
    canonicalUrl,
    warnings,
  };
}

function inferSourceType({ url, title, options }) {
  if (options.sourceType != null && String(options.sourceType).trim()) {
    return String(options.sourceType).trim();
  }
  const hay = `${url || ""} ${title || ""}`.toLowerCase();
  if (
    /aikikai|aikido[\.-]?federation|合気会|国際合気道/.test(hay) ||
    /official/.test(hay)
  ) {
    return "official-site";
  }
  if (/dojo|道場/.test(hay)) return "dojo-site";
  if (/interview|インタビュー/.test(hay)) return "interview";
  if (/blog|記事|article|news|解説/.test(hay)) return "article";
  return "article";
}

/**
 * Default Node http(s) fetcher for CLI / production use.
 */
function createDefaultHttpFetcher(defaults = {}) {
  return {
    name: "node-http",
    fetch(url, options = {}) {
      const timeoutMs =
        options.timeoutMs != null
          ? Number(options.timeoutMs)
          : defaults.timeoutMs != null
            ? Number(defaults.timeoutMs)
            : DEFAULT_TIMEOUT_MS;
      const maxResponseBytes =
        options.maxResponseBytes != null
          ? Number(options.maxResponseBytes)
          : defaults.maxResponseBytes != null
            ? Number(defaults.maxResponseBytes)
            : DEFAULT_MAX_RESPONSE_BYTES;
      const userAgent =
        options.userAgent || defaults.userAgent || DEFAULT_USER_AGENT;

      assertSafeUrl(url);

      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === "https:" ? https : http;
        const req = lib.request(
          parsed,
          {
            method: "GET",
            headers: {
              "User-Agent": userAgent,
              Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            },
            timeout: timeoutMs,
          },
          (res) => {
            const status = res.statusCode || 0;
            // Follow one redirect manually with safety checks
            if (
              status >= 300 &&
              status < 400 &&
              res.headers.location &&
              (options._redirects || 0) < 5
            ) {
              res.resume();
              let nextUrl;
              try {
                nextUrl = new URL(res.headers.location, url).toString();
                assertSafeUrl(nextUrl);
              } catch (error) {
                reject(error);
                return;
              }
              createDefaultHttpFetcher(defaults)
                .fetch(nextUrl, {
                  ...options,
                  _redirects: (options._redirects || 0) + 1,
                })
                .then(resolve, reject);
              return;
            }

            const chunks = [];
            let size = 0;
            let aborted = false;
            res.on("data", (chunk) => {
              size += chunk.length;
              if (size > maxResponseBytes) {
                aborted = true;
                req.destroy();
                const err = new Error(
                  `response exceeds maxResponseBytes (${maxResponseBytes})`
                );
                err.code = "aikido-web-max-bytes";
                reject(err);
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              if (aborted) return;
              const body = Buffer.concat(chunks).toString("utf8");
              resolve({
                url: parsed.toString(),
                finalUrl: parsed.toString(),
                status,
                headers: res.headers || {},
                body,
                fetchedAt: resolveNow(options),
              });
            });
          }
        );
        req.on("timeout", () => {
          req.destroy();
          const err = new Error(`request timed out after ${timeoutMs}ms`);
          err.code = "aikido-web-timeout";
          reject(err);
        });
        req.on("error", (error) => {
          const err = new Error(`fetch failed: ${error.message}`);
          err.code = "aikido-web-fetch";
          err.cause = error;
          reject(err);
        });
        req.end();
      });
    },
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.fetcher]
 * @param {object} [options.sourceIntake]
 * @param {function} [options.now]
 */
function createAikidoWebCollector(options = {}) {
  const fetcher =
    options.fetcher && typeof options.fetcher.fetch === "function"
      ? options.fetcher
      : createDefaultHttpFetcher(options);
  const sourceIntake = options.sourceIntake || null;
  const nowFn = options.now;

  function buildPreview(url, callOptions = {}) {
    const originalUrl = String(url).trim();
    assertSafeUrl(originalUrl);
    const fetchedAt = resolveNow({
      now: callOptions.now != null ? callOptions.now : nowFn,
    });
    const warnings = [];
    const errors = [];

    return fetcher
      .fetch(originalUrl, {
        timeoutMs: callOptions.timeoutMs,
        maxResponseBytes: callOptions.maxResponseBytes,
        userAgent: callOptions.userAgent,
        now: fetchedAt,
      })
      .then((response) => {
        const finalUrl = response.finalUrl || response.url || originalUrl;
        assertSafeUrl(finalUrl);
        const normalizedUrl = normalizeUrl(finalUrl);
        const status = Number(response.status) || 0;
        const contentType = String(
          (response.headers &&
            (response.headers["content-type"] ||
              response.headers["Content-Type"])) ||
            ""
        );
        const body = String(response.body || "");

        const meta = {
          status,
          contentType,
          fetchedAt: response.fetchedAt || fetchedAt,
          collectorVersion: COLLECTOR_VERSION,
        };

        if (status < 200 || status >= 300) {
          errors.push(`HTTP ${status}`);
          return {
            url: originalUrl,
            normalizedUrl,
            source: null,
            warnings,
            errors,
            metadata: meta,
          };
        }

        const htmlContentType = /text\/html|application\/xhtml\+xml/i.test(
          contentType
        );
        const looksLikeHtml = /^\s*</.test(body);
        if (contentType && !htmlContentType) {
          errors.push(`unsupported content-type: ${contentType}`);
          return {
            url: originalUrl,
            normalizedUrl,
            source: null,
            warnings,
            errors,
            metadata: meta,
          };
        }
        if (!htmlContentType && !looksLikeHtml) {
          errors.push("response body is not HTML");
          return {
            url: originalUrl,
            normalizedUrl,
            source: null,
            warnings,
            errors,
            metadata: meta,
          };
        }

        const parsed = parseHtmlDocument(body, finalUrl, callOptions);
        warnings.push(...parsed.warnings);

        const minTextLength =
          callOptions.minTextLength != null
            ? Number(callOptions.minTextLength)
            : DEFAULT_MIN_TEXT_LENGTH;

        if (!parsed.title) {
          errors.push("title could not be extracted");
        }
        if (!parsed.rawText) {
          errors.push("main text is empty");
        } else if (parsed.rawText.length < minTextLength) {
          errors.push(
            `main text shorter than minTextLength (${minTextLength})`
          );
        }

        const sourceType = inferSourceType({
          url: finalUrl,
          title: parsed.title,
          options: callOptions,
        });

        const tags = Array.isArray(callOptions.tags)
          ? callOptions.tags.map((t) => String(t))
          : [];

        const source = {
          sourceType,
          title: parsed.title,
          author: parsed.author,
          publisher: parsed.publisher,
          publishedAt: parsed.publishedAt,
          accessedAt: fetchedAt,
          language: parsed.language || "ja",
          rawText: parsed.rawText,
          summary: parsed.summary,
          notes: "",
          tags,
          metadata: {
            collector: "aikido-web",
            collectorVersion: COLLECTOR_VERSION,
            originalUrl,
            canonicalUrl: parsed.canonicalUrl || "",
            httpStatus: status,
            contentType,
            fetchedAt: response.fetchedAt || fetchedAt,
          },
        };

        return {
          url: originalUrl,
          normalizedUrl,
          source,
          warnings,
          errors,
          metadata: meta,
        };
      });
  }

  async function previewUrl(url, callOptions = {}) {
    return buildPreview(url, callOptions);
  }

  async function collectUrl(url, callOptions = {}) {
    if (!sourceIntake || typeof sourceIntake.createSource !== "function") {
      const err = new Error(
        "sourceIntake with createSource() is required for collectUrl"
      );
      err.code = "aikido-web-intake";
      throw err;
    }

    const preview = await buildPreview(url, callOptions);
    if (preview.errors.length || !preview.source) {
      const err = new Error(
        preview.errors.join("; ") || "failed to build source from URL"
      );
      err.code = "aikido-web-collect";
      err.preview = preview;
      throw err;
    }

    const record = sourceIntake.createSource({
      sourceType: preview.source.sourceType,
      title: preview.source.title,
      url: preview.normalizedUrl,
      author: preview.source.author,
      publisher: preview.source.publisher,
      publishedAt: preview.source.publishedAt,
      accessedAt: preview.source.accessedAt,
      language: preview.source.language,
      rawText: preview.source.rawText,
      summary: preview.source.summary,
      notes: preview.source.notes,
      tags: preview.source.tags,
      relatedKnowledgeIds: [],
      metadata: preview.source.metadata,
      allowDuplicateUrl: callOptions.allowDuplicateUrl === true,
      now: callOptions.now != null ? callOptions.now : nowFn,
    });

    return {
      source: record,
      created: true,
      warnings: preview.warnings,
      metadata: preview.metadata,
    };
  }

  async function collectUrls(urls, callOptions = {}) {
    const list = Array.isArray(urls) ? urls.slice() : [];
    const continueOnError = callOptions.continueOnError !== false;
    let working = list;
    if (callOptions.limit != null) {
      const limit = Number(callOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        const err = new Error("limit must be a non-negative integer");
        err.code = "aikido-web-options";
        throw err;
      }
      working = list.slice(0, limit);
    }

    const results = [];
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const url of working) {
      try {
        const result = await collectUrl(url, callOptions);
        results.push({ url, ok: true, ...result });
        createdCount += 1;
      } catch (error) {
        errorCount += 1;
        const skipped =
          error && error.code === "aikido-source-duplicate-url";
        if (skipped) skippedCount += 1;
        results.push({
          url,
          ok: false,
          created: false,
          skipped,
          error: {
            message: error && error.message ? error.message : String(error),
            code: error && error.code ? error.code : "aikido-web-error",
          },
          warnings: (error && error.preview && error.preview.warnings) || [],
        });
        if (!continueOnError) break;
      }
    }

    return {
      results,
      summary: {
        requestedCount: list.length,
        processedCount: results.length,
        createdCount,
        skippedCount,
        errorCount,
      },
    };
  }

  return {
    previewUrl,
    collectUrl,
    collectUrls,
    fetcherName: fetcher.name || "custom",
  };
}

module.exports = {
  COLLECTOR_VERSION,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MIN_TEXT_LENGTH,
  createAikidoWebCollector,
  createDefaultHttpFetcher,
  assertSafeUrl,
  isPrivateOrLoopbackHost,
  parseHtmlDocument,
  extractMainText,
  inferSourceType,
  decodeHtmlEntities,
  normalizeWhitespace,
};
