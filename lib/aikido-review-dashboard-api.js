/**
 * EA-001 — Aikido Candidate Review Dashboard API.
 * Reuses Candidate Review + Knowledge Store + Source Intake.
 */
const {
  createAikidoCandidateReview,
} = require("./aikido-candidate-review");
const {
  createAikidoKnowledgeStore,
  normalizeKnowledge,
  CATEGORIES,
} = require("./aikido-knowledge");
const { createAikidoSourceIntake } = require("./aikido-source-intake");
const { sanitizeMessage } = require("./dashboard-http");

const ERROR_CODES = Object.freeze({
  CANDIDATE_NOT_FOUND: "CANDIDATE_NOT_FOUND",
  CANDIDATE_TITLE_REQUIRED: "CANDIDATE_TITLE_REQUIRED",
  CANDIDATE_CATEGORY_REQUIRED: "CANDIDATE_CATEGORY_REQUIRED",
  CANDIDATE_CONTENT_REQUIRED: "CANDIDATE_CONTENT_REQUIRED",
  CANDIDATE_SAVE_FAILED: "CANDIDATE_SAVE_FAILED",
  CANDIDATE_READONLY: "CANDIDATE_READONLY",
  KNOWLEDGE_PREVIEW_FAILED: "KNOWLEDGE_PREVIEW_FAILED",
  APPROVAL_CONFIRMATION_REQUIRED: "APPROVAL_CONFIRMATION_REQUIRED",
  REJECTION_CONFIRMATION_REQUIRED: "REJECTION_CONFIRMATION_REQUIRED",
  ALREADY_APPROVED: "ALREADY_APPROVED",
  ALREADY_REJECTED: "ALREADY_REJECTED",
  KNOWLEDGE_CREATE_FAILED: "KNOWLEDGE_CREATE_FAILED",
  REVIEW_SAVE_FAILED: "REVIEW_SAVE_FAILED",
  INVALID_REQUEST_BODY: "INVALID_REQUEST_BODY",
  REJECTION_REASON_REQUIRED: "REJECTION_REASON_REQUIRED",
});

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

function parseTags(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function isEditableStatus(status) {
  return status === "pending" || status === "reviewing";
}

function buildKnowledgePreviewFromReview(review) {
  return normalizeKnowledge(
    {
      title: review.title,
      category: review.category,
      summary: review.summary,
      content: review.content,
      tags: review.tags,
      difficulty: review.difficulty,
      sources: review.sourceId ? [review.sourceId] : [],
      related: [],
      status: "draft",
    },
    { isCreate: true, now: "1970-01-01T00:00:00.000Z" }
  );
}

/**
 * @param {object} [options]
 */
function createAikidoReviewDashboardApi(options = {}) {
  const rootDir = options.rootDir;
  const knowledgeStore =
    options.knowledgeStore ||
    createAikidoKnowledgeStore({ rootDir, now: options.now });
  const reviewStore =
    options.reviewStore ||
    createAikidoCandidateReview({
      rootDir,
      now: options.now,
      knowledgeStore,
    });
  const sourceIntake =
    options.sourceIntake ||
    createAikidoSourceIntake({ rootDir, now: options.now });

  function loadSource(sourceId) {
    if (!sourceId || typeof sourceIntake.findSource !== "function") {
      return null;
    }
    try {
      return sourceIntake.findSource(sourceId);
    } catch (_error) {
      return null;
    }
  }

  function toListItem(review) {
    return {
      id: review.id,
      candidateId: review.candidateId,
      title: review.title || "",
      category: review.category,
      status: review.status,
      sourceId: review.sourceId || null,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      knowledgeId: review.knowledgeId || null,
    };
  }

  function toDetail(review) {
    const source = loadSource(review.sourceId);
    let sourceInfo = null;
    if (source) {
      sourceInfo = {
        id: source.id,
        title: source.title || "",
        sourceType: source.sourceType || "",
        url: source.url || "",
        collectedAt: source.accessedAt || source.createdAt || null,
      };
    }

    const decision =
      review.status === "converted" || review.status === "approved"
        ? "approved"
        : review.status === "rejected"
          ? "rejected"
          : null;

    return {
      id: review.id,
      candidateId: review.candidateId,
      sourceId: review.sourceId,
      title: review.title || "",
      category: review.category,
      summary: review.summary || "",
      content: review.content || "",
      tags: Array.isArray(review.tags) ? review.tags : [],
      difficulty: review.difficulty,
      status: review.status,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      knowledgeId: review.knowledgeId || null,
      editable: isEditableStatus(review.status),
      source: sourceInfo,
      sourceUnavailable: !sourceInfo && !!review.sourceId,
      review: {
        decision,
        reason: review.rejectionReason || review.reviewerNotes || null,
        knowledgeId: review.knowledgeId || null,
        reviewedAt:
          review.convertedAt ||
          review.approvedAt ||
          review.rejectedAt ||
          review.reviewedAt ||
          null,
        status: review.status,
      },
    };
  }

  function sortCandidates(items) {
    const rank = (status) => {
      if (status === "pending") return 0;
      if (status === "reviewing") return 1;
      return 2;
    };
    return items.slice().sort((a, b) => {
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      const ca = String(a.createdAt || "");
      const cb = String(b.createdAt || "");
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function listCandidates(query = {}) {
    let items = reviewStore.listReviews();
    const filter = query.status != null ? String(query.status).trim() : "";
    if (filter && filter.toLowerCase() !== "all") {
      const want = filter.toLowerCase();
      if (want === "pending") {
        items = items.filter(
          (r) => r.status === "pending" || r.status === "reviewing"
        );
      } else if (want === "approved") {
        items = items.filter(
          (r) => r.status === "approved" || r.status === "converted"
        );
      } else if (want === "rejected") {
        items = items.filter((r) => r.status === "rejected");
      } else {
        items = items.filter((r) => r.status === want);
      }
    }
    items = sortCandidates(items);
    const pendingCount = reviewStore
      .listReviews()
      .filter((r) => r.status === "pending" || r.status === "reviewing")
      .length;
    return apiOk({
      candidates: items.map(toListItem),
      pendingCount,
      categories: CATEGORIES.slice(),
    });
  }

  function getCandidate(id) {
    const review = reviewStore.findReview(id);
    if (!review) {
      return apiErr(
        ERROR_CODES.CANDIDATE_NOT_FOUND,
        "Candidate not found.",
        404
      );
    }
    return apiOk({ candidate: toDetail(review) });
  }

  function saveCandidate(id, body) {
    if (!body || typeof body !== "object") {
      return apiErr(
        ERROR_CODES.INVALID_REQUEST_BODY,
        "Request body must be a JSON object."
      );
    }
    const existing = reviewStore.findReview(id);
    if (!existing) {
      return apiErr(
        ERROR_CODES.CANDIDATE_NOT_FOUND,
        "Candidate not found.",
        404
      );
    }
    if (!isEditableStatus(existing.status)) {
      return apiErr(
        ERROR_CODES.CANDIDATE_READONLY,
        "Approved or rejected candidates cannot be edited.",
        409
      );
    }

    const title =
      body.title != null ? String(body.title).trim() : existing.title;
    const category =
      body.category != null ? String(body.category).trim() : existing.category;
    const content =
      body.content != null ? String(body.content) : existing.content;
    const summary =
      body.summary != null ? String(body.summary) : existing.summary;

    if (!title) {
      return apiErr(
        ERROR_CODES.CANDIDATE_TITLE_REQUIRED,
        "title is required."
      );
    }
    if (!category) {
      return apiErr(
        ERROR_CODES.CANDIDATE_CATEGORY_REQUIRED,
        "category is required."
      );
    }
    if (!String(content).trim()) {
      return apiErr(
        ERROR_CODES.CANDIDATE_CONTENT_REQUIRED,
        "content is required."
      );
    }

    const patch = {
      title,
      category,
      summary,
      content,
    };
    if (body.tags != null) patch.tags = parseTags(body.tags);
    if (body.difficulty != null && body.difficulty !== "") {
      patch.difficulty = body.difficulty;
    }

    try {
      const updated = reviewStore.updateReview(id, patch);
      return apiOk({
        candidate: toDetail(updated),
        message: "Candidate saved.",
      });
    } catch (error) {
      return apiErr(
        ERROR_CODES.CANDIDATE_SAVE_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }
  }

  function knowledgePreview(id) {
    const review = reviewStore.findReview(id);
    if (!review) {
      return apiErr(
        ERROR_CODES.CANDIDATE_NOT_FOUND,
        "Candidate not found.",
        404
      );
    }
    try {
      const preview = buildKnowledgePreviewFromReview(review);
      // Strip synthetic id/timestamps for display clarity; keep schema fields.
      return apiOk({
        preview: {
          title: preview.title,
          category: preview.category,
          summary: preview.summary,
          content: preview.content,
          tags: preview.tags,
          difficulty: preview.difficulty,
          sources: preview.sources,
          status: preview.status,
        },
      });
    } catch (error) {
      return apiErr(
        ERROR_CODES.KNOWLEDGE_PREVIEW_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }
  }

  function approveCandidate(id, body) {
    if (!body || typeof body !== "object") {
      return apiErr(
        ERROR_CODES.INVALID_REQUEST_BODY,
        "Request body must be a JSON object."
      );
    }
    if (body.confirm !== true) {
      return apiErr(
        ERROR_CODES.APPROVAL_CONFIRMATION_REQUIRED,
        "Approval requires confirm: true."
      );
    }

    const existing = reviewStore.findReview(id);
    if (!existing) {
      return apiErr(
        ERROR_CODES.CANDIDATE_NOT_FOUND,
        "Candidate not found.",
        404
      );
    }

    if (existing.status === "rejected") {
      return apiErr(
        ERROR_CODES.ALREADY_REJECTED,
        "Candidate is already rejected.",
        409
      );
    }

    if (
      existing.status === "converted" ||
      (existing.knowledgeId && String(existing.knowledgeId).trim())
    ) {
      return {
        ok: false,
        status: 409,
        error: {
          code: ERROR_CODES.ALREADY_APPROVED,
          message: "Already approved.",
        },
        data: {
          knowledgeId: existing.knowledgeId || null,
        },
      };
    }

    // Pre-validate Knowledge shape before mutating review status.
    try {
      buildKnowledgePreviewFromReview(existing);
    } catch (error) {
      return apiErr(
        ERROR_CODES.KNOWLEDGE_CREATE_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }

    try {
      const result =
        typeof reviewStore.approveAndCreateKnowledge === "function"
          ? reviewStore.approveAndCreateKnowledge(id)
          : (() => {
              if (existing.status !== "approved") {
                reviewStore.approveReview(id);
              }
              return reviewStore.createKnowledgeFromReview(id);
            })();
      return apiOk({
        message: "Approved successfully.",
        knowledgeId: result.knowledge.id,
        knowledge: result.knowledge,
        candidate: toDetail(result.review),
      });
    } catch (error) {
      if (error && error.code === "aikido-review-already-converted") {
        return {
          ok: false,
          status: 409,
          error: {
            code: ERROR_CODES.ALREADY_APPROVED,
            message: "Already approved.",
          },
          data: { knowledgeId: error.knowledgeId || existing.knowledgeId || null },
        };
      }
      // If Knowledge create failed first, review remains pending.
      const still = reviewStore.findReview(id);
      const code =
        still && still.status === "pending"
          ? ERROR_CODES.KNOWLEDGE_CREATE_FAILED
          : ERROR_CODES.KNOWLEDGE_CREATE_FAILED;
      return apiErr(
        code,
        sanitizeMessage(error && error.message ? error.message : error),
        500
      );
    }
  }

  function rejectCandidate(id, body) {
    if (!body || typeof body !== "object") {
      return apiErr(
        ERROR_CODES.INVALID_REQUEST_BODY,
        "Request body must be a JSON object."
      );
    }
    if (body.confirm !== true) {
      return apiErr(
        ERROR_CODES.REJECTION_CONFIRMATION_REQUIRED,
        "Rejection requires confirm: true."
      );
    }

    const existing = reviewStore.findReview(id);
    if (!existing) {
      return apiErr(
        ERROR_CODES.CANDIDATE_NOT_FOUND,
        "Candidate not found.",
        404
      );
    }
    if (existing.status === "rejected") {
      return apiErr(
        ERROR_CODES.ALREADY_REJECTED,
        "Candidate is already rejected.",
        409
      );
    }
    if (
      existing.status === "converted" ||
      existing.status === "approved" ||
      (existing.knowledgeId && String(existing.knowledgeId).trim())
    ) {
      return apiErr(
        ERROR_CODES.ALREADY_APPROVED,
        "Approved candidates cannot be rejected.",
        409
      );
    }

    const reason =
      body.reason != null && String(body.reason).trim()
        ? String(body.reason).trim()
        : body.rejectionReason != null && String(body.rejectionReason).trim()
          ? String(body.rejectionReason).trim()
          : "";
    if (!reason) {
      return apiErr(
        ERROR_CODES.REJECTION_REASON_REQUIRED,
        "rejectionReason is required."
      );
    }

    try {
      const updated = reviewStore.rejectReview(id, {
        rejectionReason: reason,
      });
      return apiOk({
        message: "Candidate rejected.",
        candidate: toDetail(updated),
      });
    } catch (error) {
      return apiErr(
        ERROR_CODES.REVIEW_SAVE_FAILED,
        sanitizeMessage(error && error.message ? error.message : error)
      );
    }
  }

  function listReviews(query = {}) {
    let items = reviewStore.listReviews();
    if (query.candidateId) {
      items = items.filter((r) => r.id === query.candidateId || r.candidateId === query.candidateId);
    }
    return apiOk({
      reviews: items.map((r) => ({
        id: r.id,
        candidateId: r.candidateId,
        status: r.status,
        decision:
          r.status === "converted" || r.status === "approved"
            ? "approved"
            : r.status === "rejected"
              ? "rejected"
              : null,
        reason: r.rejectionReason || null,
        knowledgeId: r.knowledgeId || null,
        reviewedAt:
          r.convertedAt || r.approvedAt || r.rejectedAt || r.reviewedAt || null,
      })),
    });
  }

  return {
    ERROR_CODES,
    reviewStore,
    knowledgeStore,
    sourceIntake,
    listCandidates,
    getCandidate,
    saveCandidate,
    knowledgePreview,
    approveCandidate,
    rejectCandidate,
    listReviews,
  };
}

module.exports = {
  ERROR_CODES,
  createAikidoReviewDashboardApi,
  buildKnowledgePreviewFromReview,
};
