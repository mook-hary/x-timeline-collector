/**
 * Collect preflight + dedicated Chrome restart.
 * No real Chrome / CDP / X. Run: node test/collector-preflight-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_COLLECTOR_USER_DATA_DIR,
  commandHasExactUserDataDir,
  isDedicatedCollectorChromeCommand,
  killDedicatedCollectorChrome,
  restartDedicatedCollectorChrome,
} = require("../lib/collector-chrome");
const {
  CDP_NOT_AVAILABLE,
  CDP_CONNECT_TIMEOUT,
  CDP_CONTEXT_TIMEOUT,
  X_HOME_UNAVAILABLE,
  X_AUTH_REQUIRED,
  DEFAULT_CDP_HTTP_TIMEOUT_MS,
  DEFAULT_CDP_CONNECT_TIMEOUT_MS,
  DEFAULT_X_HOME_TIMEOUT_MS,
  MAX_CHROME_RESTARTS,
  isRestartablePreflightError,
  runCollectorPreflight,
  ensureCollectorReady,
  buildCollectorPreflight,
  parsePreflightFromOutput,
  formatPreflightLine,
} = require("../lib/collector-preflight");
const { DEFAULT_COLLECT_TIMEOUT_MS } = require("../lib/morning-collect-policy");
const { formatXCollectorSummary } = require("../lib/x-collector-health");
const { runMorning, parseMorningArgs } = require("../scripts/morning");
const { COLLECT_STAGES } = require("../lib/collect-stage");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function dedicatedCommand(extra = "") {
  return (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " +
    `--remote-debugging-port=9222 --user-data-dir=${DEFAULT_COLLECTOR_USER_DATA_DIR}` +
    extra
  );
}

function makeHomeBrowser() {
  const page = {
    url: () => "https://x.com/home",
    bringToFront: async () => {},
  };
  const context = {
    pages: () => [page],
  };
  return {
    contexts: () => [context],
    disconnect() {},
    page,
  };
}

function healthyHttp() {
  return { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" };
}

async function main() {
  assert.strictEqual(
    DEFAULT_COLLECTOR_USER_DATA_DIR,
    "/Users/erefanto/x-timeline-chrome"
  );
  assert.strictEqual(DEFAULT_COLLECT_TIMEOUT_MS, 15 * 60 * 1000);
  assert.strictEqual(DEFAULT_CDP_HTTP_TIMEOUT_MS, 5000);
  assert.ok(DEFAULT_CDP_CONNECT_TIMEOUT_MS >= 15000);
  assert.ok(DEFAULT_CDP_CONNECT_TIMEOUT_MS <= 30000);
  assert.ok(DEFAULT_X_HOME_TIMEOUT_MS >= 15000);
  assert.ok(DEFAULT_X_HOME_TIMEOUT_MS <= 30000);
  assert.strictEqual(MAX_CHROME_RESTARTS, 1);
  assert.strictEqual(COLLECT_STAGES.SAVE, "save");
  console.log("preflight constants PASS");

  {
    assert.ok(
      commandHasExactUserDataDir(
        dedicatedCommand(),
        DEFAULT_COLLECTOR_USER_DATA_DIR
      )
    );
    assert.ok(
      !commandHasExactUserDataDir(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DEFAULT_COLLECTOR_USER_DATA_DIR}-other`,
        DEFAULT_COLLECTOR_USER_DATA_DIR
      )
    );
    assert.ok(
      !isDedicatedCollectorChromeCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        DEFAULT_COLLECTOR_USER_DATA_DIR
      )
    );
    assert.ok(
      !isDedicatedCollectorChromeCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/erefanto/Library/Application Support/Google/Chrome",
        DEFAULT_COLLECTOR_USER_DATA_DIR
      )
    );
    assert.ok(!isRestartablePreflightError(X_AUTH_REQUIRED));
    assert.ok(isRestartablePreflightError(CDP_NOT_AVAILABLE));
    assert.ok(isRestartablePreflightError(CDP_CONNECT_TIMEOUT));
    assert.ok(isRestartablePreflightError(CDP_CONTEXT_TIMEOUT));
    assert.ok(isRestartablePreflightError(X_HOME_UNAVAILABLE));
    console.log("preflight classify PASS");
  }

  {
    const killed = [];
    const processes = [
      {
        pid: 100,
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      {
        pid: 101,
        command:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/erefanto/Library/Application Support/Google/Chrome",
      },
      { pid: 102, command: dedicatedCommand() },
      {
        pid: 103,
        command: dedicatedCommand().replace(
          DEFAULT_COLLECTOR_USER_DATA_DIR,
          `${DEFAULT_COLLECTOR_USER_DATA_DIR}-backup`
        ),
      },
      {
        pid: 104,
        command: `node connect.js --user-data-dir=${DEFAULT_COLLECTOR_USER_DATA_DIR}`,
      },
    ];
    const result = killDedicatedCollectorChrome({
      listProcesses: () => processes.filter((p) => !killed.includes(p.pid)),
      kill: (pid, signal) => {
        assert.strictEqual(typeof pid, "number");
        assert.ok(signal === "SIGTERM" || signal === "SIGKILL");
        killed.push(pid);
      },
      sleep: () => {},
      userDataDir: DEFAULT_COLLECTOR_USER_DATA_DIR,
    });
    assert.deepStrictEqual(result.pids, [102]);
    assert.deepStrictEqual(killed, [102]);
    console.log("preflight kill dedicated only PASS");
  }

  {
    let launched = null;
    const killed = [];
    restartDedicatedCollectorChrome({
      listProcesses: () =>
        killed.includes(102)
          ? []
          : [{ pid: 102, command: dedicatedCommand() }],
      kill: (pid) => killed.push(pid),
      sleep: () => {},
      spawnChrome: (bin, args) => {
        launched = { bin, args };
        return { unref() {} };
      },
      restartWaitMs: 0,
      termWaitMs: 0,
      userDataDir: DEFAULT_COLLECTOR_USER_DATA_DIR,
    });
    assert.deepStrictEqual(killed, [102]);
    assert.ok(launched);
    assert.ok(!/killall/i.test(launched.bin));
    assert.ok(launched.args.includes("--remote-debugging-port=9222"));
    assert.ok(
      launched.args.includes(`--user-data-dir=${DEFAULT_COLLECTOR_USER_DATA_DIR}`)
    );
    console.log("preflight restart launch flags PASS");
  }

  {
    const browser = makeHomeBrowser();
    const result = await runCollectorPreflight({
      fetchJson: async () => healthyHttp(),
      connectOverCDP: async () => browser,
      assessXSession: async () => ({
        authenticated: true,
        timelineAvailable: true,
        error: null,
      }),
      timeouts: {
        cdpHttpMs: 50,
        cdpConnectMs: 50,
        xHomeMs: 50,
        restartWaitMs: 0,
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.cdpAvailable, true);
    assert.strictEqual(result.playwrightConnected, true);
    assert.strictEqual(result.xHomeAvailable, true);
    console.log("preflight healthy PASS");
  }

  {
    let restarts = 0;
    let httpCalls = 0;
    const browser = makeHomeBrowser();
    const ready = await ensureCollectorReady({
      fetchJson: async () => {
        httpCalls += 1;
        if (httpCalls === 1) {
          const err = new Error("ECONNREFUSED");
          err.code = CDP_NOT_AVAILABLE;
          throw err;
        }
        return healthyHttp();
      },
      connectOverCDP: async () => browser,
      assessXSession: async () => ({
        authenticated: true,
        timelineAvailable: true,
        error: null,
      }),
      restartDedicatedCollectorChrome: () => {
        restarts += 1;
      },
      sleep: () => {},
      timeouts: {
        cdpHttpMs: 40,
        cdpConnectMs: 40,
        xHomeMs: 40,
        restartWaitMs: 0,
      },
    });
    assert.strictEqual(ready.status, "recovered");
    assert.strictEqual(ready.chromeRestarted, true);
    assert.strictEqual(ready.attempts, 2);
    assert.strictEqual(ready.initialError, CDP_NOT_AVAILABLE);
    assert.strictEqual(restarts, 1);
    console.log("preflight http unavailable recover PASS");
  }

  {
    let restarts = 0;
    let connectCalls = 0;
    const browser = makeHomeBrowser();
    const ready = await ensureCollectorReady({
      fetchJson: async () => healthyHttp(),
      connectOverCDP: async () => {
        connectCalls += 1;
        if (connectCalls === 1) return new Promise(() => {});
        return browser;
      },
      assessXSession: async () => ({
        authenticated: true,
        timelineAvailable: true,
        error: null,
      }),
      restartDedicatedCollectorChrome: () => {
        restarts += 1;
      },
      sleep: () => {},
      timeouts: {
        cdpHttpMs: 40,
        cdpConnectMs: 25,
        xHomeMs: 40,
        restartWaitMs: 0,
      },
    });
    assert.strictEqual(ready.status, "recovered");
    assert.strictEqual(ready.chromeRestarted, true);
    assert.strictEqual(ready.attempts, 2);
    assert.strictEqual(ready.initialError, CDP_CONNECT_TIMEOUT);
    assert.strictEqual(restarts, 1);
    console.log("preflight playwright timeout recover PASS");
  }

  {
    let restarts = 0;
    const ready = await ensureCollectorReady({
      fetchJson: async () => {
        const err = new Error("down");
        err.code = CDP_NOT_AVAILABLE;
        throw err;
      },
      connectOverCDP: async () => {
        throw new Error("should not connect");
      },
      restartDedicatedCollectorChrome: () => {
        restarts += 1;
      },
      sleep: () => {},
      timeouts: {
        cdpHttpMs: 20,
        cdpConnectMs: 20,
        xHomeMs: 20,
        restartWaitMs: 0,
      },
    });
    assert.strictEqual(ready.status, "failed");
    assert.strictEqual(ready.error, CDP_NOT_AVAILABLE);
    assert.strictEqual(ready.chromeRestarted, true);
    assert.strictEqual(ready.attempts, 2);
    assert.strictEqual(restarts, 1);
    console.log("preflight still failed after restart PASS");
  }

  {
    let restarts = 0;
    const ready = await ensureCollectorReady({
      fetchJson: async () => healthyHttp(),
      connectOverCDP: async () => makeHomeBrowser(),
      assessXSession: async () => ({
        authenticated: false,
        timelineAvailable: false,
        error: X_AUTH_REQUIRED,
      }),
      restartDedicatedCollectorChrome: () => {
        restarts += 1;
      },
      sleep: () => {},
      timeouts: {
        cdpHttpMs: 40,
        cdpConnectMs: 40,
        xHomeMs: 40,
        restartWaitMs: 0,
      },
    });
    assert.strictEqual(ready.status, "failed");
    assert.strictEqual(ready.error, X_AUTH_REQUIRED);
    assert.strictEqual(ready.chromeRestarted, false);
    assert.strictEqual(ready.attempts, 1);
    assert.strictEqual(restarts, 0);
    console.log("preflight auth no restart PASS");
  }

  {
    let restarts = 0;
    await ensureCollectorReady({
      runCollectorPreflight: async () => ({
        ok: false,
        error: CDP_CONNECT_TIMEOUT,
        cdpAvailable: true,
        playwrightConnected: false,
        xHomeAvailable: false,
      }),
      restartDedicatedCollectorChrome: () => {
        restarts += 1;
      },
      sleep: () => {},
      timeouts: { restartWaitMs: 0 },
    });
    assert.strictEqual(restarts, 1);
    console.log("preflight restart max once PASS");
  }

  {
    const healthy = buildCollectorPreflight({
      status: "healthy",
      cdpAvailable: true,
      playwrightConnected: true,
      xHomeAvailable: true,
      chromeRestarted: false,
      attempts: 1,
    });
    const recovered = buildCollectorPreflight({
      status: "recovered",
      chromeRestarted: true,
      attempts: 2,
      initialError: CDP_CONNECT_TIMEOUT,
      cdpAvailable: true,
      playwrightConnected: true,
      xHomeAvailable: true,
    });
    const health = {
      authenticated: true,
      status: "healthy",
      fetchedFromScreen: 1,
      newPosts: 1,
      totalStored: 1,
    };
    const okSummary = formatXCollectorSummary(health, healthy);
    assert.ok(okSummary.includes("CDP: OK"));
    assert.ok(okSummary.includes("Chrome Restart: No"));
    assert.ok(okSummary.includes("Login: OK"));
    assert.ok(okSummary.includes("Collect: Healthy"));
    const recoveredSummary = formatXCollectorSummary(health, recovered);
    assert.ok(recoveredSummary.includes("CDP: Recovered"));
    assert.ok(recoveredSummary.includes("Chrome Restart: Yes"));
    const parsed = parsePreflightFromOutput(
      `${formatPreflightLine(recovered)}\n`
    );
    assert.strictEqual(parsed.status, "recovered");
    assert.strictEqual(parsed.initialError, CDP_CONNECT_TIMEOUT);
    console.log("preflight summary json PASS");
  }

  {
    const root = tmpDir("preflight-morning-ok-");
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "output", "timeline_enriched.json"),
      "[]\n",
      "utf8"
    );
    let connectCalls = 0;
    let collectTimeout = null;
    const result = runMorning(parseMorningArgs(["--skip-ai", "--skip-reader"]), {
      rootDir: root,
      log: () => {},
      sleep: () => {},
      ensureCollectorReady: () => ({
        status: "healthy",
        cdpAvailable: true,
        playwrightConnected: true,
        xHomeAvailable: true,
        chromeRestarted: false,
        attempts: 1,
      }),
      spawn: (cmd, args, opts) => {
        const script = String(args && args[0] ? args[0] : "");
        if (script.endsWith("connect.js")) {
          connectCalls += 1;
          collectTimeout = opts.timeout;
          return {
            status: 0,
            stdout:
              "COLLECT_STAGE:save\nCOLLECT_HEALTH_JSON:{\"authenticated\":true,\"status\":\"healthy\",\"totalStored\":1}\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(result.ok);
    assert.strictEqual(connectCalls, 1);
    assert.strictEqual(collectTimeout, DEFAULT_COLLECT_TIMEOUT_MS);
    assert.strictEqual(result.collectorPreflight.status, "healthy");
    assert.strictEqual(result.collectorPreflight.chromeRestarted, false);
    assert.strictEqual(result.stages[0].lastStage, "save");
    console.log("preflight morning healthy collect PASS");
  }

  {
    const root = tmpDir("preflight-morning-fail-");
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "output", "timeline_enriched.json"),
      "[]\n",
      "utf8"
    );
    let connectCalls = 0;
    let threw = null;
    try {
      runMorning(parseMorningArgs(["--skip-ai", "--skip-reader"]), {
        rootDir: root,
        log: () => {},
        ensureCollectorReady: () => ({
          status: "failed",
          error: CDP_CONNECT_TIMEOUT,
          chromeRestarted: true,
          attempts: 2,
          initialError: CDP_CONNECT_TIMEOUT,
        }),
        spawn: (cmd, args) => {
          const script = String(args && args[0] ? args[0] : "");
          if (script.endsWith("connect.js")) connectCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw);
    assert.strictEqual(threw.code, CDP_CONNECT_TIMEOUT);
    assert.strictEqual(connectCalls, 0);
    assert.strictEqual(threw.collectorPreflight.chromeRestarted, true);
    console.log("preflight morning fail skips collect PASS");
  }

  {
    const root = tmpDir("preflight-morning-auth-");
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "output", "timeline_enriched.json"),
      "[]\n",
      "utf8"
    );
    let connectCalls = 0;
    let threw = null;
    try {
      runMorning(parseMorningArgs(["--skip-ai", "--skip-reader"]), {
        rootDir: root,
        log: () => {},
        ensureCollectorReady: () => ({
          status: "failed",
          error: X_AUTH_REQUIRED,
          chromeRestarted: false,
          attempts: 1,
        }),
        spawn: (cmd, args) => {
          const script = String(args && args[0] ? args[0] : "");
          if (script.endsWith("connect.js")) connectCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw);
    assert.strictEqual(threw.code, X_AUTH_REQUIRED);
    assert.strictEqual(connectCalls, 0);
    assert.strictEqual(threw.collectorPreflight.chromeRestarted, false);
    console.log("preflight morning auth skips collect PASS");
  }

  console.log("collector-preflight-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
