/**
 * EP-045 — Publish pipeline.
 * Run: node test/publish-reader-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  formatPublishCommitMessage,
  createRunner,
  PUBLISH_REL_FILES,
  REQUIRED_BRANCH,
  TEST_SCRIPT_REL,
  AUDIT_SCRIPT_REL,
} = require("../lib/publish-reader");

function isNodeScriptCall(command, args, scriptRel) {
  return (
    command === process.execPath &&
    args.length === 1 &&
    path.basename(args[0]) === path.basename(scriptRel)
  );
}

// --- commit message ---
{
  const msg = formatPublishCommitMessage(new Date(2026, 6, 24, 15, 5));
  assert.strictEqual(msg, "Publish Digest Reader 2026-07-24 15:05");
  assert.deepStrictEqual(PUBLISH_REL_FILES, [
    path.join("output", "digest-reader", "index.html"),
    path.join("output", "digest-reader", "style.css"),
  ]);
  assert.strictEqual(REQUIRED_BRANCH, "main");
  console.log("EP045 message PASS");
}

// --- wrong branch refuses before mutate ---
{
  const logs = [];
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "feature/x\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const runner = createRunner({
    spawn,
    log: (l) => logs.push(l),
    generateReader: () => ({ status: 0 }),
  });
  assert.throws(
    () => runner.runPublish({ skipGenerate: true, skipTest: true, skipAudit: true }),
    /required: main/
  );
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "add"));
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "commit"));
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "push"));
  console.log("EP045 wrong-branch PASS");
}

// --- no changes → skip commit/push ---
{
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, TEST_SCRIPT_REL)) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, AUDIT_SCRIPT_REL)) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const runner = createRunner({
    spawn,
    log: () => {},
    generateReader: () => ({ status: 0 }),
    // ensureReaderHtml needs files — skip generate
  });
  const result = runner.runPublish({
    skipGenerate: true,
    skipTest: true,
    skipAudit: true,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.skippedPush, true);
  assert.ok(!calls.some((c) => c[1] === "add"));
  assert.ok(!calls.some((c) => c[1] === "commit"));
  assert.ok(!calls.some((c) => c[1] === "push"));
  console.log("EP045 no-changes PASS");
}

// --- test failure blocks commit ---
{
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (isNodeScriptCall(command, args, TEST_SCRIPT_REL)) {
      return { status: 1, stdout: "fail", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const runner = createRunner({
    spawn,
    log: () => {},
    generateReader: () => ({ status: 0 }),
  });
  assert.throws(
    () =>
      runner.runPublish({
        skipGenerate: true,
        skipAudit: true,
      }),
    /npm test failed/
  );
  assert.ok(!calls.some((c) => c[1] === "add"));
  assert.ok(!calls.some((c) => c[1] === "commit"));
  assert.ok(
    calls.some((c) => isNodeScriptCall(c[0], c.slice(1), TEST_SCRIPT_REL))
  );
  assert.ok(!calls.some((c) => c[0] === "npm"));
  console.log("EP045 test-fail PASS");
}

// --- audit failure blocks commit ---
{
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (isNodeScriptCall(command, args, TEST_SCRIPT_REL)) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, AUDIT_SCRIPT_REL)) {
      return { status: 2, stdout: "", stderr: "audit fail" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const runner = createRunner({
    spawn,
    log: () => {},
    generateReader: () => ({ status: 0 }),
  });
  assert.throws(
    () => runner.runPublish({ skipGenerate: true }),
    /audit:public failed/
  );
  assert.ok(!calls.some((c) => c[1] === "add"));
  assert.ok(
    calls.some((c) => isNodeScriptCall(c[0], c.slice(1), AUDIT_SCRIPT_REL))
  );
  assert.ok(!calls.some((c) => c[0] === "npm"));
  console.log("EP045 audit-fail PASS");
}

// --- happy path: add only publish files, commit message, push ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-reader-"));
  const dir = path.join(root, "output", "digest-reader");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  fs.writeFileSync(path.join(dir, "style.css"), "body{}", "utf8");

  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return {
        status: 0,
        stdout: " M output/digest-reader/index.html\n",
        stderr: "",
      };
    }
    if (command === "git" && args[0] === "add") {
      assert.deepStrictEqual(args.slice(1), [
        "--",
        ...PUBLISH_REL_FILES,
      ]);
      // must not be git add .
      assert.ok(!args.includes("."));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "commit") {
      assert.strictEqual(args[1], "-m");
      assert.ok(/^Publish Digest Reader \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(args[2]));
      assert.ok(!args.includes("-a"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "push") {
      assert.deepStrictEqual(args, ["push", "origin", "main"]);
      assert.ok(!args.includes("--force"));
      assert.ok(!args.includes("-f"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, TEST_SCRIPT_REL)) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, AUDIT_SCRIPT_REL)) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const runner = createRunner({
    rootDir: root,
    spawn,
    log: () => {},
    now: () => new Date(2026, 6, 24, 15, 19),
    generateReader: () => ({ status: 0 }),
  });
  const result = runner.runPublish({
    skipGenerate: true,
    skipTest: true,
    skipAudit: true,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.committed, true);
  assert.strictEqual(
    result.message,
    "Publish Digest Reader 2026-07-24 15:19"
  );
  assert.ok(calls.some((c) => c[1] === "push"));
  console.log("EP045 happy-path PASS");
}

// --- push failure keeps commit (no reset) ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-pushfail-"));
  const dir = path.join(root, "output", "digest-reader");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  fs.writeFileSync(path.join(dir, "style.css"), "body{}", "utf8");

  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return {
        status: 0,
        stdout: " M output/digest-reader/style.css\n",
        stderr: "",
      };
    }
    if (command === "git" && args[0] === "add") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "commit") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "push") {
      return { status: 1, stdout: "", stderr: "rejected" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const runner = createRunner({
    rootDir: root,
    spawn,
    log: () => {},
    generateReader: () => ({ status: 0 }),
  });
  assert.throws(
    () =>
      runner.runPublish({
        skipGenerate: true,
        skipTest: true,
        skipAudit: true,
      }),
    /history not rewritten/
  );
  assert.ok(!calls.some((c) => c[1] === "reset"));
  assert.ok(!calls.some((c) => c[1] === "revert"));
  console.log("EP045 push-fail-no-rewind PASS");
}

// --- PATH-independent: uses process.execPath + scripts, never bare "npm" ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-npm-path-"));
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, TEST_SCRIPT_REL)) {
      assert.strictEqual(args[0], path.join(root, TEST_SCRIPT_REL));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (isNodeScriptCall(command, args, AUDIT_SCRIPT_REL)) {
      assert.strictEqual(args[0], path.join(root, AUDIT_SCRIPT_REL));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const prevPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const runner = createRunner({
      rootDir: root,
      spawn,
      env: { ...process.env, PATH: "" },
      log: () => {},
      generateReader: () => ({ status: 0 }),
    });
    assert.strictEqual(runner.nodePath, process.execPath);
    const result = runner.runPublish({ skipGenerate: true });
    assert.strictEqual(result.ok, true);
    assert.ok(
      calls.some((c) => isNodeScriptCall(c[0], c.slice(1), TEST_SCRIPT_REL))
    );
    assert.ok(
      calls.some((c) => isNodeScriptCall(c[0], c.slice(1), AUDIT_SCRIPT_REL))
    );
    assert.ok(!calls.some((c) => c[0] === "npm"));
  } finally {
    process.env.PATH = prevPath;
  }
  console.log("EP045 path-independent PASS");
}

console.log("publish-reader-test: all PASS");
