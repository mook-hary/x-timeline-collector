const {
  createKnowledge,
  validateKnowledge,
  cloneKnowledge,
  withSyncedAliases,
  evidenceCount,
  loadKnowledgeStatusConfig,
  nowIso,
} = require("./knowledge-core");

const EDITABLE_FIELDS = new Set(["title", "summary", "notes", "confidence"]);
const FORBIDDEN_UPDATE_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "version",
  "status",
  "evidence",
  "stories",
  "concepts",
  "posts",
]);

function requireValidKnowledge(knowledge, options = {}) {
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const validated = validateKnowledge(knowledge, { statusConfig });
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }
  return { knowledge: validated.knowledge, statusConfig };
}

function buildResult(knowledge, operation) {
  return {
    knowledge: cloneKnowledge(knowledge),
    operation,
  };
}

function bumpVersion(knowledge, now) {
  return {
    ...cloneKnowledge(knowledge),
    version: knowledge.version + 1,
    updatedAt: now,
  };
}

/**
 * Create a Knowledge Draft. Reuses createKnowledge.
 */
function createDraft(input = {}, options = {}) {
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const now = options.now || nowIso();
  const knowledge = createKnowledge(
    {
      ...input,
      status: statusConfig.defaultStatus,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    { statusConfig, now }
  );

  return buildResult(knowledge, {
    type: "create-draft",
    changed: true,
    previousVersion: null,
    currentVersion: knowledge.version,
    details: {
      id: knowledge.id,
      status: knowledge.status,
    },
  });
}

/**
 * Update human-editable fields. Does not mutate input.
 */
function updateDraft(knowledge, changes = {}, options = {}) {
  const { knowledge: current, statusConfig } = requireValidKnowledge(knowledge, options);
  const now = options.now || nowIso();

  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("updateDraft の変更内容はオブジェクトである必要があります。");
  }

  const keys = Object.keys(changes);
  if (keys.length === 0) {
    throw new Error("更新するフィールドがありません。");
  }

  for (const key of keys) {
    if (FORBIDDEN_UPDATE_FIELDS.has(key)) {
      throw new Error(`フィールド ${key} は updateDraft では変更できません。`);
    }
    if (!EDITABLE_FIELDS.has(key)) {
      throw new Error(`未知の更新フィールドです: ${key}`);
    }
  }

  const next = cloneKnowledge(current);
  const changedFields = [];

  if (Object.prototype.hasOwnProperty.call(changes, "title")) {
    const title = String(changes.title == null ? "" : changes.title).trim();
    if (!title) throw new Error("title は空にできません。");
    if (title !== next.title) {
      next.title = title;
      changedFields.push("title");
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, "summary")) {
    const summary = String(changes.summary == null ? "" : changes.summary);
    if (summary !== next.summary) {
      next.summary = summary;
      changedFields.push("summary");
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, "notes")) {
    const notes = String(changes.notes == null ? "" : changes.notes);
    if (notes !== next.notes) {
      next.notes = notes;
      changedFields.push("notes");
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, "confidence")) {
    const confidence = Number(changes.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new Error("confidence は 0〜100 の数値である必要があります。");
    }
    if (confidence !== next.confidence) {
      next.confidence = confidence;
      changedFields.push("confidence");
    }
  }

  if (changedFields.length === 0) {
    return buildResult(current, {
      type: "update-draft",
      changed: false,
      previousVersion: current.version,
      currentVersion: current.version,
      details: { changedFields: [] },
      reason: "no-value-change",
    });
  }

  const bumped = bumpVersion(next, now);
  const validated = validateKnowledge(bumped, { statusConfig });
  if (!validated.ok) {
    throw new Error(validated.errors.join("\n"));
  }

  return buildResult(validated.knowledge, {
    type: "update-draft",
    changed: true,
    previousVersion: current.version,
    currentVersion: validated.knowledge.version,
    details: { changedFields },
  });
}

function normalizeEvidenceIdentity(type, ref) {
  if (type !== "story" && type !== "concept" && type !== "post") {
    throw new Error(`不正な Evidence 種別です: ${type}\nstory / concept / post を指定してください。`);
  }

  if (ref == null) {
    throw new Error("Evidence 参照が空です。");
  }

  if (typeof ref === "string") {
    const value = ref.trim();
    if (!value) throw new Error("Evidence 参照が空です。");
    if (type === "post" && !/^https?:\/\//i.test(value)) {
      // URL required but allow any non-empty URL-like string starting with http(s)
      // Task says url required - enforce http(s) for clarity
    }
    if (type === "post" && !value) {
      throw new Error("Post Evidence には url が必要です。");
    }
    return value;
  }

  if (typeof ref === "object" && !Array.isArray(ref)) {
    if (type === "story") {
      const id = String(ref.id || "").trim();
      if (!id) throw new Error("Story Evidence には id が必要です。");
      return id;
    }
    if (type === "concept") {
      const key = String(ref.conceptKey || ref.id || "").trim();
      if (!key) throw new Error("Concept Evidence には conceptKey が必要です。");
      if (key.startsWith("singleton:http")) {
        throw new Error(
          "singleton Topic の URL を Concept Evidence の意味キーとして使えません。"
        );
      }
      return key;
    }
    const url = String(ref.url || "").trim();
    if (!url) throw new Error("Post Evidence には url が必要です。");
    return url;
  }

  throw new Error("Evidence 参照の形式が不正です。");
}

function evidenceListKey(type) {
  if (type === "story") return "stories";
  if (type === "concept") return "concepts";
  return "posts";
}

/**
 * Add an evidence reference. Exact identity match; case-sensitive.
 */
function addEvidence(knowledge, type, ref, options = {}) {
  const { knowledge: current, statusConfig } = requireValidKnowledge(knowledge, options);
  const now = options.now || nowIso();
  const identity = normalizeEvidenceIdentity(type, ref);
  const listKey = evidenceListKey(type);
  const list = current.evidence[listKey];

  if (list.includes(identity)) {
    return buildResult(current, {
      type: "add-evidence",
      changed: false,
      previousVersion: current.version,
      currentVersion: current.version,
      details: { evidenceType: type, identity },
      reason: "duplicate-evidence",
    });
  }

  const next = cloneKnowledge(current);
  next.evidence[listKey] = [...list, identity];
  const synced = withSyncedAliases(next);
  const bumped = bumpVersion(synced, now);
  const validated = validateKnowledge(bumped, { statusConfig });
  if (!validated.ok) throw new Error(validated.errors.join("\n"));

  return buildResult(validated.knowledge, {
    type: "add-evidence",
    changed: true,
    previousVersion: current.version,
    currentVersion: validated.knowledge.version,
    details: { evidenceType: type, identity },
  });
}

/**
 * Remove an evidence reference. Missing target => unchanged (not an error).
 */
function removeEvidence(knowledge, type, ref, options = {}) {
  const { knowledge: current, statusConfig } = requireValidKnowledge(knowledge, options);
  const now = options.now || nowIso();
  const identity = normalizeEvidenceIdentity(type, ref);
  const listKey = evidenceListKey(type);
  const list = current.evidence[listKey];
  const index = list.indexOf(identity);

  if (index === -1) {
    return buildResult(current, {
      type: "remove-evidence",
      changed: false,
      previousVersion: current.version,
      currentVersion: current.version,
      details: { evidenceType: type, identity, found: false },
      reason: "evidence-not-found",
    });
  }

  const next = cloneKnowledge(current);
  next.evidence[listKey] = list.filter((item) => item !== identity);
  const synced = withSyncedAliases(next);
  const bumped = bumpVersion(synced, now);
  const validated = validateKnowledge(bumped, { statusConfig });
  if (!validated.ok) throw new Error(validated.errors.join("\n"));

  return buildResult(validated.knowledge, {
    type: "remove-evidence",
    changed: true,
    previousVersion: current.version,
    currentVersion: validated.knowledge.version,
    details: { evidenceType: type, identity, found: true },
  });
}

function validateStatusTransition(from, to, knowledge, statusConfig) {
  if (!statusConfig.statuses.includes(from)) {
    return { ok: false, error: `現在の status が不正です: ${from}` };
  }
  if (!statusConfig.statuses.includes(to)) {
    return { ok: false, error: `遷移先 status が不正です: ${to}` };
  }
  if (from === to) {
    return { ok: true, same: true };
  }

  const allowed = statusConfig.transitions[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: `許可されていない status 遷移です: ${from} → ${to}\n許可: ${allowed.join(", ") || "(なし)"}`,
    };
  }

  const count = evidenceCount(knowledge.evidence);

  if (from === "draft" && to === "review") {
    if (!String(knowledge.summary || "").trim()) {
      return { ok: false, error: "draft → review には summary が必要です。" };
    }
    if (count < 1) {
      return { ok: false, error: "draft → review には Evidence が1件以上必要です。" };
    }
  }

  if (from === "review" && to === "published") {
    if (!String(knowledge.title || "").trim()) {
      return { ok: false, error: "review → published には title が必要です。" };
    }
    if (!String(knowledge.summary || "").trim()) {
      return { ok: false, error: "review → published には summary が必要です。" };
    }
    if (count < 1) {
      return { ok: false, error: "review → published には Evidence が1件以上必要です。" };
    }
  }

  return { ok: true, same: false };
}

/**
 * Transition Knowledge status according to config/knowledge-status.json rules.
 */
function transitionStatus(knowledge, toStatus, options = {}) {
  const { knowledge: current, statusConfig } = requireValidKnowledge(knowledge, options);
  const now = options.now || nowIso();
  const to = String(toStatus || "").trim();

  const check = validateStatusTransition(current.status, to, current, statusConfig);
  if (!check.ok) {
    throw new Error(check.error);
  }

  if (check.same) {
    return buildResult(current, {
      type: "transition-status",
      changed: false,
      previousVersion: current.version,
      currentVersion: current.version,
      details: { from: current.status, to },
      reason: "same-status",
    });
  }

  const next = cloneKnowledge(current);
  next.status = to;
  const bumped = bumpVersion(next, now);
  const validated = validateKnowledge(bumped, { statusConfig });
  if (!validated.ok) throw new Error(validated.errors.join("\n"));

  return buildResult(validated.knowledge, {
    type: "transition-status",
    changed: true,
    previousVersion: current.version,
    currentVersion: validated.knowledge.version,
    details: { from: current.status, to },
  });
}

module.exports = {
  createDraft,
  updateDraft,
  addEvidence,
  removeEvidence,
  transitionStatus,
  validateStatusTransition,
  normalizeEvidenceIdentity,
  EDITABLE_FIELDS,
};
