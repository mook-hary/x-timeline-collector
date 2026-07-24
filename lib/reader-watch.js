/**
 * EP-041 — Reader watch helpers (debounce + target resolution).
 * No extra dependencies. Does not watch output/digest-reader (avoids regen loops).
 */
const fs = require("fs");
const path = require("path");
const {
  resolveRoot,
  READER_DIR_REL,
  ENRICHED_REL,
} = require("./reader-launch");

const WATCH_DEBOUNCE_MS = 200;
/** Poll interval for change detection (fs.watch avoided — EMFILE-safe). */
const WATCH_POLL_MS = 250;

/** Relative dirs/files to watch when present. */
const WATCH_TARGET_RELS = [
  "lib",
  "scripts",
  "templates",
  path.join("output", "enriched"),
  ENRICHED_REL,
  "digest.config.json",
];

const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "digest-reader",
  "browser-data",
]);

const WATCH_FILE_EXTS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".css",
  ".html",
  ".md",
]);

function toPosixRel(rel) {
  return String(rel || "").split(path.sep).join("/");
}

/**
 * Resolve existing watch roots (absolute). Missing paths are skipped.
 * @param {string} [rootDir]
 * @returns {{ absolute: string, relative: string, recursive: boolean }[]}
 */
function resolveWatchTargets(rootDir) {
  const root = resolveRoot(rootDir);
  const out = [];
  for (const rel of WATCH_TARGET_RELS) {
    const absolute = path.join(root, rel);
    if (!fs.existsSync(absolute)) continue;
    let recursive = false;
    try {
      recursive = fs.statSync(absolute).isDirectory();
    } catch (_error) {
      continue;
    }
    out.push({ absolute, relative: rel, recursive });
  }
  return out;
}

/**
 * @param {string} rootDir
 * @param {string} changedPath absolute or relative
 */
function shouldIgnoreWatchPath(rootDir, changedPath) {
  const root = resolveRoot(rootDir);
  const absolute = path.isAbsolute(changedPath)
    ? path.resolve(changedPath)
    : path.resolve(root, changedPath);
  let rel;
  try {
    rel = path.relative(root, absolute);
  } catch (_error) {
    return true;
  }
  if (!rel || rel === ".") return true;
  if (rel.startsWith(`..${path.sep}`) || rel === "..") return true;

  const posix = toPosixRel(rel);
  if (posix === toPosixRel(READER_DIR_REL)) return true;
  if (posix.startsWith(`${toPosixRel(READER_DIR_REL)}/`)) return true;

  const parts = rel.split(path.sep);
  for (const part of parts) {
    if (IGNORE_DIR_NAMES.has(part)) return true;
  }

  const base = path.basename(rel);
  if (base === ".DS_Store" || base.endsWith("~") || base.endsWith(".swp")) {
    return true;
  }
  return false;
}

function isWatchableFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return false;
  return WATCH_FILE_EXTS.has(ext);
}

/**
 * Collect files under watch targets.
 * @param {string} rootDir
 * @returns {string[]} absolute paths
 */
function listWatchFiles(rootDir) {
  const root = resolveRoot(rootDir);
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIR_NAMES.has(entry.name)) continue;
      if (entry.name === ".DS_Store") continue;
      const absolute = path.join(dir, entry.name);
      if (shouldIgnoreWatchPath(root, absolute)) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile() && isWatchableFile(absolute)) {
        files.push(absolute);
      }
    }
  }

  for (const target of resolveWatchTargets(root)) {
    if (!target.recursive) {
      if (!shouldIgnoreWatchPath(root, target.absolute) && isWatchableFile(target.absolute)) {
        files.push(target.absolute);
      } else if (
        !shouldIgnoreWatchPath(root, target.absolute) &&
        path.extname(target.absolute) === ".json"
      ) {
        files.push(target.absolute);
      }
      continue;
    }
    walk(target.absolute);
  }
  return files;
}

/**
 * Debounced regenerate scheduler.
 * ALL change notifications must go through schedule() — never call generate() directly.
 * Trailing debounce: rapid bursts (fs.watch / poll) collapse to one regenerate.
 * Default delay is always WATCH_DEBOUNCE_MS (200). Shorter delays only with allowTestDelay.
 *
 * @param {object} options
 * @param {number} [options.delayMs]
 * @param {boolean} [options.allowTestDelay] — tests only; bypasses 200ms floor
 * @param {() => { status: number }} options.generate
 * @param {(paths: string[]) => void} [options.onChange]
 * @param {(ms: number) => void} [options.onDone]
 * @param {() => void} [options.onFail]
 * @param {() => void} [options.onAfterGenerate] — refresh watchers / snapshots
 * @param {(line: string) => void} [options.log]
 */
function createWatchScheduler(options) {
  const requested = Number(options.delayMs);
  const delayMs =
    options.allowTestDelay === true && Number.isFinite(requested)
      ? Math.max(0, requested)
      : WATCH_DEBOUNCE_MS;

  const generate = options.generate;
  const onChange = options.onChange || (() => {});
  const onDone = options.onDone || (() => {});
  const onFail = options.onFail || (() => {});
  const onAfterGenerate = options.onAfterGenerate || (() => {});
  const log = options.log || (() => {});

  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {string[]} */
  let pending = [];
  let running = false;
  let rerun = false;
  let stopped = false;

  function armDebounce() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
  }

  /**
   * Record a change. Always debounced by delayMs before regenerate.
   * @param {string|string[]} relPath
   */
  function schedule(relPath) {
    if (stopped) return;
    const list = Array.isArray(relPath) ? relPath : [relPath];
    for (const item of list) {
      const label = toPosixRel(item) || "(unknown)";
      pending.push(label);
    }
    if (running) {
      // Coalesce into one follow-up after the current run (still debounced).
      rerun = true;
      return;
    }
    armDebounce();
  }

  function flush() {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    if (pending.length === 0) return;

    const paths = [...new Set(pending)];
    pending = [];
    running = true;
    onChange(paths);
    log("Regenerating Reader...");
    const started = Date.now();
    let result;
    try {
      result = generate();
    } catch (_error) {
      result = { status: 1 };
    }
    const ms = Date.now() - started;
    running = false;

    // Drop mtime noise from the same save / write settle after regenerate.
    try {
      onAfterGenerate();
    } catch (_error) {
      // ignore refresh errors
    }

    if (!result || result.status !== 0) {
      log("Reader generation failed.");
      log("");
      log("Watching continues...");
      onFail();
    } else {
      log(`Done (${ms} ms)`);
      onDone(ms);
    }

    if (stopped) return;
    if (rerun || pending.length > 0) {
      rerun = false;
      // Follow-up also waits a full debounce window (one save → one extra pass max).
      armDebounce();
    }
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = [];
    rerun = false;
  }

  return {
    schedule,
    flush,
    stop,
    get pending() {
      return [...pending];
    },
    get running() {
      return running;
    },
    delayMs,
  };
}

/**
 * Poll watch targets for mtime changes. Returns closer + snapshot refresh.
 * Change events always go through scheduler.schedule() (debounced ≥ 200ms).
 *
 * @param {string} rootDir
 * @param {{ schedule: (rel: string|string[]) => void, log?: (s: string) => void }} scheduler
 * @param {number} [intervalMs]
 * @returns {{ stop: () => void, refresh: () => void }}
 */
function startWatching(rootDir, scheduler, intervalMs = WATCH_POLL_MS) {
  const root = resolveRoot(rootDir);
  /** @type {Map<string, number>} */
  let snapshot = new Map();
  let ready = false;

  function readMtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch (_error) {
      return null;
    }
  }

  function captureSnapshot() {
    /** @type {Map<string, number>} */
    const next = new Map();
    for (const filePath of listWatchFiles(root)) {
      const mtime = readMtime(filePath);
      if (mtime == null) continue;
      next.set(filePath, mtime);
    }
    snapshot = next;
  }

  function refresh() {
    captureSnapshot();
  }

  function tick() {
    const files = listWatchFiles(root);
    /** @type {Map<string, number>} */
    const next = new Map();
    /** @type {string[]} */
    const changed = [];

    for (const filePath of files) {
      const mtime = readMtime(filePath);
      if (mtime == null) continue;
      next.set(filePath, mtime);
      if (!ready) continue;
      const prev = snapshot.get(filePath);
      if (prev == null || prev !== mtime) {
        changed.push(path.relative(root, filePath));
      }
    }

    if (ready) {
      for (const [filePath] of snapshot) {
        if (!next.has(filePath)) {
          changed.push(path.relative(root, filePath));
        }
      }
    }

    snapshot = next;
    if (!ready) {
      ready = true;
      return;
    }
    if (changed.length === 0) return;

    const rels = [];
    for (const rel of changed) {
      if (shouldIgnoreWatchPath(root, rel)) continue;
      rels.push(rel);
    }
    if (rels.length === 0) return;
    // Single schedule call → one debounce window → at most one regenerate.
    scheduler.schedule(rels);
  }

  captureSnapshot();
  ready = true;
  const timer = setInterval(
    tick,
    Math.max(50, Number(intervalMs) || WATCH_POLL_MS)
  );
  // Do not unref — watch mode must stay alive even when reusing an existing server.

  return {
    stop: () => {
      clearInterval(timer);
    },
    refresh,
  };
}

module.exports = {
  WATCH_DEBOUNCE_MS,
  WATCH_POLL_MS,
  WATCH_TARGET_RELS,
  resolveWatchTargets,
  shouldIgnoreWatchPath,
  listWatchFiles,
  createWatchScheduler,
  startWatching,
  toPosixRel,
};
