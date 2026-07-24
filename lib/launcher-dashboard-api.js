/**
 * EA-004 — Launcher Dashboard API.
 * Aggregates Review / Editorial / Morning Pipeline via existing library APIs.
 * Does not read store JSON files directly.
 */
const http = require("http");
const {
  createAikidoReviewDashboardApi,
} = require("./aikido-review-dashboard-api");
const {
  createEditorialDashboardApi,
} = require("./editorial-dashboard-api");
const {
  createMorningPipeline,
} = require("./aikido-morning-pipeline");
const { createAikidoKnowledgeStore } = require("./aikido-knowledge");
const { sanitizeMessage } = require("./dashboard-http");

const DEFAULT_REVIEW_URL = "http://127.0.0.1:4175";
const DEFAULT_EDITORIAL_URL = "http://127.0.0.1:4174";

function apiOk(data) {
  return { ok: true, data };
}

function apiErr(code, message, status = 400) {
  return {
    ok: false,
    status,
    error: { code: String(code), message: String(message) },
  };
}

function todayKey(iso, nowFn) {
  const stamp = iso || (typeof nowFn === "function" ? nowFn() : new Date().toISOString());
  return String(stamp).slice(0, 10);
}

/**
 * @param {string} url
 * @param {object} [deps]
 * @returns {Promise<{ available: boolean, ok?: boolean }>}
 */
function fetchHealth(url, deps = {}) {
  const request = deps.request || http.request;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const target = new URL("/health", url);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "GET",
          timeout: deps.timeoutMs != null ? Number(deps.timeoutMs) : 1500,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (_error) {
              json = null;
            }
            done({
              available: res.statusCode === 200 && json && json.ok === true,
              ok: !!(json && json.ok === true),
              statusCode: res.statusCode,
            });
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        done({ available: false, ok: false });
      });
      req.on("error", () => done({ available: false, ok: false }));
      req.end();
    } catch (_error) {
      done({ available: false, ok: false });
    }
  });
}

/**
 * @param {object} [options]
 */
function createLauncherDashboardApi(options = {}) {
  const rootDir = options.rootDir;
  const nowFn = options.now;
  const reviewUrl = options.reviewUrl || DEFAULT_REVIEW_URL;
  const editorialUrl = options.editorialUrl || DEFAULT_EDITORIAL_URL;

  const reviewApi =
    options.reviewApi ||
    createAikidoReviewDashboardApi({
      rootDir,
      now: nowFn,
      ...(options.reviewApiOptions || {}),
    });

  const knowledgeStore =
    options.knowledgeStore ||
    reviewApi.knowledgeStore ||
    createAikidoKnowledgeStore({
      rootDir,
      now: nowFn,
    });

  const editorialApi =
    options.editorialApi ||
    createEditorialDashboardApi({
      rootDir,
      now: nowFn,
      knowledgeStore,
      morningUrls: options.morningUrls || [],
      morningCollector: options.morningCollector,
      morningAnalyzer: options.morningAnalyzer,
      morningCandidateCreator: options.morningCandidateCreator,
      morningLogger: options.morningLogger || { info() {}, error() {} },
      morningPipeline: options.morningPipeline,
      ...(options.editorialApiOptions || {}),
    });

  const morningPipeline =
    options.morningPipeline ||
    editorialApi.morningPipeline ||
    createMorningPipeline({
      rootDir,
      now: nowFn,
      urls: options.morningUrls || [],
      logger: options.morningLogger || { info() {}, error() {} },
    });

  const httpDeps = options.httpDeps || {};

  function getStats() {
    const reviews = reviewApi.listCandidates({ status: "all" });
    const reviewItems =
      reviews.ok && reviews.data && Array.isArray(reviews.data.candidates)
        ? reviews.data.candidates
        : [];

    let pendingCandidates = 0;
    let approvedCandidates = 0;
    for (const r of reviewItems) {
      if (r.status === "pending" || r.status === "reviewing") {
        pendingCandidates += 1;
      }
      if (r.status === "approved" || r.status === "converted") {
        approvedCandidates += 1;
      }
    }
    if (
      reviews.ok &&
      reviews.data &&
      reviews.data.pendingCount != null &&
      pendingCandidates === 0
    ) {
      pendingCandidates = Number(reviews.data.pendingCount) || 0;
    }

    const knowledgeCount = knowledgeStore.listKnowledge({}).length;

    const editorials = editorialApi.listEditorials();
    const editorialItems =
      editorials.ok && editorials.data && Array.isArray(editorials.data.editorials)
        ? editorials.data.editorials
        : [];
    let editorialDrafts = 0;
    for (const e of editorialItems) {
      if (e.status === "draft" || e.status === "review") editorialDrafts += 1;
    }

    let published = 0;
    if (typeof editorialApi.listPublishes === "function") {
      const pub = editorialApi.listPublishes({
        status: "published",
        limit: 10000,
      });
      if (pub.ok && pub.data && Array.isArray(pub.data.publishes)) {
        published = pub.data.publishes.length;
      }
    }
    if (published === 0) {
      for (const e of editorialItems) {
        if (e.published || e.publishStatus === "published") published += 1;
      }
    }

    const history = morningPipeline.getHistory(50);
    const today = todayKey(null, nowFn);
    const todaysPipeline = history.filter(
      (h) => h.startedAt && String(h.startedAt).slice(0, 10) === today
    ).length;

    return apiOk({
      pendingCandidates,
      approvedCandidates,
      knowledge: knowledgeCount,
      editorialDrafts,
      published,
      todaysPipeline,
    });
  }

  function getActivity(limit = 20) {
    const max = Number.isInteger(Number(limit)) ? Math.min(Number(limit), 50) : 20;
    /** @type {{ type: string, at: string, summary: string, id?: string }[]} */
    const events = [];

    const history = morningPipeline.getHistory(20);
    for (const h of history) {
      events.push({
        type: "Pipeline",
        at: h.startedAt || h.finishedAt || "",
        summary: `${h.status || "Pipeline"} · collected ${h.collected || 0} · candidates ${h.candidates || 0}`,
        id: h.startedAt || null,
      });
    }

    const store =
      reviewApi.reviewStore ||
      (editorialApi.candidateReview ? editorialApi.candidateReview : null);
    const reviewItems =
      store && typeof store.listReviews === "function"
        ? store.listReviews({})
        : [];

    for (const r of reviewItems) {
      if (r.status === "approved" || r.status === "converted") {
        events.push({
          type: "Approve",
          at: r.approvedAt || r.convertedAt || r.updatedAt || r.createdAt || "",
          summary: r.title || r.id || "Approved candidate",
          id: r.id,
        });
      }
      if (r.status === "rejected") {
        events.push({
          type: "Reject",
          at: r.rejectedAt || r.updatedAt || r.createdAt || "",
          summary: r.title || r.id || "Rejected candidate",
          id: r.id,
        });
      }
    }

    const editorials = editorialApi.listEditorials();
    const editorialItems =
      editorials.ok && editorials.data && Array.isArray(editorials.data.editorials)
        ? editorials.data.editorials
        : [];
    for (const e of editorialItems) {
      events.push({
        type: "Editorial Save",
        at: e.updatedAt || e.createdAt || "",
        summary: e.title || e.id || "Editorial saved",
        id: e.id,
      });
    }

    const pubs = editorialApi.listPublishes({ limit: 50 });
    if (pubs.ok && pubs.data && Array.isArray(pubs.data.publishes)) {
      for (const p of pubs.data.publishes) {
        events.push({
          type: "Publish",
          at: p.publishedAt || "",
          summary: `Published ${p.editorialId || p.publishId || ""}`.trim(),
          id: p.publishId || p.editorialId,
        });
      }
    }

    events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return apiOk({ activity: events.slice(0, max) });
  }

  async function getSystemHealth() {
    const [review, editorial] = await Promise.all([
      fetchHealth(reviewUrl, httpDeps),
      fetchHealth(editorialUrl, httpDeps),
    ]);

    let pipelineAvailable = true;
    try {
      morningPipeline.getStatus();
    } catch (_error) {
      pipelineAvailable = false;
    }

    return apiOk({
      review: {
        label: "Review Dashboard",
        url: reviewUrl,
        status: review.available ? "Available" : "Unavailable",
        available: review.available,
      },
      editorial: {
        label: "Editorial Dashboard",
        url: editorialUrl,
        status: editorial.available ? "Available" : "Unavailable",
        available: editorial.available,
      },
      pipeline: {
        label: "Pipeline",
        status: pipelineAvailable ? "Available" : "Unavailable",
        available: pipelineAvailable,
      },
    });
  }

  function getHome() {
    const stats = getStats();
    const activity = getActivity(20);
    const pipelineStatus = morningPipeline.getStatus();
    let candidateCount = 0;
    try {
      if (editorialApi.candidateReview) {
        candidateCount = editorialApi.candidateReview.listReviews({}).length;
      }
    } catch (_error) {
      candidateCount = 0;
    }

    return apiOk({
      title: "Aikido Knowledge Platform",
      links: {
        review: reviewUrl,
        editorial: editorialUrl,
      },
      stats: stats.ok ? stats.data : null,
      activity: activity.ok ? activity.data.activity : [],
      pipeline: {
        ...pipelineStatus,
        candidateCount,
      },
    });
  }

  async function runMorningPipeline(bodyPayload = {}) {
    if (bodyPayload != null && typeof bodyPayload !== "object") {
      return apiErr("INVALID_REQUEST", "Request body must be a JSON object.");
    }
    if (typeof editorialApi.runMorningPipeline === "function") {
      return editorialApi.runMorningPipeline(bodyPayload || {});
    }
    try {
      const result = await morningPipeline.run({
        dryRun: bodyPayload && bodyPayload.dryRun === true,
      });
      return apiOk({
        result,
        status: morningPipeline.getStatus(),
        history: morningPipeline.getHistory(20),
      });
    } catch (error) {
      return apiErr(
        error && error.code ? error.code : "PIPELINE_FAILED",
        sanitizeMessage(error && error.message ? error.message : error),
        error && error.code === "PIPELINE_ALREADY_RUNNING" ? 409 : 400
      );
    }
  }

  function getMorningStatus() {
    if (typeof editorialApi.getMorningPipelineStatus === "function") {
      return editorialApi.getMorningPipelineStatus();
    }
    return apiOk(morningPipeline.getStatus());
  }

  return {
    reviewUrl,
    editorialUrl,
    reviewApi,
    editorialApi,
    morningPipeline,
    knowledgeStore,
    getHome,
    getStats,
    getActivity,
    getSystemHealth,
    runMorningPipeline,
    getMorningStatus,
    fetchHealth,
  };
}

module.exports = {
  DEFAULT_REVIEW_URL,
  DEFAULT_EDITORIAL_URL,
  createLauncherDashboardApi,
  fetchHealth,
  apiOk,
  apiErr,
};
