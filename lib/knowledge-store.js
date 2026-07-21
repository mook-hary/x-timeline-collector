const fs = require("fs");
const path = require("path");
const {
  validateKnowledge,
  cloneKnowledge,
  evidenceCount,
  KNOWLEDGE_ID_RE,
  loadKnowledgeStatusConfig,
  nowIso,
} = require("./knowledge-core");

const INDEX_SCHEMA_VERSION = 1;

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_cleanup) {
      // best-effort
    }
    throw new Error(`JSON の保存に失敗しました: ${filePath}\n詳細: ${error.message}`);
  }
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON が壊れています: ${filePath}\n詳細: ${error.message}`);
  }
}

function validateSafeKnowledgeId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Knowledge ID は空でない文字列である必要があります。");
  }
  const value = id.trim();
  if (value === "." || value === "..") {
    throw new Error(`不正な Knowledge ID です: ${value}`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`Knowledge ID にパス区切りは使えません: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Knowledge ID に制御文字は使えません: ${value}`);
  }
  if (!KNOWLEDGE_ID_RE.test(value)) {
    throw new Error(
      `Knowledge ID が不正です: ${value}\n英数字・ハイフン・アンダースコアのみ（先頭は英数字）を使ってください。`
    );
  }
  return value;
}

function resolveBaseDir(baseDir) {
  if (!baseDir || typeof baseDir !== "string" || !baseDir.trim()) {
    throw new Error("baseDir は必須です。");
  }
  return path.resolve(baseDir.trim());
}

function getPaths(baseDir) {
  const root = resolveBaseDir(baseDir);
  return {
    root,
    itemsDir: path.join(root, "items"),
    historyDir: path.join(root, "history"),
    indexPath: path.join(root, "index.json"),
  };
}

function itemPath(baseDir, id) {
  const safeId = validateSafeKnowledgeId(id);
  return path.join(getPaths(baseDir).itemsDir, `${safeId}.json`);
}

function historyDirFor(baseDir, id) {
  const safeId = validateSafeKnowledgeId(id);
  return path.join(getPaths(baseDir).historyDir, safeId);
}

function historyPath(baseDir, id, version) {
  const ver = Number(version);
  if (!Number.isInteger(ver) || ver < 1) {
    throw new Error("version は 1 以上の整数である必要があります。");
  }
  const padded = String(ver).padStart(6, "0");
  return path.join(historyDirFor(baseDir, id), `${padded}.json`);
}

function knowledgeExists(baseDir, id) {
  return fs.existsSync(itemPath(baseDir, id));
}

function emptyIndex(generatedAt = nowIso()) {
  return {
    version: INDEX_SCHEMA_VERSION,
    generatedAt,
    items: [],
  };
}

function initializeKnowledgeBase(baseDir) {
  const paths = getPaths(baseDir);
  let changed = false;

  if (!fs.existsSync(paths.root)) {
    fs.mkdirSync(paths.root, { recursive: true });
    changed = true;
  }
  if (!fs.existsSync(paths.itemsDir)) {
    fs.mkdirSync(paths.itemsDir, { recursive: true });
    changed = true;
  }
  if (!fs.existsSync(paths.historyDir)) {
    fs.mkdirSync(paths.historyDir, { recursive: true });
    changed = true;
  }
  if (!fs.existsSync(paths.indexPath)) {
    atomicWriteJson(paths.indexPath, emptyIndex());
    changed = true;
  }

  return {
    baseDir: paths.root,
    changed,
    paths: {
      items: paths.itemsDir,
      history: paths.historyDir,
      index: paths.indexPath,
    },
  };
}

function toIndexEntry(knowledge) {
  const evidence = knowledge.evidence || { stories: [], concepts: [], posts: [] };
  return {
    id: knowledge.id,
    title: knowledge.title,
    status: knowledge.status,
    version: knowledge.version,
    confidence: knowledge.confidence,
    createdAt: knowledge.createdAt,
    updatedAt: knowledge.updatedAt,
    evidenceCount: evidenceCount(evidence),
    storyEvidenceCount: evidence.stories.length,
    conceptEvidenceCount: evidence.concepts.length,
    postEvidenceCount: evidence.posts.length,
  };
}

function sortIndexItems(items) {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt);
    const bTime = Date.parse(b.updatedAt);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return bTime - aTime;
    }
    if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
    if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function listItemFiles(baseDir) {
  const { itemsDir } = getPaths(baseDir);
  if (!fs.existsSync(itemsDir)) return [];
  return fs
    .readdirSync(itemsDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort();
}

function loadKnowledgeFile(filePath, options = {}) {
  const data = readJsonFile(filePath);
  const validated = validateKnowledge(data, options);
  if (!validated.ok) {
    const err = new Error(`${filePath}\n${validated.errors.join("\n")}`);
    err.validation = validated;
    throw err;
  }
  return cloneKnowledge(validated.knowledge);
}

function loadKnowledge(baseDir, id, options = {}) {
  const filePath = itemPath(baseDir, id);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Knowledge が見つかりません: ${id}`);
  }
  return loadKnowledgeFile(filePath, options);
}

function loadKnowledgeVersion(baseDir, id, version, options = {}) {
  const filePath = historyPath(baseDir, id, version);
  if (!fs.existsSync(filePath)) {
    throw new Error(`履歴 version が見つかりません: ${id}@${version}`);
  }
  const knowledge = loadKnowledgeFile(filePath, options);
  if (knowledge.id !== validateSafeKnowledgeId(id)) {
    throw new Error(`履歴の id が一致しません: expected ${id}, got ${knowledge.id}`);
  }
  if (knowledge.version !== Number(version)) {
    throw new Error(
      `履歴ファイル名の version (${version}) と内部 version (${knowledge.version}) が一致しません。`
    );
  }
  return knowledge;
}

function parseHistoryVersionName(fileName) {
  const match = /^(\d{6})\.json$/.exec(fileName);
  if (!match) return null;
  const version = Number(match[1]);
  if (!Number.isInteger(version) || version < 1) return null;
  return version;
}

function listKnowledgeVersions(baseDir, id, options = {}) {
  const safeId = validateSafeKnowledgeId(id);
  const dir = historyDirFor(baseDir, safeId);
  const current = knowledgeExists(baseDir, safeId)
    ? loadKnowledge(baseDir, safeId, options)
    : null;

  const versions = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const version = parseHistoryVersionName(name);
      if (version == null) {
        throw new Error(`不正な履歴ファイル名です: ${path.join(dir, name)}`);
      }
      versions.push(version);
    }
  }
  versions.sort((a, b) => a - b);

  return {
    id: safeId,
    currentVersion: current ? current.version : null,
    versions,
  };
}

function rebuildKnowledgeIndex(baseDir, options = {}) {
  initializeKnowledgeBase(baseDir);
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const items = [];
  const errors = [];

  for (const fileName of listItemFiles(baseDir)) {
    const idFromName = fileName.replace(/\.json$/, "");
    try {
      validateSafeKnowledgeId(idFromName);
      const knowledge = loadKnowledgeFile(
        path.join(getPaths(baseDir).itemsDir, fileName),
        { statusConfig }
      );
      if (knowledge.id !== idFromName) {
        errors.push(`ファイル名と id が一致しません: ${fileName} vs ${knowledge.id}`);
        continue;
      }
      items.push(toIndexEntry(knowledge));
    } catch (error) {
      errors.push(`${fileName}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    const err = new Error(`index 再生成に失敗しました:\n${errors.join("\n")}`);
    err.errors = errors;
    throw err;
  }

  const index = {
    version: INDEX_SCHEMA_VERSION,
    generatedAt: options.now || nowIso(),
    items: sortIndexItems(items),
  };
  atomicWriteJson(getPaths(baseDir).indexPath, index);
  return index;
}

function readIndex(baseDir) {
  const { indexPath } = getPaths(baseDir);
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  const data = readJsonFile(indexPath);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`index.json の形式が不正です: ${indexPath}`);
  }
  if (!Array.isArray(data.items)) {
    throw new Error(`index.json の items が配列ではありません: ${indexPath}`);
  }
  return data;
}

function listKnowledge(baseDir, options = {}) {
  initializeKnowledgeBase(baseDir);
  let index = readIndex(baseDir);
  if (!index) {
    index = rebuildKnowledgeIndex(baseDir, options);
  }
  return {
    generatedAt: index.generatedAt || null,
    items: Array.isArray(index.items) ? [...index.items] : [],
  };
}

function saveKnowledge(baseDir, knowledge, options = {}) {
  initializeKnowledgeBase(baseDir);
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const validated = validateKnowledge(knowledge, { statusConfig });
  if (!validated.ok) {
    const err = new Error(validated.errors.join("\n"));
    err.validation = validated;
    throw err;
  }

  const next = cloneKnowledge(validated.knowledge);
  const id = validateSafeKnowledgeId(next.id);
  if (next.id !== id) {
    throw new Error("Knowledge ID が不正です。");
  }

  const currentPath = itemPath(baseDir, id);
  const histPath = historyPath(baseDir, id, next.version);
  const exists = fs.existsSync(currentPath);

  if (fs.existsSync(histPath)) {
    throw new Error(`履歴 version ${next.version} は既に存在します: ${id}`);
  }

  if (!exists) {
    if (next.version !== 1) {
      throw new Error(`新規 Knowledge の version は 1 である必要があります（got ${next.version}）。`);
    }
  } else {
    const current = loadKnowledge(baseDir, id, { statusConfig });
    if (current.id !== next.id) {
      throw new Error("id が現行 Knowledge と一致しません。");
    }
    if (current.createdAt !== next.createdAt) {
      throw new Error("createdAt は変更できません。");
    }
    if (next.version !== current.version + 1) {
      throw new Error(
        `version 競合または不正です。現行=${current.version}, 保存=${next.version}（現行+1のみ許可）。`
      );
    }
    const currentUpdated = Date.parse(current.updatedAt);
    const nextUpdated = Date.parse(next.updatedAt);
    if (
      Number.isFinite(currentUpdated) &&
      Number.isFinite(nextUpdated) &&
      nextUpdated < currentUpdated
    ) {
      throw new Error("updatedAt が現行 Knowledge より前です（逆行は拒否）。");
    }
  }

  // 1) history snapshot (never overwrite)
  atomicWriteJson(histPath, next);
  // 2) current item
  atomicWriteJson(currentPath, next);
  // 3) rebuild index from items (derived)
  const index = rebuildKnowledgeIndex(baseDir, { statusConfig, now: options.now });

  return {
    knowledge: loadKnowledge(baseDir, id, { statusConfig }),
    index,
    created: !exists,
  };
}

function validateKnowledgeBase(baseDir, options = {}) {
  const statusConfig = options.statusConfig || loadKnowledgeStatusConfig();
  const paths = getPaths(baseDir);
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(paths.root)) {
    errors.push(`Knowledge Base がありません: ${paths.root}`);
    return {
      valid: false,
      knowledgeCount: 0,
      historyCount: 0,
      errors,
      warnings,
    };
  }
  if (!fs.existsSync(paths.itemsDir)) errors.push("items/ がありません。");
  if (!fs.existsSync(paths.historyDir)) errors.push("history/ がありません。");

  const currentById = new Map();
  let historyCount = 0;

  if (fs.existsSync(paths.itemsDir)) {
    for (const fileName of listItemFiles(baseDir)) {
      const idFromName = fileName.replace(/\.json$/, "");
      const filePath = path.join(paths.itemsDir, fileName);
      try {
        validateSafeKnowledgeId(idFromName);
        const knowledge = loadKnowledgeFile(filePath, { statusConfig });
        if (knowledge.id !== idFromName) {
          errors.push(`items/${fileName}: ファイル名と id (${knowledge.id}) が不一致`);
        }
        currentById.set(knowledge.id, knowledge);

        const histDir = historyDirFor(baseDir, knowledge.id);
        if (!fs.existsSync(histDir)) {
          errors.push(`${knowledge.id}: history/ ディレクトリがありません。`);
          continue;
        }

        const versions = [];
        for (const histName of fs.readdirSync(histDir)) {
          const version = parseHistoryVersionName(histName);
          if (version == null) {
            errors.push(`${knowledge.id}: 不正な履歴ファイル名 ${histName}`);
            continue;
          }
          versions.push(version);
          historyCount += 1;
          try {
            const snap = loadKnowledgeFile(path.join(histDir, histName), { statusConfig });
            if (snap.id !== knowledge.id) {
              errors.push(`${knowledge.id}@${version}: id 不一致`);
            }
            if (snap.version !== version) {
              errors.push(
                `${knowledge.id}: ファイル名 version ${version} と内部 version ${snap.version} が不一致`
              );
            }
            if (snap.createdAt !== knowledge.createdAt) {
              errors.push(`${knowledge.id}@${version}: createdAt が現行と不一致`);
            }
          } catch (error) {
            errors.push(`${knowledge.id}@${version}: ${error.message}`);
          }
        }

        versions.sort((a, b) => a - b);
        if (!versions.includes(knowledge.version)) {
          errors.push(`${knowledge.id}: 現行 version ${knowledge.version} の履歴がありません。`);
        }
        for (let v = 1; v <= knowledge.version; v++) {
          if (!versions.includes(v)) {
            errors.push(`${knowledge.id}: version ${v} が欠番です。`);
          }
        }

        let previousUpdated = null;
        for (const v of versions) {
          if (v > knowledge.version) continue;
          try {
            const snap = loadKnowledgeVersion(baseDir, knowledge.id, v, { statusConfig });
            const updatedMs = Date.parse(snap.updatedAt);
            if (previousUpdated != null && Number.isFinite(updatedMs) && updatedMs < previousUpdated) {
              errors.push(`${knowledge.id}: updatedAt が version ${v} で逆行しています。`);
            }
            if (Number.isFinite(updatedMs)) previousUpdated = updatedMs;
          } catch (error) {
            errors.push(`${knowledge.id}@${v}: ${error.message}`);
          }
        }
      } catch (error) {
        errors.push(`items/${fileName}: ${error.message}`);
      }
    }
  }

  // orphan history dirs
  if (fs.existsSync(paths.historyDir)) {
    for (const name of fs.readdirSync(paths.historyDir)) {
      const full = path.join(paths.historyDir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      try {
        validateSafeKnowledgeId(name);
        if (!currentById.has(name)) {
          warnings.push(`history/${name} に対応する現行 Knowledge がありません。`);
        }
      } catch (error) {
        errors.push(`history/${name}: ${error.message}`);
      }
    }
  }

  // index consistency
  if (!fs.existsSync(paths.indexPath)) {
    errors.push("index.json がありません。");
  } else {
    try {
      const index = readIndex(baseDir);
      const indexIds = new Set(index.items.map((item) => item.id));
      for (const id of currentById.keys()) {
        if (!indexIds.has(id)) errors.push(`index に欠けています: ${id}`);
      }
      for (const item of index.items) {
        if (!currentById.has(item.id)) {
          errors.push(`index に余剰があります: ${item.id}`);
          continue;
        }
        const current = currentById.get(item.id);
        if (item.version !== current.version) {
          errors.push(`index の version が不一致: ${item.id}`);
        }
        if (item.status !== current.status) {
          errors.push(`index の status が不一致: ${item.id}`);
        }
        if (item.updatedAt !== current.updatedAt) {
          errors.push(`index の updatedAt が不一致: ${item.id}`);
        }
        if (item.title !== current.title) {
          errors.push(`index の title が不一致: ${item.id}`);
        }
      }
    } catch (error) {
      errors.push(`index.json: ${error.message}`);
    }
  }

  return {
    valid: errors.length === 0,
    knowledgeCount: currentById.size,
    historyCount,
    errors,
    warnings,
  };
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  validateSafeKnowledgeId,
  initializeKnowledgeBase,
  saveKnowledge,
  loadKnowledge,
  loadKnowledgeVersion,
  listKnowledge,
  listKnowledgeVersions,
  rebuildKnowledgeIndex,
  validateKnowledgeBase,
  knowledgeExists,
  getPaths,
};
