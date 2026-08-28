/**
 * Collect run stage markers for connect.js and Morning History.
 * Last reached stage is recorded even when the 15m Collect timeout fires.
 */

const COLLECT_STAGE_PREFIX = "COLLECT_STAGE:";
const COLLECT_LAST_STAGE_PREFIX = "COLLECT_LAST_STAGE:";

const COLLECT_STAGES = {
  CDP_CONNECT: "cdp_connect",
  CONTEXT_ACQUIRED: "context_acquired",
  X_HOME_SELECTED: "x_home_selected",
  HOME_REFRESH: "home_refresh",
  HOME_REFRESHED: "home_refreshed",
  LOGIN_CHECKED: "login_checked",
  INITIAL_POSTS: "initial_posts",
  SCROLLING: "scrolling",
  SAVE: "save",
};

const COLLECT_STAGE_ORDER = [
  COLLECT_STAGES.CDP_CONNECT,
  COLLECT_STAGES.CONTEXT_ACQUIRED,
  COLLECT_STAGES.X_HOME_SELECTED,
  COLLECT_STAGES.HOME_REFRESH,
  COLLECT_STAGES.HOME_REFRESHED,
  COLLECT_STAGES.LOGIN_CHECKED,
  COLLECT_STAGES.INITIAL_POSTS,
  COLLECT_STAGES.SCROLLING,
  COLLECT_STAGES.SAVE,
];

function createCollectStageTracker(write = console.error) {
  let lastStage = null;
  return {
    mark(stage) {
      const value = String(stage || "").trim();
      if (!value) return lastStage;
      lastStage = value;
      if (typeof write === "function") {
        write(`${COLLECT_STAGE_PREFIX}${value}`);
      }
      return lastStage;
    },
    get lastStage() {
      return lastStage;
    },
    writeLast() {
      if (!lastStage || typeof write !== "function") return lastStage;
      write(`${COLLECT_LAST_STAGE_PREFIX}${lastStage}`);
      return lastStage;
    },
  };
}

function parseCollectLastStage(output) {
  const text = String(output || "");
  const lastIdx = text.lastIndexOf(COLLECT_LAST_STAGE_PREFIX);
  if (lastIdx >= 0) {
    const rest = text.slice(lastIdx + COLLECT_LAST_STAGE_PREFIX.length);
    const lineEnd = rest.search(/[\r\n]/);
    const value = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
    if (value) return value;
  }
  const stageIdx = text.lastIndexOf(COLLECT_STAGE_PREFIX);
  if (stageIdx < 0) return null;
  const rest = text.slice(stageIdx + COLLECT_STAGE_PREFIX.length);
  const lineEnd = rest.search(/[\r\n]/);
  const value = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
  return value || null;
}

module.exports = {
  COLLECT_STAGE_PREFIX,
  COLLECT_LAST_STAGE_PREFIX,
  COLLECT_STAGES,
  COLLECT_STAGE_ORDER,
  createCollectStageTracker,
  parseCollectLastStage,
};
