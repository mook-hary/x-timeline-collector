/**
 * KS-002 — Aikido Editorial Bridge.
 * Registers Draft Generator output into Editorial Store (create only).
 * Does not run rules / ranking / similarity / publish / workflow changes.
 */
const BRIDGE_VERSION = "1";

/**
 * @param {object} [options]
 * @param {object} [options.editorialStore] required for publish (injected)
 */
function createAikidoEditorialBridge(options = {}) {
  const editorialStore = options.editorialStore || null;

  function requireStore() {
    if (!editorialStore || typeof editorialStore.create !== "function") {
      const err = new Error(
        "editorialStore is required (inject via createAikidoEditorialBridge({ editorialStore }))"
      );
      err.code = "aikido-bridge-no-store";
      throw err;
    }
    return editorialStore;
  }

  /**
   * Find existing draft with same knowledgeId + templateId.
   */
  function findDuplicateDraft(knowledgeId, templateId) {
    const store = requireStore();
    if (!knowledgeId || !templateId) return null;
    const kid = String(knowledgeId);
    const tid = String(templateId);
    if (typeof store.list !== "function") return null;
    const items = store.list();
    for (const item of items) {
      if (!item || item.status !== "draft") continue;
      const meta = item.metadata || {};
      if (
        String(meta.knowledgeId || "") === kid &&
        String(meta.templateId || "") === tid
      ) {
        return item;
      }
    }
    return null;
  }

  /**
   * Build Editorial create payload from a Draft Generator draft.
   * Does not mutate draft body / title / summary / tags.
   */
  function toEditorialItem(draft) {
    if (!draft || typeof draft !== "object") {
      const err = new Error("draft must be an object");
      err.code = "aikido-bridge-draft";
      throw err;
    }
    const draftMeta =
      draft.metadata && typeof draft.metadata === "object"
        ? draft.metadata
        : {};
    const knowledgeId =
      draftMeta.knowledgeId != null ? String(draftMeta.knowledgeId) : null;
    const templateId =
      draftMeta.templateId != null ? String(draftMeta.templateId) : null;
    const generatedAt =
      draftMeta.generatedAt != null ? String(draftMeta.generatedAt) : null;

    return {
      source: draft.source != null ? String(draft.source) : "aikido",
      type: draft.type != null ? String(draft.type) : "post",
      title: draft.title == null ? "" : String(draft.title),
      summary: draft.summary == null ? "" : String(draft.summary),
      body: draft.body == null ? "" : String(draft.body),
      tags: Array.isArray(draft.tags) ? draft.tags.map((t) => String(t)) : [],
      score: draft.score == null ? 0 : Number(draft.score) || 0,
      status: "draft",
      metadata: {
        source: "aikido",
        knowledgeId,
        templateId,
        generatedAt,
        bridgeVersion: BRIDGE_VERSION,
      },
    };
  }

  /**
   * @param {object} draft Draft Generator shape
   * @param {{ allowDuplicateDraft?: boolean }} [callOptions]
   */
  function publishDraft(draft, callOptions = {}) {
    const store = requireStore();
    const itemInput = toEditorialItem(draft);
    const knowledgeId = itemInput.metadata.knowledgeId;
    const templateId = itemInput.metadata.templateId;

    if (!callOptions.allowDuplicateDraft) {
      const dup = findDuplicateDraft(knowledgeId, templateId);
      if (dup) {
        const err = new Error(
          `duplicate aikido draft already in editorial (knowledgeId=${knowledgeId}, templateId=${templateId}, existing=${dup.id})`
        );
        err.code = "aikido-bridge-duplicate";
        err.existingId = dup.id;
        err.knowledgeId = knowledgeId;
        err.templateId = templateId;
        throw err;
      }
    }

    const item = store.create(itemInput);
    return {
      editorialId: item.id,
      knowledgeId,
      created: true,
      item,
    };
  }

  /**
   * @param {object[]} drafts
   * @param {{
   *   continueOnError?: boolean,
   *   limit?: number,
   *   allowDuplicateDraft?: boolean,
   * }} [callOptions]
   */
  function publishDrafts(drafts, callOptions = {}) {
    const continueOnError = callOptions.continueOnError !== false;
    let list = Array.isArray(drafts) ? drafts.slice() : [];

    if (callOptions.limit != null) {
      const limit = Number(callOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        const err = new Error("limit must be a non-negative integer");
        err.code = "aikido-bridge-options";
        throw err;
      }
      list = list.slice(0, limit);
    }

    const results = [];
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < list.length; i++) {
      const draft = list[i];
      try {
        const published = publishDraft(draft, {
          allowDuplicateDraft: callOptions.allowDuplicateDraft,
        });
        results.push({
          index: i,
          ok: true,
          ...published,
        });
        createdCount += 1;
      } catch (error) {
        const code = error && error.code ? error.code : "aikido-bridge-error";
        const message =
          error && error.message ? error.message : String(error);
        if (code === "aikido-bridge-duplicate") {
          skippedCount += 1;
          results.push({
            index: i,
            ok: false,
            skipped: true,
            created: false,
            knowledgeId: error.knowledgeId || null,
            editorialId: error.existingId || null,
            error: { message, code },
          });
        } else {
          errorCount += 1;
          results.push({
            index: i,
            ok: false,
            skipped: false,
            created: false,
            error: { message, code },
          });
        }
        if (!continueOnError) break;
      }
    }

    return {
      results,
      summary: {
        createdCount,
        skippedCount,
        errorCount,
      },
    };
  }

  return {
    bridgeVersion: BRIDGE_VERSION,
    editorialStore,
    publishDraft,
    publishDrafts,
    findDuplicateDraft,
    toEditorialItem,
  };
}

module.exports = {
  BRIDGE_VERSION,
  createAikidoEditorialBridge,
};
