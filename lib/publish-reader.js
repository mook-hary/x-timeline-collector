/**
 * EP-045 — Publish Digest Reader to GitHub Pages via git push.
 * Adds index.html + style.css + news-feed.json. No force push / no history rewind.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  generateReader,
  READER_DIR_REL,
  ensureReaderHtml,
} = require("./reader-launch");
const { NEWS_FEED_REL } = require("./news-feed");

const PUBLISH_REL_FILES = [
  path.join(READER_DIR_REL, "index.html"),
  path.join(READER_DIR_REL, "style.css"),
  NEWS_FEED_REL,
];

const REQUIRED_BRANCH = "main";
const TEST_SCRIPT_REL = path.join("scripts", "run-tests.js");
const AUDIT_SCRIPT_REL = path.join("scripts", "audit-public.js");

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

/**
 * Absolute node binary. Prefer process.execPath so launchd/PATH do not matter.
 * @param {string} [nodePath]
 * @returns {string}
 */
function resolveNodePath(nodePath) {
  const candidate = nodePath || process.execPath;
  if (!path.isAbsolute(candidate)) {
    throw new Error(`node path must be absolute: ${candidate}`);
  }
  return candidate;
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
  const nodePath = resolveNodePath(deps.nodePath);
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

  /** Equivalent to `npm test` / `npm run audit:public` without PATH npm. */
  function runNodeScript(scriptRel, options = {}) {
    const scriptPath = path.join(root, scriptRel);
    return run(nodePath, [scriptPath], options);
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
   * @returns {Promise<{
   *   ok: true,
   *   skippedPush?: boolean,
   *   committed?: boolean,
   *   message?: string,
   *   commitSha?: string|null,
   *   pagesDeploymentStarted?: boolean,
   *   pagesPublished?: boolean,
   *   pagesDeployment?: object|null,
   * }>}
   */
  async function runPublish(options = {}) {
    const skipGenerate = options.skipGenerate === true;
    const skipTest = options.skipTest === true;
    const skipAudit = options.skipAudit === true;
    const skipPagesVerify =
      options.skipPagesVerify === true ||
      String(env.PAGES_VERIFY || "").trim() === "0";

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
      if (!fs.existsSync(path.join(root, NEWS_FEED_REL))) {
        const err = new Error(`Missing publish file: ${NEWS_FEED_REL}`);
        err.code = "publish-missing-file";
        throw err;
      }
      log("[publish] Reader generated.");
    }

    if (!skipTest) {
      log("[publish] 2/7 npm test");
      requireOk(
        runNodeScript(TEST_SCRIPT_REL, {
          stdio: deps.testStdio || "inherit",
        }),
        "npm test"
      );
    }

    if (!skipAudit) {
      log("[publish] 3/7 npm run audit:public");
      requireOk(
        runNodeScript(AUDIT_SCRIPT_REL, {
          stdio: deps.auditStdio || "inherit",
        }),
        "audit:public"
      );
    }

    log("[publish] 4/7 Check publish file changes");
    if (!publishFilesChanged()) {
      log("[publish] No changes in publish files. Skipping commit/push.");
      return {
        ok: true,
        skippedPush: true,
        committed: false,
        pagesDeploymentStarted: false,
        pagesPublished: false,
        pagesDeployment: null,
        commitSha: null,
      };
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
      return {
        ok: true,
        skippedPush: true,
        committed: false,
        message,
        pagesDeploymentStarted: false,
        pagesPublished: false,
        pagesDeployment: null,
        commitSha: null,
      };
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

    const shaResult = git(["rev-parse", "HEAD"]);
    requireOk(shaResult, "git rev-parse HEAD");
    const commitSha = String(shaResult.stdout || "").trim();

    let pagesDeployment = null;
    let pagesPublished = false;
    let pagesDeploymentStarted = true;

    if (skipPagesVerify) {
      log(
        "[publish] Pages verify skipped (PAGES_VERIFY=0). pagesPublished=false until verified."
      );
      pagesDeployment = {
        commitSha,
        status: "skipped",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        errorCode: "PAGES_VERIFY_SKIPPED",
        errorMessage: "Verification skipped",
      };
    } else {
      log("[publish] Verifying GitHub Pages deployment…");
      const { verifyPagesDeployment } = require("./pages-deploy");
      const verifyFn =
        typeof deps.verifyPagesDeployment === "function"
          ? deps.verifyPagesDeployment
          : verifyPagesDeployment;
      pagesDeployment = await verifyFn({
        rootDir: root,
        commitSha,
        spawn,
        env,
        ...(deps.pagesDeploy || {}),
      });
      pagesPublished = pagesDeployment.pagesPublished === true;
      pagesDeploymentStarted =
        pagesDeployment.pagesDeploymentStarted !== false;
      if (pagesPublished) {
        log("[publish] Pages deployment succeeded.");
      } else {
        log(
          `[publish] WARNING: Pages deployment not confirmed (${
            pagesDeployment.status || "failed"
          }). Local commit kept.`
        );
      }
    }

    return {
      ok: true,
      skippedPush: false,
      committed: true,
      message,
      commitSha,
      pagesDeploymentStarted,
      pagesPublished,
      pagesDeployment,
    };
  }

  return {
    runPublish,
    formatPublishCommitMessage,
    publishFilesChanged,
    currentBranch,
    assertMainBranch,
    nodePath,
    PUBLISH_REL_FILES,
    REQUIRED_BRANCH,
  };
}

async function runPublishCli(deps = {}) {
  const runner = createRunner(deps);
  try {
    return await runner.runPublish(deps.publishOptions || {});
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
  TEST_SCRIPT_REL,
  AUDIT_SCRIPT_REL,
  formatPublishCommitMessage,
  createRunner,
  runPublishCli,
  resolveRoot,
  resolveNodePath,
};
