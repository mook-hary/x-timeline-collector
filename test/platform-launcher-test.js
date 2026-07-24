/**
 * DEV-001 — Platform Launcher.
 * Run: node test/platform-launcher-test.js
 */
const assert = require("assert");
const EventEmitter = require("events");
const {
  createPlatformLauncher,
  ERROR_CODES,
  SERVICES,
  isPortInUse,
  installSignalHandlers,
} = require("../lib/platform-launcher");

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    setImmediate(() => child.emit("exit", 0, signal || null));
    return true;
  };
  return child;
}

async function main() {
  // 1 create
  {
    const launcher = createPlatformLauncher({
      spawn: () => fakeChild(1),
      healthCheck: async () => true,
      isPortInUse: async () => false,
      logger: { info() {}, error() {} },
    });
    assert.ok(launcher);
    assert.strictEqual(typeof launcher.start, "function");
    assert.strictEqual(typeof launcher.stop, "function");
    assert.strictEqual(launcher.services.length, 3);
    assert.deepStrictEqual(
      launcher.services.map((s) => s.name),
      ["Launcher", "Editorial", "Review"]
    );
    console.log("DEV001 create PASS");
  }

  // 2-4 spawn order + health wait
  {
    const spawnCalls = [];
    const healthCalls = [];
    let healthReady = new Set();
    const launcher = createPlatformLauncher({
      rootDir: "/tmp/platform-test",
      spawn: (cmd, args) => {
        spawnCalls.push({ cmd, args: args.slice() });
        const name =
          args[0] && args[0].includes("launcher")
            ? "Launcher"
            : args[0] && args[0].includes("editorial")
              ? "Editorial"
              : "Review";
        healthReady.add(name);
        return fakeChild(spawnCalls.length + 100);
      },
      healthCheck: async (url) => {
        healthCalls.push(url);
        if (url.includes("4173")) return healthReady.has("Launcher");
        if (url.includes("4174")) return healthReady.has("Editorial");
        if (url.includes("4175")) return healthReady.has("Review");
        return false;
      },
      isPortInUse: async () => false,
      healthTimeoutMs: 2000,
      healthIntervalMs: 10,
      logger: { info() {}, error() {} },
    });

    const result = await launcher.start();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(spawnCalls.length, 3);
    assert.ok(spawnCalls[0].args[0].includes("launcher-dashboard.js"));
    assert.ok(spawnCalls[1].args[0].includes("editorial-dashboard.js"));
    assert.ok(spawnCalls[2].args[0].includes("aikido-review-dashboard.js"));
    // Health waited for each before next spawn: first health urls should start with 4173
    assert.ok(healthCalls.some((u) => u.includes("4173")));
    assert.ok(healthCalls.some((u) => u.includes("4174")));
    assert.ok(healthCalls.some((u) => u.includes("4175")));
    const first4174 = healthCalls.findIndex((u) => u.includes("4174"));
    const first4173Ok = healthCalls.findIndex((u) => u.includes("4173"));
    assert.ok(first4173Ok >= 0 && first4173Ok < first4174);

    // shell:false — spawn receives node + script, not shell string
    assert.strictEqual(spawnCalls[0].cmd, process.execPath);

    await launcher.stop();
    console.log("DEV001 spawn/order/health PASS");
  }

  // 5-6 Ctrl+C / stop children reverse order
  {
    const killOrder = [];
    const children = [];
    const launcher = createPlatformLauncher({
      spawn: () => {
        const child = fakeChild(200 + children.length);
        const origKill = child.kill.bind(child);
        child.kill = (signal) => {
          killOrder.push(children.indexOf(child));
          return origKill(signal);
        };
        children.push(child);
        return child;
      },
      healthCheck: async () => true,
      isPortInUse: async () => false,
      logger: { info() {}, error() {} },
    });
    await launcher.start();
    assert.strictEqual(launcher.getRunning().length, 3);

    // simulate signal handler
    const fakeProcess = new EventEmitter();
    fakeProcess.exitCode = null;
    fakeProcess.exit = (code) => {
      fakeProcess.exitCode = code;
    };
    installSignalHandlers(launcher, { process: fakeProcess });
    fakeProcess.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 50));

    // reverse: Review(2), Editorial(1), Launcher(0)
    assert.deepStrictEqual(killOrder, [2, 1, 0]);
    assert.strictEqual(launcher.getRunning().length, 0);
    assert.strictEqual(fakeProcess.exitCode, 0);
    console.log("DEV001 stop/SIGINT PASS");
  }

  // 7 port in use
  {
    const spawnCalls = [];
    const launcher = createPlatformLauncher({
      spawn: () => {
        spawnCalls.push(1);
        return fakeChild(1);
      },
      healthCheck: async () => true,
      isPortInUse: async (port) => port === 4174,
      logger: { info() {}, error() {} },
    });
    let err = null;
    try {
      await launcher.start();
    } catch (error) {
      err = error;
    }
    assert.ok(err);
    assert.strictEqual(err.code, ERROR_CODES.PORT_ALREADY_IN_USE);
    assert.strictEqual(spawnCalls.length, 0);
    console.log("DEV001 port conflict PASS");
  }

  // 8 timeout
  {
    const launcher = createPlatformLauncher({
      spawn: () => fakeChild(1),
      healthCheck: async () => false,
      isPortInUse: async () => false,
      healthTimeoutMs: 80,
      healthIntervalMs: 20,
      logger: { info() {}, error() {} },
    });
    let err = null;
    try {
      await launcher.start();
    } catch (error) {
      err = error;
    }
    assert.ok(err);
    assert.strictEqual(err.code, ERROR_CODES.STARTUP_TIMEOUT);
    assert.strictEqual(launcher.getRunning().length, 0);
    console.log("DEV001 timeout PASS");
  }

  // 9 partial failure — editorial health fails → review not spawned, launcher stopped
  {
    const spawnScripts = [];
    const killed = [];
    let editorialAttempts = 0;
    const launcher = createPlatformLauncher({
      spawn: (_cmd, args) => {
        spawnScripts.push(args[0]);
        const child = fakeChild(300 + spawnScripts.length);
        const orig = child.kill.bind(child);
        child.kill = (sig) => {
          killed.push(args[0]);
          return orig(sig);
        };
        return child;
      },
      healthCheck: async (url) => {
        if (url.includes("4173")) return true;
        if (url.includes("4174")) {
          editorialAttempts += 1;
          return false;
        }
        return true;
      },
      isPortInUse: async () => false,
      healthTimeoutMs: 80,
      healthIntervalMs: 20,
      logger: { info() {}, error() {} },
    });
    let err = null;
    try {
      await launcher.start();
    } catch (error) {
      err = error;
    }
    assert.ok(err);
    assert.strictEqual(err.code, ERROR_CODES.STARTUP_TIMEOUT);
    assert.ok(spawnScripts.some((s) => s.includes("launcher-dashboard")));
    assert.ok(spawnScripts.some((s) => s.includes("editorial-dashboard")));
    assert.ok(!spawnScripts.some((s) => s.includes("aikido-review-dashboard")));
    assert.ok(editorialAttempts > 0);
    assert.strictEqual(launcher.getRunning().length, 0);
    assert.ok(killed.length >= 1);
    console.log("DEV001 partial failure PASS");
  }

  // 10 full stop after success
  {
    const launcher = createPlatformLauncher({
      spawn: () => fakeChild(Math.floor(Math.random() * 1000)),
      healthCheck: async () => true,
      isPortInUse: async () => false,
      logger: { info() {}, error() {} },
    });
    await launcher.start();
    const stopped = await launcher.stop();
    assert.strictEqual(stopped.ok, true);
    assert.deepStrictEqual(stopped.stopped, ["Review", "Editorial", "Launcher"]);
    assert.strictEqual(launcher.getRunning().length, 0);
    console.log("DEV001 full stop PASS");
  }

  // services constant order
  {
    assert.deepStrictEqual(
      SERVICES.map((s) => s.port),
      [4173, 4174, 4175]
    );
    console.log("DEV001 services PASS");
  }

  // isPortInUse helper exists
  {
    assert.strictEqual(typeof isPortInUse, "function");
    console.log("DEV001 port helper PASS");
  }

  console.log("platform-launcher-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
