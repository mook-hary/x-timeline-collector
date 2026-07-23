/**
 * EP-026 — Morning Runner tests.
 * Does not run Chrome collect or OpenAI. Dangerous CLIs are mocked.
 * Run: node test/morning-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  parseMorningArgs,
  buildMorningPlan,
  runMorning,
  AI_LIMIT,
} = require("../scripts/morning");

const ROOT = path.join(__dirname, "..");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHelp(scriptArgs) {
  return spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    encoding: "utf8",
  });
}

// --- CLI help (safe; no collect / no API work) ---
{
  const helps = [
    ["scripts/morning.js", "--help"],
    ["connect.js", "--help"],
    ["analyze.js", "--help"],
    ["analyze_ai.js", "--help"],
    ["enrich_ai.js", "--help"],
  ];
  for (const args of helps) {
    const result = runHelp(args);
    assert.strictEqual(result.status, 0, `${args.join(" ")} exit`);
    assert.ok(
      /Usage:/i.test(result.stdout),
      `${args.join(" ")} should print Usage`
    );
    assert.ok(
      !/スクロール|API実行|既存投稿:/u.test(result.stdout + result.stderr),
      `${args.join(" ")} must not start work`
    );
  }
  console.log("CLI help PASS");
}

// --- parse / plan ---
{
  assert.throws(() => parseMorningArgs(["--nope"]), /不明なオプション/);

  const def = buildMorningPlan(parseMorningArgs([]));
  assert.deepStrictEqual(
    def.steps.map((s) => s.id),
    ["collect", "analyze", "analyze-ai", "enrich", "reader"]
  );
  assert.deepStrictEqual(def.steps[0].args, ["--once"]);
  assert.deepStrictEqual(def.steps[2].args, ["--limit", AI_LIMIT]);
  assert.deepStrictEqual(def.steps[3].args, ["--limit", AI_LIMIT]);

  const skipCollect = buildMorningPlan(
    parseMorningArgs(["--skip-collect", "--today", "--top", "3"])
  );
  assert.deepStrictEqual(
    skipCollect.steps.map((s) => s.id),
    ["analyze", "analyze-ai", "enrich", "reader"]
  );
  assert.deepStrictEqual(skipCollect.steps.at(-1).args, [
    "--today",
    "--top",
    "3",
  ]);

  const skipAi = buildMorningPlan(parseMorningArgs(["--skip-ai"]));
  assert.deepStrictEqual(
    skipAi.steps.map((s) => s.id),
    ["collect", "analyze", "reader"]
  );
  assert.strictEqual(skipAi.warnStaleEnriched, true);
  assert.strictEqual(skipAi.requireEnriched, true);

  const fromEnriched = buildMorningPlan(
    parseMorningArgs(["--from-enriched", "--full"])
  );
  assert.deepStrictEqual(
    fromEnriched.steps.map((s) => s.id),
    ["reader"]
  );
  assert.deepStrictEqual(fromEnriched.steps[0].args, ["--full"]);
  assert.strictEqual(fromEnriched.requireEnriched, true);

  console.log("Parse/plan PASS");
}

function mockSpawnOk() {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    // Refuse real dangerous scripts if somehow invoked without mock path
    const script = args[0] || "";
    assert.ok(
      !/pipeline\.js$/.test(script),
      "must not call pipeline.js"
    );
    return { status: 0, error: null, stdout: "", stderr: "" };
  };
  return { calls, spawn };
}

// --- --from-enriched ---
{
  const root = tmpDir("morning-from-enriched-");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output", "timeline_enriched.json"),
    "[]\n",
    "utf8"
  );
  // stub reader script path expectation: morning joins root + scripts/...
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");
  fs.mkdirSync(path.join(root, "output", "digest-reader"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output", "digest-reader", "index.html"),
    "<html></html>\n",
    "utf8"
  );

  const logs = [];
  const { calls, spawn } = mockSpawnOk();
  const result = runMorning(parseMorningArgs(["--from-enriched", "--open"]), {
    rootDir: root,
    spawn,
    log: (line) => logs.push(line),
    existsSync: (p) => fs.existsSync(p),
    openFn: () => {
      logs.push("OPEN_CALLED");
      return { status: 0 };
    },
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.stepsRun, ["reader"]);
  assert.strictEqual(result.opened, true);
  assert.ok(logs.some((l) => l.includes("既存の timeline_enriched.json")));
  assert.ok(logs.some((l) => l.includes("最新データではない可能性があります")));
  assert.ok(logs.includes("OPEN_CALLED"));
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].args[0].endsWith("build-digest-reader.js"));
  console.log("from-enriched PASS");
}

// --- --skip-collect ---
{
  const root = tmpDir("morning-skip-collect-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "enrich_ai.js"), "", "utf8");

  const { calls, spawn } = mockSpawnOk();
  const logs = [];
  const result = runMorning(parseMorningArgs(["--skip-collect"]), {
    rootDir: root,
    spawn,
    log: (line) => logs.push(line),
  });
  assert.deepStrictEqual(result.stepsRun, [
    "analyze",
    "analyze-ai",
    "enrich",
    "reader",
  ]);
  assert.ok(!calls.some((c) => String(c.args[0]).endsWith("connect.js")));
  console.log("skip-collect PASS");
}

// --- --skip-ai ---
{
  const root = tmpDir("morning-skip-ai-");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output", "timeline_enriched.json"),
    "[]\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "connect.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const { calls, spawn } = mockSpawnOk();
  const logs = [];
  const result = runMorning(parseMorningArgs(["--skip-ai", "--skip-collect"]), {
    rootDir: root,
    spawn,
    log: (line) => logs.push(line),
  });
  assert.deepStrictEqual(result.stepsRun, ["analyze", "reader"]);
  assert.ok(!calls.some((c) => /analyze_ai\.js$/.test(c.args[0])));
  assert.ok(!calls.some((c) => /enrich_ai\.js$/.test(c.args[0])));
  assert.ok(logs.some((l) => l.includes("最新データではない可能性があります")));
  assert.ok(logs.some((l) => l.includes("Morning Summary")));
  assert.ok(logs.some((l) => l.includes("Grand Total")));
  console.log("skip-ai PASS");
}

// --- missing enriched stops ---
{
  const root = tmpDir("morning-missing-enriched-");
  let threw = false;
  try {
    runMorning(parseMorningArgs(["--from-enriched"]), {
      rootDir: root,
      spawn: () => ({ status: 0 }),
      log: () => {},
    });
  } catch (error) {
    threw = true;
    assert.strictEqual(error.code, "morning-missing-enriched");
  }
  assert.ok(threw);
  console.log("missing enriched PASS");
}

// --- error stop (does not continue) ---
{
  const root = tmpDir("morning-error-stop-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "connect.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "enrich_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const calls = [];
  const spawn = (_cmd, args) => {
    calls.push(args[0]);
    if (String(args[0]).endsWith("analyze.js")) {
      return { status: 7, error: null, stdout: "", stderr: "boom" };
    }
    return { status: 0, error: null, stdout: "", stderr: "" };
  };
  const logs = [];
  let threw = false;
  try {
    runMorning(parseMorningArgs(["--skip-collect"]), {
      rootDir: root,
      spawn,
      log: (line) => logs.push(line),
    });
  } catch (error) {
    threw = true;
    assert.strictEqual(error.code, "morning-step");
    assert.strictEqual(error.exitCode, 7);
    assert.strictEqual(error.step.id, "analyze");
  }
  assert.ok(threw);
  assert.strictEqual(calls.length, 1);
  assert.ok(logs.some((l) => l.includes("exit code=7")));
  assert.ok(logs.some((l) => l.includes("command=node analyze.js")));
  console.log("error stop PASS");
}

// --- reader args forwarded ---
{
  const root = tmpDir("morning-reader-args-");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output", "timeline_enriched.json"),
    "[]\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const { calls, spawn } = mockSpawnOk();
  runMorning(
    parseMorningArgs([
      "--from-enriched",
      "--from",
      "2026-07-01",
      "--to",
      "2026-07-15",
      "--category",
      "AI",
      "--min-importance",
      "4",
      "--top",
      "5",
      "--full",
    ]),
    { rootDir: root, spawn, log: () => {} }
  );
  assert.deepStrictEqual(calls[0].args.slice(1), [
    "--from",
    "2026-07-01",
    "--to",
    "2026-07-15",
    "--category",
    "AI",
    "--min-importance",
    "4",
    "--top",
    "5",
    "--full",
  ]);
  console.log("reader args PASS");
}

// --- does not call site / pipeline ---
{
  const root = tmpDir("morning-no-site-");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "site"), { recursive: true });
  fs.writeFileSync(path.join(root, "site", "marker.txt"), "keep\n", "utf8");
  fs.writeFileSync(
    path.join(root, "output", "timeline_enriched.json"),
    "[]\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const { calls, spawn } = mockSpawnOk();
  runMorning(parseMorningArgs(["--from-enriched"]), {
    rootDir: root,
    spawn,
    log: () => {},
  });
  for (const call of calls) {
    const joined = call.args.join(" ");
    assert.ok(!/pipeline\.js/.test(joined));
    assert.ok(!/build-site/.test(joined));
    assert.ok(!/site-builder/.test(joined));
  }
  assert.strictEqual(
    fs.readFileSync(path.join(root, "site", "marker.txt"), "utf8"),
    "keep\n"
  );
  console.log("no site/pipeline PASS");
}

// --- default plan includes connect --once ---
{
  const opts = parseMorningArgs([]);
  const plan = buildMorningPlan(opts);
  assert.strictEqual(plan.steps[0].script, "connect.js");
  assert.deepStrictEqual(plan.steps[0].args, ["--once"]);
  console.log("default collect --once PASS");
}

// --- EP-030: morning aggregates usage markers ---
{
  const root = tmpDir("morning-usage-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "connect.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "enrich_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const spawn = (_cmd, args) => {
    const script = String(args[0] || "");
    let stdout = "";
    if (script.endsWith("analyze_ai.js")) {
      stdout =
        '[api-usage] {"label":"Analyze","requests":2,"input_tokens":100,"output_tokens":20,"total_tokens":120}\n';
    } else if (script.endsWith("enrich_ai.js")) {
      stdout =
        '[api-usage] {"label":"Enrich","requests":3,"input_tokens":200,"output_tokens":40,"total_tokens":240}\n';
    }
    return { status: 0, error: null, stdout, stderr: "" };
  };
  const logs = [];
  const result = runMorning(parseMorningArgs(["--skip-collect"]), {
    rootDir: root,
    spawn,
    log: (line) => logs.push(line),
  });
  assert.strictEqual(result.usage.analyze.requests, 2);
  assert.strictEqual(result.usage.enrich.requests, 3);
  const joined = logs.join("\n");
  assert.ok(joined.includes("Morning Summary"));
  assert.ok(joined.includes("Requests : 5"));
  assert.ok(joined.includes("Total    : 360"));
  assert.ok(joined.includes("Estimated Cost"));
  assert.ok(joined.includes("Model  : gpt-5-mini"));
  assert.ok(joined.includes("Estimate only; actual billing may differ."));
  // 300 input → $0.000075 (<$0.0001 → 6dp); 60 output → $0.00012 → $0.0001
  assert.ok(joined.includes("Input  : $0.000075"));
  assert.ok(joined.includes("Output : $0.0001"));
  assert.ok(joined.includes("Usage history saved:"));
  assert.strictEqual(result.historySaved, true);
  console.log("usage aggregate PASS");
}

// --- EP-032: unknown model cost unavailable, morning still succeeds ---
{
  const root = tmpDir("morning-cost-unknown-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "connect.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "enrich_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const spawn = () => ({ status: 0, error: null, stdout: "", stderr: "" });
  const logs = [];
  const result = runMorning(parseMorningArgs(["--skip-collect"]), {
    rootDir: root,
    spawn,
    log: (line) => logs.push(line),
    env: { ...process.env, OPENAI_MODEL: "not-a-priced-model" },
    historyPath: path.join(root, "data", "api-usage-history.json"),
  });
  assert.strictEqual(result.ok, true);
  const joined = logs.join("\n");
  assert.ok(joined.includes("Model  : not-a-priced-model"));
  assert.ok(joined.includes("Estimated Cost: unavailable"));
  assert.ok(
    joined.includes("pricing is not configured for not-a-priced-model")
  );
  console.log("unknown model cost PASS");
}

// --- EP-033: history saved once with usage + cost + runOptions ---
{
  const root = tmpDir("morning-hist-save-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "connect.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "enrich_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const historyCalls = [];
  const times = [
    "2026-07-23T04:27:01.000Z",
    "2026-07-23T04:30:15.123Z",
  ];
  const spawn = (_cmd, args) => {
    const script = String(args[0] || "");
    let stdout = "";
    if (script.endsWith("analyze_ai.js")) {
      stdout =
        '[api-usage] {"label":"Analyze","requests":49,"input_tokens":38200,"output_tokens":21110,"total_tokens":59310}\n';
    } else if (script.endsWith("enrich_ai.js")) {
      stdout =
        '[api-usage] {"label":"Enrich","requests":50,"input_tokens":40614,"output_tokens":27381,"total_tokens":67995}\n';
    }
    return { status: 0, error: null, stdout, stderr: "" };
  };
  const logs = [];
  const result = runMorning(parseMorningArgs(["--skip-collect"]), {
    rootDir: root,
    spawn,
    log: (line) => logs.push(line),
    env: { ...process.env, OPENAI_MODEL: "gpt-5-mini" },
    now: () => times.shift() || "2026-07-23T04:30:15.123Z",
    recordUsageHistory: (historyPath, entry) => {
      historyCalls.push({ historyPath, entry });
      return { ok: true, added: true, path: historyPath, entry };
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(historyCalls.length, 1);
  const entry = historyCalls[0].entry;
  assert.strictEqual(entry.startedAt, "2026-07-23T04:27:01.000Z");
  assert.strictEqual(entry.finishedAt, "2026-07-23T04:30:15.123Z");
  assert.strictEqual(entry.model, "gpt-5-mini");
  assert.strictEqual(entry.analyze.requests, 49);
  assert.strictEqual(entry.enrich.requests, 50);
  assert.strictEqual(entry.total.requests, 99);
  assert.strictEqual(entry.total.inputTokens, 78814);
  assert.ok(entry.estimatedCostUsd.total > 0);
  assert.deepStrictEqual(entry.runOptions, {
    skipCollect: true,
    skipAi: false,
    fromEnriched: false,
  });
  assert.ok(logs.join("\n").includes("Usage history saved:"));
  assert.ok(logs.join("\n").includes("Morning Summary"));
  console.log("history save once PASS");
}

// --- EP-033: zero usage still recorded ---
{
  const root = tmpDir("morning-hist-zero-");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output", "timeline_enriched.json"),
    "[]\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const historyCalls = [];
  const logs = [];
  const result = runMorning(parseMorningArgs(["--from-enriched"]), {
    rootDir: root,
    spawn: () => ({ status: 0, error: null, stdout: "", stderr: "" }),
    log: (line) => logs.push(line),
    now: (() => {
      let i = 0;
      const t = ["2026-07-23T05:00:00.000Z", "2026-07-23T05:00:01.000Z"];
      return () => t[i++] || t[t.length - 1];
    })(),
    recordUsageHistory: (historyPath, entry) => {
      historyCalls.push(entry);
      return { ok: true, added: true, path: historyPath, entry };
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(historyCalls.length, 1);
  assert.strictEqual(historyCalls[0].total.requests, 0);
  assert.deepStrictEqual(historyCalls[0].estimatedCostUsd, {
    input: 0,
    output: 0,
    total: 0,
  });
  assert.strictEqual(historyCalls[0].runOptions.fromEnriched, true);
  console.log("zero usage history PASS");
}

// --- EP-033: history save failure does not fail Morning ---
{
  const root = tmpDir("morning-hist-fail-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "connect.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "enrich_ai.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build-digest-reader.js"), "", "utf8");

  const logs = [];
  const result = runMorning(parseMorningArgs(["--skip-collect"]), {
    rootDir: root,
    spawn: () => ({ status: 0, error: null, stdout: "", stderr: "" }),
    log: (line) => logs.push(line),
    recordUsageHistory: () => {
      throw new Error("disk full");
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.historySaved, false);
  assert.ok(
    logs.some((l) =>
      l.includes("WARNING: failed to save usage history: disk full")
    )
  );
  console.log("history save failure soft PASS");
}

// --- EP-033: mid-run failure does not save success history ---
{
  const root = tmpDir("morning-hist-midfail-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "analyze.js"), "", "utf8");
  fs.writeFileSync(path.join(root, "analyze_ai.js"), "", "utf8");

  let historyCalls = 0;
  assert.throws(
    () =>
      runMorning(parseMorningArgs(["--skip-collect"]), {
        rootDir: root,
        spawn: (_cmd, args) => {
          const script = String(args[0] || "");
          if (script.endsWith("analyze_ai.js")) {
            return { status: 2, error: null, stdout: "", stderr: "boom" };
          }
          return { status: 0, error: null, stdout: "", stderr: "" };
        },
        log: () => {},
        recordUsageHistory: () => {
          historyCalls += 1;
          return { ok: true };
        },
      }),
    /AI Analyze failed/
  );
  assert.strictEqual(historyCalls, 0);
  console.log("mid-fail no history PASS");
}

console.log("morning-test: ALL PASS");
