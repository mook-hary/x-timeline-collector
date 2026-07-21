const fs = require("fs");
const path = require("path");

/**
 * Shared JSON file I/O for pipeline scripts.
 * Does not encode domain validation (AI schema, categories, CLI args, etc.).
 */

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * @param {string} filePath
 * @param {{
 *   label?: string,
 *   required?: boolean,
 *   defaultValue?: any,
 *   expect?: "array" | "object" | null,
 * }} [options]
 */
function readJson(filePath, options = {}) {
  const label = options.label || filePath;
  const required = options.required !== false;
  const expect = options.expect || null;

  if (!fs.existsSync(filePath)) {
    if (!required) {
      return options.defaultValue;
    }
    fail(`${label} が見つかりません: ${filePath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${label} の読み込みに失敗しました: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(
      `${label} の JSON が壊れているため終了します。上書きは行いません。\n詳細: ${error.message}`
    );
  }

  if (expect === "array") {
    if (!Array.isArray(data)) {
      fail(`${label} の形式が不正です（配列ではありません）: ${filePath}`);
    }
  } else if (expect === "object") {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      fail(
        `${label} の形式が不正です（オブジェクトではありません）: ${filePath}`
      );
    }
  }

  return data;
}

function readJsonRequired(filePath, label) {
  return readJson(filePath, { label: label || filePath, required: true });
}

function readJsonOptional(filePath, defaultValue, label) {
  return readJson(filePath, {
    label: label || filePath,
    required: false,
    defaultValue,
  });
}

function readJsonArrayRequired(filePath, label) {
  return readJson(filePath, {
    label: label || filePath,
    required: true,
    expect: "array",
  });
}

function readJsonObjectRequired(filePath, label) {
  return readJson(filePath, {
    label: label || filePath,
    required: true,
    expect: "object",
  });
}

function readJsonObjectOptional(filePath, defaultValue, label) {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  return readJson(filePath, {
    label: label || filePath,
    required: true,
    expect: "object",
  });
}

/**
 * Atomically write JSON (tmp in same directory + rename).
 * Pretty-prints with 2-space indent, matching existing pipeline outputs.
 */
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (_cleanupError) {
      // best-effort cleanup
    }
    fail(`JSON の保存に失敗しました: ${filePath}\n詳細: ${error.message}`);
  }
}

module.exports = {
  fail,
  ensureDir,
  readJson,
  readJsonRequired,
  readJsonOptional,
  readJsonArrayRequired,
  readJsonObjectRequired,
  readJsonObjectOptional,
  writeJsonAtomic,
};
