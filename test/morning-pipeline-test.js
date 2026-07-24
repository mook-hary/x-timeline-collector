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
  assert.throws(
    () =>
      runMorningPipeline(
        { dryRun: false, morningArgv: [] },
        {
          rootDir: tmpDir("morning-pipeline-fail-"),
          log: (l) => logs.push(l),
          logErr: (l) => logs.push(l),
          runMorning: () => {
            const err = new Error("collect boom");
            err.step = {
              id: "collect",
              label: "Collect",
              script: "connect.js",
              args: ["--once"],
            };
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
  console.log("EP046 fail-stops PASS");
}

// --- happy path: morning then publish once ---
{
  const root = tmpDir("morning-pipeline-ok-");
  let morningCalls = 0;
  let publishCalls = 0;
  const result = runMorningPipeline(
    { dryRun: false, morningArgv: ["--skip-collect"] },
    {
      rootDir: root,
      log: () => {},
      logErr: () => {},
      runMorning: (opts) => {
        morningCalls += 1;
        assert.strictEqual(opts.skipReader, true);
        assert.strictEqual(opts.skipCollect, true);
        assert.strictEqual(opts.fromEnriched, false);
        return { ok: true, stepsRun: ["analyze"] };
      },
      createPublishRunner: () => ({
        runPublish: () => {
          publishCalls += 1;
          return { ok: true, committed: true };
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
  console.log("EP046 happy-path PASS");
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
