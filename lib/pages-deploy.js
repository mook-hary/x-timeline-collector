/**
 * GitHub Pages deployment verification (post git push).
 * git push success ≠ Pages published. Polls Actions workflow for commit SHA.
 * Secrets/tokens never logged.
 */
const { spawnSync } = require("child_process");

const WORKFLOW_FILE = "deploy-reader-pages.yml";
const WARNING_FAILED = "PAGES_DEPLOY_FAILED";
const WARNING_TIMEOUT = "PAGES_DEPLOY_TIMEOUT";
const WARNING_UNAVAILABLE = "PAGES_VERIFY_UNAVAILABLE";

/** initial + 2 retries */
const MAX_DEPLOY_ATTEMPTS = 3;
/** Default wait for a single attempt's workflow to finish */
const DEFAULT_POLL_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 12 * 1000;
const TRANSIENT_HTTP = new Set([500, 502, 503, 504]);

function sleepSync(ms, deps = {}) {
  if (typeof deps.sleep === "function") {
    deps.sleep(ms);
    return;
  }
  const wait = Math.max(0, Math.floor(Number(ms) || 0));
  if (wait <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch (_error) {
    const end = Date.now() + wait;
    while (Date.now() < end) {
      /* busy wait */
    }
  }
}

function redactSecrets(text, env = process.env) {
  let out = String(text || "");
  const tokens = [
    env.GITHUB_TOKEN,
    env.GH_TOKEN,
    env.GITHUB_PAT,
  ].filter((t) => t && String(t).length >= 8);
  for (const token of tokens) {
    out = out.split(String(token)).join("[REDACTED]");
  }
  return out;
}

/**
 * Parse owner/repo from git remote URL.
 * @returns {{ owner: string, repo: string }|null}
 */
function parseGitHubRemote(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;
  // git@github.com:owner/repo.git
  let m = raw.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (m) {
    return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
  }
  // https://github.com/owner/repo
  try {
    const u = new URL(raw);
    if (!/github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    if (parts.length >= 2) {
      return {
        owner: parts[0],
        repo: String(parts[1]).replace(/\.git$/i, ""),
      };
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function resolveGitHubToken(env = process.env) {
  const token =
    env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_PAT || "";
  return String(token).trim() || null;
}

function isTransientHttpStatus(status) {
  return TRANSIENT_HTTP.has(Number(status));
}

function isTransientDeployFailure(runOrError) {
  if (!runOrError) return false;
  const status = Number(
    runOrError.errorCode != null
      ? runOrError.errorCode
      : runOrError.status != null
        ? runOrError.status
        : runOrError.statusCode
  );
  if (isTransientHttpStatus(status)) return true;
  const msg = String(
    runOrError.errorMessage || runOrError.message || runOrError.conclusion || ""
  ).toLowerCase();
  if (/503|502|504|500|temporar|unavailable|rate limit|gateway/.test(msg)) {
    return true;
  }
  return false;
}

function isRetryableWorkflowFailure(result) {
  if (!result || result.status !== "failed") return false;
  const code = String(result.errorCode || "");
  if (
    ["cancelled", "startup_failure", "action_required", "stale", "skipped"].includes(
      code
    )
  ) {
    return false;
  }
  if (isTransientDeployFailure(result)) return true;
  // Pages deploy flakes (e.g. deploy-pages 503) usually surface as workflow_failure.
  return code === "workflow_failure" || code === "failure";
}

/**
 * Low-level GitHub API GET/POST. Injectable fetch for tests.
 */
async function githubApi(pathname, options = {}) {
  const env = options.env || process.env;
  const token = options.token !== undefined ? options.token : resolveGitHubToken(env);
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    const err = new Error("fetch is not available");
    err.code = WARNING_UNAVAILABLE;
    throw err;
  }
  const base = options.apiBase || "https://api.github.com";
  const url = `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "x-timeline-collector-pages-deploy",
    ...(options.headers || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const method = options.method || "GET";
  const init = { method, headers };
  if (options.body != null) {
    init.body =
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }

  let lastError = null;
  const maxAttempts = options.apiRetries != null ? Number(options.apiRetries) : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        sleepSync(Math.min(8000, 1000 * 2 ** (attempt - 1)), options);
        continue;
      }
      const err = new Error(
        redactSecrets(error && error.message ? error.message : String(error), env)
      );
      err.code = WARNING_UNAVAILABLE;
      throw err;
    }

    if (isTransientHttpStatus(response.status) && attempt < maxAttempts) {
      sleepSync(Math.min(8000, 1000 * 2 ** (attempt - 1)), options);
      continue;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }

    if (!response.ok) {
      const err = new Error(
        redactSecrets(
          (json && json.message) ||
            `GitHub API ${response.status}`,
          env
        )
      );
      err.code = isTransientHttpStatus(response.status)
        ? "PAGES_API_TRANSIENT"
        : "PAGES_API_ERROR";
      err.status = response.status;
      err.errorCode = response.status;
      throw err;
    }
    return json;
  }
  const err = new Error(
    redactSecrets(lastError && lastError.message ? lastError.message : "GitHub API failed", env)
  );
  err.code = WARNING_UNAVAILABLE;
  throw err;
}

function gitCapture(args, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const root = deps.rootDir || process.cwd();
  const result = spawn("git", args, {
    cwd: root,
    encoding: "utf8",
    env: deps.env || process.env,
  });
  if (result.error || result.status !== 0) {
    const err = new Error(
      `git ${args.join(" ")} failed: ${
        result.error ? result.error.message : result.stderr || result.status
      }`
    );
    err.code = "pages-git";
    throw err;
  }
  return String(result.stdout || "").trim();
}

function resolveRepoContext(deps = {}) {
  if (deps.owner && deps.repo) {
    return { owner: deps.owner, repo: deps.repo };
  }
  const remote = gitCapture(["remote", "get-url", "origin"], deps);
  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    const err = new Error("Could not parse GitHub owner/repo from origin remote");
    err.code = WARNING_UNAVAILABLE;
    throw err;
  }
  return parsed;
}

function resolveCommitSha(deps = {}) {
  if (deps.commitSha) return String(deps.commitSha).trim();
  return gitCapture(["rev-parse", "HEAD"], deps);
}

/**
 * List Actions runs for a commit SHA (workflow file filtered when possible).
 */
async function listRunsForCommit(owner, repo, commitSha, deps = {}) {
  const q = new URLSearchParams({
    head_sha: commitSha,
    per_page: "10",
  });
  // Prefer workflow-scoped endpoint
  try {
    const data = await githubApi(
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
        WORKFLOW_FILE
      )}/runs?${q}`,
      deps
    );
    return Array.isArray(data && data.workflow_runs) ? data.workflow_runs : [];
  } catch (error) {
    if (error && error.status === 404) {
      const data = await githubApi(
        `/repos/${owner}/${repo}/actions/runs?${q}`,
        deps
      );
      const runs = Array.isArray(data && data.workflow_runs)
        ? data.workflow_runs
        : [];
      return runs.filter((r) => {
        const path = String(r.path || r.name || "");
        return path.includes("deploy-reader-pages") || /digest reader pages/i.test(String(r.name || ""));
      });
    }
    throw error;
  }
}

function pickLatestRun(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return [...runs].sort((a, b) => {
    const at = Date.parse(a.created_at || a.updated_at || 0);
    const bt = Date.parse(b.created_at || b.updated_at || 0);
    return bt - at;
  })[0];
}

async function rerunWorkflow(owner, repo, runId, deps = {}) {
  await githubApi(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, {
    ...deps,
    method: "POST",
    body: {},
  });
}

async function dispatchWorkflow(owner, repo, deps = {}) {
  await githubApi(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
      WORKFLOW_FILE
    )}/dispatches`,
    {
      ...deps,
      method: "POST",
      body: { ref: deps.ref || "main" },
    }
  );
}

/**
 * Wait until a workflow run for commitSha reaches success/failure or timeout.
 * @returns {Promise<object>} pagesDeployment record
 */
async function waitForWorkflowConclusion(owner, repo, commitSha, deps = {}) {
  const timeoutMs =
    deps.pollTimeoutMs != null
      ? Number(deps.pollTimeoutMs)
      : DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs =
    deps.pollIntervalMs != null
      ? Number(deps.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
  const startedAt = new Date(
    typeof deps.now === "function" ? deps.now() : Date.now()
  ).toISOString();
  const deadline =
    (typeof deps.now === "function" ? deps.now() : Date.now()) + timeoutMs;

  let lastRun = null;
  while ((typeof deps.now === "function" ? deps.now() : Date.now()) < deadline) {
    const runs = await listRunsForCommit(owner, repo, commitSha, deps);
    lastRun = pickLatestRun(runs);
    if (lastRun) {
      const status = String(lastRun.status || "");
      const conclusion = String(lastRun.conclusion || "");
      if (status === "completed") {
        const finishedAt = new Date(
          typeof deps.now === "function" ? deps.now() : Date.now()
        ).toISOString();
        if (conclusion === "success") {
          return {
            commitSha,
            status: "success",
            runId: lastRun.id,
            attempts: deps.attempt || 1,
            startedAt,
            finishedAt,
            errorCode: null,
            errorMessage: null,
          };
        }
        return {
          commitSha,
          status: "failed",
          runId: lastRun.id,
          attempts: deps.attempt || 1,
          startedAt,
          finishedAt,
          errorCode: conclusion === "failure" ? "workflow_failure" : conclusion || "failed",
          errorMessage: redactSecrets(
            `GitHub Actions run concluded: ${conclusion || "failed"}`,
            deps.env || process.env
          ),
        };
      }
    }
    sleepSync(intervalMs, deps);
  }

  return {
    commitSha,
    status: "timeout",
    runId: lastRun && lastRun.id ? lastRun.id : null,
    attempts: deps.attempt || 1,
    startedAt,
    finishedAt: new Date(
      typeof deps.now === "function" ? deps.now() : Date.now()
    ).toISOString(),
    errorCode: WARNING_TIMEOUT,
    errorMessage: "Timed out waiting for GitHub Pages workflow",
  };
}

/**
 * Verify Pages deploy for a commit; retry transient failures (max 3 attempts).
 */
async function verifyPagesDeployment(options = {}) {
  const deps = { ...options };
  const startedAt = new Date(
    typeof deps.now === "function" ? deps.now() : Date.now()
  ).toISOString();

  let owner;
  let repo;
  let commitSha;
  try {
    ({ owner, repo } = resolveRepoContext(deps));
    commitSha = resolveCommitSha(deps);
  } catch (error) {
    return {
      commitSha: deps.commitSha || null,
      status: "failed",
      attempts: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      errorCode: error.code || WARNING_UNAVAILABLE,
      errorMessage: redactSecrets(error.message, deps.env || process.env),
      pagesPublished: false,
      pagesDeploymentStarted: false,
      warning: WARNING_UNAVAILABLE,
    };
  }

  const maxAttempts =
    deps.maxAttempts != null ? Number(deps.maxAttempts) : MAX_DEPLOY_ATTEMPTS;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await waitForWorkflowConclusion(owner, repo, commitSha, {
        ...deps,
        attempt,
      });
    } catch (error) {
      const finishedAt = new Date(
        typeof deps.now === "function" ? deps.now() : Date.now()
      ).toISOString();
      result = {
        commitSha,
        status: "failed",
        runId: null,
        attempts: attempt,
        startedAt,
        finishedAt,
        errorCode: error.errorCode || error.status || error.code,
        errorMessage: redactSecrets(error.message, deps.env || process.env),
      };
      if (
        !isTransientDeployFailure(error) &&
        !isTransientHttpStatus(error.status)
      ) {
        return {
          ...result,
          pagesPublished: false,
          pagesDeploymentStarted: true,
          warning:
            error.code === WARNING_UNAVAILABLE
              ? WARNING_UNAVAILABLE
              : WARNING_FAILED,
        };
      }
    }
    lastResult = result;

    if (result.status === "success") {
      return {
        ...result,
        attempts: attempt,
        pagesPublished: true,
        pagesDeploymentStarted: true,
        warning: null,
      };
    }

    if (result.status === "timeout") {
      return {
        ...result,
        attempts: attempt,
        pagesPublished: false,
        pagesDeploymentStarted: true,
        warning: WARNING_TIMEOUT,
      };
    }

    // Failed — retry only if transient/retryable and attempts remain
    const transient =
      isRetryableWorkflowFailure(result) ||
      (deps.treatWorkflowFailureAsTransient === true && attempt < maxAttempts);

    if (!transient || attempt >= maxAttempts) {
      return {
        ...result,
        attempts: attempt,
        pagesPublished: false,
        pagesDeploymentStarted: true,
        warning: WARNING_FAILED,
      };
    }

    // Retry: rerun failed workflow if we have a run id + token; else dispatch
    try {
      if (result.runId && resolveGitHubToken(deps.env || process.env)) {
        await rerunWorkflow(owner, repo, result.runId, deps);
      } else if (resolveGitHubToken(deps.env || process.env)) {
        await dispatchWorkflow(owner, repo, deps);
      } else {
        // Cannot rerun without token — stop retrying
        return {
          ...result,
          attempts: attempt,
          pagesPublished: false,
          pagesDeploymentStarted: true,
          warning: WARNING_FAILED,
          errorMessage: redactSecrets(
            `${result.errorMessage || "deploy failed"}; retry requires GITHUB_TOKEN`,
            deps.env || process.env
          ),
        };
      }
    } catch (error) {
      if (!isTransientDeployFailure(error) && error.status && !isTransientHttpStatus(error.status)) {
        return {
          commitSha,
          status: "failed",
          attempts: attempt,
          startedAt,
          finishedAt: new Date().toISOString(),
          errorCode: error.errorCode || error.status || error.code,
          errorMessage: redactSecrets(error.message, deps.env || process.env),
          pagesPublished: false,
          pagesDeploymentStarted: true,
          warning: WARNING_FAILED,
        };
      }
      // transient API error — continue to next attempt after short wait
    }
    sleepSync(deps.retryWaitMs != null ? deps.retryWaitMs : 5000, deps);
  }

  return {
    ...(lastResult || {}),
    commitSha,
    status: (lastResult && lastResult.status) || "failed",
    attempts: maxAttempts,
    pagesPublished: false,
    pagesDeploymentStarted: true,
    warning: WARNING_FAILED,
  };
}

/**
 * Manual recovery: retry Pages deploy for existing commit (no collect/AI).
 */
async function retryPagesDeployment(options = {}) {
  const deps = { ...options };
  const { owner, repo } = resolveRepoContext(deps);
  const commitSha = resolveCommitSha(deps);
  const token = resolveGitHubToken(deps.env || process.env);
  if (!token) {
    const err = new Error(
      "pages:retry requires GITHUB_TOKEN (or GH_TOKEN) with actions:write"
    );
    err.code = WARNING_UNAVAILABLE;
    throw err;
  }

  const runs = await listRunsForCommit(owner, repo, commitSha, deps);
  const latest = pickLatestRun(runs);
  if (latest && latest.id && String(latest.conclusion) === "failure") {
    await rerunWorkflow(owner, repo, latest.id, deps);
  } else {
    await dispatchWorkflow(owner, repo, deps);
  }

  return verifyPagesDeployment({
    ...deps,
    owner,
    repo,
    commitSha,
    maxAttempts: deps.maxAttempts != null ? deps.maxAttempts : MAX_DEPLOY_ATTEMPTS,
  });
}

module.exports = {
  WORKFLOW_FILE,
  WARNING_FAILED,
  WARNING_TIMEOUT,
  WARNING_UNAVAILABLE,
  MAX_DEPLOY_ATTEMPTS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  parseGitHubRemote,
  resolveGitHubToken,
  redactSecrets,
  isTransientHttpStatus,
  isTransientDeployFailure,
  isRetryableWorkflowFailure,
  githubApi,
  resolveRepoContext,
  resolveCommitSha,
  listRunsForCommit,
  waitForWorkflowConclusion,
  verifyPagesDeployment,
  retryPagesDeployment,
  rerunWorkflow,
  dispatchWorkflow,
};
