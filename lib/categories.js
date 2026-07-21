const path = require("path");
const { fail, readJsonObjectRequired } = require("./pipeline-io");

const CATEGORIES_FILE = path.join(__dirname, "..", "config", "categories.json");

/**
 * Source of Truth for category names and order: config/categories.json
 * (object key order in that file).
 */
function loadCategoryConfig() {
  const data = readJsonObjectRequired(CATEGORIES_FILE, "カテゴリ設定");
  if (Object.keys(data).length === 0) {
    fail("config/categories.json にカテゴリがありません。");
  }
  return data;
}

function getCategoryOrder() {
  return Object.keys(loadCategoryConfig());
}

module.exports = {
  CATEGORIES_FILE,
  loadCategoryConfig,
  getCategoryOrder,
};
