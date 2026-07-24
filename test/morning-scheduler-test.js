/**
 * EP-047 — Morning scheduler (launchd).
 * Run: node test/morning-scheduler-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_LABEL,
  DEFAULT_HOUR,
  DEFAULT_MINUTE,
  DEFAULT_TIMEZONE,
  PLIST_DIR_REL,
  buildMorningSchedulerPlan,
  installMorningScheduler,
  uninstallMorningScheduler,
  statusMorningScheduler,
  formatStatusReport,
  parseSchedulerArgs,
} = require("../lib/morning-scheduler");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- plan defaults ---
{
  const root = tmpDir("morning-sched-plan-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "morning-pipeline.js"),
    "// stub\n",
    "utf8"
  );
  const plan = buildMorningSchedulerPlan({
    rootDir: root,
    nodePath: process.execPath,
  });
  assert.strictEqual(plan.label, DEFAULT_LABEL);
  assert.strictEqual(plan.hour, DEFAULT_HOUR);
  assert.strictEqual(plan.minute, DEFAULT_MINUTE);
  assert.strictEqual(plan.timezone, DEFAULT_TIMEZONE);
  assert.strictEqual(plan.npmEquivalent, "npm run morning");
  assert.ok(plan.plistPath.includes(PLIST_DIR_REL));
  assert.ok(plan.plistXml.includes("<key>Label</key>"));
  assert.ok(plan.plistXml.includes(DEFAULT_LABEL));
  assert.ok(plan.plistXml.includes("<key>Hour</key>"));
  assert.ok(plan.plistXml.includes("<integer>7</integer>"));
  assert.ok(plan.plistXml.includes("<key>Minute</key>"));
  assert.ok(plan.plistXml.includes(process.execPath));
  assert.ok(plan.plistXml.includes("morning-pipeline.js"));
  assert.ok(!/OPENAI|API_KEY|password|secret/i.test(plan.plistXml));
  assert.ok(!plan.plistXml.includes("KeepAlive"));
  assert.ok(!plan.plistXml.includes("EnvironmentVariables"));
  console.log("EP047 plan PASS");
}

// --- parse args ---
{
  const opts = parseSchedulerArgs([
    "--hour",
    "8",
    "--minute",
    "15",
    "--timezone",
    "Asia/Tokyo",
  ]);
  assert.strictEqual(opts.hour, 8);
  assert.strictEqual(opts.minute, 15);
  assert.throws(() => parseSchedulerArgs(["--nope"]), /Unknown option/);
  console.log("EP047 parse PASS");
}

// --- install idempotent (mocked launchctl) ---
{
  const root = tmpDir("morning-sched-install-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "morning-pipeline.js"),
    "// stub\n",
    "utf8"
  );
  const home = tmpDir("morning-sched-home-");
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });

  const originalHomedir = os.homedir;
  os.homedir = () => home;

  const launchctlCalls = [];
  const deps = {
    platform: "darwin",
    uid: 501,
    runLaunchctl: (args) => {
      launchctlCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    log: () => {},
  };

  try {
    const first = installMorningScheduler(
      { rootDir: root, nodePath: process.execPath },
      deps
    );
    assert.strictEqual(first.ok, true);
    assert.ok(fs.existsSync(first.plan.plistPath));
    assert.ok(fs.existsSync(first.plan.launchAgentsPlist));

    const bootstraps = launchctlCalls.filter((a) => a[0] === "bootstrap");
    assert.ok(bootstraps.length >= 1);

    launchctlCalls.length = 0;
    const second = installMorningScheduler(
      { rootDir: root, nodePath: process.execPath },
      deps
    );
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.status, "refreshed");
    // Still bootout+bootstrap once (safe refresh), not double labels
    assert.strictEqual(
      launchctlCalls.filter((a) => a[0] === "bootstrap").length,
      1
    );

    // uninstall without prior load still ok
    launchctlCalls.length = 0;
    const un = uninstallMorningScheduler(
      { rootDir: root, nodePath: process.execPath },
      {
        ...deps,
        runLaunchctl: (args) => {
          launchctlCalls.push(args);
          return { status: 1, stdout: "", stderr: "not loaded" };
        },
      }
    );
    assert.strictEqual(un.ok, true);
    assert.ok(!fs.existsSync(path.join(agents, `${DEFAULT_LABEL}.plist`)));

    const st = statusMorningScheduler(
      { rootDir: root, nodePath: process.execPath },
      {
        ...deps,
        runLaunchctl: () => ({ status: 1, stdout: "", stderr: "" }),
      }
    );
    assert.strictEqual(st.loaded, false);
    assert.ok(formatStatusReport(st).includes("Morning Scheduler Status"));
  } finally {
    os.homedir = originalHomedir;
  }
  console.log("EP047 install-uninstall PASS");
}

// --- non-darwin rejected ---
{
  assert.throws(
    () =>
      installMorningScheduler(
        { rootDir: tmpDir("x-"), nodePath: process.execPath },
        { platform: "linux", log: () => {} }
      ),
    /macOS/
  );
  console.log("EP047 os-guard PASS");
}

console.log("morning-scheduler-test: all PASS");
