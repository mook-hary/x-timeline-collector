/**
 * EP-046 — Morning Pipeline.
 * Run: node test/morning-pipeline-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseMorningPipelineArgs,
  buildMorningPipelinePlan,
  formatDryRunReport,
  runMorningPipeline,
  acquireMorningPipelineLock,
  releaseMorningPipelineLock,
  LOCK_REL,
} = require("../lib/morning-pipeline");
const { parseMorningArgs, buildMorningPlan } = require("../scripts/morning");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- skip-reader on morning runner ---
{
  const plan = buildMorningPlan(parseMorningArgs(["--skip-reader"]));
  assert.deepStrictEqual(
    plan.steps.map((s) => s.id),
    ["collect", "analyze", "analyze-ai", "enrich"]
  );
  assert.ok(!plan.steps.some((s) => s.id === "reader"));
  console.log("EP046 skip-reader PASS");
}

// --- parse / dry-run plan ---
{
  const opts = parseMorningPipelineArgs(["--dry-run", "--skip-collect"]);
  assert.strictEqual(opts.dryRun, true);
  assert.deepStrictEqual(opts.morningArgv, ["--skip-collect"]);

  const morningOpts = {
    ...parseMorningArgs(["--skip-collect"]),
    skipReader: true,
    fromEnriched: false,
    open: false,
  };
  const plan = buildMorningPipelinePlan(morningOpts);
  assert.ok(plan.stages.some((s) => s.id === "analyze"));
  assert.ok(plan.stages.some((s) => s.id === "publish"));
  assert.ok(!plan.stages.some((s) => s.id === "reader"));
  assert.ok(!plan.stages.some((s) => s.id === "collect"));

  const text = formatDryRunReport(plan);
  assert.ok(text.includes("Morning Pipeline (dry-run)"));
  assert.ok(text.includes("Publish Digest Reader"));
  assert.ok(text.includes("npm run publish"));
  assert.ok(text.includes("No collect / commit / push executed"));
  console.log("EP046 dry-run-plan PASS");
}

// --- dry-run does not call morning/publish ---
{
  let morningCalls = 0;
  let publishCalls = 0;
  const logs = [];
  const result = runMorningPipeline(
    { dryRun: true, morningArgv: [] },
    {
      log: (l) => logs.push(l),
      runMorning: () => {
        morningCalls += 1;
      },
      createPublishRunner: () => ({
        runPublish: () => {
          publishCalls += 1;
        },
      }),
    }
  );
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(morningCalls, 0);
  assert.strictEqual(publishCalls, 0);
  assert.ok(logs.join("\n").includes("dry-run"));
  console.log("EP046 dry-run-no-exec PASS");
}

// --- lock prevents double run ---
{
  const root = tmpDir("morning-pipeline-lock-");
  acquireMorningPipelineLock(root);
  assert.throws(() => acquireMorningPipelineLock(root), /already running/);
  releaseMorningPipelineLock(root);
  acquireMorningPipelineLock(root);
  releaseMorningPipelineLock(root);
  assert.ok(LOCK_REL.includes("morning-pipeline.lock"));
  console.log("EP046 lock PASS");
}

// --- failure stops before publish ---
{
  let publishCalls = 0;
  const logs = [];
  const root = tmpDir("morning-pipeline-fail-");
  assert.throws(
    () =>
      runMorningPipeline(
        { dryRun: false, morningArgv: [] },
        {
          rootDir: root,
          log: (l) => logs.push(l),
          logErr: (l) => logs.push(l),
          historyNow: () => new Date(2026, 6, 24, 7, 12, 33),
          runMorning: () => {
            const err = new Error("collect boom");
            err.step = {
              id: "collect",
              label: "Collect",
              script: "connect.js",
              args: ["--once"],
            };
            err.stages = [
              {
                id: "collect",
                label: "Collect",
                startedAt: "2026-07-24T07:00:00.000Z",
                finishedAt: "2026-07-24T07:00:01.000Z",
                ok: false,
                itemCount: null,
              },
            ];
            err.exitCode = 7;
            throw err;
          },
          createPublishRunner: () => ({
            runPublish: () => {
              publishCalls += 1;
            },
          }),
        }
      ),
    /Collect failed/
  );
  assert.strictEqual(publishCalls, 0);
  assert.ok(logs.some((l) => /FAILED stage=Collect/.test(l)));
  assert.ok(logs.some((l) => /command=node connect.js --once/.test(l)));
  assert.ok(logs.some((l) => /Morning Pipeline Summary/.test(l)));
  assert.ok(logs.some((l) => /Status: FAILED/.test(l)));
  const hist = path.join(
    root,
    ".pipeline-work",
    "history",
    "2026-07-24-071233.json"
  );
  assert.ok(fs.existsSync(hist));
  const report = JSON.parse(fs.readFileSync(hist, "utf8"));
  assert.strictEqual(report.status, "FAILED");
  assert.strictEqual(report.failure.stage, "Collect");
  console.log("EP046 fail-stops PASS");
}

// --- happy path: morning then publish once ---
{
  const root = tmpDir("morning-pipeline-ok-");
  let morningCalls = 0;
  let publishCalls = 0;
  const logs = [];
  const result = runMorningPipeline(
    { dryRun: false, morningArgv: ["--skip-collect"] },
    {
      rootDir: root,
      log: (l) => logs.push(l),
      logErr: () => {},
      historyNow: () => new Date(2026, 6, 24, 7, 12, 33),
      runMorning: (opts) => {
        morningCalls += 1;
        assert.strictEqual(opts.skipReader, true);
        assert.strictEqual(opts.skipCollect, true);
        assert.strictEqual(opts.fromEnriched, false);
        return {
          ok: true,
          stepsRun: ["analyze"],
          stages: [
            {
              id: "analyze",
              label: "Analyze",
              startedAt: "2026-07-24T07:00:00.000Z",
              finishedAt: "2026-07-24T07:01:00.000Z",
              ok: true,
              itemCount: 100,
            },
            {
              id: "analyze-ai",
              label: "AI Analyze",
              startedAt: "2026-07-24T07:01:00.000Z",
              finishedAt: "2026-07-24T07:02:00.000Z",
              ok: true,
              itemCount: 50,
            },
            {
              id: "enrich",
              label: "AI Enrich",
              startedAt: "2026-07-24T07:02:00.000Z",
              finishedAt: "2026-07-24T07:03:00.000Z",
              ok: true,
              itemCount: 50,
            },
          ],
        };
      },
      createPublishRunner: () => ({
        runPublish: () => {
          publishCalls += 1;
          return { ok: true, committed: true, skippedPush: false };
        },
      }),
    }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(morningCalls, 1);
  assert.strictEqual(publishCalls, 1);
  assert.deepStrictEqual(result.stagesRun, [
    "collect-analyze-enrich",
    "publish",
  ]);
  // lock released
  assert.ok(!fs.existsSync(path.join(root, LOCK_REL)));
  assert.ok(logs.some((l) => /Morning Pipeline Summary/.test(l)));
  assert.ok(logs.some((l) => /Status: SUCCESS/.test(l)));
  assert.ok(result.historyPath);
  assert.strictEqual(result.healthReport.status, "SUCCESS");
  assert.strictEqual(result.healthReport.publish.pushed, true);
  assert.strictEqual(result.healthReport.counts.analyzeAi, 50);
  console.log("EP046 happy-path PASS");
}

// --- history save failure does not fail pipeline ---
{
  const root = tmpDir("morning-pipeline-histfail-");
  const logs = [];
  const result = runMorningPipeline(
    { dryRun: false, morningArgv: ["--skip-collect"] },
    {
      rootDir: root,
      log: (l) => logs.push(l),
      logErr: () => {},
      runMorning: () => ({
        ok: true,
        stepsRun: ["analyze"],
        stages: [
          {
            id: "analyze",
            label: "Analyze",
            startedAt: "2026-07-24T07:00:00.000Z",
            finishedAt: "2026-07-24T07:00:01.000Z",
            ok: true,
            itemCount: 10,
          },
        ],
      }),
      createPublishRunner: () => ({
        runPublish: () => ({ ok: true, committed: false, skippedPush: true }),
      }),
      saveMorningHealthReport: () => {
        throw new Error("disk full");
      },
    }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.historyPath, null);
  assert.ok(logs.some((l) => /WARNING: failed to save health history/.test(l)));
  assert.ok(logs.some((l) => /Morning Pipeline Summary/.test(l)));
  assert.ok(logs.some((l) => /\(not saved\)/.test(l)));
  console.log("EP048 history-soft-fail PASS");
}

// --- COLLECT-HEALTH wiring: SUCCESS History keeps collectorHealth + collect ---
{
  const root = tmpDir("morning-pipeline-ch-ok-");
  const collectHealth = {
    authenticated: true,
    timelineAvailable: true,
    status: "healthy",
    warnings: [],
    fetchedFromScreen: 35,
    newPosts: 34,
    duplicateUrlsSkipped: 1,
    totalStored: 638,
    missingPostedAt: 5,
    newestPostAt: "2026-08-12T01:00:00.000Z",
  };
  const collectDetail = {
    fetchedFromScreen: 35,
    newPosts: 34,
    duplicateUrlsSkipped: 1,
    totalStored: 638,
    missingPostedAt: 5,
    newestPostAt: "2026-08-12T01:00:00.000Z",
  };
  const logs = [];
  const result = runMorningPipeline(
    { dryRun: false, morningArgv: [] },
    {
      rootDir: root,
      log: (l) => logs.push(l),
      logErr: () => {},
      historyNow: () => new Date(2026, 7, 12, 14, 0, 0),
      runMorning: () => ({
        ok: true,
        stepsRun: ["collect", "analyze"],
        stages: [
          {
            id: "collect",
            label: "Collect",
            startedAt: "2026-08-12T01:00:00.000Z",
            finishedAt: "2026-08-12T01:01:00.000Z",
            ok: true,
            itemCount: 638,
            collectorHealth: collectHealth,
            collect: collectDetail,
          },
          {
            id: "analyze",
            label: "Analyze",
            startedAt: "2026-08-12T01:01:00.000Z",
            finishedAt: "2026-08-12T01:02:00.000Z",
            ok: true,
            itemCount: 10,
          },
        ],
        collectorHealth: collectHealth,
        collect: collectDetail,
      }),
      createPublishRunner: () => ({
        runPublish: () => ({ ok: true, committed: true, skippedPush: false }),
      }),
    }
  );
  assert.strictEqual(result.ok, true);
  assert.ok(result.healthReport.collectorHealth);
  assert.strictEqual(result.healthReport.collectorHealth.status, "healthy");
  assert.strictEqual(result.healthReport.collectorHealth.authenticated, true);
  assert.ok(result.healthReport.collect);
  assert.strictEqual(result.healthReport.collect.newPosts, 34);
  assert.strictEqual(result.healthReport.collect.fetchedFromScreen, 35);
  assert.strictEqual(result.healthReport.counts.collect, 638);
  assert.ok(logs.some((l) => /X Collector/.test(l)));
  assert.ok(logs.some((l) => /Login: OK/.test(l)));

  const histPath = path.join(root, result.historyPath);
  assert.ok(fs.existsSync(histPath));
  const saved = JSON.parse(fs.readFileSync(histPath, "utf8"));
  assert.ok(saved.collectorHealth, "History must include collectorHealth");
  assert.strictEqual(saved.collectorHealth.status, "healthy");
  assert.strictEqual(saved.collect.newPosts, 34);
  assert.strictEqual(saved.counts.collect, 638);
  console.log("CH001 pipeline-history-success PASS");
}

// --- COLLECT-HEALTH wiring: X_AUTH_REQUIRED failed health saved ---
{
  const root = tmpDir("morning-pipeline-ch-auth-");
  const failedHealth = {
    authenticated: false,
    timelineAvailable: false,
    status: "failed",
    error: "X_AUTH_REQUIRED",
    warnings: [],
  };
  let threw = null;
  try {
    runMorningPipeline(
      { dryRun: false, morningArgv: [] },
      {
        rootDir: root,
        log: () => {},
        logErr: () => {},
        historyNow: () => new Date(2026, 7, 12, 14, 5, 0),
        runMorning: () => {
          const err = new Error("Collect failed: X_AUTH_REQUIRED");
          err.code = "X_AUTH_REQUIRED";
          err.exitCode = 1;
          err.step = { id: "collect", label: "Collect", script: "connect.js", args: ["--once"] };
          err.stages = [
            {
              id: "collect",
              label: "Collect",
              ok: false,
              itemCount: null,
              collectorHealth: failedHealth,
            },
          ];
          err.collectorHealth = failedHealth;
          throw err;
        },
        createPublishRunner: () => ({
          runPublish: () => {
            throw new Error("publish must not run after auth failure");
          },
        }),
      }
    );
  } catch (error) {
    threw = error;
  }
  assert.ok(threw);
  const histDir = path.join(root, ".pipeline-work", "history");
  const files = fs.readdirSync(histDir).filter((n) => n.endsWith(".json"));
  assert.ok(files.length >= 1);
  const saved = JSON.parse(
    fs.readFileSync(path.join(histDir, files.sort().pop()), "utf8")
  );
  assert.strictEqual(saved.status, "FAILED");
  assert.ok(saved.collectorHealth);
  assert.strictEqual(saved.collectorHealth.status, "failed");
  assert.strictEqual(saved.collectorHealth.error, "X_AUTH_REQUIRED");
  assert.strictEqual(saved.collectorHealth.authenticated, false);
  console.log("CH001 pipeline-history-auth-fail PASS");
}

// --- CLI dry-run via spawn ---
{
  const { spawnSync } = require("child_process");
  const result = spawnSync(
    process.execPath,
    ["scripts/morning-pipeline.js", "--dry-run"],
    {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
    }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Morning Pipeline (dry-run)"));
  assert.ok(result.stdout.includes("node connect.js --once"));
  assert.ok(result.stdout.includes("npm run publish"));
  console.log("EP046 cli-dry-run PASS");
}

console.log("morning-pipeline-test: all PASS");
