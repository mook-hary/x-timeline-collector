/**
 * Pages deploy verify / retry (mocked GitHub API).
 * Run: node test/pages-deploy-test.js
 */
const assert = require("assert");
const {
  parseGitHubRemote,
  redactSecrets,
  isTransientHttpStatus,
  isRetryableWorkflowFailure,
  isTransientDeployFailure,
  verifyPagesDeployment,
  retryPagesDeployment,
  WARNING_FAILED,
  WARNING_TIMEOUT,
  MAX_DEPLOY_ATTEMPTS,
} = require("../lib/pages-deploy");

const SECRET = "ghp_SUPER_SECRET_TOKEN_DO_NOT_LEAK_12345";

function makeFetchSequence(handlers) {
  let i = 0;
  return async (url, init) => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return handler(url, init, i);
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
  };
}

// --- parse remote ---
{
  assert.deepStrictEqual(
    parseGitHubRemote("git@github.com:acme/x-timeline-collector.git"),
    { owner: "acme", repo: "x-timeline-collector" }
  );
  assert.deepStrictEqual(
    parseGitHubRemote("https://github.com/acme/x-timeline-collector.git"),
    { owner: "acme", repo: "x-timeline-collector" }
  );
  console.log("pages-deploy parse-remote PASS");
}

// --- redact secrets ---
{
  const out = redactSecrets(`fail token=${SECRET} end`, {
    GITHUB_TOKEN: SECRET,
  });
  assert.ok(!out.includes(SECRET));
  assert.ok(out.includes("[REDACTED]"));
  console.log("pages-deploy redact PASS");
}

// --- transient helpers ---
{
  assert.strictEqual(isTransientHttpStatus(503), true);
  assert.strictEqual(isTransientHttpStatus(404), false);
  assert.strictEqual(
    isRetryableWorkflowFailure({
      status: "failed",
      errorCode: "workflow_failure",
    }),
    true
  );
  assert.strictEqual(
    isRetryableWorkflowFailure({
      status: "failed",
      errorCode: "cancelled",
    }),
    false
  );
  assert.strictEqual(
    isTransientDeployFailure({ errorCode: 503, errorMessage: "unavailable" }),
    true
  );
  console.log("pages-deploy helpers PASS");
}

async function runAsyncTests() {
  const baseDeps = {
    owner: "acme",
    repo: "demo",
    commitSha: "abc123def456",
    env: { GITHUB_TOKEN: SECRET },
    sleep: () => {},
    pollTimeoutMs: 60_000,
    pollIntervalMs: 1,
    retryWaitMs: 1,
    maxAttempts: MAX_DEPLOY_ATTEMPTS,
  };

  // push success + Pages success
  {
    const fetch = makeFetchSequence([
      () =>
        jsonResponse(200, {
          workflow_runs: [
            {
              id: 11,
              status: "completed",
              conclusion: "success",
              head_sha: "abc123def456",
              path: ".github/workflows/deploy-reader-pages.yml",
            },
          ],
        }),
    ]);
    const result = await verifyPagesDeployment({ ...baseDeps, fetch });
    assert.strictEqual(result.pagesPublished, true);
    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.warning, null);
    console.log("pages-deploy success PASS");
  }

  // push success + Pages failure (permanent cancelled — no retry beyond first)
  {
    let listCalls = 0;
    const fetch = async (url) => {
      if (String(url).includes("/actions/") && String(url).includes("/runs")) {
        listCalls += 1;
        return jsonResponse(200, {
          workflow_runs: [
            {
              id: 22,
              status: "completed",
              conclusion: "cancelled",
              head_sha: "abc123def456",
              path: ".github/workflows/deploy-reader-pages.yml",
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const result = await verifyPagesDeployment({
      ...baseDeps,
      fetch,
      maxAttempts: 3,
    });
    assert.strictEqual(result.pagesPublished, false);
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.attempts, 1);
    assert.ok(listCalls === 1);
    assert.strictEqual(result.warning, WARNING_FAILED);
    console.log("pages-deploy permanent-no-retry PASS");
  }

  // 503-style workflow_failure → retry → success
  {
    let listCalls = 0;
    let rerunCalls = 0;
    const fetch = async (url, init) => {
      const method = (init && init.method) || "GET";
      if (method === "POST" && String(url).includes("/rerun")) {
        rerunCalls += 1;
        return jsonResponse(201, {});
      }
      if (String(url).includes("actions/runs")) {
        listCalls += 1;
        if (listCalls === 1) {
          return jsonResponse(200, {
            workflow_runs: [
              {
                id: 33,
                status: "completed",
                conclusion: "failure",
                head_sha: "abc123def456",
                path: ".github/workflows/deploy-reader-pages.yml",
              },
            ],
          });
        }
        return jsonResponse(200, {
          workflow_runs: [
            {
              id: 34,
              status: "completed",
              conclusion: "success",
              head_sha: "abc123def456",
              path: ".github/workflows/deploy-reader-pages.yml",
            },
          ],
        });
      }
      return jsonResponse(404, { message: "not found" });
    };
    const result = await verifyPagesDeployment({ ...baseDeps, fetch });
    assert.strictEqual(result.pagesPublished, true);
    assert.strictEqual(result.status, "success");
    assert.ok(result.attempts >= 2);
    assert.ok(rerunCalls >= 1);
    console.log("pages-deploy 503-retry-then-success PASS");
  }

  // 503 exhaust retries
  {
    let listCalls = 0;
    const fetch = async (url, init) => {
      const method = (init && init.method) || "GET";
      if (method === "POST") return jsonResponse(201, {});
      listCalls += 1;
      return jsonResponse(200, {
        workflow_runs: [
          {
            id: 40 + listCalls,
            status: "completed",
            conclusion: "failure",
            head_sha: "abc123def456",
            path: ".github/workflows/deploy-reader-pages.yml",
          },
        ],
      });
    };
    const result = await verifyPagesDeployment({ ...baseDeps, fetch });
    assert.strictEqual(result.pagesPublished, false);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.warning, WARNING_FAILED);
    console.log("pages-deploy 503-exhaust PASS");
  }

  // timeout
  {
    const fetch = async () =>
      jsonResponse(200, {
        workflow_runs: [
          {
            id: 99,
            status: "in_progress",
            conclusion: null,
            head_sha: "abc123def456",
            path: ".github/workflows/deploy-reader-pages.yml",
          },
        ],
      });
    const result = await verifyPagesDeployment({
      ...baseDeps,
      fetch,
      pollTimeoutMs: 5,
      pollIntervalMs: 1,
      maxAttempts: 1,
      now: (() => {
        let t = 1_000_000;
        return () => {
          t += 100;
          return t;
        };
      })(),
    });
    assert.strictEqual(result.pagesPublished, false);
    assert.strictEqual(result.status, "timeout");
    assert.strictEqual(result.warning, WARNING_TIMEOUT);
    console.log("pages-deploy timeout PASS");
  }

  // secrets never appear in errorMessage
  {
    const fetch = async () =>
      jsonResponse(401, {
        message: `Bad credentials ${SECRET}`,
      });
    const result = await verifyPagesDeployment({
      ...baseDeps,
      fetch,
      maxAttempts: 1,
    });
    assert.strictEqual(result.pagesPublished, false);
    const blob = JSON.stringify(result);
    assert.ok(!blob.includes(SECRET), "token must not appear in result");
    console.log("pages-deploy no-secret-leak PASS");
  }

  // pages:retry does not call collect — only Actions API
  {
    const urls = [];
    const fetch = async (url, init) => {
      urls.push({ url: String(url), method: (init && init.method) || "GET" });
      if (String(url).includes("/rerun") || String(url).includes("dispatches")) {
        return jsonResponse(201, {});
      }
      return jsonResponse(200, {
        workflow_runs: [
          {
            id: 55,
            status: "completed",
            conclusion: "failure",
            head_sha: "abc123def456",
            path: ".github/workflows/deploy-reader-pages.yml",
          },
        ],
      });
    };
    // First call lists failed run → rerun → then verify loops; force success on 2nd list
    let lists = 0;
    const fetch2 = async (url, init) => {
      urls.push({ url: String(url), method: (init && init.method) || "GET" });
      const method = (init && init.method) || "GET";
      if (method === "POST") return jsonResponse(201, {});
      if (String(url).includes("actions/runs")) {
        lists += 1;
        return jsonResponse(200, {
          workflow_runs: [
            {
              id: 55,
              status: "completed",
              conclusion: lists === 1 ? "failure" : "success",
              head_sha: "abc123def456",
              path: ".github/workflows/deploy-reader-pages.yml",
            },
          ],
        });
      }
      return jsonResponse(404, {});
    };
    const result = await retryPagesDeployment({
      ...baseDeps,
      fetch: fetch2,
      maxAttempts: 2,
    });
    assert.strictEqual(result.pagesPublished, true);
    assert.ok(urls.every((u) => /api\.github\.com/.test(u.url)));
    assert.ok(!urls.some((u) => /collect|enrich|timeline/i.test(u.url)));
    console.log("pages-deploy retry-no-collect PASS");
  }

  console.log("pages-deploy-test: all PASS");
}

runAsyncTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
