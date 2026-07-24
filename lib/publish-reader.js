/**
 * EP-045 — Publish Digest Reader to GitHub Pages via git push.
 * Adds only index.html + style.css. No force push / no history rewind.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  generateReader,
  READER_DIR_REL,
  ensureReaderHtml,
} = require("./reader-launch");

const PUBLISH_REL_FILES = [
  path.join(READER_DIR_REL, "index.html"),
  path.join(READER_DIR_REL, "style.css"),
];

const REQUIRED_BRANCH = "main";

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
function formatPublishCommitMessage(date = new Date()) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `Publish Digest Reader ${y}-${mo}-${d} ${hh}:${mm}`;
}

function createRunner(deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const root = resolveRoot(deps.rootDir);
  const log = deps.log || ((line) => process.stdout.write(`${line}\n`));
  const env = deps.env || process.env;
  const now = typeof deps.now === "function" ? deps.now : () => new Date();

  function run(command, args, options = {}) {
    return spawn(command, args, {
      cwd: root,
      encoding: "utf8",
      env,
      stdio: options.stdio || "pipe",
    });
  }

  function git(args, options = {}) {
    return run("git", args, options);
  }

  function requireOk(result, label) {
    if (result.error) {
      const err = new Error(`${label} failed: ${result.error.message}`);
      err.code = "publish-spawn";
      err.cause = result.error;
      throw err;
    }
    const status = result.status == null ? 1 : result.status;
    if (status !== 0) {
      const err = new Error(`${label} failed (exit ${status})`);
      err.code = "publish-step";
      err.exitCode = status;
      err.result = result;
      throw err;
    }
    return result;
  }

  function currentBranch() {
    const result = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    requireOk(result, "git branch");
    return String(result.stdout || "").trim();
  }

  function publishFilesChanged() {
    const result = git(["status", "--porcelain", "--", ...PUBLISH_REL_FILES]);
    requireOk(result, "git status");
    return String(result.stdout || "").trim().length > 0;
  }

  function assertMainBranch() {
    const branch = currentBranch();
    if (branch !== REQUIRED_BRANCH) {
      const err = new Error(
        `Refusing to publish: current branch is "${branch}" (required: ${REQUIRED_BRANCH}).\n` +
          `Switch to ${REQUIRED_BRANCH} and retry: npm run publish`
      );
      err.code = "publish-wrong-branch";
      err.exitCode = 1;
      throw err;
    }
    return branch;
  }

  /**
   * @returns {{ ok: true, skippedPush?: boolean, committed?: boolean, message?: string }}
   */
  function runPublish(options = {}) {
    const skipGenerate = options.skipGenerate === true;
    const skipTest = options.skipTest === true;
    const skipAudit = options.skipAudit === true;

    assertMainBranch();

    if (!skipGenerate) {
      log("[publish] 1/7 Generate Reader");
      const gen = (deps.generateReader || generateReader)(root, {
        spawn,
        env,
        stdio: deps.readerStdio || "inherit",
      });
      if (gen.status !== 0) {
        const err = new Error("Reader generation failed");
        err.code = "publish-generate";
        err.exitCode = gen.status || 1;
        throw err;
      }
      ensureReaderHtml(root);
      log("[publish] Reader generated.");
    }

    if (!skipTest) {
      log("[publish] 2/7 npm test");
      requireOk(
        run("npm", ["test"], { stdio: deps.testStdio || "inherit" }),
        "npm test"
      );
    }

    if (!skipAudit) {
      log("[publish] 3/7 npm run audit:public");
      requireOk(
        run("npm", ["run", "audit:public"], {
          stdio: deps.auditStdio || "inherit",
        }),
        "audit:public"
      );
    }

    log("[publish] 4/7 Check publish file changes");
    if (!publishFilesChanged()) {
      log("[publish] No changes in publish files. Skipping commit/push.");
      return { ok: true, skippedPush: true, committed: false };
    }
    log("[publish] Changes detected:");
    for (const rel of PUBLISH_REL_FILES) {
      log(`  - ${rel}`);
    }

    log("[publish] 5/7 git add (Reader files only)");
    for (const rel of PUBLISH_REL_FILES) {
      if (!fs.existsSync(path.join(root, rel))) {
        const err = new Error(`Missing publish file: ${rel}`);
        err.code = "publish-missing-file";
        throw err;
      }
    }
    requireOk(git(["add", "--", ...PUBLISH_REL_FILES]), "git add");

    log("[publish] 6/7 git commit");
    const message = formatPublishCommitMessage(now());
    const commitResult = git(["commit", "-m", message]);
    if (
      commitResult.status !== 0 &&
      /nothing to commit/i.test(
        `${commitResult.stdout || ""}\n${commitResult.stderr || ""}`
      )
    ) {
      log("[publish] Nothing to commit after staging. Done.");
      return { ok: true, skippedPush: true, committed: false, message };
    }
    requireOk(commitResult, "git commit");
    log(`[publish] Committed: ${message}`);

    log("[publish] 7/7 git push origin main");
    assertMainBranch();
    const pushResult = git(["push", "origin", REQUIRED_BRANCH]);
    if (pushResult.error || pushResult.status !== 0) {
      const err = new Error(
        "git push failed. Local commit was kept (history not rewritten).\n" +
          "Fix remote issues and run: git push origin main"
      );
      err.code = "publish-push";
      err.exitCode = pushResult.status == null ? 1 : pushResult.status;
      err.result = pushResult;
      throw err;
    }
    log("[publish] Pushed to origin/main. GitHub Pages workflow should start.");

    return {
      ok: true,
      skippedPush: false,
      committed: true,
      message,
    };
  }

  return {
    runPublish,
    formatPublishCommitMessage,
    publishFilesChanged,
    currentBranch,
    assertMainBranch,
    PUBLISH_REL_FILES,
    REQUIRED_BRANCH,
  };
}

function runPublishCli(deps = {}) {
  const runner = createRunner(deps);
  try {
    return runner.runPublish(deps.publishOptions || {});
  } catch (error) {
    const logErr =
      deps.logErr || ((line) => process.stderr.write(`${line}\n`));
    logErr(`[publish] ERROR: ${error.message}`);
    const code = error.exitCode != null ? error.exitCode : 1;
    error.exitCode = code;
    throw error;
  }
}

module.exports = {
  PUBLISH_REL_FILES,
  REQUIRED_BRANCH,
  formatPublishCommitMessage,
  createRunner,
  runPublishCli,
  resolveRoot,
};
